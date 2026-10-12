import { AlertCircle, LoaderCircle, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, type ICloudAccount } from '../../../shared/api'
import { getLocale, t } from '../../../shared/i18n'
import '../styles/icloud-alias-batch.css'
import { queueCookieJarCall, useICloudAliasDrafts } from '../hooks/useICloudAliasDrafts'
import { useICloudAliasQuota } from '../hooks/useICloudAliasQuota'
import {
  ICLOUD_ALIAS_CHANNEL_ORDER,
  aliasChannelBlockedMessage,
  availableChannels,
  batchSummary,
  buildAliasBatch,
  draftsAfterRun,
  draftsToBatch,
  exhaustedResetAt,
  hasUsableAliasChannel,
  planAliasBatch,
  remainingFor,
  shouldResyncAfterRun,
  type AliasBatchItem,
  type ICloudAliasChannelChoice,
} from '../model/icloud-alias-batch'
import { runAliasBatch, type AliasBatchApi, type CreatedAlias } from '../model/icloud-alias-batch-run'
import { ICloudAliasBatchProgress } from './ICloudAliasBatchProgress'
import { ICloudAliasDraftActions, ICloudAliasDraftCards } from './ICloudAliasDraftCards'
import { ICloudAliasQuantityFields } from './ICloudAliasQuantityFields'

type BatchStep = 'form' | 'running' | 'complete'

const CHOICE_LABELS: Record<ICloudAliasChannelChoice, string> = {
  auto: '自动',
  apple_account: 'Apple Account',
  icloud_web: 'iCloud Cookie',
}

// The run's cookie-channel calls write the same jar as the card previews, so
// they wait their turn on the same queue.
const batchApi: AliasBatchApi = {
  previewICloudAlias: (accountId) => queueCookieJarCall(accountId, () => api.previewICloudAlias(accountId)),
  createICloudAlias: (input) => (input.channel === 'icloud_web'
    ? queueCookieJarCall(input.accountId, () => api.createICloudAlias(input))
    : api.createICloudAlias(input)),
}

function Spinner() {
  return <LoaderCircle className="spin" size={15} aria-hidden="true" />
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
}

