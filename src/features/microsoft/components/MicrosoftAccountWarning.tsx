import { AlertCircle, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { api, type MicrosoftAccount } from '../../../shared/api'
import { t } from '../../../shared/i18n'
import {
  microsoftAccountsNeedingAttention,
  verifyMicrosoftAccounts,
  type MicrosoftVerifyOutcome,
} from '../model/microsoft-verify'

export function MicrosoftAccountWarning({ accounts, onVerified }: {
  accounts: MicrosoftAccount[]
  onVerified: (outcome: MicrosoftVerifyOutcome) => Promise<void>
}) {
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const failing = microsoftAccountsNeedingAttention(accounts)
  if (!failing.length) return null

  async function verifyAll() {
    const accountIds = failing.map(({ id }) => id)
    setProgress({ done: 0, total: accountIds.length })
    try {
      const outcome = await verifyMicrosoftAccounts(accountIds, (accountId) => api.verifyMicrosoft(accountId),
        (done) => setProgress({ done, total: accountIds.length }))
      await onVerified(outcome)
    } finally { setProgress(null) }
  }

  return <div className="gmail-partial-error">
    <AlertCircle size={15} />
    <span className="gmail-partial-error__text" role="status">
      {t('{count} 个 Microsoft 账号需要处理，其他账号仍可继续使用。', { count: failing.length })}</span>
    <button className="gmail-partial-error__action" type="button" disabled={Boolean(progress)}
      onClick={() => void verifyAll()}>
      {progress ? <LoaderCircle className="spin" size={13} /> : <ShieldCheck size={13} />}
      {progress ? t('正在验证 {done}/{total}…', progress) : t('全部验证')}</button>
  </div>
}
