import { describe, expect, it } from 'vitest'
import { createICloudApi } from './icloud-api-client'

describe('iCloud API client Apple Account contract', () => {
  it('starts and completes the Apple Account login flow without retaining secrets', async () => {
    const calls: Array<{ path: string; method: string; body: Record<string, unknown> }> = []
    const api = createICloudApi(async <T>(path: string, init: RequestInit = {}) => {
      calls.push({
        path,
        method: init.method || 'GET',
        body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
      })
      return {} as T
    }, JSON.stringify)

    await api.startICloudAppleAccountLogin('account/1', 'owner@example.com', 'secret')
    await api.completeICloudAppleAccountLogin('account/1', 'challenge/1', '123456')

    expect(calls).toEqual([
      {
        path: '/api/icloud/accounts/account%2F1/apple-account/login/start', method: 'POST',
        body: { appleId: 'owner@example.com', password: 'secret' },
      },
      {
        path: '/api/icloud/accounts/account%2F1/apple-account/login/2fa', method: 'POST',
        body: { challengeId: 'challenge/1', code: '123456' },
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
