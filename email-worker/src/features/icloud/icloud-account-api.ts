import { writeAudit } from '../../shared/audit/audit'
import {
  APPLE_ACCOUNT_ERROR_CODES,
  ICloudClient,
  ICLOUD_CREDENTIAL_ERROR_STATUS,
  ICLOUD_WEB_ERROR_CODES,
  ICloudRemoteError,
} from './icloud-apple'
import {
  ICloudAliasQuotaError,
  claimICloudAliasCreate,
  exhaustICloudAliasChannel,
  readICloudAliasQuota,
  releaseICloudAliasCreate,
  type ICloudAliasChannel,
} from './icloud-alias-quota'
import { AppleAccountClient } from './icloud-account-client'
import {
  ICloudAccountStore,
  ICloudStoreError,
  parseICloudCookies,
  publicICloudAccount,
} from './icloud-store'
import type { AppleAccountState, ICloudAccount } from './icloud-types'
import type { Env, SessionUser } from '../../app/types'

const appleAccountCreateGates = new Map<string, Promise<void>>()

/**
 * Serializes creates for one account. Apple rotates `scnt` and the session id on
 * every successful response, so two concurrent multi-step creates on the same
 * session corrupt each other. Rate limiting lives in icloud-alias-quota.ts; this
 * gate only enforces single flight.
 */
export async function withAppleAccountCreateGate<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  const previous = appleAccountCreateGates.get(accountId) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.catch(() => undefined).then(() => current)
  appleAccountCreateGates.set(accountId, queued)
  await previous.catch(() => undefined)
  try {
    return await operation()
  } finally {
    release()
    if (appleAccountCreateGates.get(accountId) === queued) appleAccountCreateGates.delete(accountId)
  }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedSecret(value: unknown, field: string, maximum = 4096): string {
  const result = stringField(value)
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ICloudStoreError(400, `${field} 无效。`)
  }
  return result
}

export function appleAccountStateBody(body: Record<string, unknown>): AppleAccountState {
  const source = body.state && typeof body.state === 'object' && !Array.isArray(body.state)
    ? body.state as Record<string, unknown> : body
  const cookies = parseICloudCookies(source.cookies)
  const scnt = boundedSecret(source.scnt, 'Apple Account scnt')
  const apiKey = boundedSecret(source.apiKey, 'Apple Account apiKey')
  const sessionId = stringField(source.sessionId)
  if (sessionId.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new ICloudStoreError(400, 'Apple Account sessionId 无效。')
  }
  const host = stringField(source.host) || 'appleid.apple.com'
  const origin = stringField(source.origin) || 'https://account.apple.com'
  const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const cleanOrigin = origin.replace(/\/$/, '')
  if (!/^(?:appleid|account)\.apple\.com(?:\.cn)?$/i.test(cleanHost)
    || !/^https:\/\/(?:account|appleid)\.apple\.com(?:\.cn)?$/i.test(cleanOrigin)) {
    throw new ICloudStoreError(400, 'Apple Account 服务地址无效。')
  }
  return {
    cookies, scnt, apiKey, sessionId,
    expiresAt: stringField(source.expiresAt),
    lastCheckedAt: stringField(source.lastCheckedAt),
    userAgent: stringField(source.userAgent), host: cleanHost, origin: cleanOrigin,
  }
}

function jsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json<unknown>().then((body) => {
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new ICloudStoreError(400, '请求体必须是 JSON 对象。')
    return body as Record<string, unknown>
  }).catch((error) => {
    if (error instanceof ICloudStoreError) throw error
    throw new ICloudStoreError(400, '请求体必须是 JSON 对象。')
  })
}

function auditDetail(account: Pick<ICloudAccount, 'name'>, detail: Record<string, unknown> = {}) {
  return { accountName: account.name, ...detail }
}

