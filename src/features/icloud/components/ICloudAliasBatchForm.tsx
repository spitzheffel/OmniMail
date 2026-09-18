import { AlertCircle, LoaderCircle, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { api, type ICloudAccount } from '../../../shared/api'
import { t } from '../../../shared/i18n'
import '../styles/icloud-alias-batch.css'
import { useICloudAliasDrafts } from '../hooks/useICloudAliasDrafts'
import { useICloudAliasQuota } from '../hooks/useICloudAliasQuota'
import {
  availableChannels,
  batchSummary,
  buildAliasBatch,
  draftsToBatch,
  planAliasBatch,
  remainingFor,
  type AliasBatchItem,
  type ICloudAliasChannelChoice,
} from '../model/icloud-alias-batch'
import { runAliasBatch, type CreatedAlias } from '../model/icloud-alias-batch-run'
import { ICloudAliasBatchProgress } from './ICloudAliasBatchProgress'
import { ICloudAliasDraftActions, ICloudAliasDraftCards } from './ICloudAliasDraftCards'
import { ICloudAliasQuantityFields } from './ICloudAliasQuantityFields'

type BatchStep = 'form' | 'running' | 'complete'

const CHOICE_LABELS: Record<ICloudAliasChannelChoice, string> = {
  auto: '自动',
  apple_account: 'Apple Account',
  icloud_web: 'iCloud Cookie',
}

function Spinner() {
  return <LoaderCircle className="spin" size={15} aria-hidden="true" />
}

export function ICloudAliasBatchForm({ account, close, onCreated }: {
  account: ICloudAccount
  close: () => void
  onCreated: (aliases: CreatedAlias[]) => Promise<void>
}) {
  const { channels, estimated, error: quotaError, applyRemaining } = useICloudAliasQuota(account)
  const [choice, setChoice] = useState<ICloudAliasChannelChoice>('auto')
  const [quantity, setQuantity] = useState(1)
  const [baseLabel, setBaseLabel] = useState('')
  const [step, setStep] = useState<BatchStep>('form')
  const [items, setItems] = useState<AliasBatchItem[]>([])
  const [progress, setProgress] = useState({ completed: 0, total: 0 })
  const [runError, setRunError] = useState('')
  const stopped = useRef(false)

  const usable = useMemo(() => availableChannels(channels), [channels])
  const bothChannels = usable.length > 1
  const effective: ICloudAliasChannelChoice = bothChannels ? choice : usable[0] || 'apple_account'
  // Preview cards only earn their place where the address is known up front.
  const useCards = effective === 'icloud_web'
  const maximum = Math.max(0, remainingFor(channels, effective))
  const running = step === 'running'

  const drafts = useICloudAliasDrafts(account.id, Math.max(1, maximum), useCards)
  const count = useCards ? drafts.drafts.length : Math.min(quantity, Math.max(1, maximum))

  useEffect(() => {
    setQuantity((value) => Math.max(1, Math.min(value, Math.max(1, maximum))))
  }, [maximum])

  // Closing mid-run leaves the loop to finish its current item and stop.
  useEffect(() => () => { stopped.current = true }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (running || maximum < 1) return
    const planned = useCards
      ? draftsToBatch(drafts.drafts)
      : buildAliasBatch(
        planAliasBatch(count, channels, effective),
        baseLabel,
        () => crypto.randomUUID(),
      )
    if (!planned.length) return
    stopped.current = false
    setRunError('')
    setItems(planned)
    setProgress({ completed: 0, total: planned.length })
    setStep('running')
    const result = await runAliasBatch({
      api,
      accountId: account.id,
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
    setItems(result.items)
    applyRemaining('apple_account', result.remaining.apple_account)
    applyRemaining('icloud_web', result.remaining.icloud_web)
    setStep('complete')
    if (result.created.length) await onCreated(result.created)
    else if (batchSummary(result.items).failed === 0) setRunError(t('本次没有创建任何隐藏邮箱。'))
  }

  function restart() {
    // Created cards already exist upstream and their previewId is spent; only
    // the unfinished ones come back for another go.
    if (useCards) {
      drafts.prune(new Set(items.filter((item) => item.status !== 'success').map((item) => item.id)))
    }
    setItems([])
    setProgress({ completed: 0, total: 0 })
    setRunError('')
    setStep('form')
  }

  const summaryText = running || step === 'complete'
    ? t('创建进度 {completed}/{total}', progress)
    : maximum < 1
      ? t('本小时额度已用完')
      : t('创建项目 {count}/{max}', { count, max: maximum })

  return (
    <form className="icloud-form icloud-alias-batch-form" onSubmit={(event) => void submit(event)}>
      <div className="icloud-alias-batch-toolbar">
        <div className="icloud-alias-batch-summary">
          <span>{summaryText}</span>
          <progress className={running ? 'is-active' : ''} max={progress.total || 1}
            value={progress.completed} aria-label={t('创建进度')} aria-hidden={!running} />
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
          onPreview={drafts.preview} onRemove={drafts.remove} onLabel={drafts.setLabel} />
        : <ICloudAliasQuantityFields quantity={count} maximum={maximum} baseLabel={baseLabel}
          disabled={running} onQuantity={setQuantity} onBaseLabel={setBaseLabel} />
        : <ICloudAliasBatchProgress items={items} complete={step === 'complete'} />}

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

      <footer>
        {step === 'complete' && <button className="button button--secondary" type="button"
          onClick={restart}><RotateCcw size={15} />{t('继续创建')}</button>}
        <button className="button button--secondary" type="button" onClick={close}>
          {t(step === 'complete' ? '完成' : running ? '停止并关闭' : '取消')}
        </button>
        {step !== 'complete' && <button className="button button--primary"
          disabled={running || maximum < 1 || (useCards && drafts.busy)}>
          {running ? <Spinner /> : <Plus size={15} />}
          {running
            ? t('正在创建 {completed}/{total}', progress)
            : t('创建 {count} 个', { count })}
        </button>}
      </footer>
    </form>
  )
}
