import { describe, expect, it, vi } from 'vitest'
import { settleAppleClaim, settleWebClaim, withAppleAccountCreateGate } from './icloud-account-api'
import { APPLE_ACCOUNT_ERROR_CODES, ICLOUD_CREDENTIAL_ERROR_STATUS, ICLOUD_WEB_ERROR_CODES, ICloudRemoteError } from './icloud-apple'
import type { Env } from '../../app/types'

describe('withAppleAccountCreateGate', () => {
  it('runs one create at a time per account', async () => {
    // Apple rotates scnt and the session id on every successful response, so
    // overlapping multi-step creates on one session would corrupt each other.
    const order: string[] = []
    const first = withAppleAccountCreateGate('icloud_single_flight', async () => {
      order.push('first:start')
      await Promise.resolve()
      order.push('first:end')
    })
    const second = withAppleAccountCreateGate('icloud_single_flight', async () => {
      order.push('second:start')
    })

    await Promise.all([first, second])

    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('lets the next create through after the previous one rejects', async () => {
    const failing = withAppleAccountCreateGate('icloud_after_failure', async () => {
      throw new Error('apple failed')
    })
    await expect(failing).rejects.toThrow('apple failed')

    const operation = vi.fn(async () => 'created')
    await expect(withAppleAccountCreateGate('icloud_after_failure', operation)).resolves.toBe('created')
    expect(operation).toHaveBeenCalledOnce()
  })

  it('does not serialize creates across different accounts', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = withAppleAccountCreateGate('icloud_account_a', async () => {
      order.push('a:start')
      await blocked
      order.push('a:end')
    })
    const second = withAppleAccountCreateGate('icloud_account_b', async () => {
      order.push('b:done')
    })

    await second
    releaseFirst()
    await first

    expect(order).toEqual(['a:start', 'b:done', 'a:end'])
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