export function ICloudAliasBatchForm({ account, close, closing = false, onCreated }: {
  account: ICloudAccount
  close: () => void
  /** ICloudModal has started closing; it unmounts the form 210 ms later. */
  closing?: boolean
  /**
   * Re-syncs the workspace after a run, with nothing created too: a create whose
   * answer never came may exist upstream, and a failed one may have changed the
   * stored account (an expired session).
   */
  onCreated: (aliases: CreatedAlias[]) => Promise<void>
}) {
  const {
    channels, unusable, estimated, error: quotaError, applyRemaining, disable, refresh: refreshQuota,
  } = useICloudAliasQuota(account)
  const [choice, setChoice] = useState<ICloudAliasChannelChoice>('auto')
  const [quantity, setQuantity] = useState(1)
  const [baseLabel, setBaseLabel] = useState('')
  const [step, setStep] = useState<BatchStep>('form')
  const [items, setItems] = useState<AliasBatchItem[]>([])
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [runError, setRunError] = useState('')
  const stopped = useRef(false)
  // Set once the dialog starts closing. A run settling after that must leave
  // the workspace alone: it may already show another account.
  const dismissed = useRef(false)
  const accountId = useRef(account.id)
  accountId.current = account.id
  const resync = useRef(onCreated)
  resync.current = onCreated
  const formRef = useRef<HTMLFormElement>(null)
  const progressRef = useRef<HTMLProgressElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const focusedStep = useRef(step)

  const usable = useMemo(() => availableChannels(channels), [channels])
  const bothChannels = usable.length > 1
  const effective: ICloudAliasChannelChoice = bothChannels ? choice : usable[0] || 'apple_account'
  // Preview cards only earn their place where the address is known up front.
  const useCards = effective === 'icloud_web'
  const maximum = Math.max(0, remainingFor(channels, effective))
  const running = step === 'running'
  const resetsAt = exhaustedResetAt(channels)

  const drafts = useICloudAliasDrafts(
    account.id,
    maximum,
    useCards && !closing,
    () => applyRemaining('icloud_web', 0),
  )
  const { clamp } = drafts
  const count = useCards ? drafts.drafts.length : Math.min(quantity, Math.max(1, maximum))

  useEffect(() => {
    setQuantity((value) => Math.max(1, Math.min(value, Math.max(1, maximum))))
  }, [maximum])

  // Cards are capped as they are added, against whatever budget was known then;
  // the real one can arrive later and be smaller.
  useEffect(() => {
    if (useCards && step === 'form') clamp(maximum)
  }, [clamp, maximum, step, useCards])

  useEffect(() => {
    // StrictMode replays the mount after a simulated unmount; only a real
    // unmount may leave these set.
    dismissed.current = false
    return () => {
      stopped.current = true
      dismissed.current = true
    }
  }, [])

  // ICloudModal keeps the form mounted through its exit animation. Waiting for
  // the unmount lets an item that settles in that window start another create,
  // and spend another hourly slot, after the user asked to stop.
  useEffect(() => {
    if (!closing) return
    stopped.current = true
    dismissed.current = true
  }, [closing])

  // Each step disables or removes the control that had focus (the submit
  // button, then the progress bar), which would drop focus out of the dialog.
  useEffect(() => {
    if (focusedStep.current === step) return
    focusedStep.current = step
    if (step === 'running') progressRef.current?.focus()
    else if (step === 'complete') doneRef.current?.focus()
    else {
      (formRef.current?.querySelector<HTMLElement>('[data-modal-autofocus]:not(:disabled)')
        || doneRef.current)?.focus()
    }
  }, [step])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (closing || running || maximum < 1) return
    const planned = useCards
      ? draftsToBatch(drafts.drafts)
      : buildAliasBatch(
        planAliasBatch(count, channels, effective),
        baseLabel,
        () => crypto.randomUUID(),
      )
    if (!planned.length) return
    const runAccountId = account.id
    stopped.current = false
    setRunError('')
    setItems(planned)
    setProgress({ completed: 0, total: planned.length })
    setStep('running')
    const result = await runAliasBatch({
      api: batchApi,
      accountId: runAccountId,
      items: planned,
      choice: effective,
      quota: channels,
      shouldStop: () => stopped.current,
      onItems: (current) => {
        setItems(current)
        setProgress({
          completed: current.filter((item) => item.status !== 'pending' && item.status !== 'running').length,
          total: current.length,
        })
      },
    })
    if (dismissed.current) return
    setItems(result.items)
    setStep('complete')
    // The dialog now serves another account: this run's numbers are not its
    // numbers, and a sync would load this account's aliases over it.
    if (accountId.current !== runAccountId) return
    for (const channel of ICLOUD_ALIAS_CHANNEL_ORDER) {
      const left = result.remaining[channel]
      if (left !== undefined) applyRemaining(channel, left)
    }
    for (const channel of result.unusable) disable(channel)
    // The run only learns about the channels it used. Availability (a session
    // the server has just marked expired) and the reset time come from here.
    void refreshQuota()
    if (shouldResyncAfterRun(result)) await resync.current(result.created)
    else setRunError(t('本次没有创建任何隐藏邮箱。'))
  }

  function restart() {
    // Created cards already exist upstream and their previewId is spent; only
    // the unfinished ones come back, carrying what the run learned about them.
    if (useCards) drafts.restore(draftsAfterRun(drafts.drafts, items))
    setItems([])
    setProgress({ completed: 0, total: 0 })
    setRunError('')
    setStep('form')
  }

  function idleSummary(): string {
    // Not a budget problem: waiting for the window to roll over changes
    // nothing, the credentials themselves have to be fixed.
    if (!hasUsableAliasChannel(account)) return aliasChannelBlockedMessage(account)
    if (maximum >= 1) return t('创建项目 {count}/{max}', { count, max: maximum })
    if (unusable.length && !usable.length) return t('登录态已失效，请在账号设置中更新后再创建。')
    return resetsAt === undefined
      ? t('本小时额度已用完')
      : t('本小时额度已用完，{time} 恢复', { time: clockTime(resetsAt) })
  }

  const summary = batchSummary(items)
  const announcement = step !== 'complete' ? '' : [
    t('创建已结束：{success} 个成功，{failed} 个失败。', summary),
    summary.unknown ? t('{unknown} 个结果未知。', summary) : '',
    summary.skipped ? t('{skipped} 个未创建。', summary) : '',
  ].filter(Boolean).join(' ')

  return (
    <form ref={formRef} className="icloud-form icloud-alias-batch-form"
      onSubmit={(event) => void submit(event)}>
      <div className="icloud-alias-batch-toolbar">
        <div className="icloud-alias-batch-summary">
          <span>{running || step === 'complete' ? t('创建进度 {completed}/{total}', progress) : idleSummary()}</span>
          <progress ref={progressRef} tabIndex={-1} className={running ? 'is-active' : ''}
            max={progress.total || 1} value={progress.completed}
            aria-label={t('创建进度')} aria-hidden={!running} />
        </div>
        {step === 'form' && bothChannels && <div className="icloud-alias-channel-switch"
          role="group" aria-label={t('创建通道')}>
          {(['auto', 'apple_account', 'icloud_web'] as const).map((option) => (
            <button type="button" key={option} disabled={running}
              aria-pressed={choice === option}
              onClick={() => setChoice(option)}>{t(CHOICE_LABELS[option])}</button>
          ))}
        </div>}
        {step === 'form' && useCards && <ICloudAliasDraftActions count={drafts.drafts.length}
          maximum={Math.max(1, maximum)} disabled={drafts.busy || running} onAdd={drafts.add} />}
      </div>

      {step === 'form' ? useCards
        ? <ICloudAliasDraftCards drafts={drafts.drafts} disabled={running}
          canPreview={maximum > 0}
          onPreview={drafts.preview} onRemove={drafts.remove} onLabel={drafts.setLabel} />
        : <ICloudAliasQuantityFields quantity={count} maximum={maximum} baseLabel={baseLabel}
          disabled={running} onQuantity={setQuantity} onBaseLabel={setBaseLabel} />
        : <ICloudAliasBatchProgress items={items} complete={step === 'complete'}
          resetTime={resetsAt === undefined ? '' : clockTime(resetsAt)} />}

      {step === 'form' && <p className="icloud-alias-quota">
        {channels.filter((quota) => quota.available).map((quota) => (
          <span key={quota.channel}>
            {t(quota.channel === 'apple_account' ? '新接口本小时剩余 {remaining}/{limit}' : '旧接口本小时剩余 {remaining}/{limit}',
              { remaining: quota.remaining, limit: quota.limit })}{' '}
          </span>
        ))}
        {estimated && <span>{quotaError
          ? t('（额度为估算值，无法与 Apple 核对）')
          : t('（额度为估算值，正在与 Apple 核对）')}</span>}
      </p>}

      {runError && <p className="inline-error" role="alert"><AlertCircle size={15} />{t(runError)}</p>}
      {/* Present from the first render: a live region that arrives with its
          text already inside is often not announced at all. Worded apart from
          the visible summary, which stays plain text. */}
      <p className="sr-only" role="status">{announcement}</p>

      <footer>
        {step === 'complete' && <button className="button button--secondary" type="button"
          onClick={restart}><RotateCcw size={15} />{t('继续创建')}</button>}
        <button ref={doneRef} className="button button--secondary" type="button" onClick={close}>
          {t(step === 'complete' ? '完成' : running ? '停止并关闭' : '取消')}
        </button>
        {step !== 'complete' && <button className="button button--primary"
          disabled={closing || running || maximum < 1 || (useCards && drafts.busy)}>
          {running ? <Spinner /> : <Plus size={15} />}
          {running
            ? t('正在创建 {completed}/{total}', progress)
            : t('创建 {count} 个', { count })}
        </button>}
      </footer>
    </form>
  )
}
