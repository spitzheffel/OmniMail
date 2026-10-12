import { describe, expect, it } from 'vitest'
import { settleAppleClaim, settleWebClaim } from './icloud-account-api'
import { APPLE_ACCOUNT_ERROR_CODES, ICLOUD_CREDENTIAL_ERROR_STATUS, ICLOUD_WEB_ERROR_CODES, ICloudRemoteError } from './icloud-apple'
import type { Env } from '../../app/types'

/** The hour the claim was taken in; settlement must act on it, not on whatever hour it is now. */
const CLAIMED_HOUR = 1_789_639_200

function quotaDatabase() {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind: (...bindings: unknown[]) => ({
            run: async () => { statements.push({ sql, bindings }); return { meta: { changes: 1 } } },
            first: async () => { statements.push({ sql, bindings }); return null },
          }),
        }
      },
    },
  } as unknown as Env
  const kind = () => statements.map(({ sql }) => (
    sql.includes('hour_count - 1') ? 'refund' : sql.startsWith('INSERT INTO') ? 'exhaust' : 'other'
  ))
  return { env, kind, statements }
}

describe('settleWebClaim', () => {
  it('saturates the window when Apple reports its own cap', async () => {
    const { env, kind } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(429, 'capped', true, ICLOUD_WEB_ERROR_CODES.limit), CLAIMED_HOUR)
    expect(kind()).toEqual(['exhaust'])
  })

  it('refunds an outright refusal to the hour the slot came from', async () => {
    const { env, kind, statements } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(400, '隐藏邮箱地址无效。', true), CLAIMED_HOUR)
    expect(kind()).toEqual(['refund'])
    expect(statements[0].bindings.at(-1)).toBe(CLAIMED_HOUR)
  })

  it('refunds a lost Hide My Email entitlement even though it is not definitive', async () => {
    // validate() raises this one without a `definitive` flag; keying the refund
    // on `definitive` alone used to burn a slot per attempt.
    const { env, kind } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(ICLOUD_CREDENTIAL_ERROR_STATUS, '权限不足'), CLAIMED_HOUR)
    expect(kind()).toEqual(['refund'])
  })

  it('keeps the slot when a timeout may have committed the reserve', async () => {
    const { env, kind } = quotaDatabase()
    await settleWebClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(504, '连接 iCloud 超时。'), CLAIMED_HOUR)
    expect(kind()).toEqual([])
  })
})

describe('settleAppleClaim', () => {
  it('saturates on an upstream limit and refunds a dead session', async () => {
    const limited = quotaDatabase()
    await settleAppleClaim(limited.env, 'user-1', 'acct-1', new ICloudRemoteError(429, 'capped', true, APPLE_ACCOUNT_ERROR_CODES.limit), CLAIMED_HOUR)
    expect(limited.kind()).toEqual(['exhaust'])

    const expired = quotaDatabase()
    await settleAppleClaim(expired.env, 'user-1', 'acct-1', new ICloudRemoteError(422, 'expired', true, APPLE_ACCOUNT_ERROR_CODES.auth), CLAIMED_HOUR)
    expect(expired.kind()).toEqual(['refund'])
    expect(expired.statements[0].bindings.at(-1)).toBe(CLAIMED_HOUR)
  })

  it('refunds a call Apple throttled before it reached the create', async () => {
    // A 429 on a call that creates nothing is Apple slowing that call down,
    // not the hourly cap: the slot was never spent.
    const { env, kind } = quotaDatabase()
    await settleAppleClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(503, 'slow down', true, APPLE_ACCOUNT_ERROR_CODES.throttled), CLAIMED_HOUR)
    expect(kind()).toEqual(['refund'])
  })

  it('keeps the slot for an ambiguous API failure', async () => {
    // add may have succeeded while complete failed, which does spend Apple's
    // quota, so this must not be refunded.
    const { env, kind } = quotaDatabase()
    await settleAppleClaim(env, 'user-1', 'acct-1', new ICloudRemoteError(502, 'huh', true, APPLE_ACCOUNT_ERROR_CODES.api), CLAIMED_HOUR)
    expect(kind()).toEqual([])
  })
})
