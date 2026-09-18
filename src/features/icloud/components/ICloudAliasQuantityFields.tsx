import { Minus, Plus } from 'lucide-react'
import { useState } from 'react'
import { t } from '../../../shared/i18n'
import { aliasBatchLabel } from '../model/icloud-alias-batch'
import { ICloudAliasLabelPresets } from './ICloudAliasLabelPresets'

/**
 * The Apple Account path generates addresses server-side, so there is nothing
 * to preview per item. One quantity plus one base label replaces the old wall
 * of identical empty cards.
 */
export function ICloudAliasQuantityFields({ quantity, maximum, baseLabel, disabled, onQuantity, onBaseLabel }: {
  quantity: number
  maximum: number
  baseLabel: string
  disabled: boolean
  onQuantity: (value: number) => void
  onBaseLabel: (value: string) => void
}) {
  const clamp = (value: number) => Math.max(1, Math.min(maximum || 1, Math.floor(value) || 1))
  // Clamping on every keystroke would turn a cleared field straight back into
  // "1", so the next digit lands behind it ("15" for an intended "5"). Let the
  // empty string stand until the user types a digit or leaves the field.
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (value: number) => { setDraft(null); onQuantity(clamp(value)) }
  const preview = aliasBatchLabel(baseLabel, 1, quantity)

  return (
    <>
      <div className="icloud-alias-quantity">
        <span id="icloud-alias-quantity-label">{t('创建数量')}</span>
        <div className="icloud-alias-quantity-control">
          <button className="icloud-alias-draft-action" type="button"
            disabled={disabled || quantity <= 1} aria-label={t('减少一个')}
            onClick={() => commit(quantity - 1)}><Minus size={15} /></button>
          <input type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)}
            value={draft ?? quantity} disabled={disabled || maximum < 1}
            aria-labelledby="icloud-alias-quantity-label" data-modal-autofocus
            onChange={(event) => (event.target.value === ''
              ? setDraft('')
              : commit(Number(event.target.value)))}
            // Implicit submission fires straight from this field. A blank draft
            // has to resolve back to the number the button promises first, or
            // Enter silently creates the pre-edit quantity over an empty field.
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || draft === null) return
              event.preventDefault()
              setDraft(null)
            }}
            onBlur={() => setDraft(null)} />
          <button className="icloud-alias-draft-action" type="button"
            disabled={disabled || quantity >= maximum} aria-label={t('增加一个')}
            onClick={() => commit(quantity + 1)}><Plus size={15} /></button>
          <button className="button button--secondary" type="button"
            disabled={disabled || maximum < 1 || quantity >= maximum}
            onClick={() => commit(maximum)}>{t('加到上限')}</button>
        </div>
      </div>
      <label>
        <span>{t('基础标签（可选）')}</span>
        <input value={baseLabel} maxLength={60} disabled={disabled}
          placeholder={t('留空则由系统自动生成')}
          onChange={(event) => onBaseLabel(event.target.value.slice(0, 60))} />
      </label>
      <p className="icloud-form-note">{preview
        ? t('将依次命名为 {first} … {last}', {
          first: preview, last: aliasBatchLabel(baseLabel, quantity, quantity),
        })
        : t('留空标签时由 Apple 自动命名。')}</p>
      <ICloudAliasLabelPresets value={baseLabel} disabled={disabled} onPick={onBaseLabel} />
    </>
  )
}
