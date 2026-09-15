import { decryptICloudSecret, encryptICloudSecret } from './icloud-credentials'
import { ICloudAccountStore, ICloudStoreError, publicICloudAccount } from './icloud-store'
import { AppleAccountClient } from './icloud-account-client'
import {
  APPLE_ACCOUNT_ERROR_CODES,
  ICloudRemoteError,
} from './icloud-apple'
import type { AppleAccountState } from './icloud-types'
import type { Env, SessionUser } from '../../app/types'

const APPLE_AUTH_BASE = 'https://idmsa.apple.com/appleauth/auth'
const APPLE_ACCOUNT_ORIGIN = 'https://account.apple.com'
const APPLE_ACCOUNT_CLIENT_ID = 'af1139274f266b22b68c2a3e7ad932cb3c0bbe854e13a79af78dcc73136882c3'
const APPLE_ACCOUNT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const AUTH_TIMEOUT_MS = 30_000
const CHALLENGE_TTL_SECONDS = 10 * 60
const CHALLENGE_MAX_ATTEMPTS = 5

type PendingAuthState = {
  appleId: string
  frameId: string
  cookies: Record<string, string>
  scnt: string
  sessionId: string
  authAttributes: string
  hcBits: number
  hcChallenge: string
  twoFactorMethod: 'trusted_device' | 'phone'
}

function safeString(value: unknown, max = 4096): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) return ''
  return text
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`).join('; ')
}

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

function authHeaders(session: PendingAuthState, includeAppleAccount = true): Headers {
  const frame = frameTag(session.frameId)
  const headers = new Headers({
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'Content-Type': 'application/json',
    Origin: APPLE_ACCOUNT_ORIGIN,
    Referer: `${APPLE_ACCOUNT_ORIGIN}/`,
    'User-Agent': APPLE_ACCOUNT_UA,
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
    'X-Apple-I-FD-Client-Info': JSON.stringify({ U: APPLE_ACCOUNT_UA, L: 'zh', Z: 'GMT+08:00', V: '1.1', F: '' }),
    'X-Apple-App-Id': APPLE_ACCOUNT_CLIENT_ID,
  })
  if (includeAppleAccount) {
    headers.set('X-Apple-Domain-Id', '11')
    headers.set('X-Apple-Privacy-Consent', 'true')
    headers.set('X-Apple-Privacy-Consent-Accepted', 'true')
  }
  if (session.scnt) headers.set('scnt', session.scnt)
  if (session.sessionId) headers.set('X-Apple-ID-Session-Id', session.sessionId)
  if (session.authAttributes) headers.set('X-Apple-Auth-Attributes', session.authAttributes)
  const cookie = cookieHeader(session.cookies)
  if (cookie) headers.set('Cookie', cookie)
  return headers
}

function captureHeaders(session: PendingAuthState, headers: Headers): void {
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

async function appleRequest(
  session: PendingAuthState,
  method: string,
  path: string,
  body?: unknown,
  allowConflict = false,
): Promise<{ status: number; text: string }> {
  const headers = authHeaders(session)
  const response = await fetch(`${APPLE_AUTH_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  })
  const text = await response.text()
  captureHeaders(session, response.headers)
  if (response.status === 409 && allowConflict) return { status: response.status, text }
  if (!response.ok) {
    const lower = text.toLowerCase()
    const code = response.status === 401 || response.status === 403 || response.status === 419
      || lower.includes('authentication_failed') ? APPLE_ACCOUNT_ERROR_CODES.auth : APPLE_ACCOUNT_ERROR_CODES.api
    throw new ICloudRemoteError(
      code === APPLE_ACCOUNT_ERROR_CODES.auth ? 422 : 502,
      code === APPLE_ACCOUNT_ERROR_CODES.auth ? 'Apple ID 或密码错误，或管理态登录已失效。' : `Apple 登录请求失败（HTTP ${response.status}）。`,
      true,
      code,
    )
  }
  return { status: response.status, text }
}

