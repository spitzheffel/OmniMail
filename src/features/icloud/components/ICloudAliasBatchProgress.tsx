import { AlertCircle, Check, CircleSlash, LoaderCircle } from 'lucide-react'
import { t } from '../../../shared/i18n'
import { batchSummary, type AliasBatchItem, type AliasItemStatus } from '../model/icloud-alias-batch'

const STATUS_TEXT: Record<AliasItemStatus, string> = {
  pending: '等待创建',
  running: '正在创建',
  success: '创建成功',
  error: '创建失败',
  skipped: '已跳过',
}

function StatusIcon({ status }: { status: AliasItemStatus }) {
  if (status === 'running') return <LoaderCircle className="spin" size={15} aria-hidden="true" />
  if (status === 'success') return <Check size={16} aria-hidden="true" />
  if (status === 'error') return <AlertCircle size={15} aria-hidden="true" />
  if (status === 'skipped') return <CircleSlash size={15} aria-hidden="true" />
  return null
}

/**
 * Rows stay in place once they succeed and fill in with the address that was
 * actually created, instead of animating away.
 */
export function ICloudAliasBatchProgress({ items, complete }: {
  items: AliasBatchItem[]
  complete: boolean
}) {
  const summary = batchSummary(items)
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
              <span className={`icloud-alias-creation-status is-${item.status}`}
                role="status" aria-live="polite">
                <StatusIcon status={item.status} />{t(STATUS_TEXT[item.status])}
              </span>
            </div>
            <strong>{item.email || (item.label ? item.label : t('等待 Apple 生成地址'))}</strong>
            {item.email && item.label && <small>{item.label}</small>}
            {item.error && <small className="inline-error" role="alert">
              <AlertCircle size={15} />{t(item.error)}
            </small>}
          </section>
        ))}
      </div>
      {complete && <div className="icloud-alias-complete" role="status" aria-live="polite">
        <h4 className={summary.failed || summary.skipped ? undefined : 'is-clean'}>
          {summary.failed || summary.skipped
            ? <AlertCircle size={16} aria-hidden="true" />
            : <Check size={16} aria-hidden="true" />}
          {t('成功 {success} 个，失败 {failed} 个。', summary)}
        </h4>
        {summary.skipped > 0 && <p>{t('另有 {skipped} 个因额度或取消未创建。', summary)}</p>}
        {summary.success > 0 && <p>{t('新接口 {apple} 个 · 旧接口 {web} 个', summary)}</p>}
      </div>}
    </>
  )
}
