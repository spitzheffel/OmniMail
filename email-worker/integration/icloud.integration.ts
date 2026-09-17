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
import { ICloudAccountStore } from '../src/features/icloud/icloud-store'
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
  const HOUR_START = Math.floor(NOW / ICLOUD_ALIAS_HOUR_SECONDS) * ICLOUD_ALIAS_HOUR_SECONDS

  async function windowRow(channel: string) {
    return env.DB.prepare(
      'SELECT hour_started_at, hour_count FROM icloud_alias_create_limits WHERE account_id = ? AND channel = ?',
    ).bind('icloud-account-1', channel).first<{ hour_started_at: number; hour_count: number }>()
  }

  it('hands out exactly the channel budget and then refuses', async () => {
    const limit = ICLOUD_ALIAS_HOURLY_LIMITS.apple_account
    for (let taken = 1; taken <= limit; taken += 1) {
      await expect(
        claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', NOW),
      ).resolves.toEqual({ allowed: true, remaining: limit - taken })
    }

    const denied = await claimICloudAliasCreate(
      env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', NOW,
    )
    expect(denied).toEqual({ allowed: false, retryAfter: HOUR_START + 3600 - NOW })
    expect(await windowRow('apple_account')).toMatchObject({ hour_started_at: HOUR_START, hour_count: limit })
  })

  it('leaves the window untouched while it keeps refusing', async () => {
    for (let elapsed = 0; elapsed < 5; elapsed += 1) {
      const result = await claimICloudAliasCreate(
        env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', NOW + elapsed,
      )
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(NOW + elapsed + result.retryAfter).toBe(HOUR_START + 3600)
    }
    expect(await windowRow('apple_account')).toMatchObject({ hour_started_at: HOUR_START })
  })

  it('keeps the two channels on independent budgets', async () => {
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', NOW),
    ).resolves.toEqual({ allowed: true, remaining: ICLOUD_ALIAS_HOURLY_LIMITS.icloud_web - 1 })
  })

  it('refunds a reservation that never reached Apple', async () => {
    await releaseICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', NOW)
    expect(await windowRow('icloud_web')).toMatchObject({ hour_count: 0 })
  })

  it('starts a clean budget once the hour rolls over', async () => {
    const next = NOW + 3600
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', next),
    ).resolves.toEqual({ allowed: true, remaining: ICLOUD_ALIAS_HOURLY_LIMITS.apple_account - 1 })
    expect(await windowRow('apple_account')).toMatchObject({ hour_count: 1 })
  })

  it('saturates the window when Apple reports its own cap', async () => {
    const next = NOW + 3600
    await exhaustICloudAliasChannel(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', next)
    expect(await windowRow('apple_account'))
      .toMatchObject({ hour_count: ICLOUD_ALIAS_HOURLY_LIMITS.apple_account })
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', next),
    ).resolves.toMatchObject({ allowed: false })
  })

  it('reports per-channel state scoped to the owning user', async () => {
    const next = NOW + 3600
    await expect(readICloudAliasQuota(env.DB, 'icloud-owner', 'icloud-account-1', next))
      .resolves.toMatchObject([
        { channel: 'apple_account', used: ICLOUD_ALIAS_HOURLY_LIMITS.apple_account, remaining: 0 },
        { channel: 'icloud_web', used: 0 },
      ])
    // The same account id read as a different user sees none of that usage.
    await expect(readICloudAliasQuota(env.DB, 'icloud-other', 'icloud-account-1', next))
      .resolves.toMatchObject([
        { channel: 'apple_account', used: 0, remaining: ICLOUD_ALIAS_HOURLY_LIMITS.apple_account },
        { channel: 'icloud_web', used: 0, remaining: ICLOUD_ALIAS_HOURLY_LIMITS.icloud_web },
      ])
  })
})
describe('iCloud credential flags', () => {
  it('derives channel availability without decrypting anything', async () => {
    // The seeded row holds deliberately undecryptable ciphertext, so a helper
    // that touched the credentials would throw here.
    const store = new ICloudAccountStore(env, 'icloud-owner')

    await expect(store.credentialFlags('icloud-account-1')).resolves.toEqual({
      hasCookies: true, hasAppPassword: true, hasAppleAccount: false,
    })
    await expect(store.get('icloud-account-1')).rejects.toThrow()
  })

  it('refuses an account owned by another user', async () => {
    await expect(new ICloudAccountStore(env, 'icloud-other').credentialFlags('icloud-account-1'))
      .rejects.toMatchObject({ status: 404 })
  })
})
