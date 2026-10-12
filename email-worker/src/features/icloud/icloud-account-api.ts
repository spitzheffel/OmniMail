import { writeAudit } from '../../shared/audit/audit'
import {
  APPLE_ACCOUNT_ERROR_CODES,
  ICloudClient,
  ICLOUD_CREDENTIAL_ERROR_MESSAGE,
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
  ACTIVE_APPLE_SESSION,
  appleSessionRotated,
  assertAppleIdBindable,
  currentAppleSession,
  expiredPatch,
  missingAppleSession,
  persistAppleSession,
  promoteAppleOnly,
  withAppleAccountSessionGate,
  withAppleSessionRetry,
  type Defer,
} from './icloud-apple-session'
import { AppleAccountClient, type AppleAccountAlias } from './icloud-account-client'
import { iCloudErrorResponse, jsonBody, stringField } from './icloud-http'
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
  const appleId = stringField(source.appleId).toLowerCase()
  if (appleId.length > 254 || /[\u0000-\u001f\u007f]/.test(appleId)) {
    throw new ICloudStoreError(400, 'Apple ID 无效。')
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
    ...(appleId ? { appleId } : {}),
  }
}

function auditDetail(account: Pick<ICloudAccount, 'name'>, detail: Record<string, unknown> = {}) {
  return { accountName: account.name, ...detail }
}

function responseError(error: unknown): Response {
  return iCloudErrorResponse(error, 'Apple Account request failed')
}

export async function updateICloudAppleAccount(env: Env, user: SessionUser, id: string, request: Request, ip: string): Promise<Response> {
  try {
    const body = await jsonBody(request)
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(id)
    const state = appleAccountStateBody(body)
    if (state.appleId) await assertAppleIdBindable(store, account, state.appleId)
    const client = new AppleAccountClient(state)
    await client.refresh()
    Object.assign(account, {
      appleAccountState: client.state, appleAccountExpiresAt: client.state.expiresAt, ...ACTIVE_APPLE_SESSION,
    })
    await store.saveAppleAccountState(account)
    await promoteAppleOnly(store, account)
    await writeAudit(env, user.id, 'icloud.credentials.apple_account', id, ip, auditDetail(account, { appleAccountHost: client.state.host }))
    return Response.json({ account: publicICloudAccount(account) })
  } catch (error) { return responseError(error) }
}

