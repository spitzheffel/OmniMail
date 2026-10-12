import { ApiError } from '../../../shared/api/api-client'
import { t } from '../../../shared/i18n'
import type { ICloudAppleTwoFactor } from '../api/icloud-api-client'

/**
 * The server's word for a sign-in whose challenge can no longer be answered:
 * expired, out of attempts, or spent on a code Apple took before a later step
 * failed. The form has to start the sign-in over; re-sending the code cannot work.
 */
export const APPLE_LOGIN_CHALLENGE_GONE = 'apple_login_challenge_gone'

export function appleLoginChallengeGone(error: unknown): boolean {
  return error instanceof ApiError && error.code === APPLE_LOGIN_CHALLENGE_GONE
}

/** The masked number the SMS went to, when Apple named one. */
export function appleTwoFactorPhone(challenge: ICloudAppleTwoFactor): string {
  return challenge.phones.find((phone) => phone.id === challenge.phoneId)?.number || ''
}

/** Where to look for the code, for the notice shown as the code field appears. */
export function appleTwoFactorNotice(challenge: ICloudAppleTwoFactor): string {
  if (challenge.method !== 'phone') return t('请输入受信任设备上的验证码')
  const phone = appleTwoFactorPhone(challenge)
  return phone ? t('验证码已通过短信发送到 {phone}', { phone }) : t('验证码已通过短信发送到受信任手机号')
}
