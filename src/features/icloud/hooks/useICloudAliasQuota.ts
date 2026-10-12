import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ICloudAccount, type ICloudAliasChannel, type ICloudAliasQuotaChannel } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import {
  ICLOUD_ALIAS_CHANNEL_ORDER,
  ICLOUD_ALIAS_FALLBACK_LIMITS,
  accountChannelAvailability,
  quotaRefreshDelay,
} from '../model/icloud-alias-batch'

/**
 * Rendered while the real numbers are in flight or unreachable. Availability is
 * known locally from the saved credentials, so only the budgets are guessed.
 */
function fallbackChannels(account: ICloudAccount): ICloudAliasQuotaChannel[] {
  const available = accountChannelAvailability(account)
  return ICLOUD_ALIAS_CHANNEL_ORDER.map((channel) => ({
    channel,
    available: available[channel],
    limit: ICLOUD_ALIAS_FALLBACK_LIMITS[channel],
    used: 0,
    remaining: available[channel] ? ICLOUD_ALIAS_FALLBACK_LIMITS[channel] : 0,
    resetsAt: '',
  }))
}

export function useICloudAliasQuota(account: ICloudAccount) {
  const [loaded, setChannels] = useState<ICloudAliasQuotaChannel[]>(() => fallbackChannels(account))
  const [unusable, setUnusable] = useState<ICloudAliasChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [estimated, setEstimated] = useState(true)
  const [error, setError] = useState('')
  const requestId = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const accountId = account.id

  const refresh = useCallback(async () => {
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    const current = ++requestId.current
    setLoading(true)
    try {
      const result = await api.iCloudAliasQuota(accountId, abort.signal)
      if (current !== requestId.current) return
      setChannels(result.channels)
      setEstimated(false)
      setError('')
    } catch (quotaError) {
      if (current !== requestId.current || abort.signal.aborted) return
      setError(errorMessage(quotaError))
    } finally {
      if (current === requestId.current) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void refresh()
    return () => { controller.current?.abort() }
  }, [refresh])

  // A channel whose credentials were rejected mid-run stays out of planning for
  // the rest of this dialog, whatever the next read says: the quota endpoint
  // only knows a cookie jar is stored, not that Apple has just refused it.
  const channels = useMemo(() => loaded.map((quota) => (
    unusable.includes(quota.channel) ? { ...quota, available: false, remaining: 0 } : quota
  )), [loaded, unusable])

  // Otherwise a dialog that reached 0 stays locked after the hour rolls over,
  // until it is closed and opened again.
  useEffect(() => {
    const delay = quotaRefreshDelay(channels, Date.now())
    if (delay === undefined) return undefined
    const timer = window.setTimeout(() => void refresh(), delay)
    return () => window.clearTimeout(timer)
  }, [channels, refresh])

  /** Fold a create response's `remaining` in without another round-trip. */
  const applyRemaining = useCallback((channel: ICloudAliasChannel, remaining: number) => {
    setChannels((items) => items.map((item) => (
      item.channel === channel
        ? { ...item, remaining: Math.max(0, remaining), used: Math.max(0, item.limit - remaining) }
        : item
    )))
  }, [])

  const disable = useCallback((channel: ICloudAliasChannel) => {
    setUnusable((items) => (items.includes(channel) ? items : [...items, channel]))
  }, [])

  return { channels, unusable, loading, estimated, error, refresh, applyRemaining, disable }
}
