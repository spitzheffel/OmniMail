import { t } from '../../../shared/i18n'
import type { ICloudAccount, ICloudAliasChannel, ICloudAliasQuotaChannel } from '../../../shared/api'

/** `auto` fills the Apple Account budget first, then spills to the cookie channel. */
export type ICloudAliasChannelChoice = ICloudAliasChannel | 'auto'

/**
 * Only used while the quota request is in flight or has failed. The server owns
 * the real numbers; these exist so the dialog can render something sane.
 */
export const ICLOUD_ALIAS_FALLBACK_LIMITS: Record<ICloudAliasChannel, number> = {
  apple_account: 20,
  icloud_web: 5,
}

export const ICLOUD_ALIAS_CHANNEL_ORDER: readonly ICloudAliasChannel[] = ['apple_account', 'icloud_web']

/**
 * `unknown`: the create went out but no verdict came back, so Apple may hold
 * the alias. Reporting it as a failure invites a retry that creates a second one.
 */
export type AliasItemStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'unknown'

export type AliasBatchItem = {
  id: string
  label: string
  channel: ICloudAliasChannel
  /** Reserved preview address for the cookie channel, then the created address. */
  email: string
  previewId: string
  status: AliasItemStatus
  error: string
}

/** One editable preview card on the legacy cookie channel. */
export type AliasDraft = {
  id: string
  label: string
  email: string
  previewId: string
  loading: boolean
  error: string
}

export function newAliasDraft(id: string): AliasDraft {
  return { id, label: '', email: '', previewId: '', loading: false, error: '' }
}

export function draftsToBatch(drafts: AliasDraft[]): AliasBatchItem[] {
  return drafts.map((draft) => ({
    id: draft.id,
    label: draft.label,
    channel: 'icloud_web' as const,
    email: draft.email,
    previewId: draft.previewId,
    status: 'pending' as AliasItemStatus,
    error: '',
  }))
}

export type AliasBatchSummary = {
  success: number
  failed: number
  skipped: number
  unknown: number
  apple: number
  web: number
}

/**
 * Port of the reference panel's schedulerMailboxLabel, minus the batch index.
 * An empty base keeps today's behaviour of letting the server auto-name.
 */
export function aliasBatchLabel(base: string, index: number, total: number): string {
  const trimmed = base.trim()
  if (!trimmed) return ''
  if (total <= 1) return trimmed
  const width = Math.max(2, String(total).length)
  return `${trimmed}-${String(index).padStart(width, '0')}`
}

export function channelQuota(
  channels: ICloudAliasQuotaChannel[],
  channel: ICloudAliasChannel,
): ICloudAliasQuotaChannel | undefined {
  return channels.find((item) => item.channel === channel)
}

export function channelRemaining(
  channels: ICloudAliasQuotaChannel[],
  channel: ICloudAliasChannel,
): number {
  const quota = channelQuota(channels, channel)
  return quota?.available ? Math.max(0, quota.remaining) : 0
}

export function availableChannels(channels: ICloudAliasQuotaChannel[]): ICloudAliasChannel[] {
  return ICLOUD_ALIAS_CHANNEL_ORDER.filter((channel) => channelQuota(channels, channel)?.available)
}

export type AliasChannelAccount = Pick<
  ICloudAccount, 'hasCookies' | 'hasAppleAccount' | 'appleAccountStatus'
> & Partial<Pick<ICloudAccount, 'status'>>

/**
 * Which channels the saved credentials can actually use, mirroring the server's
 * iCloudAliasChannels(). An expired Apple session is not one of them, and
 * neither is a cookie jar Apple rejected (the account's `error` status): Apple
 * has already refused each, so offering it plans a batch onto slots that cannot
 * be spent. Both the workspace entry point and the quota fallback read it here
 * so they cannot disagree about what "has a login" means.
 */
export function accountChannelAvailability(
  account: AliasChannelAccount,
): Record<ICloudAliasChannel, boolean> {
  return {
    apple_account: Boolean(account.hasAppleAccount) && account.appleAccountStatus !== 'expired',
    icloud_web: Boolean(account.hasCookies) && account.status !== 'error',
  }
}

export function hasUsableAliasChannel(account: AliasChannelAccount): boolean {
  return Object.values(accountChannelAvailability(account)).some(Boolean)
}

/**
 * Why the create flow is closed, already translated. The workspace entry point
 * and the dialog behind it both show this; wording it separately in each is how
 * they came to disagree about which of the two reasons applies.
 */
export function aliasChannelBlockedMessage(account?: AliasChannelAccount): string {
  if (account?.appleAccountStatus === 'expired') return t('Apple Account 登录态已过期，请重新登录。')
  if (account?.hasCookies && account.status === 'error') return t('iCloud Cookie 已失效，请在账号设置中更新。')
  return t('配置 Cookie 或 Apple Account 后可创建隐藏邮箱')
}

function errorStatus(error: unknown): unknown {
  return (error as { status?: unknown } | null)?.status
}

/** A 429 from the alias endpoints is always the hourly cap. */
export function isAliasQuotaRejection(error: unknown): boolean {
  return errorStatus(error) === 429
}

/**
 * A 422 is the channel's credentials failing (an expired Apple Account session,
 * a rejected cookie jar), not this one item: every later call on the same
 * channel would fail the same way.
 */
export function isAliasCredentialRejection(error: unknown): boolean {
  return errorStatus(error) === 422
}

/**
 * No verdict: the browser gave up waiting (408) or the Worker timed out on
 * Apple (504). The create may still have been committed upstream.
 */
export function isAliasOutcomeUnknown(error: unknown): boolean {
  const status = errorStatus(error)
  return status === 408 || status === 504
}

