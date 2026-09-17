import type { ICloudAlias, ICloudAliasChannel, ICloudAliasQuotaChannel } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { t } from '../../../shared/i18n'
import {
  ICLOUD_ALIAS_CHANNEL_ORDER,
  channelRemaining,
  type AliasBatchItem,
  type ICloudAliasChannelChoice,
} from './icloud-alias-batch'

export type CreatedAlias = Pick<ICloudAlias, 'email' | 'label' | 'createdAt'>

/** The slice of the API client the run loop needs, so tests can pass a stub. */
export type AliasBatchApi = {
  previewICloudAlias: (accountId: string) => Promise<{ email: string; previewId: string }>
  createICloudAlias: (input: {
    accountId: string
    label: string
    channel: ICloudAliasChannel
    email?: string
    previewId?: string
  }) => Promise<{ alias: CreatedAlias; channel: ICloudAliasChannel; remaining: number }>
}

export type AliasBatchRunOptions = {
  api: AliasBatchApi
  accountId: string
  items: AliasBatchItem[]
  choice: ICloudAliasChannelChoice
  quota: ICloudAliasQuotaChannel[]
  /** Polled between items so closing the dialog stops the run at a clean boundary. */
  shouldStop?: () => boolean
  onItems?: (items: AliasBatchItem[]) => void
}

export type AliasBatchRunResult = {
  items: AliasBatchItem[]
  created: CreatedAlias[]
  remaining: Record<ICloudAliasChannel, number>
}

function quotaRejection(error: unknown): boolean {
  return typeof (error as { status?: unknown } | null)?.status === 'number'
    && (error as { status: number }).status === 429
}

export async function runAliasBatch(options: AliasBatchRunOptions): Promise<AliasBatchRunResult> {
  const { api, accountId, choice, quota, shouldStop, onItems } = options
  const items = options.items.map((item) => ({ ...item }))
  const created: CreatedAlias[] = []
  const exhausted = new Set<ICloudAliasChannel>()
  const remaining: Record<ICloudAliasChannel, number> = {
    apple_account: channelRemaining(quota, 'apple_account'),
    icloud_web: channelRemaining(quota, 'icloud_web'),
  }
  const publish = () => onItems?.(items.map((item) => ({ ...item })))

  // Only `auto` may move an item; an explicitly chosen channel must surface its
  // own limit instead of quietly spending the other channel's budget.
  function reroute(from: ICloudAliasChannel): ICloudAliasChannel | undefined {
    if (choice !== 'auto') return undefined
    return ICLOUD_ALIAS_CHANNEL_ORDER.find((channel) => (
      channel !== from && !exhausted.has(channel) && remaining[channel] > 0
    ))
  }

  for (let index = 0; index < items.length; index += 1) {
    if (shouldStop?.()) {
      for (let rest = index; rest < items.length; rest += 1) {
        items[rest] = { ...items[rest], status: 'skipped', error: t('已取消') }
      }
      publish()
      break
    }
    if (exhausted.has(items[index].channel)) {
      const alternative = reroute(items[index].channel)
      if (!alternative) {
        items[index] = { ...items[index], status: 'skipped', error: t('本小时创建额度已用完') }
        publish()
        continue
      }
      items[index] = { ...items[index], channel: alternative }
    }
    const item = items[index]
    items[index] = { ...item, status: 'running', error: '' }
    publish()
    try {
      let { email, previewId } = item
      // The cookie channel reserves a concrete address first. Doing it here
      // rather than upfront keeps the preview fresh when its turn comes.
      if (item.channel === 'icloud_web' && !email) {
        const preview = await api.previewICloudAlias(accountId)
        email = preview.email
        previewId = preview.previewId
      }
      const result = await api.createICloudAlias({
        accountId,
        label: item.label,
        channel: item.channel,
        email: item.channel === 'icloud_web' ? email : undefined,
        previewId: item.channel === 'icloud_web' ? previewId : undefined,
      })
      created.push(result.alias)
      remaining[result.channel] = result.remaining
      items[index] = {
        ...item,
        channel: result.channel,
        email: result.alias.email,
        previewId: '',
        status: 'success',
        error: '',
      }
      publish()
    } catch (error) {
      if (quotaRejection(error)) {
        exhausted.add(item.channel)
        remaining[item.channel] = 0
        const alternative = reroute(item.channel)
        if (alternative) {
          // Retry this same item on the other channel; `exhausted` guarantees
          // the loop cannot bounce it back.
          items[index] = { ...item, channel: alternative, status: 'pending', error: '' }
          index -= 1
          continue
        }
        items[index] = { ...item, status: 'skipped', error: errorMessage(error) }
        publish()
        continue
      }
      items[index] = { ...item, status: 'error', error: errorMessage(error) }
      publish()
    }
  }
  return { items, created, remaining }
}
