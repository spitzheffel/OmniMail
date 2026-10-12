import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { isAliasQuotaRejection, newAliasDraft, type AliasDraft } from '../model/icloud-alias-batch'

/**
 * Every cookie-channel call writes the refreshed cookie jar back on the server,
 * so two in flight make that a last-writer-wins race. The chain is per account
 * and module-wide rather than per hook: a dialog closed mid-preview leaves its
 * request running, and the next dialog, or the batch run, has to queue behind
 * it instead of racing it.
 */
const cookieJarQueues = new Map<string, Promise<void>>()

export function queueCookieJarCall<T>(accountId: string, call: () => Promise<T>): Promise<T> {
  const result = (cookieJarQueues.get(accountId) || Promise.resolve()).then(call)
  const tail = result.then(() => undefined, () => undefined)
  cookieJarQueues.set(accountId, tail)
  void tail.then(() => {
    if (cookieJarQueues.get(accountId) === tail) cookieJarQueues.delete(accountId)
  })
  return result
}

/**
 * Preview drafts for the legacy cookie channel, where the suggested address is
 * real information worth showing before committing.
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
  // `enabled` must stay a pure channel switch. Folding the budget into it makes
  // a quota response that lands after the first preview re-run the effect, and
  // its cleanup invalidates that request — leaving a blank card for a round-trip
  // that was already spent. The reseed below reads the budget from here instead.
  const budget = useRef(maximum)
  budget.current = maximum
  const versions = useRef(new Map<string, number>())
  const inFlight = useRef(new Map<string, number>())
  draftsRef.current = drafts

  const update = useCallback((id: string, patch: Partial<AliasDraft>) => {
    setDrafts((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])

  const invalidate = useCallback((id: string) => {
    versions.current.set(id, (versions.current.get(id) || 0) + 1)
  }, [])

  const preview = useCallback((id: string) => {
    const version = (versions.current.get(id) || 0) + 1
    versions.current.set(id, version)
    inFlight.current.set(id, (inFlight.current.get(id) || 0) + 1)
    update(id, { loading: true, error: '' })
    return queueCookieJarCall(accountId, async () => {
      try {
        // Invalidated while it waited (card removed, channel left, dialog
        // closed): never send it. Checking only after the request still spends
        // an Apple round-trip and a jar write on a result nobody will see.
        if (versions.current.get(id) !== version) return
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
    })
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
    const survivors = draftsRef.current.filter((draft) => draft.id !== id)
    if (!survivors.length) return
    invalidate(id)
    // The mount effect previews firstDraftId whenever the channel is re-entered;
    // left on a removed card, that is a real Apple preview no card can receive.
    if (firstDraftId.current === id) firstDraftId.current = survivors[0].id
    setDrafts((items) => (items.length > 1 ? items.filter((item) => item.id !== id) : items))
  }, [invalidate])

  /**
   * Cap the cards at the budget. `add` caps only against the budget known at the
   * time, and the real one can arrive later and be smaller: the surplus would be
   * counted, submitted and skipped. Dropping it also cancels its queued previews.
   */
  const clamp = useCallback((limit: number) => {
    const room = Math.max(1, limit)
    const surplus = draftsRef.current.slice(room)
    if (!surplus.length) return
    for (const draft of surplus) invalidate(draft.id)
    setDrafts((items) => items.slice(0, room))
  }, [invalidate])

  const setLabel = useCallback((id: string, label: string) => {
    update(id, { label: label.slice(0, 80) })
  }, [update])

  /**
   * Replace the cards after a batch with the ones still to create (see
   * draftsAfterRun). Created cards already exist upstream and their previewId is
   * spent, so bringing them back would replay them on the next submit. Nothing
   * left reseeds one fresh card.
   */
  const restore = useCallback((next: AliasDraft[]) => {
    const kept = new Set(next.map((draft) => draft.id))
    for (const draft of draftsRef.current) {
      if (!kept.has(draft.id)) invalidate(draft.id)
    }
    // The mount effect previews firstDraftId whenever the channel is re-entered;
    // leaving it pointing at a dropped card would fire a real Apple preview whose
    // result no card can receive.
    if (next.length) {
      firstDraftId.current = next[0].id
      setDrafts(next)
      return
    }
    const fresh = newAliasDraft(crypto.randomUUID())
    firstDraftId.current = fresh.id
    setDrafts([fresh])
    // After a fully successful batch the window is saturated and submit is
    // disabled, so a preview here could only produce a failed round-trip and an
    // error card.
    if (budget.current > 0) void preview(fresh.id)
  }, [invalidate, preview])

  return {
    drafts, preview, add, remove, clamp, restore, setLabel,
    busy: drafts.some((draft) => draft.loading),
  }
}
