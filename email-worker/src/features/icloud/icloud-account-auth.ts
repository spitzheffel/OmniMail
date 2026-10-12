import { writeAudit } from '../../shared/audit/audit'
import {
  checkAppleAccountLoginRateLimit,
  consumeAppleAccountLoginRateLimit,
} from '../auth/registration/registration-security'
import { APPLE_ACCOUNT_ERROR_CODES, ICloudRemoteError } from './icloud-apple'
import {
  APPLE_ACCOUNT_ORIGIN,
  APPLE_ACCOUNT_USER_AGENT,
  AppleAccountClient,
  appleAccountCookieHeader,
} from './icloud-account-client'
import { srpBase64, srpProof, srpPublic, srpSecret } from './icloud-apple-srp'
import {
  ACTIVE_APPLE_SESSION,
  assertAppleIdBindable,
  authFailure,
  outlive,
  promoteAppleOnly,
  type Defer,
} from './icloud-apple-session'
import {
  APPLE_LOGIN_CHALLENGE_GONE,
  AppleLoginChallenges,
  CHALLENGE_MAX_ATTEMPTS,
  appleLoginChallengeGone,
  type ClaimedChallenge,
  type PendingAppleSignIn,
  type TrustedPhone,
  type TwoFactorMethod,
} from './icloud-auth-challenges'
import { iCloudErrorResponse, jsonBody } from './icloud-http'
import { ICloudAccountStore, ICloudStoreError, publicICloudAccount } from './icloud-store'
import type { AppleAccountState, ICloudAccount } from './icloud-types'
import type { Env, SessionUser } from '../../app/types'

const APPLE_AUTH_BASE = 'https://idmsa.apple.com/appleauth/auth'
const APPLE_ACCOUNT_CLIENT_ID = 'af1139274f266b22b68c2a3e7ad932cb3c0bbe854e13a79af78dcc73136882c3'
const AUTH_TIMEOUT_MS = 30_000
/**
 * The Apple calls of one step, the start or a code, together. The web client
 * gives up after 120s; a start still talking to Apple past that would push a
 * code nobody is left to enter, so the step gives up first.
 */
const SIGN_IN_BUDGET_MS = 90_000

/** What a sign-in step works with besides the pending Apple session. */
interface SignInContext {
  env: Env
  user: SessionUser
  store: ICloudAccountStore
  account: ICloudAccount
  ip: string
}

function safeString(value: unknown, max = 4096): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

/** Cookie values are kept exactly as Apple set them, quotes included, since that is how a browser returns them. */
function mergeCookies(cookies: Record<string, string>, headers: Headers): void {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() || []
  const fallback = headers.get('set-cookie')
  for (const value of values.length ? values : fallback ? fallback.split(/,(?=\s*[^;,=]+=[^;,]*)/) : []) {
    const pair = value.split(';', 1)[0]
    const at = pair.indexOf('=')
    if (at < 1) continue
    const name = pair.slice(0, at).trim()
    const cookie = pair.slice(at + 1).trim()
    if (name && cookie) cookies[name] = cookie
  }
}

function frameTag(frameId: string): string {
  return `auth-${frameId}`
}

function authHeaders(session: PendingAppleSignIn): Headers {
  const frame = frameTag(session.frameId)
  const headers = new Headers({
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/json',
    Origin: APPLE_ACCOUNT_ORIGIN,
    Referer: `${APPLE_ACCOUNT_ORIGIN}/`,
    'User-Agent': APPLE_ACCOUNT_USER_AGENT,
    'X-Apple-Widget-Key': APPLE_ACCOUNT_CLIENT_ID,
    'X-Apple-OAuth-Client-Id': APPLE_ACCOUNT_CLIENT_ID,
    'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
    'X-Apple-OAuth-Redirect-URI': APPLE_ACCOUNT_ORIGIN,
    'X-Apple-OAuth-Response-Mode': 'web_message',
    'X-Apple-OAuth-Response-Type': 'code',
    'X-Apple-OAuth-State': frame,
    'X-Apple-Frame-Id': frame,
    'X-Apple-I-Request-Context': 'ca',
    'X-Apple-I-TimeZone': 'Asia/Shanghai',
    'X-Apple-I-FD-Client-Info': JSON.stringify({ U: APPLE_ACCOUNT_USER_AGENT, L: 'zh', Z: 'GMT+08:00', V: '1.1', F: '' }),
    'X-Apple-App-Id': APPLE_ACCOUNT_CLIENT_ID,
    'X-Apple-Domain-Id': '11',
    'X-Apple-Privacy-Consent': 'true',
    'X-Apple-Privacy-Consent-Accepted': 'true',
  })
  if (session.scnt) headers.set('scnt', session.scnt)
  if (session.sessionId) headers.set('X-Apple-ID-Session-Id', session.sessionId)
  if (session.authAttributes) headers.set('X-Apple-Auth-Attributes', session.authAttributes)
  const cookie = appleAccountCookieHeader(session.cookies)
  if (cookie) headers.set('Cookie', cookie)
  return headers
}