function responseError(error: unknown): Response {
  if (error instanceof ICloudAliasQuotaError) {
    return Response.json(
      { error: error.message, code: error.code, channel: error.channel, retryAfter: error.retryAfter },
      { status: error.status, headers: { 'Retry-After': String(error.retryAfter) } },
    )
  }
  if (error instanceof ICloudRemoteError) {
    // `detail` stays out of `error` so the client can still translate it.
    return Response.json(
      error.detail ? { error: error.message, detail: error.detail } : { error: error.message },
      { status: error.status },
    )
  }
  if (error instanceof ICloudStoreError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error('Apple Account request failed', error)
  return Response.json({ error: 'Apple Account 暂时无法处理这个请求。' }, { status: 502 })
}

export async function updateICloudAppleAccount(env: Env, user: SessionUser, id: string, request: Request, ip: string): Promise<Response> {
  try {
    const body = await jsonBody(request)
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(id)
    const client = new AppleAccountClient(appleAccountStateBody(body))
    await client.refresh()
    account.appleAccountState = client.state; account.appleAccountStatus = 'active'
    account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
    await store.saveAppleAccountState(account)
    await writeAudit(env, user.id, 'icloud.credentials.apple_account', id, ip, auditDetail(account, { appleAccountHost: client.state.host }))
    return Response.json({ account: publicICloudAccount(account) })
  } catch (error) { return responseError(error) }
}

export async function refreshICloudAppleAccount(env: Env, user: SessionUser, id: string): Promise<Response> {
  try {
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(id)
    if (!account.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
    const client = new AppleAccountClient(account.appleAccountState)
    await client.refresh()
    account.appleAccountState = client.state; account.appleAccountStatus = 'active'
    account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
    await store.saveAppleAccountState(account)
    return Response.json({ account: publicICloudAccount(account) })
  } catch (error) { return responseError(error) }
}

export async function deleteICloudAppleAccount(env: Env, user: SessionUser, id: string, ip: string): Promise<Response> {
  try {
    const store = new ICloudAccountStore(env, user.id)
    const account = { name: await store.getName(id) }
    await store.clearAppleAccountState(id)
    await writeAudit(env, user.id, 'icloud.credentials.apple_account.delete', id, ip, auditDetail(account))
    return Response.json({ ok: true })
  } catch (error) { return responseError(error) }
}

/**
 * Whether an inferred-channel request may spill over to the legacy cookie
 * channel. Only an upstream limit qualifies: an expired or missing Apple session
 * must surface, because silently burning the scarce cookie budget hides the fact
 * that the user has to re-import their login state.
 */
function appleAccountFailure(error: unknown): boolean {
  return error instanceof ICloudRemoteError && error.code === APPLE_ACCOUNT_ERROR_CODES.limit
}

/**
 * Settle the reservation taken before the Apple call.
 * - upstream limit: the hour is genuinely spent, so saturate the window;
 * - auth/missing: the request failed before the create POST, so refund it;
 * - anything else: ambiguous (add may have succeeded, complete may have failed),
 *   so keep the reservation rather than risk over-creating.
 */
export async function settleAppleClaim(env: Env, userId: string, accountId: string, error: unknown): Promise<void> {
  const code = error instanceof ICloudRemoteError ? error.code : ''
  if (code === APPLE_ACCOUNT_ERROR_CODES.limit) {
    await exhaustICloudAliasChannel(env.DB, userId, accountId, 'apple_account').catch(() => undefined)
    return
  }
  if (code === APPLE_ACCOUNT_ERROR_CODES.auth || code === APPLE_ACCOUNT_ERROR_CODES.missing) {
    await releaseICloudAliasCreate(env.DB, userId, accountId, 'apple_account').catch(() => undefined)
  }
}

async function refreshAliasSummaryForCreate(
  store: ICloudAccountStore,
  account: ICloudAccount,
  client: ICloudClient,
): Promise<void> {
  account.cookies = client.cookies
  account.status = 'active'
  account.lastError = ''
  try {
    const aliases = await client.listAliases()
    account.aliasTotal = aliases.length
    account.aliasActive = aliases.filter((alias) => alias.active).length
    account.lastValidated = new Date().toISOString()
  } catch (error) {
    account.lastError = '隐藏邮箱操作已完成，但账号状态同步失败。'
    if (error instanceof ICloudRemoteError && error.status === ICLOUD_CREDENTIAL_ERROR_STATUS) account.status = 'error'
  }
  await store.saveCookies(account)
}

export async function createICloudAlias(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  try {
    const body = await request.json<Record<string, unknown>>()
    const accountId = stringField(body.accountId)
    const label = stringField(body.label)
    const email = stringField(body.email).toLowerCase()
    const previewId = stringField(body.previewId).toLowerCase()
    const requestedChannel = body.channel === 'apple_account' || body.channel === 'icloud_web' ? body.channel : ''
    if (!accountId || label.length > 80 || Boolean(email) !== Boolean(previewId)
      || (email && !/^[^@\s]{1,64}@icloud\.com$/.test(email))
      || (previewId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(previewId))) {
      throw new ICloudStoreError(400, '隐藏邮箱参数无效。')
    }
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(accountId)
    const hasCookies = Object.keys(account.cookies).length > 0
    const useAppleAccount = requestedChannel === 'apple_account'
      || (!requestedChannel && !email && Boolean(account.appleAccountState))
    // An explicitly requested channel never spills over; the inferred path still
    // may, so the client can plan the split up front instead of discovering it
    // through failed Apple round-trips.
    const mayFallBack = requestedChannel !== 'apple_account' && hasCookies
    if (useAppleAccount) {
      if (email || previewId) throw new ICloudStoreError(400, 'Apple Account 新接口创建不接受旧接口预览地址。')
      if (!account.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
      const client = new AppleAccountClient(account.appleAccountState)
      let claimed = false
      try {
        // Refresh before claiming. A stale-session refresh never reaches
        // /email/private/add, so its failures must not spend an hourly slot.
        if (!client.isUsable()) await client.refresh()
        const claim = await claimICloudAliasCreate(env.DB, user.id, accountId, 'apple_account')
        if (!claim.allowed) {
          if (!mayFallBack) throw new ICloudAliasQuotaError('apple_account', claim.retryAfter)
        } else {
          claimed = true
          const created = await withAppleAccountCreateGate(accountId, () => client.createAlias(label))
          account.appleAccountState = client.state; account.appleAccountStatus = 'active'
          account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
          account.aliasTotal += 1; account.aliasActive += created.active ? 1 : 0
          await store.saveAppleAccountState(account)
          await writeAudit(env, user.id, 'icloud.alias.create', accountId, ip, auditDetail(account, {
            alias: created.email, label: created.label, channel: 'apple_account',
          }))
          return Response.json({
            alias: { email: created.email, label: created.label, createdAt: created.createdAt },
            channel: 'apple_account', remaining: claim.remaining,
          }, { status: 201 })
        }
      } catch (error) {
        // Settling an unclaimed slot would decrement someone else's successful
        // create, so only reconcile when a reservation was actually taken.
        if (claimed) await settleAppleClaim(env, user.id, accountId, error)
        if (error instanceof ICloudRemoteError && !(error instanceof ICloudAliasQuotaError)) {
          // Persist only values received from successful requests. This keeps
          // a refreshed scnt/Cookie usable even when the subsequent create
          // step is rate-limited or fails validation.
          account.appleAccountState = client.state
          account.appleAccountExpiresAt = client.state.expiresAt
          if (error.code === APPLE_ACCOUNT_ERROR_CODES.auth) account.appleAccountStatus = 'expired'
          account.appleAccountError = error.message.slice(0, 300)
          await store.saveAppleAccountState(account).catch(() => undefined)
        }
        if (!mayFallBack || !appleAccountFailure(error)) throw error
      }
    }
    if (!hasCookies) throw new ICloudStoreError(400, '该账号尚未配置可创建隐藏邮箱的登录态。')
    const client = new ICloudClient(account.cookies, account.host, previewId || undefined)
    // /v1/hme/generate only asks Apple for a candidate address; /v1/hme/reserve
    // is what spends the budget. Claiming between the two keeps credential and
    // entitlement failures from burning a slot they never reached.
    const reserveEmail = email || await client.generateAlias()
    const webClaim = await claimICloudAliasCreate(env.DB, user.id, accountId, 'icloud_web')
    if (!webClaim.allowed) throw new ICloudAliasQuotaError('icloud_web', webClaim.retryAfter)
    let alias: { email: string; label: string; createdAt: string }
    try {
      alias = await client.reserveAlias(reserveEmail, label)
    } catch (error) {
      await settleWebClaim(env, user.id, accountId, error)
      throw error
    }
    await refreshAliasSummaryForCreate(store, account, client)
    await writeAudit(env, user.id, 'icloud.alias.create', accountId, ip, auditDetail(account, {
      alias: alias.email, label: alias.label, channel: 'icloud_web',
    }))
    return Response.json({ alias, channel: 'icloud_web', remaining: webClaim.remaining }, { status: 201 })
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: '请求体必须是 JSON 对象。' }, { status: 400 })
    return responseError(error)
  }
}

/**
 * Settle a reservation after /v1/hme/reserve failed. Same policy as
 * settleAppleClaim — refund only what provably never committed — but a
 * different discriminator, because AppleAccountClient.request hardcodes
 * `definitive: true` while ICloudClient.request derives it from the status.
 * Do not "unify" the two by swapping mechanisms.
 * - upstream cap: saturate the window;
 * - definitive, or the 422 raised when the cookie lost its Hide My Email
 *   entitlement: Apple refused outright, nothing was reserved, refund;
 * - anything else (timeout, transport failure, 5xx, unparsable body):
 *   ambiguous, the reserve may have committed upstream, so keep the slot.
 */
export async function settleWebClaim(env: Env, userId: string, accountId: string, error: unknown): Promise<void> {
  const remote = error instanceof ICloudRemoteError ? error : undefined
  if (!remote) return
  if (remote.code === ICLOUD_WEB_ERROR_CODES.limit) {
    await exhaustICloudAliasChannel(env.DB, userId, accountId, 'icloud_web').catch(() => undefined)
    return
  }
  if (remote.definitive || remote.status === ICLOUD_CREDENTIAL_ERROR_STATUS) {
    await releaseICloudAliasCreate(env.DB, userId, accountId, 'icloud_web').catch(() => undefined)
  }
}

export async function getICloudAliasQuota(
  env: Env,
  user: SessionUser,
  request: Request,
): Promise<Response> {
  try {
    const accountId = new URL(request.url).searchParams.get('accountId') || ''
    if (!accountId) throw new ICloudStoreError(400, '缺少 accountId。')
    // Channel availability is derived in SQL: this endpoint has no business
    // decrypting cookies, the app password and the Apple session just to read
    // two booleans.
    const flags = await new ICloudAccountStore(env, user.id).credentialFlags(accountId)
    const available: Record<ICloudAliasChannel, boolean> = {
      apple_account: flags.hasAppleAccount,
      icloud_web: flags.hasCookies,
    }
    const quotas = await readICloudAliasQuota(env.DB, user.id, accountId)
    const channels = quotas.map((quota) => ({
      channel: quota.channel,
      available: available[quota.channel],
      limit: quota.limit,
      used: quota.used,
      remaining: available[quota.channel] ? quota.remaining : 0,
      resetsAt: new Date(quota.resetsAt * 1000).toISOString(),
    }))
    return Response.json({ channels }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return responseError(error) }
}
