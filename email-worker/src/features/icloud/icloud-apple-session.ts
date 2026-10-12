import { APPLE_ACCOUNT_ERROR_CODES, ICloudRemoteError } from './icloud-apple'
import { APPLE_ACCOUNT_REQUEST_TIMEOUT_MS, AppleAccountClient } from './icloud-account-client'
import { ICloudStoreError, type ICloudAccountStore } from './icloud-store'
import type { AppleAccountState, ICloudAccount } from './icloud-types'

/** Registers work that must outlive the request (ExecutionContext.waitUntil). */
export type Defer = (task: Promise<unknown>) => void

/**
 * Let `work` finish after the client goes away. Apple calls change state at
 * Apple (a rotated scnt, a pushed code, a created alias) that has to be
 * recorded whether or not anyone is still waiting for the answer.
 */
export function outlive<T>(defer: Defer, work: Promise<T>): Promise<T> {
  defer(work.catch(() => undefined))
  return work
}

type AppleSessionPatch = Partial<Pick<ICloudAccount, 'appleAccountStatus' | 'appleAccountError'>>

/** What a request writes once Apple has accepted the session. */
export const ACTIVE_APPLE_SESSION: AppleSessionPatch = { appleAccountStatus: 'active', appleAccountError: '' }

export function missingAppleSession(): ICloudStoreError {
  return new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
}

const appleAccountSessionHolds = new Map<string, { since: number }>()
// Waiters start brisk and back off: the hold ahead of them can run for minutes.
const APPLE_SESSION_GATE_POLL_MS = 25
const APPLE_SESSION_GATE_MAX_POLL_MS = 500
/**
 * Past this a hold counts as abandoned. It has to outlast any live holder: a
 * create on a stale session makes up to five sequential Apple calls of up to
 * APPLE_ACCOUNT_REQUEST_TIMEOUT_MS each, and breaking into a live hold replays
 * the scnt it is about to rotate. A holder registered with `defer` releases on
 * its own after a disconnect; this bound covers holders Workers cancels once
 * the waitUntil allowance runs out.
 */
export const APPLE_SESSION_GATE_MAX_HOLD_MS = 6 * APPLE_ACCOUNT_REQUEST_TIMEOUT_MS

/**
 * Serializes Apple Account calls for one account: creates, listings and manual
 * refreshes. Apple rotates `scnt` and the session id on every successful
 * response, so two overlapping calls on one session replay each other's stale
 * values. Callers adopt the stored session inside the gate (currentAppleSession)
 * and persist what they rotated before leaving it, so whoever waits behind them
 * starts from the fresh scnt.
 *
 * Workers drops a request mid-await when its client disconnects, which the web
 * client does routinely (switching accounts aborts the listing). A dropped
 * holder would lose the scnt Apple just rotated and leave its hold for the next
 * request to wait out, so once the hold is taken the operation runs under
 * `defer`. Waiting is not deferred: a request nobody is waiting for any more
 * should not start Apple calls.
 *
 * Waiters poll instead of awaiting the holder's promise: a promise settled from
 * another request's context is not something a Workers request can safely
 * wait on. The map is per isolate; across isolates, and once a hold is
 * abandoned, advanceAppleAccountState keeps an overlapping write from undoing
 * a newer one, and withAppleSessionRetry lets the loser of such an overlap
 * retry on the winner's session. Rate limiting lives in icloud-alias-quota.ts;
 * this gate only enforces single flight.
 */
export async function withAppleAccountSessionGate<T>(
  accountId: string,
  operation: () => Promise<T>,
  defer: Defer,
): Promise<T> {
  let pollMs = APPLE_SESSION_GATE_POLL_MS
  for (;;) {
    const held = appleAccountSessionHolds.get(accountId)
    if (!held || Date.now() - held.since > APPLE_SESSION_GATE_MAX_HOLD_MS) break
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    pollMs = Math.min(APPLE_SESSION_GATE_MAX_POLL_MS, pollMs * 2)
  }
  const hold = { since: Date.now() }
  appleAccountSessionHolds.set(accountId, hold)
  return outlive(defer, (async () => {
    try {
      return await operation()
    } finally {
      if (appleAccountSessionHolds.get(accountId) === hold) appleAccountSessionHolds.delete(accountId)
    }
  })())
}

export interface AppleSession {
  client: AppleAccountClient
  /** sessionValues(client.state) as adopted, to tell whether Apple has rotated anything since. */
  adopted: string
  /** The status columns as adopted, so a write that would change nothing can be skipped. */
  stored: Pick<ICloudAccount, 'appleAccountStatus' | 'appleAccountError' | 'appleAccountExpiresAt'>
}

/** The state minus lastCheckedAt, a local timestamp rather than a value Apple handed out. */
function sessionValues(state: AppleAccountState): string {
  return JSON.stringify({ ...state, lastCheckedAt: '' })
}

/** Whether Apple handed out new session values since the session was adopted. */
export function appleSessionRotated({ client, adopted }: AppleSession): boolean {
  return sessionValues(client.state) !== adopted
}

/**
 * Adopt the Apple session as it is stored right now. Called inside the gate, so
 * a request that queued behind another starts from the scnt that one rotated
 * instead of the copy it read on arrival. Only the session columns are read:
 * the cookie jar and app password the arrival read already decrypted are not
 * touched by Apple calls.
 */