async function primeManageState(session: PendingAuthState): Promise<void> {
  for (const path of ['/account/manage/section/privacy', '/bootstrap/portal']) {
    const response = await fetch(`${APPLE_ACCOUNT_ORIGIN}${path}`, {
      headers: {
        Accept: path === '/bootstrap/portal' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml',
        Referer: `${APPLE_ACCOUNT_ORIGIN}/`, 'User-Agent': APPLE_ACCOUNT_UA,
        'X-Apple-I-Request-Context': 'ca', 'X-Apple-I-TimeZone': 'Asia/Shanghai',
        Cookie: cookieHeader(session.cookies),
      },
      redirect: 'follow', signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
    const text = await response.text()
    captureHeaders(session, response.headers)
    if (!response.ok && response.status !== 404) {
      throw new ICloudRemoteError(502, `Apple Account 登录预热失败（HTTP ${response.status}）。`, true, APPLE_ACCOUNT_ERROR_CODES.api)
    }
    if (path === '/bootstrap/portal' && text.trim()) {
      const portal = parseJson(text)
      const timeout = Number(portal.timeOutInterval)
      if (Number.isFinite(timeout) && timeout > 0) session.hcBits = Math.max(session.hcBits, 0)
    }
  }
  const token = await fetch('https://appleid.apple.com/account/manage/gs/ws/token', {
    headers: { ...Object.fromEntries(authHeaders(session).entries()), Accept: 'application/json' },
    redirect: 'follow', signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
  })
  await token.text(); captureHeaders(session, token.headers)
  if (!token.ok && token.status !== 404) {
    throw new ICloudRemoteError(502, `Apple Account 管理态预热失败（HTTP ${token.status}）。`, true, APPLE_ACCOUNT_ERROR_CODES.api)
  }
}

const SRP_N = BigInt(`0x${
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050'
  + 'A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50'
  + 'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8'
  + '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B'
  + 'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748'
  + '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE'
  + '6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFB'
  + 'B694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73'
}`)
const SRP_G = 2n
const SRP_BYTES = 256

function pad(value: bigint): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const bytes = Uint8Array.from(hex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) || [])
  const output = new Uint8Array(SRP_BYTES)
  output.set(bytes.slice(-SRP_BYTES), SRP_BYTES - Math.min(SRP_BYTES, bytes.length))
  return output
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { output.set(part, offset); offset += part.length }
  return output
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', concat(...parts)))
}

function hexBytes(value: string): Uint8Array {
  const normalized = value.replace(/^0x/i, '').padStart(value.length % 2 ? value.length + 1 : value.length, '0')
  return Uint8Array.from(normalized.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) || [])
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
}

function base64(value: Uint8Array): string {
  let text = ''
  for (const byte of value) text += String.fromCharCode(byte)
  return btoa(text)
}

function hex(value: Uint8Array): string {
  return Array.from(value).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let factor = ((base % modulus) + modulus) % modulus
  let power = exponent
  while (power > 0n) {
    if (power & 1n) result = (result * factor) % modulus
    factor = (factor * factor) % modulus
    power >>= 1n
  }
  return result
}

function srpSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

function srpPublic(secret: Uint8Array): Uint8Array {
  const a = BigInt(`0x${hex(secret)}`)
  return pad(modPow(SRP_G, a, SRP_N))
}

async function srpProof(appleId: string, password: string, response: Record<string, unknown>, secret: Uint8Array): Promise<{ m1: string; m2: string }> {
  const salt = base64Bytes(safeString(response.salt))
  const serverB = BigInt(`0x${Array.from(base64Bytes(safeString(response.b))).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`)
  if (!salt.length || !serverB || serverB >= SRP_N) throw new ICloudRemoteError(502, 'Apple SRP 挑战参数无效。', true, APPLE_ACCOUNT_ERROR_CODES.api)
  const a = BigInt(`0x${Array.from(secret).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`)
  const A = modPow(SRP_G, a, SRP_N)
  const nBytes = hexBytes(SRP_N.toString(16))
  const k = BigInt(`0x${Array.from(await sha256(nBytes, pad(SRP_G))).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`)
  const passHash = await sha256(new TextEncoder().encode(password))
  const protocol = safeString(response.protocol) || 's2k'
  const passwordInput = protocol === 's2k_fo' ? new TextEncoder().encode(hex(passHash)) : passHash
  const key = await crypto.subtle.importKey('raw', passwordInput, 'PBKDF2', false, ['deriveBits'])
  const iterations = Number(response.iteration)
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new ICloudRemoteError(502, 'Apple SRP 迭代参数无效。', true, APPLE_ACCOUNT_ERROR_CODES.api)
  }
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
  ))
  const inner = await sha256(concat(new TextEncoder().encode(':'), derived))
  const x = BigInt(`0x${Array.from(await sha256(salt, inner)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`)
  const u = BigInt(`0x${Array.from(await sha256(pad(A), pad(serverB))).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`)
  const gx = modPow(SRP_G, x, SRP_N)
  const base = ((serverB - k * gx) % SRP_N + SRP_N) % SRP_N
  const shared = modPow(base, a + u * x, SRP_N)
  const sessionKey = await sha256(pad(shared))
  const hG = await sha256(pad(SRP_G))
  const hN = await sha256(nBytes)
  const xor = hG.map((byte, index) => byte ^ hN[index])
  const m1 = await sha256(xor, await sha256(new TextEncoder().encode(appleId)), salt, pad(A), pad(serverB), sessionKey)
  const m2 = await sha256(pad(A), m1, sessionKey)
  return { m1: base64(m1), m2: base64(m2) }
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