/** How many aliases the chosen mode can still create this hour. */
export function remainingFor(
  channels: ICloudAliasQuotaChannel[],
  choice: ICloudAliasChannelChoice,
): number {
  if (choice !== 'auto') return channelRemaining(channels, choice)
  return ICLOUD_ALIAS_CHANNEL_ORDER
    .reduce((total, channel) => total + channelRemaining(channels, channel), 0)
}

/**
 * Decide up front which channel each item uses, so a batch never discovers the
 * split by burning failed Apple round-trips. Returns fewer entries than `count`
 * when the hourly budget cannot cover it.
 */
export function planAliasBatch(
  count: number,
  channels: ICloudAliasQuotaChannel[],
  choice: ICloudAliasChannelChoice,
): ICloudAliasChannel[] {
  const wanted = Math.max(0, Math.floor(count))
  const order = choice === 'auto' ? ICLOUD_ALIAS_CHANNEL_ORDER : [choice]
  const plan: ICloudAliasChannel[] = []
  for (const channel of order) {
    const budget = Math.min(channelRemaining(channels, channel), wanted - plan.length)
    for (let taken = 0; taken < budget; taken += 1) plan.push(channel)
    if (plan.length >= wanted) break
  }
  return plan
}

export function buildAliasBatch(
  plan: ICloudAliasChannel[],
  baseLabel: string,
  newId: () => string,
): AliasBatchItem[] {
  return plan.map((channel, index) => ({
    id: newId(),
    label: aliasBatchLabel(baseLabel, index + 1, plan.length),
    channel,
    email: '',
    previewId: '',
    status: 'pending' as AliasItemStatus,
    error: '',
  }))
}

export function batchSummary(items: AliasBatchItem[]): AliasBatchSummary {
  const done = items.filter((item) => item.status === 'success')
  return {
    success: done.length,
    failed: items.filter((item) => item.status === 'error').length,
    skipped: items.filter((item) => item.status === 'skipped').length,
    unknown: items.filter((item) => item.status === 'unknown').length,
    apple: done.filter((item) => item.channel === 'apple_account').length,
    web: done.filter((item) => item.channel === 'icloud_web').length,
  }
}

/**
 * What a progress row leads with. "Waiting for Apple" only holds while the item
 * can still produce an address; once it has ended without one it contradicts
 * the badge beside it, and for a cookie item whose preview failed it also names
 * the wrong party.
 */
export function aliasItemHeadline(item: Pick<AliasBatchItem, 'email' | 'label' | 'status'>): string {
  if (item.email) return item.email
  if (item.label) return item.label
  if (item.status === 'pending' || item.status === 'running') return t('等待 Apple 生成地址')
  return item.status === 'unknown' ? t('地址未知') : t('未创建')
}

/**
 * The cards '继续创建' brings back: every one that was not created, with what
 * the run learned about it. A refused card loses its reservation, or the next
 * submit would offer Apple the address it just turned down. A card whose result
 * is unknown keeps it: re-sending the same address cannot make a second alias,
 * a fresh one could.
 */
export function draftsAfterRun(drafts: AliasDraft[], items: AliasBatchItem[]): AliasDraft[] {
  const outcomes = new Map(items.map((item) => [item.id, item]))
  return drafts.flatMap((draft) => {
    const item = outcomes.get(draft.id)
    if (!item || item.status === 'pending' || item.status === 'skipped') return [draft]
    if (item.status === 'success') return []
    return item.status === 'unknown'
      ? [{ ...draft, email: item.email, previewId: item.previewId, error: item.error }]
      : [{ ...draft, email: '', previewId: '', error: item.error }]
  })
}

/**
 * Whether the workspace has to re-read the account after a run. Not only when
 * something was created: a create whose verdict never came may exist upstream,
 * and a failure may have changed the stored account (an expired session, a
 * rejected jar) that the next plan is built from.
 */
export function shouldResyncAfterRun(result: { items: AliasBatchItem[]; created: unknown[] }): boolean {
  return result.created.length > 0
    || result.items.some((item) => item.status === 'error' || item.status === 'unknown')
}

function resetAt(channels: ICloudAliasQuotaChannel[], spent: (quota: ICloudAliasQuotaChannel) => boolean) {
  const resets = channels
    .filter((quota) => quota.available && spent(quota))
    .map((quota) => Date.parse(quota.resetsAt))
    .filter(Number.isFinite)
  return resets.length ? Math.min(...resets) : undefined
}

/** When the hour rolls over for a usable channel that has nothing left, in epoch ms. */
export function exhaustedResetAt(channels: ICloudAliasQuotaChannel[]): number | undefined {
  return resetAt(channels, (quota) => quota.remaining <= 0)
}

/** Lands the re-read just after the server's hour floor has moved on. */
const QUOTA_RESET_SLACK_MS = 1_000
/** A reset already in the past means the clocks disagree; back off, don't spin. */
const QUOTA_RETRY_MS = 15_000

/**
 * How long to wait before reading the quota again, or undefined when nothing in
 * the current window has been spent and a reset would change nothing. Without
 * it, a dialog that reached 0 stays locked after the window resets.
 */
export function quotaRefreshDelay(channels: ICloudAliasQuotaChannel[], now: number): number | undefined {
  const reset = resetAt(channels, (quota) => quota.remaining < quota.limit)
  if (reset === undefined) return undefined
  if (reset <= now) return QUOTA_RETRY_MS
  // The server floors windows to the hour; anything further out is bogus, and
  // setTimeout fires at once for delays past 2^31 - 1 ms.
  return Math.min(reset - now, 3_600_000) + QUOTA_RESET_SLACK_MS
}