export async function currentAppleSession(store: ICloudAccountStore, account: ICloudAccount): Promise<AppleSession> {
  Object.assign(account, await store.appleSession(account.id))
  if (!account.appleAccountState) throw missingAppleSession()
  const client = new AppleAccountClient(account.appleAccountState)
  return {
    client,
    adopted: sessionValues(client.state),
    stored: {
      appleAccountStatus: account.appleAccountStatus,
      appleAccountError: account.appleAccountError,
      appleAccountExpiresAt: account.appleAccountExpiresAt,
    },
  }
}

/**
 * Record what Apple rotated, unless the stored session moved on since it was
 * adopted. Only values from successful responses are on `client.state`, so a
 * refreshed scnt survives a later step failing. A call that rotated nothing
 * and leaves the status as it was has nothing to record.
 */
export async function persistAppleSession(
  store: ICloudAccountStore,
  account: ICloudAccount,
  session: AppleSession,
  patch: AppleSessionPatch = {},
): Promise<boolean> {
  account.appleAccountState = session.client.state
  account.appleAccountExpiresAt = session.client.state.expiresAt
  Object.assign(account, patch)
  const rotated = appleSessionRotated(session)
  const { stored } = session
  if (!rotated && account.appleAccountStatus === stored.appleAccountStatus
    && (account.appleAccountError || '') === (stored.appleAccountError || '')
    && (account.appleAccountExpiresAt || '') === (stored.appleAccountExpiresAt || '')) return true
  return store.advanceAppleAccountState(account, rotated)
}

/** An auth failure means Apple rejected the stored session outright. */
export function expiredPatch(error: ICloudRemoteError): AppleSessionPatch {
  return error.code === APPLE_ACCOUNT_ERROR_CODES.auth
    ? { appleAccountStatus: 'expired', appleAccountError: error.message.slice(0, 300) }
    : {}
}

export function authFailure(error: unknown): boolean {
  return error instanceof ICloudRemoteError && error.code === APPLE_ACCOUNT_ERROR_CODES.auth
}

/**
 * Run an Apple call on the adopted session, and give an auth failure one more
 * try before it is believed, since a session marked expired takes a full
 * password and 2FA sign-in to replace. Apple refuses a session that still works
 * in two ways: another isolate rotated it meanwhile (the gate only serializes
 * within one), which adopting what is stored now cures; or its short-lived
 * values lapsed before the local expiry said so, which a refresh cures. A call
 * that already refreshed and still failed is believed.
 *
 * `ref.session` always holds the session the last attempt used, so callers
 * persist what that one rotated whichever way the call ends.
 */
export async function withAppleSessionRetry<T>(
  store: ICloudAccountStore,
  account: ICloudAccount,
  ref: { session: AppleSession },
  call: (client: AppleAccountClient) => Promise<T>,
): Promise<T> {
  try {
    return await call(ref.session.client)
  } catch (error) {
    if (!authFailure(error)) throw error
    const adoptedCipher = account.appleAccountRead?.cipher
    if (await store.appleSessionCipher(account.id) !== adoptedCipher) {
      ref.session = await currentAppleSession(store, account)
      return call(ref.session.client)
    }
    if (ref.session.client.refreshAttempted) throw error
    await ref.session.client.refresh()
    return call(ref.session.client)
  }
}

/**
 * Refuse a sign-in as an Apple ID the account cannot take. Aliases created
 * through the session land on whichever Apple ID it signed in as, so one that
 * differs from the account's would split its aliases across two Apple IDs with
 * nothing showing it. The account's Apple ID is the one an earlier session
 * signed in as, else the one its validated cookie jar belongs to. Phone-number
 * sign-ins cannot be compared with an address and pass. A second account on
 * the same Apple ID is refused too: the hourly quota is kept per account, so it
 * would double the budget Apple enforces once.
 */
export async function assertAppleIdBindable(
  store: ICloudAccountStore,
  account: ICloudAccount,
  appleId: string,
): Promise<void> {
  const wanted = appleId.trim().toLowerCase()
  const signedIn = account.appleAccountState?.appleId?.trim().toLowerCase() || ''
  const fromCookies = Object.keys(account.cookies).length ? account.realEmail.trim().toLowerCase() : ''
  const comparable = (value: string) => value.includes('@') && wanted.includes('@') && value !== wanted
  if (signedIn && comparable(signedIn)) {
    throw new ICloudStoreError(409, '这个 iCloud 账号已登录另一个 Apple ID；如需更换，请先移除 Apple Account 登录态：', signedIn)
  }
  if (!signedIn && fromCookies && comparable(fromCookies)) {
    throw new ICloudStoreError(409, '这个 iCloud 账号的 Cookie 属于另一个 Apple ID，请用它登录：', fromCookies)
  }
  const owner = await store.appleIdOwner(wanted, account.id)
  if (owner) throw new ICloudStoreError(409, '这个 Apple ID 已在另一个 iCloud 账号中使用：', owner)
}

/**
 * Mark an account added through the Apple Account sign-in alone active once
 * Apple has accepted its session (ICloudAccountStore.promoteAppleOnly), and
 * mirror the write on the copy a response reports.
 */
export async function promoteAppleOnly(store: ICloudAccountStore, account: ICloudAccount): Promise<void> {
  if (account.status !== 'pending' || Object.keys(account.cookies).length || account.appPassword) return
  await store.promoteAppleOnly(account.id)
  account.status = 'active'
  account.lastValidated = new Date().toISOString()
  account.lastError = ''
}
