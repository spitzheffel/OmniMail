import { describe, expect, it, vi } from 'vitest'
import { startAppleAccountLogin, submitAppleAccountLogin2FA } from './icloud-account-auth'
import type { Env, SessionUser } from '../../app/types'

const user = {
  id: 'user-1',
  email: 'user@example.com',
  displayName: 'User',
  role: 'user',
  mailboxLimit: 1,
  storageQuotaBytes: 1024,
  storageUsedBytes: 0,
  canCreateMailboxes: false,
  canReply: false,
  canTranslate: false,
  temporaryExpiresAt: null,
} satisfies SessionUser

function request(body: unknown): Request {
  return new Request('https://mail.example.com/api/icloud/accounts/account-1/apple-account/login/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('Apple Account login validation', () => {
  it('rejects missing credentials before contacting Apple', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const response = await startAppleAccountLogin(
      {} as Env,
      user,
      'account-1',
      request({ appleId: '', password: '' }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: '请填写 Apple ID 和密码。' })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })

  it('rejects malformed two-factor codes before reading challenge state', async () => {
    const response = await submitAppleAccountLogin2FA(
      {} as Env,
      user,
      'account-1',
      new Request('https://mail.example.com', {
        method: 'POST',
        body: JSON.stringify({ challengeId: 'challenge-1', code: '12' }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: '请输入 6 位验证码。' })
  })
})
