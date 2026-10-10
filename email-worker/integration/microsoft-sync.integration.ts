import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env as OmniMailEnv, MailQueueJob, SessionUser } from '../src/app/types'
import {
  claimMicrosoftValidationAttempt,
  MICROSOFT_VALIDATION_ATTEMPTS,
  verifyMicrosoftAccount,
} from '../src/features/microsoft/microsoft-account-api'
import { MicrosoftAccountStore } from '../src/features/microsoft/microsoft-store'
import { enqueueDueMicrosoftSyncs, syncMicrosoftAccount } from '../src/features/microsoft/microsoft-sync'
import type { MicrosoftAccount } from '../src/features/microsoft/microsoft-types'
import { ImapConnectionError } from '../src/platform/imap/imap-errors'

declare global {
  namespace Cloudflare {
    interface Env extends OmniMailEnv {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>
    }
  }
}

// Stands in for Outlook's IMAP server; everything between it and D1 is real.
const imap = vi.hoisted(() => ({ failure: null as Error | null, opened: 0 }))
vi.mock('../src/features/microsoft/microsoft-imap', async (importOriginal) => ({
  ...await importOriginal<object>(),
  MicrosoftImapClient: class {
    async open() {
      imap.opened += 1
      if (imap.failure) throw imap.failure
    }
    async close() {}
    async listFolders() {
      return [{ path: 'INBOX', displayName: 'Inbox', flags: [], specialUse: '', uidValidity: null, lastUid: 0 }]
    }
    async examineFolder() { return { uidValidity: 1, exists: 0 } }
    async searchAllUids() { return [] }
    async fetchMetadata() { return [] }
  },
}))

const USER = 'microsoft-sync-owner'
const user = { id: USER, role: 'user' } as SessionUser
const IP = '203.0.113.7'
const NOW = Math.floor(Date.now() / 1000)
const HOUR = 60 * 60

function refusal(): ImapConnectionError {
  return new ImapConnectionError(400, 'IMAP OAuth2 认证失败。', true, 'NO AUTHENTICATE failed.')
}

async function account(id: string, fields: Partial<MicrosoftAccount> = {}): Promise<void> {
  await new MicrosoftAccountStore(env, USER).insert({
    id, userId: USER, name: id, providedEmail: `${id}@outlook.com`, normalizedEmail: `${id}@outlook.com`,
    authMode: 'oauth2', clientId: '00000000-0000-0000-0000-000000000001', authority: 'consumers',
    refreshToken: 'refresh-token', accessToken: 'cached-access-token', accessTokenExpiresAt: NOW + HOUR,
    password: '', status: 'active', lastSyncedAt: null, nextSyncAt: 0, lastErrorCode: '',
    lastErrorAt: null, syncLeaseId: null, syncLeaseUntil: null, tokenLeaseId: null,
    tokenLeaseUntil: null, lastManualSyncAt: null, createdAt: NOW, updatedAt: NOW, ...fields,
  })
}

function queuedIds(jobs: MailQueueJob[]): string[] {
  return jobs.flatMap((job) => job.kind === 'microsoft-sync' ? [job.accountId] : [])
}

async function row(id: string) {
  return env.DB.prepare(
    `SELECT status, last_error_code, last_error_at, next_sync_at, sync_lease_id
       FROM microsoft_imap_accounts WHERE id = ?`,
  ).bind(id).first<{
    status: string
    last_error_code: string
    last_error_at: number | null
    next_sync_at: number
    sync_lease_id: string | null
  }>()
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare(`INSERT INTO users (id, email, display_name, password_hash, role)
    VALUES (?, 'microsoft-sync-owner@example.com', 'Owner', 'test', 'user')`).bind(USER).run()
})

beforeEach(async () => {
  imap.failure = null
  imap.opened = 0
  await env.DB.prepare('DELETE FROM microsoft_imap_accounts WHERE user_id = ?').bind(USER).run()
  await env.DB.prepare('DELETE FROM microsoft_imap_validation_limits').run()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
    access_token: 'fresh-access-token', refresh_token: 'rotated-refresh-token', expires_in: 3600,
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
  }))
})

afterEach(() => { vi.restoreAllMocks() })

