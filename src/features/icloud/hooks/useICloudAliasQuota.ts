import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type ICloudAccount, type ICloudAliasChannel, type ICloudAliasQuotaChannel } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { ICLOUD_ALIAS_CHANNEL_ORDER, ICLOUD_ALIAS_FALLBACK_LIMITS } from '../model/icloud-alias-batch'

/**
 * Rendered while the real numbers are in flight or unreachable. Availability is
 * known locally from the saved credentials, so only the budgets are guessed.
 */
function fallbackChannels(account: ICloudAccount): ICloudAliasQuotaChannel[] {
  const available: Record<ICloudAliasChannel, boolean> = {
    // Mirrors getICloudAliasQuota: an expired session needs a re-import, not a
    // batch of creates that each fail the same way.
    apple_account: Boolean(account.hasAppleAccount) && account.appleAccountStatus !== 'expired',
    icloud_web: Boolean(account.hasCookies),
  }
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
  const [channels, setChannels] = useState<ICloudAliasQuotaChannel[]>(() => fallbackChannels(account))
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

  /** Fold a create response's `remaining` in without another round-trip. */
  const applyRemaining = useCallback((channel: ICloudAliasChannel, remaining: number) => {
    setChannels((items) => items.map((item) => (
      item.channel === channel
        ? { ...item, remaining: Math.max(0, remaining), used: Math.max(0, item.limit - remaining) }
        : item
    )))
  }, [])

  return { channels, loading, estimated, error, refresh, applyRemaining }
}
