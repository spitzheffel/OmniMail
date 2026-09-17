import { t } from '../../../shared/i18n'

const PRESETS = ['购物', '社交', '订阅', '工作', '临时使用'] as const

/** Shared by the quantity form (sets the base label) and the preview cards. */
export function ICloudAliasLabelPresets({ value, disabled, onPick }: {
  value: string
  disabled: boolean
  onPick: (label: string) => void
}) {
  return (
    <div className="icloud-label-presets" role="group" aria-label={t('快捷用途标签')}>
      <button type="button" disabled={disabled} aria-pressed={!value}
        onClick={() => onPick('')}>{t('自动生成')}</button>
      {PRESETS.map((preset) => (
        <button type="button" key={preset} disabled={disabled} aria-pressed={value === t(preset)}
          onClick={() => onPick(t(preset))}>{t(preset)}</button>
      ))}
    </div>
  )
}