describe('真实 D1 Microsoft 同步对拒绝的分级', () => {
  it('第一次被拒只记为暂时错误，15 分钟后重试，并记下 Microsoft 的原话', async () => {
    await account('refused-once')
    imap.failure = refusal()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await syncMicrosoftAccount(env, 'refused-once', NOW)

    // Both the cached token and a freshly refreshed one were refused.
    expect(imap.opened).toBe(2)
    expect(result).toEqual({ status: 'skipped', retryable: false })
    expect(await row('refused-once')).toMatchObject({
      status: 'error', last_error_code: 'imap_access_rejected', last_error_at: NOW,
      next_sync_at: NOW + 15 * 60, sync_lease_id: null,
    })
    expect(warn).toHaveBeenCalledWith('Microsoft IMAP refused the account', expect.objectContaining({
      accountId: 'refused-once', status: 'error', detail: 'NO AUTHENTICATE failed.',
    }))
  })

  it('连续被拒满 6 小时才转为权限错误，此后每 6 小时复查一次', async () => {
    await account('refused-long', {
      status: 'error', lastErrorCode: 'imap_access_rejected', lastErrorAt: NOW - 6 * HOUR,
    })
    imap.failure = refusal()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await syncMicrosoftAccount(env, 'refused-long', NOW)

    expect(await row('refused-long')).toMatchObject({
      status: 'permission_error', last_error_at: NOW - 6 * HOUR, next_sync_at: NOW + 6 * HOUR,
    })
  })

  it('权限错误的账号在 Microsoft 恢复后自己回到正常', async () => {
    await account('parked', {
      status: 'permission_error', lastErrorCode: 'imap_access_rejected',
      lastErrorAt: NOW - 48 * HOUR, nextSyncAt: NOW - 1,
    })

    expect(await syncMicrosoftAccount(env, 'parked', NOW)).toEqual({ status: 'synced', retryable: false })
    expect(await row('parked')).toMatchObject({
      status: 'active', last_error_code: '', last_error_at: null, next_sync_at: NOW + 5 * 60,
    })
  })

  it('调度器会带上到期的权限错误账号，凭据错误仍留给用户处理', async () => {
    await account('permission-due', { status: 'permission_error', nextSyncAt: NOW - 1 })
    await account('permission-later', { status: 'permission_error', nextSyncAt: NOW + HOUR })
    await account('credential-due', { status: 'credential_error', nextSyncAt: NOW - 1 })
    const sent: MailQueueJob[] = []
    const queue = { send: async (job: MailQueueJob) => { sent.push(job) } }

    await enqueueDueMicrosoftSyncs({ ...env, MAIL_QUEUE: queue } as unknown as OmniMailEnv, NOW)

    expect(queuedIds(sent)).toContain('permission-due')
    expect(queuedIds(sent)).not.toContain('permission-later')
    expect(queuedIds(sent)).not.toContain('credential-due')
    expect(await row('permission-due')).toMatchObject({ status: 'permission_error', next_sync_at: NOW + 5 * 60 })
    expect(await row('credential-due')).toMatchObject({ status: 'credential_error', next_sync_at: NOW - 1 })
  })

  it('同步中途死掉留下的租约过期后，调度器把账号救回来重试', async () => {
    await account('stale', { status: 'syncing', syncLeaseId: 'dead', syncLeaseUntil: NOW - 1, nextSyncAt: NOW + HOUR })
    await account('running', { status: 'syncing', syncLeaseId: 'live', syncLeaseUntil: NOW + 60 })
    const sent: MailQueueJob[] = []
    const queue = { send: async (job: MailQueueJob) => { sent.push(job) } }

    await enqueueDueMicrosoftSyncs({ ...env, MAIL_QUEUE: queue } as unknown as OmniMailEnv, NOW)

    expect(queuedIds(sent)).toContain('stale')
    expect(queuedIds(sent)).not.toContain('running')
    expect(await row('stale')).toMatchObject({
      status: 'error', last_error_code: 'stale_lease', last_error_at: NOW,
      next_sync_at: NOW + 5 * 60, sync_lease_id: null,
    })
    expect(await row('running')).toMatchObject({ status: 'syncing', sync_lease_id: 'live' })
  })
})

describe('真实 D1 Microsoft 立即验证', () => {
  it('验证通过后账号立刻回到同步计划，而不是等原来排的下一次', async () => {
    await account('verified', {
      status: 'permission_error', lastErrorCode: 'imap_access_rejected',
      lastErrorAt: NOW - 48 * HOUR, nextSyncAt: NOW + 6 * HOUR,
    })

    const response = await verifyMicrosoftAccount(env, user, 'verified', IP)

    expect(response.status).toBe(200)
    expect(await row('verified')).toMatchObject({
      status: 'active', last_error_code: '', last_error_at: null, next_sync_at: 0,
    })
  })

  it('被限流拒绝的验证不会把账号改成错误', async () => {
    await account('throttled', {
      status: 'permission_error', lastErrorCode: 'imap_access_rejected',
      lastErrorAt: NOW - 48 * HOUR, nextSyncAt: NOW + 6 * HOUR,
    })
    for (let attempt = 0; attempt < MICROSOFT_VALIDATION_ATTEMPTS; attempt += 1) {
      await claimMicrosoftValidationAttempt(env, USER, IP)
    }

    const response = await verifyMicrosoftAccount(env, user, 'throttled', IP)

    expect(response.status).toBe(429)
    expect(imap.opened).toBe(0)
    expect(await row('throttled')).toMatchObject({
      status: 'permission_error', last_error_code: 'imap_access_rejected',
      last_error_at: NOW - 48 * HOUR, next_sync_at: NOW + 6 * HOUR,
    })
  })

  it('验证被拒与同步被拒算作同一段连续失败', async () => {
    await account('verify-refused', {
      status: 'error', lastErrorCode: 'imap_access_rejected', lastErrorAt: NOW - 7 * HOUR,
    })
    imap.failure = refusal()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const before = Math.floor(Date.now() / 1000)

    const response = await verifyMicrosoftAccount(env, user, 'verify-refused', IP)

    expect(response.status).toBe(400)
    const after = await row('verify-refused')
    expect(after).toMatchObject({ status: 'permission_error', last_error_at: NOW - 7 * HOUR })
    expect(after!.next_sync_at).toBeGreaterThanOrEqual(before + 6 * HOUR)
  })
})