/** Unlike the management API, the sign-in rotates its values on refusals too, and the next call must present them. */
function captureHeaders(session: PendingAppleSignIn, headers: Headers): void {
  mergeCookies(session.cookies, headers)
  const scnt = headers.get('scnt')?.trim()
  const sessionId = headers.get('X-Apple-ID-Session-Id')?.trim()
  const attrs = headers.get('X-Apple-Auth-Attributes')?.trim()
  if (scnt) session.scnt = scnt
  if (sessionId) session.sessionId = sessionId
  if (attrs) session.authAttributes = attrs
  const bits = Number.parseInt(headers.get('X-Apple-HC-Bits') || '', 10)
  if (Number.isSafeInteger(bits) && bits > 0 && bits <= 30) session.hcBits = bits
  const challenge = headers.get('X-Apple-HC-Challenge')?.trim()
  if (challenge) session.hcChallenge = challenge
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

/** Apple's own explanation of a refusal, for `detail`. */
function appleReason(status: number, text: string): string {
  const data = parseJson(text)
  const errors = [data.serviceErrors, data.service_errors].find(Array.isArray) as unknown[] | undefined
  const message = (errors || [])
    .map((entry) => safeString((entry as Record<string, unknown> | null)?.message, 300))
    .find(Boolean)
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`
}

function appleTimeout(): ICloudRemoteError {
  return new ICloudRemoteError(504, '连接 Apple Account 超时。', false, APPLE_ACCOUNT_ERROR_CODES.api)
}

/**
 * One call to Apple inside the step's budget. Reading the body stays inside
 * the try: a stall or reset there is a transport failure too.
 */
async function appleFetch(
  url: string,
  init: RequestInit,
  deadline: number,
): Promise<{ response: Response; text: string }> {
  const left = deadline - Date.now()
  if (left <= 0) throw appleTimeout()
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(AUTH_TIMEOUT_MS, left)) })
    return { response, text: await response.text() }
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      throw appleTimeout()
    }
    throw new ICloudRemoteError(502, '连接 Apple Account 失败。', false, APPLE_ACCOUNT_ERROR_CODES.api)
  }
}

/** `codeCheck` marks the calls that submit a verification code, where a 400 means the code was wrong. */
function signInError(status: number, text: string, codeCheck: boolean): ICloudRemoteError {
  if (codeCheck && (status === 400 || text.includes('-21669'))) {
    return new ICloudRemoteError(422, '验证码不正确，请重新输入。', true, APPLE_ACCOUNT_ERROR_CODES.auth)
  }
  const reason = appleReason(status, text)
  if (status === 401 || status === 403 || status === 419 || /authentication_failed/i.test(text)) {
    return new ICloudRemoteError(422, 'Apple 登录已失效，请重新登录。', true, APPLE_ACCOUNT_ERROR_CODES.auth, reason)
  }
  if (status === 429 || status === 503) {
    return new ICloudRemoteError(503, 'Apple 登录请求过于频繁，请稍后再试。', true, APPLE_ACCOUNT_ERROR_CODES.throttled, reason)
  }
  return new ICloudRemoteError(502, 'Apple 登录请求失败。', true, APPLE_ACCOUNT_ERROR_CODES.api, reason)
}

async function appleRequest(
  session: PendingAppleSignIn,
  method: string,
  path: string,
  body: unknown,
  deadline: number,
  { codeCheck = false }: { codeCheck?: boolean } = {},
): Promise<string> {
  const { response, text } = await appleFetch(`${APPLE_AUTH_BASE}${path}`, {
    method,
    headers: authHeaders(session),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  }, deadline)
  captureHeaders(session, response.headers)
  if (!response.ok) throw signInError(response.status, text, codeCheck)
  return text
}

async function primeManageState(session: PendingAppleSignIn, deadline: number): Promise<void> {
  for (const path of ['/account/manage/section/privacy', '/bootstrap/portal']) {
    const { response } = await appleFetch(`${APPLE_ACCOUNT_ORIGIN}${path}`, {
      headers: {
        Accept: path === '/bootstrap/portal' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
        Referer: `${APPLE_ACCOUNT_ORIGIN}/`, 'User-Agent': APPLE_ACCOUNT_USER_AGENT,
        'X-Apple-I-Request-Context': 'ca', 'X-Apple-I-TimeZone': 'Asia/Shanghai',
        Cookie: appleAccountCookieHeader(session.cookies),
      },
      redirect: 'follow',
    }, deadline)
    captureHeaders(session, response.headers)
    if (!response.ok && response.status !== 404) {
      throw new ICloudRemoteError(502, 'Apple Account 登录预热失败。', true, APPLE_ACCOUNT_ERROR_CODES.api, `HTTP ${response.status}`)
    }
  }
  const { response: token } = await appleFetch('https://appleid.apple.com/account/manage/gs/ws/token', {
    headers: { ...Object.fromEntries(authHeaders(session).entries()), Accept: 'application/json' },
    redirect: 'follow',
  }, deadline)
  captureHeaders(session, token.headers)
  if (!token.ok && token.status !== 404) {
    throw new ICloudRemoteError(502, 'Apple Account 管理态预热失败。', true, APPLE_ACCOUNT_ERROR_CODES.api, `HTTP ${token.status}`)
  }
}

async function openSignInFrame(session: PendingAppleSignIn, deadline: number): Promise<void> {
  const frame = frameTag(session.frameId)
  const authorize = new URL(`${APPLE_AUTH_BASE}/authorize/signin`)
  authorize.search = new URLSearchParams({
    frame_id: frame, skVersion: '7', iframeId: frame, client_id: APPLE_ACCOUNT_CLIENT_ID,
    redirect_uri: APPLE_ACCOUNT_ORIGIN, response_type: 'code', response_mode: 'web_message',
    state: frame, authVersion: '8.0.2',
  }).toString()
  const { response } = await appleFetch(authorize.toString(), {
    headers: { Accept: 'text/html,*/*', 'User-Agent': APPLE_ACCOUNT_USER_AGENT }, redirect: 'follow',
  }, deadline)
  captureHeaders(session, response.headers)
}

async function hashcash(bits: number, challenge: string): Promise<string> {
  if (!bits || !challenge) return ''
  const prefix = `1:${bits}:${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}:${challenge}::`
  for (let counter = 0; counter < 1_000_000; counter += 1) {
    const candidate = `${prefix}${counter.toString(36)}`
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(candidate))
    let zeroBits = 0
    for (const byte of new Uint8Array(digest)) {
      if (!byte) { zeroBits += 8; continue }
      for (let bit = 7; bit >= 0 && (byte & (1 << bit)) === 0; bit -= 1) zeroBits += 1
      break
    }
    if (zeroBits >= bits) return candidate
  }
  throw new ICloudRemoteError(502, 'Apple Account 动态验证生成失败，请稍后重试。', true, APPLE_ACCOUNT_ERROR_CODES.api)
}

/** True when Apple wants a verification code before it lets the session in. */
async function completeSignIn(
  session: PendingAppleSignIn,
  proof: { m1: string; m2: string },
  c: unknown,
  deadline: number,
): Promise<boolean> {
  const hc = await hashcash(session.hcBits, session.hcChallenge)
  const headers = authHeaders(session)
  if (hc) headers.set('X-Apple-HC', hc)
  const { response, text } = await appleFetch(`${APPLE_AUTH_BASE}/signin/complete?isRememberMeEnabled=true`, {
    method: 'POST', headers, redirect: 'follow',
    body: JSON.stringify({ accountName: session.appleId, m1: proof.m1, m2: proof.m2, c, rememberMe: true }),
  }, deadline)
  captureHeaders(session, response.headers)
  if (response.status === 409) return true
  if (response.ok) return false
  throw response.status === 401 || response.status === 403
    ? new ICloudRemoteError(422, 'Apple ID 或密码错误。', true, APPLE_ACCOUNT_ERROR_CODES.auth, appleReason(response.status, text))
    : new ICloudRemoteError(502, 'Apple Account 登录失败。', true, APPLE_ACCOUNT_ERROR_CODES.api, appleReason(response.status, text))
}

function trustedPhones(value: unknown): TrustedPhone[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const phone = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
    const id = Number(phone.id)
    if (!Number.isSafeInteger(id) || id < 0) return []
    return [{ id, number: safeString(phone.obfuscatedNumber, 64) || safeString(phone.numberWithDialCode, 64) }]
  }).slice(0, 10)
}

/**
 * Learn where Apple can send the code: the trusted phones it can text, and
 * whether any trusted device can take a push. Without the list the push is
 * still worth trying, so failing here only costs the SMS fallback — unless
 * Apple has rejected the session outright.
 */
async function twoFactorOptions(session: PendingAppleSignIn, deadline: number): Promise<{ noTrustedDevices: boolean }> {
  try {
    const data = parseJson(await appleRequest(session, 'GET', '', undefined, deadline))
    session.phones = trustedPhones(data.trustedPhoneNumbers)
    return { noTrustedDevices: data.noTrustedDevices === true }
  } catch (error) {
    if (authFailure(error)) throw error
    return { noTrustedDevices: false }
  }
}

function noTrustedPhone(): ICloudRemoteError {
  return new ICloudRemoteError(502, 'Apple 没有返回可接收验证码的受信任手机号。', true, APPLE_ACCOUNT_ERROR_CODES.api)
}

async function sendSms(session: PendingAppleSignIn, phoneId: number, deadline: number): Promise<void> {
  await appleRequest(session, 'PUT', '/verify/phone', { phoneNumber: { id: phoneId }, mode: 'sms' }, deadline)
  session.twoFactorMethod = 'phone'
  session.phoneId = phoneId
}

/**
 * Send the code the way the user asked, falling back to SMS when no trusted
 * device takes it. A failed push is never reported as sent: an Apple ID that
 * only has a phone would wait for a code that is not coming.
 */
async function deliverCode(session: PendingAppleSignIn, noTrustedDevices: boolean, deadline: number): Promise<void> {
  const phone = session.phones[0]
  if (session.twoFactorMethod === 'trusted_device' && !noTrustedDevices) {
    try {
      await appleRequest(session, 'PUT', '/verify/trusteddevice/securitycode', undefined, deadline)
      return
    } catch (error) {
      if (!phone || authFailure(error)) throw error
    }
  }
  if (!phone) throw noTrustedPhone()
  await sendSms(session, phone.id, deadline)
}

function twoFactorBody(challengeId: string, expiresAt: number, session: PendingAppleSignIn) {
  return {
    needs2FA: true,
    challengeId,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    method: session.twoFactorMethod,
    phones: session.phones,
    ...(session.phoneId ? { phoneId: session.phoneId } : {}),
  }
}

function stateFromPending(session: PendingAppleSignIn): AppleAccountState {
  return {
    cookies: { ...session.cookies }, scnt: session.scnt, sessionId: session.sessionId,
    apiKey: '', expiresAt: '', lastCheckedAt: '', userAgent: APPLE_ACCOUNT_USER_AGENT,
    host: 'appleid.apple.com', origin: APPLE_ACCOUNT_ORIGIN, appleId: session.appleId,
  }
}

/** Trade the signed-in session for a management one, store it, and record who did it from where. */
async function finishSignIn(
  context: SignInContext,
  session: PendingAppleSignIn,
  via: 'password' | 'two_factor',
): Promise<Response> {
  const { env, user, store, account, ip } = context
  const client = new AppleAccountClient(stateFromPending(session))
  await client.refresh()
  Object.assign(account, {
    appleAccountState: client.state, appleAccountExpiresAt: client.state.expiresAt, ...ACTIVE_APPLE_SESSION,
  })
  await store.saveAppleAccountState(account)
  await promoteAppleOnly(store, account)
  await writeAudit(env, user.id, 'icloud.credentials.apple_account', account.id, ip, {
    accountName: account.name, appleAccountHost: client.state.host, signIn: via,
  })
  return Response.json({ needs2FA: false, account: publicICloudAccount(account) })
}

function tooManyAppleLogins(retryAfter: number): Response {
  return Response.json(
    { error: 'Apple ID 登录尝试过于频繁，请稍后再试。', retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  )
}

function loginErrorResponse(error: unknown): Response {
  return iCloudErrorResponse(error, 'Apple Account sign-in failed', 'Apple Account 登录暂时失败。')
}

async function signIn(context: SignInContext, appleId: string, password: string, method: TwoFactorMethod): Promise<Response> {
  const { env, user, account } = context
  const deadline = Date.now() + SIGN_IN_BUDGET_MS
  const session: PendingAppleSignIn = {
    appleId, frameId: crypto.randomUUID().replaceAll('-', ''), cookies: {}, scnt: '', sessionId: '',
    authAttributes: '', hcBits: 0, hcChallenge: '', twoFactorMethod: method, phoneId: 0, phones: [],
  }
  await primeManageState(session, deadline)
  await openSignInFrame(session, deadline)
  await appleRequest(session, 'POST', '/verify/device/key/challenge', { passkeyAutofill: false }, deadline)
  await appleRequest(session, 'POST', '/federate?isRememberMeEnabled=true', { accountName: appleId, rememberMe: true }, deadline)
  // Charged here, right before the SRP round that counts toward the Apple
  // ID's lockout: warm-up failures above never reach it. The check up front
  // already refused a spent allowance; this catches attempts that raced it.
  const limit = await consumeAppleAccountLoginRateLimit(env.DB, user.id, appleId)
  if (!limit.allowed) return tooManyAppleLogins(limit.retryAfter)
  const secret = srpSecret()
  const init = parseJson(await appleRequest(session, 'POST', '/signin/init', {
    a: srpBase64(srpPublic(secret)), accountName: appleId, protocols: ['s2k', 's2k_fo'],
  }, deadline))
  const proof = await srpProof(appleId, password, {
    salt: safeString(init.salt), b: safeString(init.b), iteration: Number(init.iteration),
    protocol: safeString(init.protocol) || 's2k',
  }, secret)
  if (!await completeSignIn(session, proof, init.c, deadline)) return finishSignIn(context, session, 'password')
  const { noTrustedDevices } = await twoFactorOptions(session, deadline)
  await deliverCode(session, noTrustedDevices, deadline)
  const { id, expiresAt } = await new AppleLoginChallenges(env, user.id, account.id).open(session)
  return Response.json(twoFactorBody(id, expiresAt, session))
}

export async function startAppleAccountLogin(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
  ip: string,
  defer: Defer,
): Promise<Response> {
  try {
    const body = await jsonBody(request)
    const appleId = safeString(body.appleId, 254).toLowerCase()
    const password = safeString(body.password, 256)
    if (!appleId || !password) throw new ICloudStoreError(400, '请填写 Apple ID 和密码。')
    // Refused before anything is decrypted or sent to Apple.
    const precheck = await checkAppleAccountLoginRateLimit(env.DB, user.id, appleId)
    if (!precheck.allowed) return tooManyAppleLogins(precheck.retryAfter)
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(accountId)
    await assertAppleIdBindable(store, account, appleId)
    const method: TwoFactorMethod = body.twoFactorMethod === 'phone' ? 'phone' : 'trusted_device'
    return await outlive(defer, signIn({ env, user, store, account, ip }, appleId, password, method))
  } catch (error) {
    return loginErrorResponse(error)
  }
}

/** Once a challenge can no longer be answered, whatever went wrong also tells the client to start over. */
function spentChallenge(error: unknown): ICloudStoreError {
  if (error instanceof ICloudStoreError || error instanceof ICloudRemoteError) {
    return new ICloudStoreError(error.status, error.message, error.detail, APPLE_LOGIN_CHALLENGE_GONE)
  }
  console.error('Apple Account sign-in failed after Apple accepted the code', error)
  return new ICloudStoreError(500, 'Apple Account 登录暂时失败。', '', APPLE_LOGIN_CHALLENGE_GONE)
}

/**
 * After a refused attempt, keep what Apple rotated for the next one, or drop
 * the challenge once its attempts are spent. Returns the error to report.
 */
async function afterFailedAttempt(
  challenges: AppleLoginChallenges,
  challengeId: string,
  claimed: ClaimedChallenge,
  error: unknown,
): Promise<unknown> {
  const last = claimed.attempts >= CHALLENGE_MAX_ATTEMPTS
  try {
    if (last) await challenges.close(challengeId)
    else await challenges.save(challengeId, claimed.state)
  } catch (storeError) {
    console.error('Apple sign-in challenge could not be updated', storeError)
  }
  return last ? appleLoginChallengeGone(true) : error
}

async function verifyCode(
  context: SignInContext,
  challenges: AppleLoginChallenges,
  challengeId: string,
  claimed: ClaimedChallenge,
  code: string,
): Promise<Response> {
  const session = claimed.state
  const deadline = Date.now() + SIGN_IN_BUDGET_MS
  const bySms = session.twoFactorMethod === 'phone'
  try {
    await appleRequest(
      session, 'POST',
      bySms ? '/verify/phone/securitycode' : '/verify/trusteddevice/securitycode',
      bySms ? { phoneNumber: { id: session.phoneId }, securityCode: { code }, mode: 'sms' } : { securityCode: { code } },
      deadline, { codeCheck: true },
    )
  } catch (error) {
    throw await afterFailedAttempt(challenges, challengeId, claimed, error)
  }
  // Apple has taken the code: whatever happens next, it cannot be answered again.
  await challenges.close(challengeId).catch((error) => console.error('Apple sign-in challenge could not be closed', error))
  try {
    await appleRequest(session, 'GET', '/2sv/trust', undefined, deadline)
    return await finishSignIn(context, session, 'two_factor')
  } catch (error) {
    throw spentChallenge(error)
  }
}

export async function submitAppleAccountLogin2FA(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
  ip: string,
  defer: Defer,
): Promise<Response> {
  try {
    const body = await jsonBody(request)
    const challengeId = safeString(body.challengeId, 128)
    const code = safeString(body.code, 6)
    if (!challengeId || !/^\d{6}$/.test(code)) throw new ICloudStoreError(400, '请输入 6 位验证码。')
    const challenges = new AppleLoginChallenges(env, user.id, accountId)
    const claimed = await challenges.claim(challengeId)
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(accountId)
    // The account may have taken another Apple ID while the code was on its way.
    await assertAppleIdBindable(store, account, claimed.state.appleId)
    return await outlive(defer, verifyCode({ env, user, store, account, ip }, challenges, challengeId, claimed, code))
  } catch (error) {
    return loginErrorResponse(error)
  }
}

/** Switch a sign-in waiting for its code to SMS, on the trusted phone the user picked. */
export async function sendAppleAccountLoginSms(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
  defer: Defer,
): Promise<Response> {
  try {
    const body = await jsonBody(request)
    const challengeId = safeString(body.challengeId, 128)
    const phoneId = body.phoneId === undefined ? undefined : Number(body.phoneId)
    if (phoneId !== undefined && !Number.isSafeInteger(phoneId)) {
      throw new ICloudStoreError(400, '请选择 Apple 返回的受信任手机号。')
    }
    if (!challengeId) throw appleLoginChallengeGone(false)
    const challenges = new AppleLoginChallenges(env, user.id, accountId)
    const claimed = await challenges.claim(challengeId)
    // Sending a code on the last attempt would leave none to enter it with.
    if (claimed.attempts >= CHALLENGE_MAX_ATTEMPTS) {
      await challenges.close(challengeId)
      throw appleLoginChallengeGone(true)
    }
    const session = claimed.state
    if (!session.phones.length) throw noTrustedPhone()
    const phone = phoneId === undefined ? session.phones[0] : session.phones.find((entry) => entry.id === phoneId)
    if (!phone) throw new ICloudStoreError(400, '请选择 Apple 返回的受信任手机号。')
    return await outlive(defer, (async () => {
      try {
        await sendSms(session, phone.id, Date.now() + SIGN_IN_BUDGET_MS)
      } catch (error) {
        await challenges.save(challengeId, session).catch(() => undefined)
        throw error
      }
      // Unlike after a refusal, this write has to land: the code is on its way
      // by SMS, and only a challenge that says so submits it to the SMS check.
      await challenges.save(challengeId, session)
      return Response.json(twoFactorBody(challengeId, claimed.expiresAt, session))
    })())
  } catch (error) {
    return loginErrorResponse(error)
  }
}
