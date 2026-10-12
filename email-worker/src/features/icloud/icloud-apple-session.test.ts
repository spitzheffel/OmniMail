import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPLE_ACCOUNT_ERROR_CODES, ICloudRemoteError } from './icloud-apple'
import { AppleAccountClient } from './icloud-account-client'
import {
  APPLE_SESSION_GATE_MAX_HOLD_MS,
  assertAppleIdBindable,
  currentAppleSession,
  outlive,
  withAppleAccountSessionGate,
  withAppleSessionRetry,
  type AppleSession,
} from './icloud-apple-session'
import { ICloudStoreError, type ICloudAccountStore } from './icloud-store'
import type { AppleAccountState, ICloudAccount } from './icloud-types'

afterEach(() => {
  // Spies first: restoring a setTimeout spy after the real timers came back
  // would put the fake one back in place.
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const ignore = () => undefined

function state(overrides: Partial<AppleAccountState> = {}): AppleAccountState {
  return {
    cookies: { session: 'cookie' }, scnt: 'scnt-adopted', sessionId: 'session', apiKey: 'api',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), lastCheckedAt: '', userAgent: '',
    host: 'appleid.apple.com', origin: 'https://account.apple.com', ...overrides,
  }
}

function account(overrides: Partial<ICloudAccount> = {}): ICloudAccount {
  return {
    id: 'acct-1', userId: 'user-1', name: 'Personal', realEmail: '', icloudEmail: '',
    cookies: {}, host: 'icloud.com', appPassword: '', status: 'active',
    aliasTotal: 0, aliasActive: 0, lastValidated: '', lastError: '', createdAt: '',
    appleAccountState: state(), appleAccountStatus: 'active',
    appleAccountRead: { cipher: 'cipher-adopted', plaintext: '' },
    ...overrides,
  }
}

describe('withAppleAccountSessionGate', () => {
  it('runs one Apple call at a time per account', async () => {
    // Apple rotates scnt and the session id on every successful response, so
    // overlapping multi-step creates on one session would corrupt each other.
    const order: string[] = []
    const first = withAppleAccountSessionGate('icloud_single_flight', async () => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push('first:end')
    }, ignore)
    const second = withAppleAccountSessionGate('icloud_single_flight', async () => {
      order.push('second:start')
    }, ignore)

    await Promise.all([first, second])

    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('lets the next call through after the previous one rejects', async () => {
    const failing = withAppleAccountSessionGate('icloud_after_failure', async () => {
      throw new Error('apple failed')
    }, ignore)
    await expect(failing).rejects.toThrow('apple failed')

    const operation = vi.fn(async () => 'created')
    await expect(withAppleAccountSessionGate('icloud_after_failure', operation, ignore)).resolves.toBe('created')
    expect(operation).toHaveBeenCalledOnce()
  })

  it('does not serialize calls across different accounts', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = withAppleAccountSessionGate('icloud_account_a', async () => {
      order.push('a:start')
      await blocked
      order.push('a:end')
    }, ignore)
    const second = withAppleAccountSessionGate('icloud_account_b', async () => {
      order.push('b:done')
    }, ignore)

    await second
    releaseFirst()
    await first

    expect(order).toEqual(['a:start', 'b:done', 'a:end'])
  })

  it('keeps an operation alive once it holds the session, not while it waits', async () => {
    // A holder the client abandons must still finish and release; a waiter the
    // client abandons should not go on to start Apple calls nobody will see.
    const kept: Promise<unknown>[] = []
    const defer = (task: Promise<unknown>) => { kept.push(task) }
    let releaseFirst!: () => void
    const first = withAppleAccountSessionGate('icloud_keep_alive', () => new Promise<void>((resolve) => {
      releaseFirst = resolve
    }), defer)
    const second = withAppleAccountSessionGate('icloud_keep_alive', async () => {
      throw new Error('apple failed')
    }, defer)

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(kept).toHaveLength(1)
    releaseFirst()
    await first
    await expect(second).rejects.toThrow('apple failed')

    expect(kept).toHaveLength(2)
    // waitUntil must get promises that settle cleanly, even for a failed operation.
    await expect(Promise.all(kept)).resolves.toHaveLength(2)
  })

  it('backs off while it waits instead of waking every 25 ms', async () => {
    // The hold ahead can run for minutes; a fixed 25 ms poll woke a waiter
    // thousands of times for nothing.
    vi.useFakeTimers()
    const delays: number[] = []
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      delays.push(delay ?? 0)
      return realSetTimeout(callback, delay)
    }) as typeof setTimeout)
    let release!: () => void
    const holder = withAppleAccountSessionGate('icloud_backoff', () => new Promise<void>((resolve) => {
      release = resolve
    }), ignore)
    const waiter = withAppleAccountSessionGate('icloud_backoff', async () => 'listed', ignore)

    await vi.advanceTimersByTimeAsync(5_000)
    release()
    await holder
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(waiter).resolves.toBe('listed')
    expect(delays.slice(0, 7)).toEqual([25, 50, 100, 200, 400, 500, 500])
    expect(Math.max(...delays)).toBe(500)
  })

  describe('with a holder that never finishes', () => {
    it('lets the next call through once the hold counts as abandoned', async () => {
      // Workers drops a request the client cancels mid-await, so its finally
      // never runs. Waiting on it forever wedged every later listing, create
      // and refresh for the account in that isolate.
      vi.useFakeTimers()
      void withAppleAccountSessionGate('icloud_abandoned', () => new Promise<never>(() => undefined), ignore)
      const operation = vi.fn(async () => 'listed')
      const next = withAppleAccountSessionGate('icloud_abandoned', operation, ignore)

      await vi.advanceTimersByTimeAsync(APPLE_SESSION_GATE_MAX_HOLD_MS - 1_000)
      expect(operation).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)

      await expect(next).resolves.toBe('listed')
    })

    it('does not break into a holder still working through slow Apple calls', async () => {
      // A stale-session create makes up to five sequential Apple calls of up to
      // 20 s each; a waiter that took over at 30 s replayed the scnt it was
      // about to rotate.
      vi.useFakeTimers()
      const holder = withAppleAccountSessionGate('icloud_slow_holder', () => new Promise<string>((resolve) => {
        setTimeout(() => resolve('created'), 90_000)
      }), ignore)
      const operation = vi.fn(async () => 'listed')
      const next = withAppleAccountSessionGate('icloud_slow_holder', operation, ignore)

      await vi.advanceTimersByTimeAsync(80_000)
      expect(operation).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(11_000)

      await expect(holder).resolves.toBe('created')
      await expect(next).resolves.toBe('listed')
    })
  })
})

