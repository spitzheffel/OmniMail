import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index'
import { createSessionToken, storeSession } from '../src/features/auth/session/auth'
import {
  ICLOUD_ALIAS_HOURLY_LIMITS,
  ICLOUD_ALIAS_HOUR_SECONDS,
  claimICloudAliasCreate,
  exhaustICloudAliasChannel,
  readICloudAliasQuota,
  releaseICloudAliasCreate,
} from '../src/features/icloud/icloud-alias-quota'
import type { Env as OmniMailEnv } from '../src/app/types'

declare global {
  namespace Cloudflare {
    interface Env extends OmniMailEnv {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>
    }
  }
}

const ownerToken = createSessionToken()
const otherToken = createSessionToken()

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
        id, email, display_name, password_hash, role, mailbox_limit,
        storage_quota_bytes, can_create_mailboxes, can_reply
      ) VALUES ('icloud-owner', 'icloud-owner@example.com', 'Owner', 'test', 'user', 1, 1024, 1, 0)`,
    ),
    env.DB.prepare(
      `INSERT INTO users (
        id, email, display_name, password_hash, role, mailbox_limit,
        storage_quota_bytes, can_create_mailboxes, can_reply
      ) VALUES ('icloud-other', 'icloud-other@example.com', 'Other', 'test', 'user', 1, 1024, 1, 0)`,
    ),
  ])
  await Promise.all([
    storeSession(env.DB, 'icloud-owner', ownerToken),
    storeSession(env.DB, 'icloud-other', otherToken),
  ])
  const id = 'icloud-account-1'
  await env.DB.prepare(
    `INSERT INTO icloud_accounts (
      id, user_id, name, cookies_cipher, app_password_cipher, status,
      created_at, updated_at
    ) VALUES (?, 'icloud-owner', 'Personal', ?, ?, 'active', ?, ?)`,
  ).bind(
    id,
    'not-a-valid-cookie-cipher',
    'not-a-valid-password-cipher',
    new Date().toISOString(),
    new Date().toISOString(),
  ).run()
})

function request(path: string, token = ownerToken): Request {
  return new Request(`https://mail.example.com${path}`, {
    headers: { Cookie: `omnimail_session=${token}` },
  })
}

