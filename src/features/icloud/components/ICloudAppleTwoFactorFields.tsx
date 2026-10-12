import { LoaderCircle, MessageSquare, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { api } from '../../../shared/api'
import { t } from '../../../shared/i18n'
import type { ICloudAppleTwoFactor } from '../api/icloud-api-client'
import { appleTwoFactorNotice } from '../model/icloud-apple-login'

/**
 * The code step of an Apple Account sign-in, shared by the add-account dialog
 * and the settings panel: the code field, where the code went, and the switch
 * to SMS for an Apple ID whose trusted devices did not get it.
 */
export function ICloudAppleTwoFactorFields({ accountId, challenge, code, disabled, onCode, onChallenge, onError }: {
  accountId: string
  challenge: ICloudAppleTwoFactor
  code: string
  disabled: boolean
  onCode: (code: string) => void
  onChallenge: (challenge: ICloudAppleTwoFactor) => void
  onError: (error: unknown) => void
}) {
  const [phoneId, setPhoneId] = useState(challenge.phoneId ?? challenge.phones[0]?.id ?? 0)
  const [sending, setSending] = useState(false)
  const expires = new Date(challenge.expiresAt)

  async function sendSms() {
    setSending(true)
    try { onChallenge(await api.sendICloudAppleAccountLoginSms(accountId, challenge.challengeId, phoneId)) }
    catch (error) { onError(error) }
    finally { setSending(false) }
  }

  return <>
    <label><span>{t(challenge.method === 'phone' ? '短信验证码' : '受信任设备验证码')}</span><input value={code}
      inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={6} pattern="[0-9]{6}" required
      autoFocus data-modal-autofocus onChange={(event) => onCode(event.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
    <p className="icloud-form-note"><ShieldCheck size={15} aria-hidden="true" />{appleTwoFactorNotice(challenge)}{' '}
      {Number.isFinite(expires.getTime())
        ? t('验证码将在 {expiresAt} 前有效', { expiresAt: expires.toLocaleTimeString() })
        : t('验证码有效期约 10 分钟。')}</p>
    {challenge.phones.length > 0 && <div className="icloud-apple-account-actions">
      {challenge.phones.length > 1 && <label><span>{t('接收短信的手机号')}</span>
        <select value={phoneId} disabled={disabled || sending} onChange={(event) => setPhoneId(Number(event.target.value))}>
          {challenge.phones.map((phone) => <option key={phone.id} value={phone.id}>
            {phone.number || t('手机号 {id}', { id: phone.id })}</option>)}
        </select></label>}
      <button className="button button--secondary" type="button" disabled={disabled || sending} onClick={() => void sendSms()}>
        {sending ? <LoaderCircle className="spin" size={15} aria-hidden="true" /> : <MessageSquare size={15} aria-hidden="true" />}
        {t(challenge.method === 'phone' ? '重新发送短信' : '改用短信接收验证码')}</button>
    </div>}
  </>
}