function parseJson(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function stateFromPending(session: PendingAuthState): AppleAccountState {
  return {
    cookies: { ...session.cookies }, scnt: session.scnt, sessionId: session.sessionId,
    apiKey: '', expiresAt: '', lastCheckedAt: '', userAgent: APPLE_ACCOUNT_UA,
    host: 'appleid.apple.com', origin: APPLE_ACCOUNT_ORIGIN,
  }
}

export async function startAppleAccountLogin(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json<Record<string, unknown>>()
    const appleId = safeString(body.appleId, 254).toLowerCase()
    const password = safeString(body.password, 256)
    const method = body.twoFactorMethod === 'phone' ? 'phone' : 'trusted_device'
    if (!appleId || !password) throw new ICloudStoreError(400, '请填写 Apple ID 和密码。')
    const store = new ICloudAccountStore(env, user.id)
    await store.get(accountId)
    const session: PendingAuthState = {
      appleId, frameId: crypto.randomUUID().replaceAll('-', ''), cookies: {}, scnt: '', sessionId: '',
      authAttributes: '', hcBits: 0, hcChallenge: '', twoFactorMethod: method,
    }
    await primeManageState(session)
    const frame = frameTag(session.frameId)
    const authorize = new URL(`${APPLE_AUTH_BASE}/authorize/signin`)
    authorize.search = new URLSearchParams({
      frame_id: frame, skVersion: '7', iframeId: frame, client_id: APPLE_ACCOUNT_CLIENT_ID,
      redirect_uri: APPLE_ACCOUNT_ORIGIN, response_type: 'code', response_mode: 'web_message',
      state: frame, authVersion: '8.0.2',
    }).toString()
    const first = await fetch(authorize, { headers: { Accept: 'text/html,*/*', 'User-Agent': APPLE_ACCOUNT_UA }, redirect: 'follow', signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) })
    captureHeaders(session, first.headers)
    await first.text()
    await appleRequest(session, 'POST', '/verify/device/key/challenge', { passkeyAutofill: false })
    await appleRequest(session, 'POST', '/federate?isRememberMeEnabled=true', { accountName: appleId, rememberMe: true })
    const secret = srpSecret()
    const init = await appleRequest(session, 'POST', '/signin/init', {
      a: base64(srpPublic(secret)),
      accountName: appleId, protocols: ['s2k', 's2k_fo'],
    })
    const challenge = parseJson(init.text)
    const proof = await srpProof(appleId, password, challenge, secret)
    const hc = await hashcash(session.hcBits, session.hcChallenge)
    const completeBody: Record<string, unknown> = {
      accountName: appleId, m1: proof.m1, m2: proof.m2, c: challenge.c, rememberMe: true,
    }
    const completeHeaders = authHeaders(session)
    if (hc) completeHeaders.set('X-Apple-HC', hc)
    const complete = await fetch(`${APPLE_AUTH_BASE}/signin/complete?isRememberMeEnabled=true`, {
      method: 'POST', headers: completeHeaders, body: JSON.stringify(completeBody), redirect: 'follow', signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
    })
    await complete.text(); captureHeaders(session, complete.headers)
    if (complete.status === 409) {
      if (method === 'trusted_device') {
        await appleRequest(session, 'PUT', '/verify/trusteddevice/securitycode').catch(() => undefined)
      } else {
        await appleRequest(session, 'PUT', '/verify/phone', {
          phoneNumber: { id: 1 }, mode: 'sms',
        }).catch(() => undefined)
      }
      const challengeId = crypto.randomUUID()
      const now = Math.floor(Date.now() / 1000)
      await env.DB.prepare(
        'DELETE FROM icloud_auth_challenges WHERE user_id = ? AND (expires_at <= ? OR account_id = ?)',
      ).bind(user.id, now, accountId).run()
      const cipher = await encryptICloudSecret(env, JSON.stringify(session), `${user.id}:${accountId}:apple-auth:${challengeId}`)
      await env.DB.prepare(
        `INSERT INTO icloud_auth_challenges (id, user_id, account_id, state_cipher, expires_at, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).bind(challengeId, user.id, accountId, cipher, now + CHALLENGE_TTL_SECONDS, now).run()
      return Response.json({ needs2FA: true, challengeId, expiresAt: new Date((now + CHALLENGE_TTL_SECONDS) * 1000).toISOString(), message: method === 'phone' ? '验证码已发送到受信任手机号。' : '请在受信任设备上确认并输入验证码。' })
    }
    if (!complete.ok) throw new ICloudRemoteError(422, 'Apple Account 登录失败。', true, APPLE_ACCOUNT_ERROR_CODES.auth)
    const account = await store.get(accountId)
    const client = new AppleAccountClient(stateFromPending(session))
    await client.refresh()
    account.appleAccountState = client.state
    account.appleAccountStatus = 'active'; account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
    await store.saveAppleAccountState(account)
    return Response.json({ needs2FA: false, account: publicICloudAccount(account) })
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: '请求体必须是 JSON 对象。' }, { status: 400 })
    if (error instanceof ICloudStoreError || error instanceof ICloudRemoteError) return Response.json({ error: error.message }, { status: error.status })
    console.error('Apple Account login failed', error)
    return Response.json({ error: 'Apple Account 登录暂时失败。' }, { status: 502 })
  }
}

export async function submitAppleAccountLogin2FA(
  env: Env,
  user: SessionUser,
  accountId: string,
  request: Request,
): Promise<Response> {
  try {
    const body = await request.json<Record<string, unknown>>()
    const challengeId = safeString(body.challengeId, 128)
    const code = safeString(body.code, 6)
    if (!challengeId || !/^\d{6}$/.test(code)) throw new ICloudStoreError(400, '请输入 6 位验证码。')
    const row = await env.DB.prepare(
      `SELECT state_cipher, expires_at, attempts FROM icloud_auth_challenges
       WHERE id = ? AND user_id = ? AND account_id = ? LIMIT 1`,
    ).bind(challengeId, user.id, accountId).first<{ state_cipher: string; expires_at: number; attempts: number }>()
    const now = Math.floor(Date.now() / 1000)
    if (!row || row.expires_at <= now) throw new ICloudStoreError(400, '登录挑战已过期，请重新开始。')
    if (row.attempts >= CHALLENGE_MAX_ATTEMPTS) throw new ICloudStoreError(429, '验证码尝试次数过多，请重新开始登录。')
    const session = JSON.parse(await decryptICloudSecret(env, row.state_cipher, `${user.id}:${accountId}:apple-auth:${challengeId}`)) as PendingAuthState
    await env.DB.prepare('UPDATE icloud_auth_challenges SET attempts = attempts + 1 WHERE id = ?').bind(challengeId).run()
    const bodyPayload = session.twoFactorMethod === 'phone'
      ? { phoneNumber: { id: 1 }, securityCode: { code }, mode: 'sms' }
      : { securityCode: { code } }
    const path = session.twoFactorMethod === 'phone' ? '/verify/phone/securitycode' : '/verify/trusteddevice/securitycode'
    await appleRequest(session, 'POST', path, bodyPayload)
    await appleRequest(session, 'GET', '/2sv/trust')
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(accountId)
    const client = new AppleAccountClient(stateFromPending(session))
    await client.refresh()
    account.appleAccountState = client.state
    account.appleAccountStatus = 'active'; account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
    await store.saveAppleAccountState(account)
    await env.DB.prepare('DELETE FROM icloud_auth_challenges WHERE id = ?').bind(challengeId).run()
    return Response.json({ needs2FA: false, account: publicICloudAccount(account) })
  } catch (error) {
    if (error instanceof ICloudStoreError || error instanceof ICloudRemoteError) return Response.json({ error: error.message }, { status: error.status })
    console.error('Apple Account 2FA failed', error)
    return Response.json({ error: 'Apple Account 验证失败。' }, { status: 422 })
  }
}
