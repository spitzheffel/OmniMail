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

export type AliasItemStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped'

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
>

/**
 * Which channels the saved credentials can actually use, mirroring the server's
 * iCloudAliasChannels(). An expired Apple session is not one of them: Apple has
 * already rejected it, so offering it plans a batch onto slots that cannot be
 * spent. Both the workspace entry point and the quota fallback read it here so
 * they cannot disagree about what "has a login" means.
 */
export function accountChannelAvailability(
  account: AliasChannelAccount,
): Record<ICloudAliasChannel, boolean> {
  return {
    apple_account: Boolean(account.hasAppleAccount) && account.appleAccountStatus !== 'expired',
    icloud_web: Boolean(account.hasCookies),
  }
}

export function hasUsableAliasChannel(account: AliasChannelAccount): boolean {
  return Object.values(accountChannelAvailability(account)).some(Boolean)
}

/** A 429 from the alias endpoints is always the hourly cap. */
export function isAliasQuotaRejection(error: unknown): boolean {
  return (error as { status?: unknown } | null)?.status === 429
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
    apple: done.filter((item) => item.channel === 'apple_account').length,
    web: done.filter((item) => item.channel === 'icloud_web').length,
  }
}
