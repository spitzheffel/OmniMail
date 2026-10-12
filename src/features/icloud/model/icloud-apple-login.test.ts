import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../shared/api/api-client'
import type { ICloudAppleTwoFactor } from '../api/icloud-api-client'
import { appleLoginChallengeGone, appleTwoFactorNotice, appleTwoFactorPhone } from './icloud-apple-login'

function challenge(overrides: Partial<ICloudAppleTwoFactor> = {}): ICloudAppleTwoFactor {
  return {
    needs2FA: true, challengeId: 'challenge-1', expiresAt: '2026-10-10T10:10:00.000Z',
    method: 'trusted_device', phones: [{ id: 7, number: '+86 ••• •••• ••12' }], ...overrides,
  }
}

describe('appleLoginChallengeGone', () => {
  it('recognises only the server\'s word for a challenge that cannot be answered any more', () => {
    expect(appleLoginChallengeGone(new ApiError('expired', 410, undefined, undefined, 'apple_login_challenge_gone'))).toBe(true)
    // A wrong code leaves the challenge usable: the form must keep it.
    expect(appleLoginChallengeGone(new ApiError('验证码不正确，请重新输入。', 422))).toBe(false)
    expect(appleLoginChallengeGone(new Error('apple_login_challenge_gone'))).toBe(false)
  })
})

describe('appleTwoFactorNotice', () => {
  it('points at the trusted device unless the code went by SMS', () => {
    expect(appleTwoFactorNotice(challenge())).toBe('请输入受信任设备上的验证码')
  })

  it('names the masked number the SMS went to', () => {
    const sms = challenge({ method: 'phone', phoneId: 7 })

    expect(appleTwoFactorPhone(sms)).toBe('+86 ••• •••• ••12')
    expect(appleTwoFactorNotice(sms)).toBe('验证码已通过短信发送到 +86 ••• •••• ••12')
  })

  it('still says SMS when Apple named no number', () => {
    expect(appleTwoFactorNotice(challenge({ method: 'phone', phoneId: 3 })))
      .toBe('验证码已通过短信发送到受信任手机号')
  })
})
