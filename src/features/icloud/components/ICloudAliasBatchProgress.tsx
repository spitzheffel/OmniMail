import { AlertCircle, Check, CircleQuestionMark, CircleSlash, LoaderCircle } from 'lucide-react'
import { t } from '../../../shared/i18n'
import {
  aliasItemHeadline,
  batchSummary,
  type AliasBatchItem,
  type AliasItemStatus,
} from '../model/icloud-alias-batch'

const STATUS_TEXT: Record<AliasItemStatus, string> = {
  pending: '等待创建',
  running: '正在创建',
  success: '创建成功',
  error: '创建失败',
  skipped: '已跳过',
  unknown: '结果未知',
}

function StatusIcon({ status }: { status: AliasItemStatus }) {
  if (status === 'running') return <LoaderCircle className="spin" size={15} aria-hidden="true" />
  if (status === 'success') return <Check size={16} aria-hidden="true" />
  if (status === 'error') return <AlertCircle size={15} aria-hidden="true" />
  if (status === 'skipped') return <CircleSlash size={15} aria-hidden="true" />
  if (status === 'unknown') return <CircleQuestionMark size={15} aria-hidden="true" />
  return null
}

/**
 * Rows stay in place once they succeed and fill in with the address that was
 * actually created, instead of animating away.
 *
 * No row is a live region and no row error is an alert: a channel running dry
 * settles every remaining row in one commit, which turned into a burst of
 * announcements. The form announces the outcome once instead, from a region
 * that already exists when the text arrives.
 */
export function ICloudAliasBatchProgress({ items, complete, resetTime = '' }: {
  items: AliasBatchItem[]
  complete: boolean
  /** When the spent budget comes back, already formatted; empty when unknown. */
  resetTime?: string
}) {
  const summary = batchSummary(items)
  const clean = !summary.failed && !summary.skipped && !summary.unknown
  return (
    <>
      <div className="icloud-alias-drafts is-running">
        {items.map((item, index) => (
          <section className={`icloud-alias-preview is-${item.status}`} key={item.id}
            data-alias-draft-id={item.id} role="group"
            aria-labelledby={`icloud-alias-item-${item.id}`}
            aria-busy={item.status === 'running'}>
            <div>
              <span id={`icloud-alias-item-${item.id}`}>
                {t('隐藏邮箱 {index}', { index: index + 1 })}
                {item.status === 'success' && <span className="icloud-alias-channel-tag">
                  {t(item.channel === 'apple_account' ? '新接口' : '旧接口')}
                </span>}
              </span>
              <span className={`icloud-alias-creation-status is-${item.status}`}>
                <StatusIcon status={item.status} />{t(STATUS_TEXT[item.status])}
              </span>
            </div>
            <strong>{aliasItemHeadline(item)}</strong>
            {item.email && item.label && <small>{item.label}</small>}
            {item.error && <small className="inline-error">
              <AlertCircle size={15} aria-hidden="true" />{t(item.error)}
            </small>}
          </section>
        ))}
      </div>
      {complete && <div className="icloud-alias-complete">
        <h4 className={clean ? 'is-clean' : undefined}>
          {clean ? <Check size={16} aria-hidden="true" /> : <AlertCircle size={16} aria-hidden="true" />}
          {t('成功 {success} 个，失败 {failed} 个。', summary)}
        </h4>
        {summary.unknown > 0 && <p>{t('另有 {unknown} 个结果未知，请以同步后的地址列表为准。', summary)}</p>}
        {/* Budget, cancellation or a channel whose sign-in was rejected: the
            rows carry the reason, the summary only counts. */}
        {summary.skipped > 0 && <p>{t('另有 {skipped} 个未创建，原因见各项说明。', summary)}</p>}
        {summary.skipped > 0 && resetTime && <p>{t('额度将于 {time} 恢复。', { time: resetTime })}</p>}
        {summary.success > 0 && <p>{t('新接口 {apple} 个 · 旧接口 {web} 个', summary)}</p>}
      </div>}
    </>
  )
}