function patchRequest(path: string, body: unknown, token = ownerToken): Request {
  return new Request(`https://mail.example.com${path}`, {
    method: 'PATCH',
    headers: {
      Cookie: `omnimail_session=${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('iCloud account API', () => {
  it('lists only public metadata for the authenticated owner', async () => {
    const response = await worker.fetch(
      request('/api/icloud/accounts'),
      env,
      createExecutionContext(),
    )
    const result = await response.json() as { accounts: unknown[] }

    expect(response.status).toBe(200)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      id: 'icloud-account-1',
      hasCookies: true,
      hasAppPassword: true,
    })
    expect(JSON.stringify(result)).not.toContain('never-return')
    expect(JSON.stringify(result)).not.toContain('icloud-owner')
  })

  it('isolates accounts by user ownership', async () => {
    const response = await worker.fetch(
      request('/api/icloud/accounts', otherToken),
      env,
      createExecutionContext(),
    )
    await expect(response.json()).resolves.toEqual({ accounts: [] })
  })

  it('renames only an account owned by the authenticated user', async () => {
    const denied = await worker.fetch(
      patchRequest('/api/icloud/accounts/icloud-account-1', { name: 'Other name' }, otherToken),
      env,
      createExecutionContext(),
    )
    expect(denied.status).toBe(404)

    const response = await worker.fetch(
      patchRequest('/api/icloud/accounts/icloud-account-1', { name: 'Work iCloud' }),
      env,
      createExecutionContext(),
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, name: 'Work iCloud' })
    const account = await env.DB.prepare(
      'SELECT name FROM icloud_accounts WHERE id = ?',
    ).bind('icloud-account-1').first<{ name: string }>()
    expect(account?.name).toBe('Work iCloud')
  })
})

describe('iCloud alias hourly quota', () => {
  // 2026-09-17T10:17:36Z — deliberately off an hour boundary.
  const NOW = 1_789_640_256
  // One hour per test, because a window resets on any later hour it has not
  // seen. A window also never moves back, so the hours rise in declaration
  // order: a test stamped earlier than the row its predecessor left would be
  // refused as a late arrival.
  const AT = {
    budget: NOW,
    refusing: NOW + 1 * 3600,
    channels: NOW + 2 * 3600,
    refund: NOW + 3 * 3600,
    // rollover claims in its own hour and again in the one after it.
    rollover: NOW + 4 * 3600,
    saturated: NOW + 6 * 3600,
    scoped: NOW + 7 * 3600,
    // The cases below use the hour given and the one after it.
    late: NOW + 8 * 3600,
    lateRefund: NOW + 10 * 3600,
    cappedRefund: NOW + 12 * 3600,
    lateCap: NOW + 13 * 3600,
  }
  const APPLE_LIMIT = ICLOUD_ALIAS_HOURLY_LIMITS.apple_account

  function hourStart(now: number): number {
    return Math.floor(now / ICLOUD_ALIAS_HOUR_SECONDS) * ICLOUD_ALIAS_HOUR_SECONDS
  }

  async function windowRow(channel: string) {
    return env.DB.prepare(
      'SELECT hour_started_at, hour_count FROM icloud_alias_create_limits WHERE account_id = ? AND channel = ?',
    ).bind('icloud-account-1', channel).first<{ hour_started_at: number; hour_count: number }>()
  }

  async function spendAppleBudget(now: number): Promise<void> {
    for (let taken = 0; taken < APPLE_LIMIT; taken += 1) {
      await claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', now)
    }
  }

  it('hands out exactly the channel budget and then refuses', async () => {
    for (let taken = 1; taken <= APPLE_LIMIT; taken += 1) {
      await expect(
        claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', AT.budget),
      ).resolves.toEqual({ allowed: true, remaining: APPLE_LIMIT - taken, hourStartedAt: hourStart(AT.budget) })
    }

    const denied = await claimICloudAliasCreate(
      env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', AT.budget,
    )
    expect(denied).toEqual({ allowed: false, retryAfter: hourStart(AT.budget) + 3600 - AT.budget })
    expect(await windowRow('apple_account'))
      .toMatchObject({ hour_started_at: hourStart(AT.budget), hour_count: APPLE_LIMIT })
  })

  it('leaves the window untouched while it keeps refusing', async () => {
    await spendAppleBudget(AT.refusing)

    for (let elapsed = 0; elapsed < 5; elapsed += 1) {
      const result = await claimICloudAliasCreate(
        env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', AT.refusing + elapsed,
      )
      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(AT.refusing + elapsed + result.retryAfter).toBe(hourStart(AT.refusing) + 3600)
      }
    }
    expect(await windowRow('apple_account'))
      .toMatchObject({ hour_started_at: hourStart(AT.refusing), hour_count: APPLE_LIMIT })
  })

  it('keeps the two channels on independent budgets', async () => {
    await spendAppleBudget(AT.channels)

    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', AT.channels),
    ).resolves.toEqual({
      allowed: true, remaining: ICLOUD_ALIAS_HOURLY_LIMITS.icloud_web - 1, hourStartedAt: hourStart(AT.channels),
    })
  })

  it('refunds a reservation that never reached Apple', async () => {
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', AT.refund),
    ).resolves.toMatchObject({ allowed: true })

    await releaseICloudAliasCreate(
      env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', hourStart(AT.refund), AT.refund,
    )

    expect(await windowRow('icloud_web'))
      .toMatchObject({ hour_started_at: hourStart(AT.refund), hour_count: 0 })
  })

  it('starts a clean budget once the hour rolls over', async () => {
    await spendAppleBudget(AT.rollover)

    const next = AT.rollover + 3600
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', next),
    ).resolves.toEqual({ allowed: true, remaining: APPLE_LIMIT - 1, hourStartedAt: hourStart(next) })
    expect(await windowRow('apple_account'))
      .toMatchObject({ hour_started_at: hourStart(next), hour_count: 1 })
  })

  it('saturates the window when Apple reports its own cap', async () => {
    await exhaustICloudAliasChannel(
      env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', AT.saturated,
    )

    expect((await windowRow('apple_account'))?.hour_count).toBeGreaterThanOrEqual(APPLE_LIMIT)
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', AT.saturated),
    ).resolves.toMatchObject({ allowed: false })
  })

  it('reports per-channel state scoped to the owning user', async () => {
    await exhaustICloudAliasChannel(
      env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', AT.scoped,
    )

    await expect(readICloudAliasQuota(env.DB, 'icloud-owner', 'icloud-account-1', AT.scoped))
      .resolves.toMatchObject([
        { channel: 'apple_account', used: APPLE_LIMIT, remaining: 0 },
        { channel: 'icloud_web', used: 0 },
      ])
    // The same account id read as a different user sees none of that usage.
    await expect(readICloudAliasQuota(env.DB, 'icloud-other', 'icloud-account-1', AT.scoped))
      .resolves.toMatchObject([
        { channel: 'apple_account', used: 0, remaining: APPLE_LIMIT },
        { channel: 'icloud_web', used: 0, remaining: ICLOUD_ALIAS_HOURLY_LIMITS.icloud_web },
      ])
  })

  it('refuses a claim from an hour already over instead of rolling the window back', async () => {
    // A claim stamped just before the hour that reaches D1 after the next one
    // opened used to reset the row to its own hour, forgetting every claim
    // the newer hour had already made.
    const hour = hourStart(AT.late)
    await claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', hour + 3600)

    await expect(claimICloudAliasCreate(
      env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', hour + 3599,
    )).resolves.toEqual({ allowed: false, retryAfter: 1 })
    expect(await windowRow('apple_account')).toMatchObject({ hour_started_at: hour + 3600, hour_count: 1 })
  })

  it('refunds into the hour the claim was taken from, not the one it fails in', async () => {
    // The attempt failed after the hour turned: taking one off the new window
    // would hand out a slot nobody spent there.
    const hour = hourStart(AT.lateRefund)
    await claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', hour)
    await claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', hour + 3600)

    await releaseICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', hour, hour + 3601)

    expect(await windowRow('icloud_web')).toMatchObject({ hour_started_at: hour + 3600, hour_count: 1 })
  })

  it('does not let a refund reopen a window Apple capped', async () => {
    // A request in flight when Apple reported its cap is refunded afterwards;
    // the window has to stay shut for the rest of the hour regardless.
    const hour = hourStart(AT.cappedRefund)
    const claim = await claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', hour)
    await exhaustICloudAliasChannel(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', hour + 1)

    await releaseICloudAliasCreate(
      env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', claim.allowed ? claim.hourStartedAt : 0, hour + 2,
    )

    await expect(claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', hour + 3))
      .resolves.toMatchObject({ allowed: false })
    await expect(readICloudAliasQuota(env.DB, 'icloud-owner', 'icloud-account-1', hour + 3))
      .resolves.toMatchObject([{ channel: 'apple_account', used: APPLE_LIMIT, remaining: 0 }, { channel: 'icloud_web' }])
  })

  it('does not let a late cap report roll a newer window back', async () => {
    const hour = hourStart(AT.lateCap)
    await claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', hour + 3600)

    await exhaustICloudAliasChannel(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', hour + 3599)

    expect(await windowRow('apple_account')).toMatchObject({ hour_started_at: hour + 3600, hour_count: 1 })
  })
})
