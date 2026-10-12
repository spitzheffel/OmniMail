import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ICloudAccount } from '../../../shared/api'
import type { ICloudAppleTwoFactor } from '../api/icloud-api-client'
import { ICloudAppleAccountLogin } from './ICloudAppleAccountLogin'
import { ICloudAppleTwoFactorFields } from './ICloudAppleTwoFactorFields'

function account(overrides: Partial<ICloudAccount>): ICloudAccount {
  return {
    id: 'icloud-1', name: 'Personal', realEmail: '', icloudEmail: '', host: 'icloud.com', status: 'active',
    aliasTotal: 0, aliasActive: 0, lastValidated: '', lastError: '', createdAt: '',
    hasCookies: false, hasAppPassword: true, hasAppleAccount: false,
    appleAccountStatus: 'none', appleAccountExpiresAt: '',
    ...overrides,
  }
}

function panel(overrides: Partial<ICloudAccount>): string {
  return renderToStaticMarkup(
    <ICloudAppleAccountLogin account={account(overrides)} onChanged={async () => undefined} onNotice={() => undefined} />,
  )
}

function count(html: string, text: string): number {
  return html.split(text).length - 1
}

describe('ICloudAppleAccountLogin', () => {
  it('lets a phone-number Apple ID through the browser\'s own validation', () => {
    // type="email" made the browser refuse anything without an "@" before the
    // form could submit, though the server signs phone numbers in too.
    const html = panel({})

    expect(html).toMatch(/<input type="text"[^>]*autocomplete="username"/i)
    expect(html).not.toContain('type="email"')
  })

  it('offers removing a dead session beside the sign-in, once', () => {
    const html = panel({ hasAppleAccount: true, appleAccountStatus: 'expired' })

    expect(html).toContain('需要重新登录')
    expect(count(html, '移除 Apple Account')).toBe(1)
  })

  it('offers refresh and removal for a working session', () => {
    const html = panel({ hasAppleAccount: true, appleAccountStatus: 'active' })

    expect(html).toContain('刷新登录态')
    expect(count(html, '移除 Apple Account')).toBe(1)
  })
})

describe('ICloudAppleTwoFactorFields', () => {
  function fields(overrides: Partial<ICloudAppleTwoFactor>): string {
    const challenge: ICloudAppleTwoFactor = {
      needs2FA: true, challengeId: 'challenge-1', expiresAt: '2026-10-10T10:10:00.000Z',
      method: 'trusted_device', phones: [], ...overrides,
    }
    return renderToStaticMarkup(
      <ICloudAppleTwoFactorFields accountId="icloud-1" challenge={challenge} code="" disabled={false}
        onCode={() => undefined} onChallenge={() => undefined} onError={() => undefined} />,
    )
  }

  it('offers SMS instead when Apple has a trusted phone', () => {
    const html = fields({ phones: [{ id: 7, number: '+86 ••• •••• ••12' }] })

    expect(html).toContain('受信任设备验证码')
    expect(html).toContain('改用短信接收验证码')
    // One phone needs no picker.
    expect(html).not.toContain('<select')
  })

  it('asks which phone when there are several, and says where the SMS went', () => {
    const html = fields({
      method: 'phone', phoneId: 9,
      phones: [{ id: 7, number: '+86 ••• •••• ••12' }, { id: 9, number: '+1 (•••) •••-••34' }],
    })

    expect(html).toContain('短信验证码')
    expect(html).toContain('验证码已通过短信发送到 +1 (•••) •••-••34')
    expect(html).toContain('重新发送短信')
    expect(count(html, '<option')).toBe(2)
  })

  it('offers no SMS when Apple named no phone', () => {
    expect(fields({})).not.toContain('短信')
  })
})
