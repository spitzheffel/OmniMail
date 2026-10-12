import { AlertCircle, Check, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, type ICloudAccount } from '../../../shared/api'
import { errorMessage } from '../../../shared/api/errorMessage'
import { t } from '../../../shared/i18n'
import type { ICloudAppleTwoFactor } from '../api/icloud-api-client'
import { appleLoginChallengeGone, appleTwoFactorNotice } from '../model/icloud-apple-login'
import { ICloudAppleTwoFactorFields } from './ICloudAppleTwoFactorFields'

function Spinner() {
  return <LoaderCircle className="spin" size={15} aria-hidden="true" />
}

/** Login form for Apple's account-management session. Password is cleared after each request. */
export function ICloudAppleAccountLogin({ account, onChanged, onNotice }: {
  account: ICloudAccount
  onChanged: () => Promise<void>
  onNotice: (message: string) => void
}) {
  const [appleId, setAppleId] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [challenge, setChallenge] = useState<ICloudAppleTwoFactor | null>(null)
  const [busy, setBusy] = useState<'login' | '2fa' | 'refresh' | 'delete' | ''>('')
  const [error, setError] = useState('')

  /** A challenge that can no longer be answered sends the form back to the password step. */
  function fail(failure: unknown) {
    setError(errorMessage(failure))
    if (appleLoginChallengeGone(failure)) { setChallenge(null); setCode('') }
  }

  async function startLogin(event: FormEvent) {
    event.preventDefault()
    setBusy('login'); setError('')
    try {
      const result = await api.startICloudAppleAccountLogin(account.id, appleId.trim(), password)
      setPassword('')
      if (result.needs2FA) {
        setChallenge(result)
        onNotice(appleTwoFactorNotice(result))
      } else {
        setChallenge(null)
        await onChanged()
        onNotice(t('Apple Account 已连接'))
      }
    } catch (loginError) {
      setPassword('')
      fail(loginError)
    } finally { setBusy('') }
  }

  async function completeTwoFactor(event: FormEvent) {
    event.preventDefault()
    if (!challenge) return
    setBusy('2fa'); setError('')
    try {
      await api.completeICloudAppleAccountLogin(account.id, challenge.challengeId, code.trim())
      setCode(''); setChallenge(null)
      await onChanged()
      onNotice(t('Apple Account 已连接'))
    } catch (twoFactorError) { fail(twoFactorError) } finally { setBusy('') }
  }

  async function refresh() {
    setBusy('refresh'); setError('')
    try { await api.refreshICloudAppleAccount(account.id); await onChanged(); onNotice(t('Apple Account 登录态已刷新')) }
    catch (refreshError) {
      setError(errorMessage(refreshError))
      // A failed refresh may still have stored a rotated scnt or marked the
      // session expired; re-read it so the dialog offers the right actions.
      await onChanged().catch(() => undefined)
    } finally { setBusy('') }
  }

  async function remove() {
    setBusy('delete'); setError('')
    try { await api.deleteICloudAppleAccount(account.id); await onChanged(); onNotice(t('Apple Account 已移除')) }
    catch (deleteError) { setError(errorMessage(deleteError)) } finally { setBusy('') }
  }

  const connected = account.hasAppleAccount && account.appleAccountStatus === 'active'
  const needsLogin = account.appleAccountStatus === 'error' || account.appleAccountStatus === 'expired'
  const expires = account.appleAccountExpiresAt ? new Date(account.appleAccountExpiresAt) : null
  const expiresText = expires && Number.isFinite(expires.getTime())
    ? expires.toLocaleString() : ''
  // Offered beside the sign-in too: a dead session can be dropped without signing in again first.
  const removeButton = account.hasAppleAccount && <button className="button icloud-danger-button" type="button"
    disabled={Boolean(busy)} onClick={() => void remove()}>
    {busy === 'delete' ? <Spinner /> : <Trash2 size={15} />}{t('移除 Apple Account')}
  </button>

  return (
    <section className="icloud-form icloud-apple-account-form">
      <h3><KeyRound size={17} />{t('Apple Account 登录')} <small>{connected ? t('已连接') : t(needsLogin ? '需要重新登录' : '未配置')}</small></h3>
      {connected ? <>
        <p className="icloud-form-note"><ShieldCheck size={15} />{t('新接口创建已启用，可减少无效预览请求。')}{expiresText && <> {t('登录态有效至 {expiresAt}', { expiresAt: expiresText })}</>}</p>
        <div className="icloud-apple-account-actions">
          <button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void refresh()}>
            {busy === 'refresh' ? <Spinner /> : <RefreshCw size={15} />}{t('刷新登录态')}
          </button>
          {removeButton}
        </div>
      </> : challenge ? <form onSubmit={(event) => void completeTwoFactor(event)}>
        <ICloudAppleTwoFactorFields accountId={account.id} challenge={challenge} code={code} disabled={Boolean(busy)}
          onCode={setCode} onChallenge={(next) => { setChallenge(next); setError(''); onNotice(appleTwoFactorNotice(next)) }}
          onError={fail} />
        <button className="button button--primary" disabled={busy === '2fa'}>{busy === '2fa' ? <Spinner /> : <Check size={15} />}{t('验证并完成登录')}</button>
      </form> : <form onSubmit={(event) => void startLogin(event)}>
        {/* Not type="email": an Apple ID can be a phone number. */}
        <label><span>Apple ID</span><input type="text" inputMode="email" value={appleId} required autoComplete="username"
          data-modal-autofocus onChange={(event) => setAppleId(event.target.value)} placeholder={t('邮箱或手机号')} /></label>
        <label><span>{t('Apple ID 密码')}</span><input type="password" value={password} required autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)} /></label>
        <p className="icloud-form-note"><ShieldCheck size={15} />{t('密码只用于本次登录请求，不会保存或回传。')}</p>
        <div className="icloud-apple-account-actions">
          <button className="button button--secondary" disabled={Boolean(busy)}>{busy === 'login' ? <Spinner /> : <KeyRound size={15} />}{t('连接 Apple Account')}</button>
          {removeButton}
        </div>
      </form>}
      {error && <p className="inline-error" role="alert"><AlertCircle size={15} />{t(error)}</p>}
    </section>
  )
}
