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
import { refreshICloudAliasSummary } from './icloud-alias-summary'
import {
  APPLE_ACCOUNT_REQUEST_TIMEOUT_MS,
  AppleAccountClient,
  type AppleAccountAlias,
} from './icloud-account-client'
import {
  ICloudAccountStore,
  ICloudStoreError,
  iCloudAliasChannels,
  iCloudAliasCounts,
  parseICloudCookies,
  publicICloudAccount,
} from './icloud-store'
import type { AppleAccountState, ICloudAccount } from './icloud-types'
import type { Env, SessionUser } from '../../app/types'

const appleAccountSessionHolds = new Map<string, { since: number }>()
const APPLE_SESSION_GATE_POLL_MS = 25
/**
 * Past this a hold counts as abandoned. It has to outlast any live holder: a
 * create on a stale session makes up to five sequential Apple calls of up to
 * APPLE_ACCOUNT_REQUEST_TIMEOUT_MS each, and breaking into a live hold replays
 * the scnt it is about to rotate. A holder kept alive with `keepAlive` releases
 * on its own after a disconnect; this bound covers callers without one and
 * holders Workers cancels once the waitUntil allowance runs out.
 */
export const APPLE_SESSION_GATE_MAX_HOLD_MS = 6 * APPLE_ACCOUNT_REQUEST_TIMEOUT_MS

/** Registers work that must outlive the request (ExecutionContext.waitUntil). */
export type KeepAlive = (task: Promise<unknown>) => void

/**
 * Serializes Apple Account calls for one account: creates, listings and manual
 * refreshes. Apple rotates `scnt` and the session id on every successful
 * response, so two overlapping calls on one session replay each other's stale
 * values. Callers adopt the stored session inside the gate (currentAppleSession)
 * and persist what they rotated before leaving it, so whoever waits behind them
 * starts from the fresh scnt.
 *
 * Workers drops a request mid-await when its client disconnects, which the web
 * client does routinely (switching accounts aborts the listing, and every call
 * has a 15 s timeout). A dropped holder would lose the scnt Apple just rotated
 * and leave its hold for the next request to wait out, so once the hold is
 * taken the operation runs under `keepAlive`. Waiting is not kept alive: a
 * request nobody is waiting for any more should not start Apple calls.
 *
 * Waiters poll instead of awaiting the holder's promise: a promise settled from
 * another request's context is not something a Workers request can safely
 * wait on. The map is per isolate; across isolates, and once a hold is
 * abandoned, advanceAppleAccountState keeps an overlapping write from undoing
 * a newer one. Rate limiting lives in icloud-alias-quota.ts; this gate only
 * enforces single flight.
 */
export async function withAppleAccountSessionGate<T>(
  accountId: string,
  operation: () => Promise<T>,
  keepAlive?: KeepAlive,
): Promise<T> {
  for (;;) {
    const held = appleAccountSessionHolds.get(accountId)
    if (!held || Date.now() - held.since > APPLE_SESSION_GATE_MAX_HOLD_MS) break
    await new Promise((resolve) => setTimeout(resolve, APPLE_SESSION_GATE_POLL_MS))
  }
  const hold = { since: Date.now() }
  appleAccountSessionHolds.set(accountId, hold)
  const run = (async () => {
    try {
      return await operation()
    } finally {
      if (appleAccountSessionHolds.get(accountId) === hold) appleAccountSessionHolds.delete(accountId)
    }
  })()
  keepAlive?.(run.catch(() => undefined))
  return run
}

interface AppleSession {
  client: AppleAccountClient
  /** sessionValues(client.state) as adopted, to tell whether Apple has rotated anything since. */
  adopted: string
}

/** The state minus lastCheckedAt, a local timestamp rather than a value Apple handed out. */
function sessionValues(state: AppleAccountState): string {
  return JSON.stringify({ ...state, lastCheckedAt: '' })
}

/** Whether Apple handed out new session values since the session was adopted. */
function appleSessionRotated({ client, adopted }: AppleSession): boolean {
  return sessionValues(client.state) !== adopted
}

/**
 * Adopt the Apple session as it is stored right now. Called inside the gate, so
 * a request that queued behind another starts from the scnt that one rotated
 * instead of the copy it read on arrival.
 */
