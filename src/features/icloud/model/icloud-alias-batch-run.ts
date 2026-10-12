import type { ICloudAlias, ICloudAliasChannel, ICloudAliasQuotaChannel } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { t } from '../../../shared/i18n'
import {
  ICLOUD_ALIAS_CHANNEL_ORDER,
  channelRemaining,
  isAliasCredentialRejection,
  isAliasOutcomeUnknown,
  isAliasQuotaRejection,
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
  /**
   * Only the channels the server reported on. A channel the run never touched
   * would just echo the submit-time snapshot, which may be the fallback guess.
   */
  remaining: Partial<Record<ICloudAliasChannel, number>>
  /** Channels whose credentials were rejected mid-run. */
  unusable: ICloudAliasChannel[]
}

export async function runAliasBatch(options: AliasBatchRunOptions): Promise<AliasBatchRunResult> {
  const { api, accountId, choice, quota, shouldStop, onItems } = options
  const items = options.items.map((item) => ({ ...item }))
  const created: CreatedAlias[] = []
  const unusable = new Set<ICloudAliasChannel>()
  // What the run believes is left, starting from the plan's snapshot and then
  // following every answer. A channel at 0 is spent whether a 429 said so or a
  // success did: the next item on it could only win a 429 after a preview, a
  // cookie-jar write and a service lookup.
  const budget: Record<ICloudAliasChannel, number> = {
    apple_account: channelRemaining(quota, 'apple_account'),
    icloud_web: channelRemaining(quota, 'icloud_web'),
  }
  const reported: Partial<Record<ICloudAliasChannel, number>> = {}
  const publish = () => onItems?.(items.map((item) => ({ ...item })))
  const open = (channel: ICloudAliasChannel) => !unusable.has(channel) && budget[channel] > 0

  // Only `auto` may move an item; an explicitly chosen channel must surface its
  // own limit instead of quietly spending the other channel's budget.
  function reroute(from: ICloudAliasChannel): ICloudAliasChannel | undefined {
    if (choice !== 'auto') return undefined
    return ICLOUD_ALIAS_CHANNEL_ORDER.find((channel) => channel !== from && open(channel))
  }

  for (let index = 0; index < items.length; index += 1) {
    if (shouldStop?.()) {
      for (let rest = index; rest < items.length; rest += 1) {
        items[rest] = { ...items[rest], status: 'skipped', error: t('已取消') }
      }
      publish()
      break
    }
    const planned = items[index].channel
    if (!open(planned)) {
      const alternative = reroute(planned)
      if (!alternative) {
        items[index] = {
          ...items[index],
          status: 'skipped',
          error: unusable.has(planned) ? t('这个通道的登录态已失效，未再尝试。') : t('本小时创建额度已用完'),
        }
        publish()
        continue
      }
      items[index] = { ...items[index], channel: alternative }
    }
    const item = items[index]
    items[index] = { ...item, status: 'running', error: '' }
    publish()
    let { email, previewId } = item
    let sent = false
    try {
      // The cookie channel reserves a concrete address first. Doing it here
      // rather than upfront keeps the preview fresh when its turn comes.
      if (item.channel === 'icloud_web' && !email) {
        const preview = await api.previewICloudAlias(accountId)
        email = preview.email
        previewId = preview.previewId
        // Held on the item so a create that never answers still knows which
        // address it asked for.
        items[index] = { ...items[index], email, previewId }
        publish()
      }
      sent = true
      const result = await api.createICloudAlias({
        accountId,
        label: item.label,
        channel: item.channel,
        email: item.channel === 'icloud_web' ? email : undefined,
        previewId: item.channel === 'icloud_web' ? previewId : undefined,
      })
      created.push(result.alias)
      budget[result.channel] = result.remaining
      reported[result.channel] = result.remaining
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
      if (isAliasQuotaRejection(error)) {
        budget[item.channel] = 0
        reported[item.channel] = 0
        const alternative = reroute(item.channel)
        if (alternative) {
          // Retry this same item on the other channel; the spent budget
          // guarantees the loop cannot bounce it back.
          items[index] = { ...item, channel: alternative, status: 'pending', error: '' }
          index -= 1
          continue
        }
        items[index] = { ...item, status: 'skipped', error: errorMessage(error) }
        publish()
        continue
      }
      // Not rerouted like a 429: this item has to show why the channel died,
      // or a dead session hides behind successes on the other channel.
      if (isAliasCredentialRejection(error)) unusable.add(item.channel)
      items[index] = sent && isAliasOutcomeUnknown(error)
        ? {
          ...item, email, previewId, status: 'unknown',
          error: t('请求超时，结果未知：Apple 可能已经创建了这个地址，请以同步后的列表为准。'),
        }
        : { ...item, email, previewId, status: 'error', error: errorMessage(error) }
      publish()
    }
  }
  return { items, created, remaining: reported, unusable: [...unusable] }
}
