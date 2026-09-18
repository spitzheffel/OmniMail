import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { isAliasQuotaRejection, newAliasDraft, type AliasDraft } from '../model/icloud-alias-batch'

/**
 * Preview drafts for the legacy cookie channel, where the suggested address is
 * real information worth showing before committing.
 *
 * Every preview writes the refreshed cookie jar back on the server, so requests
 * are chained one at a time; firing several in parallel makes that a
 * last-writer-wins race.
 */
export function useICloudAliasDrafts(
  accountId: string,
  maximum: number,
  enabled: boolean,
  onExhausted?: () => void,
) {
  const [drafts, setDrafts] = useState<AliasDraft[]>(() => [newAliasDraft(crypto.randomUUID())])
  const firstDraftId = useRef(drafts[0].id)
  const draftsRef = useRef(drafts)
  // Held in a ref so a caller's inline arrow cannot change preview's identity;
  // that would re-run the mount effect, which invalidates the request in flight.
  const exhausted = useRef(onExhausted)
  exhausted.current = onExhausted
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const versions = useRef(new Map<string, number>())
  const inFlight = useRef(new Map<string, number>())
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  draftsRef.current = drafts

  const update = useCallback((id: string, patch: Partial<AliasDraft>) => {
    setDrafts((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const preview = useCallback((id: string) => {
    const version = (versions.current.get(id) || 0) + 1
    versions.current.set(id, version)
    inFlight.current.set(id, (inFlight.current.get(id) || 0) + 1)
    update(id, { loading: true, error: '' })
    const run = async () => {
      try {
        const result = await api.previewICloudAlias(accountId)
        if (versions.current.get(id) !== version) return
        update(id, { email: result.email, previewId: result.previewId })
      } catch (previewError) {
        if (versions.current.get(id) !== version) return
        // /alias/preview spends nothing, but Apple answers it with the same cap.
        // Folding that into the quota is what stops the dialog from advertising
        // slots and letting every further card repeat the round-trip.
        if (isAliasQuotaRejection(previewError)) exhausted.current?.()
        update(id, { error: errorMessage(previewError) })
      } finally {
        // The version guard decides whether the *result* is still wanted; the
        // spinner must clear regardless, or an invalidated draft would stay
        // loading forever and lock the dialog. Counting in-flight requests keeps
        // a superseded response from clearing a newer one's spinner.
        const pending = (inFlight.current.get(id) || 1) - 1
        if (pending > 0) inFlight.current.set(id, pending)
        else {
          inFlight.current.delete(id)
          update(id, { loading: false })
        }
      }
    }
    queue.current = queue.current.then(run, run)
    return queue.current
  }, [accountId, update])

  // The first preview and the invalidation that cancels it must live in one
  // effect. Split apart, StrictMode's mount/unmount/mount would invalidate the
  // only request that was ever issued and leave the card loading forever.
  useEffect(() => {
    if (!enabled) return undefined
    const active = versions.current
    const timer = window.setTimeout(() => void preview(firstDraftId.current), 0)
    return () => {
      window.clearTimeout(timer)
      for (const [id, version] of active) active.set(id, version + 1)
    }
  }, [enabled, preview])

  // Side effects must stay out of the state updater: React may run an updater
  // more than once, and a preview started in there would target a draft that is
  // not in state yet.
  const add = useCallback((count = 1) => {
    const room = Math.max(0, Math.min(count, maximum - draftsRef.current.length))
    if (!room) return
    const created = Array.from({ length: room }, () => newAliasDraft(crypto.randomUUID()))
    setDrafts((items) => {
      // draftsRef only refreshes on render, so two clicks inside one frame would
      // both see the pre-click length. Clamping again against the live state is
      // what actually enforces the cap; a draft dropped here simply never
      // matches its own preview update.
      const accepted = Math.max(0, Math.min(created.length, maximum - items.length))
      return accepted ? [...items, ...created.slice(0, accepted)] : items
    })
    for (const draft of created) void preview(draft.id)
  }, [maximum, preview])

  const remove = useCallback((id: string) => {
    versions.current.set(id, (versions.current.get(id) || 0) + 1)
    setDrafts((items) => (items.length > 1 ? items.filter((item) => item.id !== id) : items))
  }, [])

  const setLabel = useCallback((id: string, label: string) => {
    update(id, { label: label.slice(0, 80) })
  }, [update])

  /**
   * Keep only the listed drafts. After a batch the created cards already exist
   * upstream and their previewId is spent, so bringing them back would replay
   * them on the next submit. No survivors reseeds one fresh card.
   */
  const prune = useCallback((keep: Set<string>) => {
    const survivors = draftsRef.current.filter((draft) => keep.has(draft.id))
    for (const draft of draftsRef.current) {
      if (!keep.has(draft.id)) versions.current.set(draft.id, (versions.current.get(draft.id) || 0) + 1)
    }
    // The mount effect previews firstDraftId whenever the channel is re-entered;
    // leaving it pointing at a pruned card would fire a real Apple preview whose
    // result no card can receive.
    if (survivors.length) {
      firstDraftId.current = survivors[0].id
      setDrafts(survivors)
      return
    }
    const fresh = newAliasDraft(crypto.randomUUID())
    firstDraftId.current = fresh.id
    setDrafts([fresh])
    // After a fully successful batch the window is saturated and submit is
    // disabled, so a preview here could only produce a failed round-trip and an
    // error card. The mount effect fires one as soon as the budget returns.
    if (enabledRef.current) void preview(fresh.id)
  }, [preview])

  return { drafts, preview, add, remove, prune, setLabel, busy: drafts.some((draft) => draft.loading) }
}