async function currentAppleSession(store: ICloudAccountStore, account: ICloudAccount): Promise<AppleSession> {
  const current = await store.get(account.id)
  if (!current.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
  account.appleAccountState = current.appleAccountState
  account.appleAccountStatus = current.appleAccountStatus
  account.appleAccountExpiresAt = current.appleAccountExpiresAt
  account.appleAccountError = current.appleAccountError
  account.appleAccountRead = current.appleAccountRead
  account.aliasTotal = current.aliasTotal
  account.aliasActive = current.aliasActive
  const client = new AppleAccountClient(current.appleAccountState)
  return { client, adopted: sessionValues(client.state) }
}

/**
 * Record what Apple rotated, unless the stored session moved on since it was
 * adopted. Only values from successful responses are on `client.state`, so a
 * refreshed scnt survives a later step failing.
 */
function persistAppleSession(
  store: ICloudAccountStore,
  account: ICloudAccount,
  session: AppleSession,
  patch: Partial<Pick<ICloudAccount, 'appleAccountStatus' | 'appleAccountError'>> = {},
): Promise<boolean> {
  account.appleAccountState = session.client.state
  account.appleAccountExpiresAt = session.client.state.expiresAt
  Object.assign(account, patch)
  return store.advanceAppleAccountState(account, appleSessionRotated(session))
}

/** An auth failure means Apple rejected the stored session outright. */
function expiredPatch(error: ICloudRemoteError): Partial<Pick<ICloudAccount, 'appleAccountStatus' | 'appleAccountError'>> {
  return error.code === APPLE_ACCOUNT_ERROR_CODES.auth
    ? { appleAccountStatus: 'expired', appleAccountError: error.message.slice(0, 300) }
    : {}
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

export async function refreshICloudAppleAccount(
  env: Env,
  user: SessionUser,
  id: string,
  keepAlive?: KeepAlive,
): Promise<Response> {
  try {
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(id)
    if (!account.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
    const saved = await withAppleAccountSessionGate(id, async () => {
      const session = await currentAppleSession(store, account)
      try {
        await session.client.refresh()
      } catch (error) {
        // The token call may already have rotated scnt before a later step
        // failed; keep that, and record a session Apple rejected outright.
        if (error instanceof ICloudRemoteError) {
          await persistAppleSession(store, account, session, expiredPatch(error)).catch(() => false)
        }
        throw error
      }
      return persistAppleSession(store, account, session, { appleAccountStatus: 'active', appleAccountError: '' })
    }, keepAlive)
    if (saved) return Response.json({ account: publicICloudAccount(account) })
    // Superseded by a newer write: report what is stored, not this request's
    // copy, and a session removed meanwhile is not something that refreshed.
    const current = await store.get(id)
    if (!current.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
    return Response.json({ account: publicICloudAccount(current) })
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

export async function createICloudAlias(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
  keepAlive?: KeepAlive,
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
    const usable = iCloudAliasChannels(account)
    const hasCookies = usable.icloudWeb
    // An explicit channel is honoured even when the session looks unusable, so
    // the caller gets Apple's own error rather than a silent reroute; the
    // inferred path follows the same availability the quota endpoint publishes.
    const useAppleAccount = requestedChannel === 'apple_account'
      || (!requestedChannel && !email && usable.appleAccount)
    // An explicitly requested channel never spills over; the inferred path still
    // may, so the client can plan the split up front instead of discovering it
    // through failed Apple round-trips.
    const mayFallBack = requestedChannel !== 'apple_account' && hasCookies
    if (useAppleAccount) {
      if (email || previewId) throw new ICloudStoreError(400, 'Apple Account 新接口创建不接受旧接口预览地址。')
      if (!account.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
      try {
        // Refresh, claim and create all run under the gate. The refresh rotates
        // scnt like any other Apple call, so it must not overlap another
        // request's; and claiming only after the previous create has settled
        // lets a window that create just saturated reject queued requests
        // locally instead of each one rediscovering Apple's limit. The refresh
        // still precedes the claim: a stale-session refresh never reaches
        // /email/private/add, so its failures must not spend an hourly slot.
        // Every outcome persists its session before the gate opens, so the
        // request queued next adopts the scnt this one rotated. The counters,
        // the audit row and the claim settlement are inside too: the gated
        // operation runs under keepAlive and still commits at Apple after the
        // client has gone, so its bookkeeping has to come along.
        const outcome = await withAppleAccountSessionGate(accountId, async (): Promise<
          { denied: number } | { expired: true } | { created: AppleAccountAlias; remaining: number }
        > => {
          const session = await currentAppleSession(store, account)
          // The inferred channel was chosen from the arrival read. A request
          // that queued behind one that just found the session dead leaves it
          // to the cookie jar instead of replaying it at Apple.
          if (requestedChannel !== 'apple_account' && account.appleAccountStatus === 'expired') return { expired: true }
          const { client } = session
          let claimed = false
          try {
            if (!client.isUsable()) await client.refresh()
            const claim = await claimICloudAliasCreate(env.DB, user.id, accountId, 'apple_account')
            if (!claim.allowed) {
              // The refresh already rotated the session upstream; dropping it
              // would leave a dead scnt in the store and the next call would
              // mark the account expired.
              if (appleSessionRotated(session)) {
                await persistAppleSession(store, account, session, { appleAccountStatus: 'active', appleAccountError: '' })
                  .catch(() => false)
              }
              return { denied: claim.retryAfter }
            }
            claimed = true
            const created = await client.createAlias(label)
            // Apple has committed the alias. Failing to record the rotated
            // session, the counters (they resync on the next listing) or the
            // audit row must not turn it into an error the caller would retry,
            // creating a second alias.
            await persistAppleSession(store, account, session, { appleAccountStatus: 'active', appleAccountError: '' })
              .catch(() => false)
            await store.addAliasSummary(accountId, created.active ? 1 : 0).catch(() => undefined)
            await writeAudit(env, user.id, 'icloud.alias.create', accountId, ip, auditDetail(account, {
              alias: created.email, label: created.label, channel: 'apple_account',
            })).catch((error) => console.error('iCloud alias audit failed after Apple created it', error))
            return { created, remaining: claim.remaining }
          } catch (error) {
            // Persist only values received from successful requests, which
            // keeps a rotated scnt usable whatever failed after it. A rotation
            // also means Apple accepted the session: an explicit
            // channel:'apple_account' bypasses the availability check, so this
            // runs for rows still marked expired, and leaving them that way
            // would hide a session Apple just accepted.
            const remote = error instanceof ICloudRemoteError ? error : undefined
            if (remote || appleSessionRotated(session)) {
              await persistAppleSession(store, account, session, {
                ...(appleSessionRotated(session) ? { appleAccountStatus: 'active', appleAccountError: '' } : {}),
                ...(remote ? { appleAccountError: remote.message.slice(0, 300), ...expiredPatch(remote) } : {}),
              }).catch(() => false)
            }
            // Settling an unclaimed slot would decrement someone else's
            // successful create, so only reconcile a reservation this call took.
            if (claimed) await settleAppleClaim(env, user.id, accountId, error)
            throw error
          }
        }, keepAlive)
        if ('expired' in outcome) {
          if (!mayFallBack) {
            throw new ICloudRemoteError(ICLOUD_CREDENTIAL_ERROR_STATUS, account.appleAccountError
              || 'Apple Account 管理态已失效，请重新导入登录态。', true, APPLE_ACCOUNT_ERROR_CODES.auth)
          }
        } else if ('denied' in outcome) {
          if (!mayFallBack) throw new ICloudAliasQuotaError('apple_account', outcome.denied)
        } else {
          const { created, remaining } = outcome
          return Response.json({
            alias: { email: created.email, label: created.label, createdAt: created.createdAt },
            channel: 'apple_account', remaining,
          }, { status: 201 })
        }
      } catch (error) {
        if (!mayFallBack || !appleAccountFailure(error)) throw error
      }
    }
    if (!hasCookies) throw new ICloudStoreError(400, '该账号尚未配置可创建隐藏邮箱的登录态。')
    const client = new ICloudClient(account.cookies, account.host, previewId || undefined)
    // A draft card arrives with email+previewId already set, so generateAlias()
    // below is skipped and reserveAlias() would be the first call to resolve the
    // service — inside the claim window. validate() throttles for reasons that
    // have nothing to do with the cap, and settleWebClaim can neither saturate
    // nor refund that, so the slot would simply burn. Pay the cost up front.
    await client.ensureService()
    // /v1/hme/generate only asks Apple for a candidate address; /v1/hme/reserve
    // is what spends the budget. Claiming between the two keeps credential and
    // entitlement failures from burning a slot they never reached.
    let reserveEmail = email
    if (!reserveEmail) {
      try {
        reserveEmail = await client.generateAlias()
      } catch (error) {
        // Apple may already phrase the hourly cap at generate time. No claim
        // exists yet to settle, so saturate the window directly; otherwise the
        // next dialog would still advertise the slots and rediscover the limit.
        if (error instanceof ICloudRemoteError && error.code === ICLOUD_WEB_ERROR_CODES.limit) {
          await exhaustICloudAliasChannel(env.DB, user.id, accountId, 'icloud_web').catch(() => undefined)
        }
        throw error
      }
    }
    const webClaim = await claimICloudAliasCreate(env.DB, user.id, accountId, 'icloud_web')
    if (!webClaim.allowed) throw new ICloudAliasQuotaError('icloud_web', webClaim.retryAfter)
    let alias: { email: string; label: string; createdAt: string }
    try {
      alias = await client.reserveAlias(reserveEmail, label)
    } catch (error) {
      await settleWebClaim(env, user.id, accountId, error)
      throw error
    }
    await refreshICloudAliasSummary(store, account, client)
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
    // Shared with createICloudAlias's inferred path so the client never plans
    // onto a channel the create handler would refuse.
    const account = await new ICloudAccountStore(env, user.id).get(accountId)
    const usable = iCloudAliasChannels(account)
    const available: Record<ICloudAliasChannel, boolean> = {
      apple_account: usable.appleAccount,
      icloud_web: usable.icloudWeb,
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

/**
 * List aliases through the Apple Account session, under the session gate: for
 * accounts without a cookie jar, and in place of a jar Apple has rejected.
 * Errors propagate for the caller's handler to answer. Standing in for a
 * rejected jar (`cookieError`), only a real list helps: any Apple failure, or a
 * region without the list, answers with the jar's error, since the jar is what
 * the user has to fix.
 */
export function listAppleAccountAliases(
  store: ICloudAccountStore,
  account: ICloudAccount,
  { cookieError, keepAlive }: { cookieError?: ICloudRemoteError; keepAlive?: KeepAlive } = {},
): Promise<Response> {
  const listing = withAppleAccountSessionGate(account.id, async () => {
    const session = await currentAppleSession(store, account)
    const { client } = session
    const known = iCloudAliasCounts(account)
    try {
      const aliases = await client.listAliases()
      account.aliasTotal = aliases.length
      account.aliasActive = aliases.filter((alias) => alias.active).length
      await Promise.all([
        persistAppleSession(store, account, session, { appleAccountStatus: 'active', appleAccountError: '' }),
        store.saveAliasSummary(account, known),
      ])
      // The list is real, but the jar still has to be re-imported; say so.
      return Response.json(cookieError ? { aliases, cookieError: cookieError.message } : { aliases })
    } catch (error) {
      if (!(error instanceof ICloudRemoteError)) throw error
      // A refresh before the listing, or a 200 whose body could not be read,
      // already rotated scnt upstream; dropping it leaves a dead one stored.
      if (appleSessionRotated(session) || error.code === APPLE_ACCOUNT_ERROR_CODES.auth) {
        await persistAppleSession(store, account, session, expiredPatch(error)).catch(() => false)
      }
      if (cookieError) throw cookieError
      // Apple Account management does not expose the legacy HME list in every
      // region, and creation stays usable without it. Only a missing endpoint
      // means that; a timeout or an outage still has to reach the user.
      if (error.code === APPLE_ACCOUNT_ERROR_CODES.unavailable) return Response.json({ aliases: [] })
      throw error
    }
  }, keepAlive)
  // Whatever else failed on the way (the session removed meanwhile, D1), the
  // jar is still what the user has to fix; log what was not an expected answer.
  return cookieError ? listing.catch((error) => {
    if (!(error instanceof ICloudRemoteError) && !(error instanceof ICloudStoreError)) {
      console.error('Apple Account listing failed in place of a rejected jar', error)
    }
    throw cookieError
  }) : listing
}