describe('outlive', () => {
  it('hands waitUntil a promise that settles even when the work fails', async () => {
    const kept: Promise<unknown>[] = []
    const work = outlive((task) => { kept.push(task) }, Promise.reject(new Error('apple failed')))

    await expect(work).rejects.toThrow('apple failed')
    await expect(kept[0]).resolves.toBeUndefined()
  })
})

describe('withAppleSessionRetry', () => {
  function storeWith(cipher: string, stored: AppleAccountState = state({ scnt: 'scnt-stored' })) {
    return {
      appleSessionCipher: vi.fn(async () => cipher),
      appleSession: vi.fn(async () => ({
        appleAccountState: stored, appleAccountStatus: 'active' as const,
        appleAccountRead: { cipher, plaintext: JSON.stringify(stored) },
      })),
    } as unknown as ICloudAccountStore & {
      appleSessionCipher: ReturnType<typeof vi.fn>
      appleSession: ReturnType<typeof vi.fn>
    }
  }

  function session(scnt = 'scnt-adopted'): AppleSession {
    return { client: new AppleAccountClient(state({ scnt })), adopted: '', stored: { appleAccountStatus: 'active' } }
  }

  const expired = () => new ICloudRemoteError(422, 'expired', true, APPLE_ACCOUNT_ERROR_CODES.auth)

  it('passes any failure but a rejected session straight through', async () => {
    const store = storeWith('cipher-adopted')
    const call = vi.fn(async () => { throw new ICloudRemoteError(502, 'down', true, APPLE_ACCOUNT_ERROR_CODES.api) })

    await expect(withAppleSessionRetry(store, account(), { session: session() }, call)).rejects.toThrow('down')
    expect(call).toHaveBeenCalledOnce()
    expect(store.appleSessionCipher).not.toHaveBeenCalled()
  })

  it('retries on the session another isolate stored meanwhile', async () => {
    // Two isolates, two gates: the other one rotated the session first, so
    // this one's scnt is stale, not dead. Marking it expired would demand a
    // full sign-in for a session that works.
    const store = storeWith('cipher-newer')
    const refresh = vi.spyOn(AppleAccountClient.prototype, 'refresh')
    const ref = { session: session() }
    const seen: string[] = []
    const call = vi.fn(async (client: AppleAccountClient) => {
      seen.push(client.state.scnt)
      if (seen.length === 1) throw expired()
      return 'listed'
    })

    await expect(withAppleSessionRetry(store, account(), ref, call)).resolves.toBe('listed')
    expect(seen).toEqual(['scnt-adopted', 'scnt-stored'])
    expect(ref.session.client.state.scnt).toBe('scnt-stored')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes once before believing that Apple rejected the stored session', async () => {
    const store = storeWith('cipher-adopted')
    const refresh = vi.spyOn(AppleAccountClient.prototype, 'refresh').mockImplementation(async function (this: AppleAccountClient) {
      this.refreshAttempted = true
      return this.state
    })
    const call = vi.fn(async () => { throw expired() })

    await expect(withAppleSessionRetry(store, account(), { session: session() }, call)).rejects.toThrow('expired')
    expect(refresh).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('believes the rejection when the call already refreshed', async () => {
    const store = storeWith('cipher-adopted')
    const refresh = vi.spyOn(AppleAccountClient.prototype, 'refresh')
    const ref = { session: session() }
    ref.session.client.refreshAttempted = true
    const call = vi.fn(async () => { throw expired() })

    await expect(withAppleSessionRetry(store, account(), ref, call)).rejects.toThrow('expired')
    expect(refresh).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledOnce()
  })
})

describe('currentAppleSession', () => {
  it('keeps the Apple ID the session signed in as through every rotation', async () => {
    const stored = state({ appleId: 'owner@icloud.com' })
    const store = {
      appleSession: async () => ({ appleAccountState: stored, appleAccountStatus: 'active' as const }),
    } as unknown as ICloudAccountStore

    const { client } = await currentAppleSession(store, account())

    expect(client.state.appleId).toBe('owner@icloud.com')
  })
})

describe('assertAppleIdBindable', () => {
  function storeOwning(owner = '') {
    return { appleIdOwner: vi.fn(async () => owner) } as unknown as ICloudAccountStore & {
      appleIdOwner: ReturnType<typeof vi.fn>
    }
  }

  async function refusal(promise: Promise<void>): Promise<ICloudStoreError> {
    const error = await promise.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(ICloudStoreError)
    return error as ICloudStoreError
  }

  it('refuses a sign-in as another Apple ID than the session already signed in as', async () => {
    // Aliases land on whichever Apple ID the session belongs to; switching it
    // silently would split the account's aliases across two Apple IDs.
    const error = await refusal(assertAppleIdBindable(
      storeOwning(), account({ appleAccountState: state({ appleId: 'first@icloud.com' }) }), 'Second@iCloud.com',
    ))

    expect(error.status).toBe(409)
    expect(error.detail).toBe('first@icloud.com')
  })

  it('refuses a sign-in as another Apple ID than the cookie jar belongs to', async () => {
    const error = await refusal(assertAppleIdBindable(
      storeOwning(), account({ appleAccountState: null, cookies: { token: 'x' }, realEmail: 'jar@icloud.com' }),
      'other@icloud.com',
    ))

    expect(error.status).toBe(409)
    expect(error.detail).toBe('jar@icloud.com')
  })

  it('refuses an Apple ID another account of the user already creates aliases as', async () => {
    // The hourly budget is kept per account: a second account on the same
    // Apple ID would double what Apple enforces once.
    const store = storeOwning('Work iCloud')

    const error = await refusal(assertAppleIdBindable(store, account({ appleAccountState: null }), 'Owner@iCloud.com'))

    expect(error.status).toBe(409)
    expect(error.detail).toBe('Work iCloud')
    expect(store.appleIdOwner).toHaveBeenCalledWith('owner@icloud.com', 'acct-1')
  })

  it('lets the same Apple ID sign in again, and a phone-number Apple ID through', async () => {
    const signedIn = account({ appleAccountState: state({ appleId: 'owner@icloud.com' }), cookies: { token: 'x' }, realEmail: 'owner@icloud.com' })

    await expect(assertAppleIdBindable(storeOwning(), signedIn, 'OWNER@icloud.com')).resolves.toBeUndefined()
    await expect(assertAppleIdBindable(storeOwning(), signedIn, '+8613800000000')).resolves.toBeUndefined()
  })
})
