import { AlertCircle, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { t } from '../../../shared/i18n'
import type { AliasDraft } from '../model/icloud-alias-batch'
import { ICloudAliasLabelPresets } from './ICloudAliasLabelPresets'

function Spinner() {
  return <LoaderCircle className="spin" size={15} aria-hidden="true" />
}

/**
 * Legacy cookie channel. Unlike the Apple path, the address is known before
 * submitting, so each item stays a card the user can reroll or drop.
 */
export function ICloudAliasDraftCards({ drafts, disabled, onPreview, onRemove, onLabel }: {
  drafts: AliasDraft[]
  disabled: boolean
  onPreview: (id: string) => void
  onRemove: (id: string) => void
  onLabel: (id: string, label: string) => void
}) {
  const [activeId, setActiveId] = useState(drafts[0]?.id || '')
  const active = drafts.find((draft) => draft.id === activeId) || drafts[0]
  const busy = drafts.some((draft) => draft.loading)

  return (
    <>
      <div className="icloud-alias-drafts">
        {drafts.map((draft, index) => (
          <section className="icloud-alias-preview" key={draft.id} data-alias-draft-id={draft.id}
            role="group" aria-labelledby={`icloud-alias-draft-${draft.id}`} aria-busy={draft.loading}>
            <div>
              <span id={`icloud-alias-draft-${draft.id}`}>{t('隐藏邮箱 {index}', { index: index + 1 })}</span>
              <span className="icloud-alias-preview-actions">
                <button className="icloud-alias-draft-action" type="button"
                  disabled={busy || disabled}
                  aria-label={t('为隐藏邮箱 {index} 换一个地址', { index: index + 1 })}
                  data-tooltip={t('换一个')}
                  onClick={() => onPreview(draft.id)}>
                  {draft.loading ? <Spinner /> : <RefreshCw size={15} />}
                </button>
                {drafts.length > 1 && <button className="icloud-alias-draft-action is-danger"
                  type="button" disabled={disabled}
                  aria-label={t('移除第 {index} 个隐藏邮箱', { index: index + 1 })}
                  data-tooltip={t('移除')}
                  onClick={() => onRemove(draft.id)}>
                  <Trash2 size={15} />
                </button>}
              </span>
            </div>
            <strong aria-live="polite">{draft.email
              || t(draft.loading ? '正在生成候选地址…' : '暂时无法生成地址')}</strong>
            <label>
              <span>{t('用途标签（可选）')}</span>
              <input value={draft.label} maxLength={80} disabled={disabled}
                data-modal-autofocus={index === 0 || undefined}
                onFocus={() => setActiveId(draft.id)}
                onChange={(event) => onLabel(draft.id, event.target.value)}
                placeholder={t('留空则由系统自动生成')} />
            </label>
            {draft.error && <small className="inline-error" role="alert">
              <AlertCircle size={15} />{t(draft.error)}
            </small>}
          </section>
        ))}
      </div>
      <ICloudAliasLabelPresets value={active?.label || ''} disabled={disabled}
        onPick={(label) => active && onLabel(active.id, label)} />
    </>
  )
}

export function ICloudAliasDraftActions({ count, maximum, disabled, onAdd }: {
  count: number
  maximum: number
  disabled: boolean
  onAdd: (amount: number) => void
}) {
  const full = count >= maximum
  return (
    <span className="icloud-alias-preview-actions">
      <button className="button button--secondary" type="button" disabled={disabled || full}
        onClick={() => onAdd(1)}><Plus size={15} />{t('增加邮箱')}</button>
      <button className="button button--secondary" type="button" disabled={disabled || full}
        onClick={() => onAdd(maximum - count)}>{t('加到上限')}</button>
    </span>
  )
}