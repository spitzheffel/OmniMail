import { describe, expect, it } from 'vitest'
import { createICloudApi } from './icloud-api-client'

describe('iCloud API client Apple Account contract', () => {
  it('starts and completes the Apple Account login flow without retaining secrets', async () => {
    const calls: Array<{ path: string; method: string; body: Record<string, unknown>; timeoutMs?: number }> = []
    const api = createICloudApi(async <T>(path: string, init: RequestInit & { timeoutMs?: number } = {}) => {
      calls.push({
        path,
        method: init.method || 'GET',
        body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
        timeoutMs: init.timeoutMs,
      })
      return {} as T
    }, JSON.stringify)

    await api.startICloudAppleAccountLogin('account/1', 'owner@example.com', 'secret')
    await api.sendICloudAppleAccountLoginSms('account/1', 'challenge/1', 7)
    await api.completeICloudAppleAccountLogin('account/1', 'challenge/1', '123456')

    // A sign-in step makes up to ten Apple calls and gives up after 90 s on the
    // server; the default 15 s would abandon one that pushes a code moments later.
    expect(calls).toEqual([
      {
        path: '/api/icloud/accounts/account%2F1/apple-account/login/start', method: 'POST',
        body: { appleId: 'owner@example.com', password: 'secret' }, timeoutMs: 120_000,
      },
      {
        path: '/api/icloud/accounts/account%2F1/apple-account/login/sms', method: 'POST',
        body: { challengeId: 'challenge/1', phoneId: 7 }, timeoutMs: 120_000,
      },
      {
        path: '/api/icloud/accounts/account%2F1/apple-account/login/2fa', method: 'POST',
        body: { challengeId: 'challenge/1', code: '123456' }, timeoutMs: 120_000,
      },
    ])
  })

  it('omits legacy preview fields for direct Apple Account creation', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const api = createICloudApi(async <T>(path: string, init: RequestInit = {}) => {
      calls.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return {} as T
    }, JSON.stringify)

    await api.createICloudAlias({ accountId: 'account-1', label: 'Shopping', channel: 'apple_account' })

    expect(calls[0]).toEqual({
      path: '/api/icloud/aliases',
      body: { accountId: 'account-1', label: 'Shopping', channel: 'apple_account' },
    })
  })

  it('waits long enough for a create that refreshes the session and then creates', async () => {
    // Up to five Apple calls of 20 s each behind the session gate: the default
    // 15 s turned aliases Apple did create into failures.
    const timeouts: Array<number | undefined> = []
    const api = createICloudApi(async <T>(_path: string, init: RequestInit & { timeoutMs?: number } = {}) => {
      timeouts.push(init.timeoutMs)
      return {} as T
    }, JSON.stringify)

    await api.createICloudAlias({ accountId: 'account-1', label: '', channel: 'apple_account' })

    expect(timeouts[0]).toBeGreaterThanOrEqual(120_000)
  })

  it('sends the reserved preview address on the legacy cookie channel', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const api = createICloudApi(async <T>(path: string, init: RequestInit = {}) => {
      calls.push({ path, body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return {} as T
    }, JSON.stringify)

    await api.createICloudAlias({
      accountId: 'account-1', label: '', channel: 'icloud_web',
      email: 'suggested@icloud.com', previewId: '00000000-0000-4000-8000-000000000001',
    })

    expect(calls[0].body).toEqual({
      accountId: 'account-1', label: '', channel: 'icloud_web',
      email: 'suggested@icloud.com', previewId: '00000000-0000-4000-8000-000000000001',
    })
  })

  it('reads the hourly quota with an escaped account id and a caller signal', async () => {
    const calls: Array<{ path: string; signal?: AbortSignal | null }> = []
    const api = createICloudApi(async <T>(path: string, init: RequestInit = {}) => {
      calls.push({ path, signal: init.signal })
      return {} as T
    }, JSON.stringify)
    const controller = new AbortController()

    await api.iCloudAliasQuota('account/1', controller.signal)

    expect(calls[0].path).toBe('/api/icloud/aliases/quota?accountId=account%2F1')
    expect(calls[0].signal).toBe(controller.signal)
  })
})
