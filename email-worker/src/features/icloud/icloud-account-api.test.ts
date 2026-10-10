import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APPLE_SESSION_GATE_MAX_HOLD_MS,
  settleAppleClaim,
  settleWebClaim,
  withAppleAccountSessionGate,
} from './icloud-account-api'
import { APPLE_ACCOUNT_ERROR_CODES, ICLOUD_CREDENTIAL_ERROR_STATUS, ICLOUD_WEB_ERROR_CODES, ICloudRemoteError } from './icloud-apple'
import type { Env } from '../../app/types'

describe('withAppleAccountSessionGate', () => {
  it('runs one create at a time per account', async () => {
    // Apple rotates scnt and the session id on every successful response, so
    // overlapping multi-step creates on one session would corrupt each other.
    const order: string[] = []
    const first = withAppleAccountSessionGate('icloud_single_flight', async () => {
      order.push('first:start')
      await Promise.resolve()
      order.push('first:end')
    })
    const second = withAppleAccountSessionGate('icloud_single_flight', async () => {
      order.push('second:start')
    })

    await Promise.all([first, second])

    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('lets the next create through after the previous one rejects', async () => {
    const failing = withAppleAccountSessionGate('icloud_after_failure', async () => {
      throw new Error('apple failed')
    })
    await expect(failing).rejects.toThrow('apple failed')

    const operation = vi.fn(async () => 'created')
    await expect(withAppleAccountSessionGate('icloud_after_failure', operation)).resolves.toBe('created')
    expect(operation).toHaveBeenCalledOnce()
  })

  it('does not serialize creates across different accounts', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = withAppleAccountSessionGate('icloud_account_a', async () => {
      order.push('a:start')
      await blocked
      order.push('a:end')
    })
    const second = withAppleAccountSessionGate('icloud_account_b', async () => {
      order.push('b:done')
    })

    await second
    releaseFirst()
    await first

    expect(order).toEqual(['a:start', 'b:done', 'a:end'])
  })

  it('keeps an operation alive once it holds the session, not while it waits', async () => {
    // A holder the client abandons must still finish and release; a waiter the
    // client abandons should not go on to start Apple calls nobody will see.
    const kept: Promise<unknown>[] = []
    const keepAlive = (task: Promise<unknown>) => { kept.push(task) }
    let releaseFirst!: () => void
    const first = withAppleAccountSessionGate('icloud_keep_alive', () => new Promise<void>((resolve) => {
      releaseFirst = resolve
    }), keepAlive)
    const second = withAppleAccountSessionGate('icloud_keep_alive', async () => {
      throw new Error('apple failed')
    }, keepAlive)

    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(kept).toHaveLength(1)
    releaseFirst()
    await first
    await expect(second).rejects.toThrow('apple failed')

    expect(kept).toHaveLength(2)
    // waitUntil must get promises that settle cleanly, even for a failed operation.
    await expect(Promise.all(kept)).resolves.toHaveLength(2)
  })

  describe('with a holder that never finishes', () => {
    afterEach(() => vi.useRealTimers())

    it('lets the next call through once the hold counts as abandoned', async () => {
      // Workers drops a request the client cancels mid-await, so its finally
      // never runs. Waiting on it forever wedged every later listing, create
      // and refresh for the account in that isolate.
      vi.useFakeTimers()
      void withAppleAccountSessionGate('icloud_abandoned', () => new Promise<never>(() => undefined))
      const operation = vi.fn(async () => 'listed')
      const next = withAppleAccountSessionGate('icloud_abandoned', operation)

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
      }))
      const operation = vi.fn(async () => 'listed')
      const next = withAppleAccountSessionGate('icloud_slow_holder', operation)

      await vi.advanceTimersByTimeAsync(80_000)
      expect(operation).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(11_000)

      await expect(holder).resolves.toBe('created')
      await expect(next).resolves.toBe('listed')
    })
  })
})
function quotaDatabase() {
  const statements: string[] = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: () => ({
            run: async () => { statements.push(sql); return { meta: { changes: 1 } } },
            first: async () => { statements.push(sql); return null },
          }),
        }
      },
    },
  } as unknown as Env
  const kind = () => statements.map((sql) => (
    sql.includes('hour_count - 1') ? 'refund' : sql.includes('MAX(') ? 'exhaust' : 'other'
  ))
  return { env, kind }
}

describe('settleWebClaim', () => {
  it('saturates the window when Apple reports its own cap', async () => {
    const { env, kind } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(429, 'capped', true, ICLOUD_WEB_ERROR_CODES.limit))
    expect(kind()).toEqual(['exhaust'])
  })

  it('refunds an outright refusal', async () => {
    const { env, kind } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(400, '隐藏邮箱地址无效。', true))
    expect(kind()).toEqual(['refund'])
  })

  it('refunds a lost Hide My Email entitlement even though it is not definitive', async () => {
    // validate() raises this one without a `definitive` flag; keying the refund
    // on `definitive` alone used to burn a slot per attempt.
    const { env, kind } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(ICLOUD_CREDENTIAL_ERROR_STATUS, '权限不足'))
    expect(kind()).toEqual(['refund'])
  })

  it('keeps the slot when a timeout may have committed the reserve', async () => {
    const { env, kind } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(504, '连接 iCloud 超时。'))
    expect(kind()).toEqual([])
  })
})

describe('settleAppleClaim', () => {
  it('saturates on an upstream limit and refunds a dead session', async () => {
    const limited = quotaDatabase()
    await settleAppleClaim(limited.env, 'user-1', 'acct-1', new ICloudRemoteError(429, 'capped', true, APPLE_ACCOUNT_ERROR_CODES.limit))
    expect(limited.kind()).toEqual(['exhaust'])

    const expired = quotaDatabase()
    await settleAppleClaim(expired.env, 'user-1', 'acct-1', new ICloudRemoteError(422, 'expired', true, APPLE_ACCOUNT_ERROR_CODES.auth))
    expect(expired.kind()).toEqual(['refund'])
  })

  it('keeps the slot for an ambiguous API failure', async () => {
    // add may have succeeded while complete failed, which does spend Apple's
    // quota, so this must not be refunded.
    const { env, kind } = quotaDatabase()
    await settleAppleClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(502, 'huh', true, APPLE_ACCOUNT_ERROR_CODES.api))
    expect(kind()).toEqual([])
  })
})