export async function refreshICloudAppleAccount(
  env: Env,
  user: SessionUser,
  id: string,
  defer: Defer,
): Promise<Response> {
  try {
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(id)
    if (!account.appleAccountState) throw missingAppleSession()
    const saved = await withAppleAccountSessionGate(id, async () => {
      const ref = { session: await currentAppleSession(store, account) }
      try {
        await withAppleSessionRetry(store, account, ref, (client) => client.refresh())
      } catch (error) {
        // The token call may already have rotated scnt before a later step
        // failed; keep that, and record a session Apple rejected outright.
        if (error instanceof ICloudRemoteError) {
          await persistAppleSession(store, account, ref.session, expiredPatch(error)).catch(() => false)
        }
        throw error
      }
      const persisted = await persistAppleSession(store, account, ref.session, ACTIVE_APPLE_SESSION)
      if (persisted) await promoteAppleOnly(store, account)
      return persisted
    }, defer)
    if (saved) return Response.json({ account: publicICloudAccount(account) })
    // Superseded by a newer write: report what is stored, not this request's
    // copy, and a session removed meanwhile is not something that refreshed.
    const current = await store.get(id)
    if (!current.appleAccountState) throw missingAppleSession()
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
 * that the user has to sign in again.
 */
function appleAccountFailure(error: unknown): boolean {
  return error instanceof ICloudRemoteError && error.code === APPLE_ACCOUNT_ERROR_CODES.limit
}

/**
 * Settle the reservation taken before the Apple call, in the hour it was taken.
 * - upstream limit: the hour is genuinely spent, so saturate the window;
 * - auth/missing, or a throttled refresh: the request failed before the
 *   create POST (which is metered, so it is never `throttled`), so refund it;
 * - anything else: ambiguous (add may have succeeded, complete may have failed),
 *   so keep the reservation rather than risk over-creating.
 */
export async function settleAppleClaim(
  env: Env,
  userId: string,
  accountId: string,
  error: unknown,
  claimedHour: number,
): Promise<void> {
  const code = error instanceof ICloudRemoteError ? error.code : ''
  if (code === APPLE_ACCOUNT_ERROR_CODES.limit) {
    await exhaustICloudAliasChannel(env.DB, userId, accountId, 'apple_account').catch(() => undefined)
    return
  }
  if (code === APPLE_ACCOUNT_ERROR_CODES.auth || code === APPLE_ACCOUNT_ERROR_CODES.missing
    || code === APPLE_ACCOUNT_ERROR_CODES.throttled) {
    await releaseICloudAliasCreate(env.DB, userId, accountId, 'apple_account', claimedHour).catch(() => undefined)
  }
}

type AppleCreateOutcome =
  | { denied: number }
  | { expired: true }
  | { created: AppleAccountAlias; remaining: number }

/**
 * Refresh, claim and create, all run under the session gate. The refresh
 * rotates scnt like any other Apple call, so it must not overlap another
 * request's; and claiming only after the previous create has settled lets a
 * window that create just saturated reject queued requests locally instead of
 * each one rediscovering Apple's limit. The refresh still precedes the claim: a
 * stale-session refresh never reaches /email/private/add, so its failures must
 * not spend an hourly slot. Every outcome persists its session before the gate
 * opens, so the request queued next adopts the scnt this one rotated. The
 * counters, the audit row and the claim settlement are inside too: the gated
 * operation runs under `defer` and still commits at Apple after the client has
 * gone, so its bookkeeping has to come along.
 */
async function createThroughAppleAccount(
  env: Env,
  user: SessionUser,
  store: ICloudAccountStore,
  account: ICloudAccount,
  { label, ip }: { label: string; ip: string },
): Promise<AppleCreateOutcome> {
  const ref = { session: await currentAppleSession(store, account) }
  // An expired session waits for the user to sign in again: replaying it at
  // Apple once per remaining item of a batch only collects more refusals. An
  // inferred channel leaves the item to the cookie jar; an explicit one says so.
  if (account.appleAccountStatus === 'expired') return { expired: true }
  let claimedHour: number | undefined
  try {
    if (!ref.session.client.isUsable()) await withAppleSessionRetry(store, account, ref, (client) => client.refresh())
    const claim = await claimICloudAliasCreate(env.DB, user.id, account.id, 'apple_account')
    if (!claim.allowed) {
      // The refresh already rotated the session upstream; dropping it would
      // leave a dead scnt in the store and the next call would mark it expired.
      if (appleSessionRotated(ref.session)) {
        await persistAppleSession(store, account, ref.session, ACTIVE_APPLE_SESSION).catch(() => false)
      }
      return { denied: claim.retryAfter }
    }
    claimedHour = claim.hourStartedAt
    const created = await withAppleSessionRetry(store, account, ref, (client) => client.createAlias(label))
    // Apple has committed the alias. Failing to record the rotated session,
    // the counters (they resync on the next listing) or the audit row must not
    // turn it into an error the caller would retry, creating a second alias.
    await Promise.all([
      persistAppleSession(store, account, ref.session, ACTIVE_APPLE_SESSION).catch(() => false),
      store.addAliasSummary(account.id, created.active ? 1 : 0).catch(() => undefined),
      promoteAppleOnly(store, account).catch(() => undefined),
      writeAudit(env, user.id, 'icloud.alias.create', account.id, ip, auditDetail(account, {
        alias: created.email, label: created.label, channel: 'apple_account',
      })).catch((error) => console.error('iCloud alias audit failed after Apple created it', error)),
    ])
    return { created, remaining: claim.remaining }
  } catch (error) {
    // Persist only values received from successful requests, which keeps a
    // rotated scnt usable whatever failed after it. A rotation also means Apple
    // accepted the session.
    const remote = error instanceof ICloudRemoteError ? error : undefined
    if (remote || appleSessionRotated(ref.session)) {
      await persistAppleSession(store, account, ref.session, {
        ...(appleSessionRotated(ref.session) ? ACTIVE_APPLE_SESSION : {}),
        ...(remote ? { appleAccountError: remote.message.slice(0, 300), ...expiredPatch(remote) } : {}),
      }).catch(() => false)
    }
    // Settling an unclaimed slot would decrement someone else's successful
    // create, so only reconcile a reservation this call took.
    if (claimedHour !== undefined) await settleAppleClaim(env, user.id, account.id, error, claimedHour)
    throw error
  }
}

export async function createICloudAlias(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
  defer: Defer,
): Promise<Response> {
  try {
    const body = await jsonBody(request)
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
    // An explicit channel is honoured even when the session looks unusable, so
    // the caller gets the session's own error rather than a silent reroute; the
    // inferred path follows the same availability the quota endpoint publishes.
    const useAppleAccount = requestedChannel === 'apple_account'
      || (!requestedChannel && !email && usable.appleAccount)
    // An explicitly requested channel never spills over; the inferred path still
    // may, so the client can plan the split up front instead of discovering it
    // through failed Apple round-trips.
    const mayFallBack = requestedChannel !== 'apple_account' && usable.icloudWeb
    if (useAppleAccount) {
      if (email || previewId) throw new ICloudStoreError(400, 'Apple Account 新接口创建不接受旧接口预览地址。')
      if (!account.appleAccountState) throw missingAppleSession()
      try {
        const outcome = await withAppleAccountSessionGate(
          accountId, () => createThroughAppleAccount(env, user, store, account, { label, ip }), defer,
        )
        if ('expired' in outcome) {
          if (!mayFallBack) {
            throw new ICloudRemoteError(ICLOUD_CREDENTIAL_ERROR_STATUS, account.appleAccountError
              || 'Apple Account 管理态已失效，请重新登录。', true, APPLE_ACCOUNT_ERROR_CODES.auth)
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
    if (!usable.icloudWeb) {
      // A jar Apple already rejected would only be rejected again, and an
      // expired session only after the user signs in again; say which.
      if (Object.keys(account.cookies).length) {
        throw new ICloudRemoteError(ICLOUD_CREDENTIAL_ERROR_STATUS, ICLOUD_CREDENTIAL_ERROR_MESSAGE, true)
      }
      if (account.appleAccountState) {
        throw new ICloudRemoteError(ICLOUD_CREDENTIAL_ERROR_STATUS, account.appleAccountError
          || 'Apple Account 管理态已失效，请重新登录。', true, APPLE_ACCOUNT_ERROR_CODES.auth)
      }
      throw new ICloudStoreError(400, '该账号尚未配置可创建隐藏邮箱的登录态。')
    }
    return await createThroughCookies(env, user, store, account, { label, email, previewId, ip })
  } catch (error) {
    return responseError(error)
  }
}

async function createThroughCookies(
  env: Env,
  user: SessionUser,
  store: ICloudAccountStore,
  account: ICloudAccount,
  { label, email, previewId, ip }: { label: string; email: string; previewId: string; ip: string },
): Promise<Response> {
  const client = new ICloudClient(account.cookies, account.host, previewId || undefined)
  try {
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
          await exhaustICloudAliasChannel(env.DB, user.id, account.id, 'icloud_web').catch(() => undefined)
        }
        throw error
      }
    }
    const webClaim = await claimICloudAliasCreate(env.DB, user.id, account.id, 'icloud_web')
    if (!webClaim.allowed) throw new ICloudAliasQuotaError('icloud_web', webClaim.retryAfter)
    let alias: { email: string; label: string; createdAt: string }
    try {
      alias = await client.reserveAlias(reserveEmail, label)
    } catch (error) {
      await settleWebClaim(env, user.id, account.id, error, webClaim.hourStartedAt)
      throw error
    }
    // Apple has committed the alias; as on the Apple channel, failing to record
    // it must not turn into an error the caller would retry.
    await Promise.all([
      refreshICloudAliasSummary(store, account, client)
        .catch((error) => console.error('iCloud alias summary failed after Apple created it', error)),
      writeAudit(env, user.id, 'icloud.alias.create', account.id, ip, auditDetail(account, {
        alias: alias.email, label: alias.label, channel: 'icloud_web',
      })).catch((error) => console.error('iCloud alias audit failed after Apple created it', error)),
    ])
    return Response.json({ alias, channel: 'icloud_web', remaining: webClaim.remaining }, { status: 201 })
  } catch (error) {
    // Same rule as the listing: a jar Apple rejected is recorded, so the
    // channel stops being offered until a listing finds it working again.
    if (error instanceof ICloudRemoteError && error.status === ICLOUD_CREDENTIAL_ERROR_STATUS) {
      account.cookies = client.cookies
      account.status = 'error'
      account.lastError = error.message.slice(0, 300)
      await store.saveCookies(account).catch(() => false)
    }
    throw error
  }
}

/**
 * Settle a reservation after /v1/hme/reserve failed, in the hour it was taken.
 * Same policy as settleAppleClaim — refund only what provably never committed
 * — but a different discriminator, because AppleAccountClient.request hardcodes
 * `definitive: true` while ICloudClient.request derives it from the status.
 * Do not "unify" the two by swapping mechanisms.
 * - upstream cap: saturate the window;
 * - definitive, or the 422 raised when the cookie lost its Hide My Email
 *   entitlement: Apple refused outright, nothing was reserved, refund;
 * - anything else (timeout, transport failure, 5xx, unparsable body):
 *   ambiguous, the reserve may have committed upstream, so keep the slot.
 */
export async function settleWebClaim(
  env: Env,
  userId: string,
  accountId: string,
  error: unknown,
  claimedHour: number,
): Promise<void> {
  const remote = error instanceof ICloudRemoteError ? error : undefined
  if (!remote) return
  if (remote.code === ICLOUD_WEB_ERROR_CODES.limit) {
    await exhaustICloudAliasChannel(env.DB, userId, accountId, 'icloud_web').catch(() => undefined)
    return
  }
  if (remote.definitive || remote.status === ICLOUD_CREDENTIAL_ERROR_STATUS) {
    await releaseICloudAliasCreate(env.DB, userId, accountId, 'icloud_web', claimedHour).catch(() => undefined)
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
  { cookieError, defer }: { cookieError?: ICloudRemoteError; defer: Defer },
): Promise<Response> {
  const listing = withAppleAccountSessionGate(account.id, async () => {
    const ref = { session: await currentAppleSession(store, account) }
    const known = iCloudAliasCounts(account)
    let aliases: AppleAccountAlias[]
    try {
      aliases = await withAppleSessionRetry(store, account, ref, (client) => client.listAliases())
    } catch (error) {
      if (!(error instanceof ICloudRemoteError)) throw error
      // A refresh before the listing, or a 200 whose body could not be read,
      // already rotated scnt upstream; dropping it leaves a dead one stored.
      if (appleSessionRotated(ref.session) || error.code === APPLE_ACCOUNT_ERROR_CODES.auth) {
        await persistAppleSession(store, account, ref.session, expiredPatch(error)).catch(() => false)
      }
      if (cookieError) throw cookieError
      // Apple Account management does not expose the legacy HME list in every
      // region, and creation stays usable without it. Only a missing endpoint
      // means that; a timeout or an outage still has to reach the user.
      if (error.code === APPLE_ACCOUNT_ERROR_CODES.unavailable) return Response.json({ aliases: [] })
      throw error
    }
    account.aliasTotal = aliases.length
    account.aliasActive = aliases.filter((alias) => alias.active).length
    // Apple answered; failing to record that must not cost the caller the list.
    await Promise.all([
      persistAppleSession(store, account, ref.session, ACTIVE_APPLE_SESSION),
      store.saveAliasSummary(account, known),
      promoteAppleOnly(store, account),
    ]).catch((error) => console.error('Apple Account listing could not be recorded', error))
    // The list is real, but the jar still has to be replaced; say so.
    return Response.json(cookieError ? { aliases, cookieError: cookieError.message } : { aliases })
  }, defer)
  // Whatever else failed on the way (the session removed meanwhile), the jar is
  // still what the user has to fix; log what was not an expected answer.
  return cookieError ? listing.catch((error) => {
    if (!(error instanceof ICloudRemoteError) && !(error instanceof ICloudStoreError)) {
      console.error('Apple Account listing failed in place of a rejected jar', error)
    }
    throw cookieError
  }) : listing
}
