import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPLE_ACCOUNT_ERROR_CODES,
  ICloudRemoteError,
} from './icloud-apple'
import { AppleAccountClient } from './icloud-account-client'
import { withAppleAccountCreateGate } from './icloud-account-api'
import type { AppleAccountState } from './icloud-types'

afterEach(() => vi.restoreAllMocks())

function state(overrides: Partial<AppleAccountState> = {}): AppleAccountState {
  return {
    cookies: { session: 'cookie-value' }, scnt: 'scnt-old', sessionId: 'session-old',
    apiKey: 'api-old', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lastCheckedAt: new Date().toISOString(), userAgent: '', host: 'appleid.apple.com',
    origin: 'https://account.apple.com', ...overrides,
  }
}

describe('Apple Account private email client', () => {
  it('refreshes the management state before creating when it is expired', async () => {
    const calls: Array<{ path: string; headers: Headers; body: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input))
      calls.push({ path: url.pathname, headers: new Headers(init?.headers), body: String(init?.body || '') })
      if (url.pathname === '/account/manage/gs/ws/token') {
        return new Response('{"timeOutInterval":15}', { headers: { scnt: 'scnt-token', 'set-cookie': 'token-cookie=ok; Path=/' } })
      }
      if (url.pathname === '/account/manage') {
        return new Response('{"apiKey":"api-fresh"}', { headers: { scnt: 'scnt-manage' } })
      }
      if (url.pathname === '/account/manage/email/private/add') {
        return new Response('{"emailAddress":"Candidate.Alias@icloud.com"}', { headers: { scnt: 'scnt-add' } })
      }
      if (url.pathname === '/account/manage/email/private/add/complete') {
        return new Response('{"emailAddress":"Candidate.Alias@icloud.com","id":"alias-1","label":"Shop","active":true}', { headers: { scnt: 'scnt-complete' } })
      }
      if (url.pathname === '/account/manage/email/private/alias-1.em') {
        return new Response('{"emailAddress":"Candidate.Alias@icloud.com","id":"alias-1","label":"Shop","active":true}', { headers: { scnt: 'scnt-detail' } })
      }
      return new Response('', { status: 404 })
    })

    const client = new AppleAccountClient(state({ expiresAt: '' }))
    await expect(client.createAlias('Shop')).resolves.toMatchObject({
      email: 'candidate.alias@icloud.com', anonymousId: 'alias-1', active: true,
    })
    expect(calls.map(({ path }) => path)).toEqual([
      '/account/manage/gs/ws/token', '/account/manage',
      '/account/manage/email/private/add', '/account/manage/email/private/add/complete',
      '/account/manage/email/private/alias-1.em',
    ])
    expect(calls[2].headers.get('X-Apple-Api-Key')).toBe('api-fresh')
    expect(calls[2].headers.get('scnt')).toBe('scnt-manage')
    expect(calls[2].headers.get('Cookie')).toContain('token-cookie=ok')
    expect(client.state.scnt).toBe('scnt-detail')
    expect(client.state.apiKey).toBe('api-fresh')
    expect(Date.parse(client.state.expiresAt)).toBeGreaterThan(Date.now())
  })

  it('keeps refreshed credentials out of a failed write response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"limit"}', { status: 429 }),
    )
    const client = new AppleAccountClient(state())
    await expect(client.createAlias('Shop')).rejects.toMatchObject({
      status: 429, code: APPLE_ACCOUNT_ERROR_CODES.limit,
    })
    expect(client.state.scnt).toBe('scnt-old')
    expect(client.state.cookies).toEqual({ session: 'cookie-value' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('maps Apple session expiry to an independent credential error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"service_errors":[{"message":"authentication_failed"}]}', { status: 401 }),
    )
    const client = new AppleAccountClient(state())
    await expect(client.createAlias('Shop')).rejects.toEqual(expect.objectContaining({
      status: 422, code: APPLE_ACCOUNT_ERROR_CODES.auth,
    }))
  })

  it('requires scnt before attempting a refresh', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const client = new AppleAccountClient(state({ scnt: '' }))
    await expect(client.refresh()).rejects.toMatchObject({
      status: 422, code: APPLE_ACCOUNT_ERROR_CODES.missing,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not leak remote response details for a malformed success body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>oops</html>'))
    const client = new AppleAccountClient(state())
    await expect(client.createAlias('Shop')).rejects.toBeInstanceOf(ICloudRemoteError)
  })

  it('serializes concurrent creates for the same account', async () => {
    const order: string[] = []
    const first = withAppleAccountCreateGate('same-account', async () => {
      order.push('first-start')
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('first-end')
    })
    const second = withAppleAccountCreateGate('same-account', async () => {
      order.push('second-start')
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })
  it('reports an unrecognised listing payload instead of claiming zero aliases', async () => {
    // aliasArray() cannot find a list in this shape. Returning [] would let the
    // caller persist alias_total = 0 over a known-good count.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ unexpected: { shape: true } }))
    const client = new AppleAccountClient(state())

    const error = await client.listAliases().catch((reason) => reason)

    expect(error).toBeInstanceOf(ICloudRemoteError)
    expect((error as ICloudRemoteError).code).toBe(APPLE_ACCOUNT_ERROR_CODES.api)
  })

  it('still reports a genuinely empty list as empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ hmeEmails: [] }))
    const client = new AppleAccountClient(state())

    await expect(client.listAliases()).resolves.toEqual([])
  })
})
