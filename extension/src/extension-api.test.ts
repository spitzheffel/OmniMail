import { describe, expect, it } from 'vitest'
import { extensionApiCall } from './extension-api'

describe('Float background API calls', () => {
  it('creates iCloud aliases without the cookie-only preview', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
      calls.push([path, init])
      return { alias: { email: 'shop@icloud.com', label: 'Shop', createdAt: '' } } as T
    }

    await extensionApiCall(
      { type: 'api:create-icloud-alias', accountId: 'apple-only', label: 'Shop' },
      request,
      async () => undefined,
      async () => [],
    )

    // No email/previewId lets the Worker pick the channel: an Apple-Account-only
    // account has no cookie jar for /api/icloud/aliases/preview to use.
    expect(calls).toEqual([['/api/icloud/aliases', {
      method: 'POST', body: JSON.stringify({ accountId: 'apple-only', label: 'Shop' }),
    }]])
  })
})
