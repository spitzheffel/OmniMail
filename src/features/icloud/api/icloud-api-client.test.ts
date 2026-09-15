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

    await api.createICloudAlias('account-1', 'Shopping')

    expect(calls[0]).toEqual({
      path: '/api/icloud/aliases',
      body: { accountId: 'account-1', label: 'Shopping' },
    })
  })
})
