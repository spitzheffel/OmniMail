import { describe, expect, it } from 'vitest'
import {
  ICLOUD_ALIAS_HOURLY_LIMITS,
  ICLOUD_ALIAS_HOUR_SECONDS,
  ICloudAliasQuotaError,
  claimICloudAliasCreate,
  exhaustICloudAliasChannel,
  iCloudAliasQuotaState,
  readICloudAliasQuota,
  releaseICloudAliasCreate,
} from './icloud-alias-quota'

type Statement = { sql: string; bindings: unknown[] }

function database(options: {
  row?: Record<string, number> | null
  rows?: Record<string, number>[]
} = {}) {
  const statements: Statement[] = []
  return {
    db: {
      prepare(sql: string) {
        const statement = {
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings
            statements.push({ sql, bindings })
            return this
          },
          run: async () => ({ meta: { changes: 1 } }),
          first: async () => options.row ?? null,
          all: async () => ({ results: options.rows ?? [] }),
        }
        return statement
      },
    } as unknown as D1Database,
    statements,
  }
}

// 2026-09-17T10:17:36Z — deliberately not on an hour boundary.
const NOW = 1_789_640_256
const HOUR_START = Math.floor(NOW / ICLOUD_ALIAS_HOUR_SECONDS) * ICLOUD_ALIAS_HOUR_SECONDS

describe('iCloudAliasQuotaState', () => {
  it('reports the documented per-channel budgets when nothing was used', () => {
    expect(iCloudAliasQuotaState([], NOW)).toEqual([
      { channel: 'apple_account', limit: 20, used: 0, remaining: 20, resetsAt: HOUR_START + 3600 },
      { channel: 'icloud_web', limit: 5, used: 0, remaining: 5, resetsAt: HOUR_START + 3600 },
    ])
  })

  it('ignores counts recorded in an earlier window', () => {
    const rows = [
      { channel: 'apple_account', hour_started_at: HOUR_START - 3600, hour_count: 20 },
      { channel: 'icloud_web', hour_started_at: HOUR_START, hour_count: 2 },
    ]
    const state = iCloudAliasQuotaState(rows, NOW)
    expect(state[0]).toMatchObject({ channel: 'apple_account', used: 0, remaining: 20 })
    expect(state[1]).toMatchObject({ channel: 'icloud_web', used: 2, remaining: 3 })
  })

  it('honours a caller-supplied limit override', () => {
    const rows = [{ channel: 'apple_account', hour_started_at: HOUR_START, hour_count: 4 }]
    expect(iCloudAliasQuotaState(rows, NOW, { apple_account: 6 })[0])
      .toMatchObject({ limit: 6, used: 4, remaining: 2 })
  })
})

describe('claimICloudAliasCreate', () => {
  it('reserves with one guarded upsert and reports what is left', async () => {
    const { db, statements } = database({ row: { hour_count: 3 } })

    await expect(claimICloudAliasCreate(db, 'user-1', 'acct-1', 'apple_account', NOW))
      .resolves.toEqual({ allowed: true, remaining: 17 })

    expect(statements).toHaveLength(1)
    expect(statements[0].sql).toContain('ON CONFLICT(account_id, channel) DO UPDATE')
    expect(statements[0].sql).toContain('RETURNING hour_count')
    expect(statements[0].bindings).toEqual([
      'user-1', 'acct-1', 'apple_account', HOUR_START, NOW,
      ICLOUD_ALIAS_HOURLY_LIMITS.apple_account,
    ])
  })

  it('denies once the window is full and points at the fixed hour boundary', async () => {
    const { db } = database({ row: null })

    await expect(claimICloudAliasCreate(db, 'user-1', 'acct-1', 'icloud_web', NOW))
      .resolves.toEqual({ allowed: false, retryAfter: HOUR_START + 3600 - NOW })
  })

  it('never moves the reset time, however many denials pile up', async () => {
    const { db } = database({ row: null })
    const deadlines = new Set<number>()
    // The regression guard for the cooldown that used to extend itself: the
    // window start is a fixed hour floor, so repeated rejections one second
    // apart all resolve to the same absolute reset instant.
    for (let elapsed = 0; elapsed < 600; elapsed += 1) {
      const at = NOW + elapsed
      const result = await claimICloudAliasCreate(db, 'user-1', 'acct-1', 'apple_account', at)
      expect(result.allowed).toBe(false)
      if (!result.allowed) deadlines.add(at + result.retryAfter)
    }
    expect([...deadlines]).toEqual([HOUR_START + 3600])
  })

  it('denies without touching the database when the limit is overridden to zero', async () => {
    const { db, statements } = database({ row: { hour_count: 1 } })

    await expect(claimICloudAliasCreate(db, 'user-1', 'acct-1', 'apple_account', NOW, { apple_account: 0 }))
      .resolves.toEqual({ allowed: false, retryAfter: HOUR_START + 3600 - NOW })
    expect(statements).toHaveLength(0)
  })
})

describe('refund and saturation', () => {
  it('only gives back a reservation inside the current window', async () => {
    const { db, statements } = database()

    await releaseICloudAliasCreate(db, 'user-1', 'acct-1', 'apple_account', NOW)

    expect(statements[0].sql).toContain('hour_count = hour_count - 1')
    expect(statements[0].sql).toContain('hour_count > 0')
    expect(statements[0].bindings).toEqual([NOW, 'acct-1', 'apple_account', 'user-1', HOUR_START])
  })

  it('saturates the window to the channel limit after an upstream cap', async () => {
    const { db, statements } = database()

    await exhaustICloudAliasChannel(db, 'user-1', 'acct-1', 'icloud_web', NOW)

    expect(statements[0].sql).toContain('MAX(icloud_alias_create_limits.hour_count, excluded.hour_count)')
    expect(statements[0].bindings).toEqual([
      'user-1', 'acct-1', 'icloud_web', HOUR_START,
      ICLOUD_ALIAS_HOURLY_LIMITS.icloud_web, NOW,
    ])
  })
})

describe('readICloudAliasQuota', () => {
  it('scopes the read to the owning user', async () => {
    const { db, statements } = database({
      rows: [{ channel: 'apple_account', hour_started_at: HOUR_START, hour_count: 20 }],
    })

    const quota = await readICloudAliasQuota(db, 'user-1', 'acct-1', NOW)

    expect(statements[0].sql).toContain('WHERE account_id = ? AND user_id = ?')
    expect(statements[0].bindings).toEqual(['acct-1', 'user-1'])
    expect(quota[0]).toMatchObject({ channel: 'apple_account', used: 20, remaining: 0 })
  })
})

describe('ICloudAliasQuotaError', () => {
  it('keeps the countdown out of the translatable sentence', () => {
    const error = new ICloudAliasQuotaError('apple_account', 1_800)
    expect(error.status).toBe(429)
    expect(error.retryAfter).toBe(1_800)
    expect(error.message).toBe('本小时 Apple Account 创建额度已用完，请稍后再试。')
    expect(error.message).not.toMatch(/\d/)
  })
})
