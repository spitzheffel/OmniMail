import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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
import { createICloudAlias, previewICloudAlias } from '../src/features/icloud/icloud-api'
import { encryptICloudCredential } from '../src/features/icloud/icloud-credentials'
import { ICloudAccountStore, iCloudAliasChannels } from '../src/features/icloud/icloud-store'
import type { AppleAccountState, ICloudAccount } from '../src/features/icloud/icloud-types'
import type { Env as OmniMailEnv, SessionUser } from '../src/app/types'

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
    // The store suites below insert their own rows. Giving them a separate
    // owner is what keeps 'lists only public metadata' from counting them —
    // otherwise the whole file only passes in declaration order.
    env.DB.prepare(
      `INSERT INTO users (
        id, email, display_name, password_hash, role, mailbox_limit,
        storage_quota_bytes, can_create_mailboxes, can_reply
      ) VALUES ('icloud-store', 'icloud-store@example.com', 'Store', 'test', 'user', 1, 1024, 1, 0)`,
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
  // One hour per test, because a window resets on any hour it has not seen.
  // Sharing one made every case depend on the rows its predecessors left
  // behind, so the suite only passed in declaration order.
  const AT = {
    budget: NOW,
    refusing: NOW + 1 * 3600,
    channels: NOW + 2 * 3600,
    refund: NOW + 3 * 3600,
    // rollover claims in its own hour and again in the one after it.
    rollover: NOW + 4 * 3600,
    saturated: NOW + 6 * 3600,
    scoped: NOW + 7 * 3600,
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
      ).resolves.toEqual({ allowed: true, remaining: APPLE_LIMIT - taken })
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
    ).resolves.toEqual({ allowed: true, remaining: ICLOUD_ALIAS_HOURLY_LIMITS.icloud_web - 1 })
  })

  it('refunds a reservation that never reached Apple', async () => {
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', AT.refund),
    ).resolves.toMatchObject({ allowed: true })

    await releaseICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'icloud_web', AT.refund)

    expect(await windowRow('icloud_web'))
      .toMatchObject({ hour_started_at: hourStart(AT.refund), hour_count: 0 })
  })

  it('starts a clean budget once the hour rolls over', async () => {
    await spendAppleBudget(AT.rollover)

    const next = AT.rollover + 3600
    await expect(
      claimICloudAliasCreate(env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', next),
    ).resolves.toEqual({ allowed: true, remaining: APPLE_LIMIT - 1 })
    expect(await windowRow('apple_account'))
      .toMatchObject({ hour_started_at: hourStart(next), hour_count: 1 })
  })

  it('saturates the window when Apple reports its own cap', async () => {
    await exhaustICloudAliasChannel(
      env.DB, 'icloud-owner', 'icloud-account-1', 'apple_account', AT.saturated,
    )

    expect(await windowRow('apple_account')).toMatchObject({ hour_count: APPLE_LIMIT })
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
})

const STORE_USER = 'icloud-store'

function seededAccount(id: string, overrides: Partial<ICloudAccount> = {}): ICloudAccount {
  return {
    id,
    userId: STORE_USER,
    name: 'Cookieless',
    realEmail: '',
    icloudEmail: 'owner@icloud.com',
    cookies: {},
    host: 'icloud.com',
    appPassword: 'app-secret',
    status: 'active',
    aliasTotal: 0,
    aliasActive: 0,
    lastValidated: '',
    lastError: '',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as ICloudAccount
}

function storeStore(): ICloudAccountStore {
  return new ICloudAccountStore(env, STORE_USER)
}

function listed(id: string) {
  return storeStore().list().then((items) => items.find((item) => item.id === id))
}

/**
 * Run `before` between the bind and the run of the first prepared statement
 * matching `needle`. The store only ever calls .bind().run() on the statement
 * we intercept, so the narrow stand-in is enough.
 */
function racingDb(db: D1Database, needle: string, before: () => Promise<unknown>): D1Database {
  let armed = true
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql)
      if (!armed || !sql.includes(needle)) return statement
      armed = false
      return {
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args)
          return { run: async () => { await before(); return bound.run() } } as D1PreparedStatement
        },
      } as D1PreparedStatement
    },
  } as D1Database
}

describe('iCloud cookie jar storage', () => {
  it('stores an empty jar as empty so SQL availability agrees with the create path', async () => {
    // Encrypting '{}' yields real ciphertext, which made list()'s
    // cookies_cipher <> '' advertise a cookie channel the create path refuses.
    await storeStore().insert(seededAccount('icloud-cookieless'))

    await expect(listed('icloud-cookieless')).resolves.toMatchObject({
      hasCookies: false, hasAppPassword: true,
    })
  })

  it('normalizes a legacy row that stored the ciphertext of an empty jar', async () => {
    await storeStore().insert(seededAccount('icloud-legacy-jar'))
    // Exactly what the pre-fix code wrote for a cookie-less account.
    await env.DB.prepare('UPDATE icloud_accounts SET cookies_cipher = ? WHERE id = ?').bind(
      await encryptICloudCredential(env, '{}', `${STORE_USER}:icloud-legacy-jar:cookies`),
      'icloud-legacy-jar',
    ).run()
    await expect(listed('icloud-legacy-jar')).resolves.toMatchObject({ hasCookies: true })

    await storeStore().get('icloud-legacy-jar')

    await expect(listed('icloud-legacy-jar')).resolves.toMatchObject({ hasCookies: false })
  })

  it('leaves a jar saved between the read and the normalizing write alone', async () => {
    // The normalizing UPDATE carries WHERE cookies_cipher = ? precisely so it
    // cannot erase a jar another request stored while this read was in flight.
    await storeStore().insert(seededAccount('icloud-legacy-race'))
    await env.DB.prepare('UPDATE icloud_accounts SET cookies_cipher = ? WHERE id = ?').bind(
      await encryptICloudCredential(env, '{}', `${STORE_USER}:icloud-legacy-race:cookies`),
      'icloud-legacy-race',
    ).run()

    const raced = new ICloudAccountStore(
      { ...env, DB: racingDb(env.DB, "cookies_cipher = ''", () => storeStore().saveCookies(
        seededAccount('icloud-legacy-race', { cookies: { session: 'live' } }),
      )) } as typeof env,
      STORE_USER,
    )
    await raced.get('icloud-legacy-race')

    await expect(storeStore().get('icloud-legacy-race'))
      .resolves.toMatchObject({ cookies: { session: 'live' } })
  })

  it('rejects a jar whose plaintext is not an object with a readable error', async () => {
    // JSON.parse('null') succeeds; every reader then calls Object.keys on it.
    await storeStore().insert(seededAccount('icloud-null-jar'))
    await env.DB.prepare('UPDATE icloud_accounts SET cookies_cipher = ? WHERE id = ?').bind(
      await encryptICloudCredential(env, 'null', `${STORE_USER}:icloud-null-jar:cookies`),
      'icloud-null-jar',
    ).run()

    await expect(storeStore().get('icloud-null-jar'))
      .rejects.toMatchObject({ status: 500, message: 'iCloud 账号凭据已损坏。' })
  })
})

describe('iCloud alias counters', () => {
  it('keeps a create increment that a concurrent cookie save would overwrite', async () => {
    // Every saveCookies caller holds an account read before its network
    // round-trip, so persisting their counters here reverts the create that
    // landed meanwhile — including the one the call is reporting on.
    const snapshot = seededAccount('icloud-counters', {
      aliasTotal: 10, aliasActive: 9, cookies: { session: 'value' },
    })
    await storeStore().insert(snapshot)

    await storeStore().addAliasSummary('icloud-counters', 1)
    await storeStore().saveCookies(snapshot)

    await expect(listed('icloud-counters')).resolves.toMatchObject({
      aliasTotal: 11, aliasActive: 10,
    })
  })

  it('yields to a create that landed after the listing was taken', async () => {
    // A listing is only authoritative for the state it saw. Writing it over an
    // increment that arrived later drops an alias the account really has.
    const store = storeStore()
    await store.insert(seededAccount('icloud-summary-race', { aliasTotal: 10, aliasActive: 10 }))

    const raced = new ICloudAccountStore(
      { ...env, DB: racingDb(env.DB, 'alias_total = ?', () => (
        store.addAliasSummary('icloud-summary-race', 1)
      )) } as typeof env,
      STORE_USER,
    )
    await raced.saveAliasSummary('icloud-summary-race', 10, 10, 10)

    await expect(listed('icloud-summary-race')).resolves.toMatchObject({
      aliasTotal: 11, aliasActive: 11,
    })
  })

  it('still applies a listing that found one alias fewer', async () => {
    // The guard must not block the legitimate case it exists alongside: a
    // delete lowers the count and nothing else touched the row.
    const store = storeStore()
    await store.insert(seededAccount('icloud-summary-delete', { aliasTotal: 10, aliasActive: 10 }))

    await store.saveAliasSummary('icloud-summary-delete', 9, 9, 10)

    await expect(listed('icloud-summary-delete')).resolves.toMatchObject({
      aliasTotal: 9, aliasActive: 9,
    })
  })

  it('applies two concurrent creates as two increments', async () => {
    await storeStore().insert(seededAccount('icloud-counters-race', { aliasTotal: 10, aliasActive: 9 }))

    await Promise.all([
      storeStore().addAliasSummary('icloud-counters-race', 1),
      storeStore().addAliasSummary('icloud-counters-race', 1),
    ])

    await expect(listed('icloud-counters-race')).resolves.toMatchObject({
      aliasTotal: 12, aliasActive: 11,
    })
  })
})

const STORE_SESSION = { id: STORE_USER } as SessionUser

function aliasRequest(body: unknown): Request {
  return new Request('https://mail.example.com/api/icloud/aliases', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

/** A fresh Response per call: request() retries, and a body reads only once. */
function throttled(): Response {
  return new Response('Too Many Requests', { status: 429 })
}

function serviceResponse(): Response {
  return Response.json({
    webservices: { premiummailsettings: { url: 'https://p71-maildomainws.icloud.com' } },
    dsInfo: { dsid: '123', appleId: 'person@icloud.com' },
  })
}

/** An Apple management state that is past its timeout but still refreshable. */
function staleAppleState(): AppleAccountState {
  return {
    cookies: { session: 'cookie-value' }, scnt: 'scnt-old', sessionId: 'session-old',
    apiKey: 'api-old', expiresAt: '', lastCheckedAt: '', userAgent: '',
    host: 'appleid.apple.com', origin: 'https://account.apple.com',
  }
}

/** Answer the two calls refresh() makes, and nothing else. */
async function appleRefreshOnly(input: RequestInfo | URL): Promise<Response> {
  const { pathname } = new URL(String(input))
  if (pathname === '/account/manage/gs/ws/token') {
    return new Response('{"timeOutInterval":15}', { headers: { scnt: 'scnt-fresh' } })
  }
  if (pathname === '/account/manage') {
    return new Response('{"apiKey":"api-fresh"}', { headers: { scnt: 'scnt-manage' } })
  }
  return new Response('', { status: 404 })
}

/** Make every statement touching `needle` fail, as a D1 outage would. */
function failingDb(db: D1Database, needle: string): D1Database {
  return {
    prepare(sql: string) {
      if (!sql.includes(needle)) return db.prepare(sql)
      const boom = async () => { throw new Error('D1_ERROR: database is unavailable') }
      return { bind: () => ({ first: boom, run: boom, all: boom }) } as unknown as D1PreparedStatement
    },
  } as D1Database
}

function appleStatus(accountId: string): Promise<{ apple_account_status: string } | null> {
  return env.DB.prepare('SELECT apple_account_status FROM icloud_accounts WHERE id = ?')
    .bind(accountId).first<{ apple_account_status: string }>()
}

function webUsed(accountId: string): Promise<number | undefined> {
  return readICloudAliasQuota(env.DB, STORE_USER, accountId)
    .then((quotas) => quotas.find((item) => item.channel === 'icloud_web')?.used)
}

/**
 * The alias handlers' failure paths, against a real D1. They reach the quota
 * table and the store, which the unit suites stub away — every regression this
 * feature has produced so far has lived in exactly that gap.
 */
describe('iCloud alias handler failure paths', () => {
  afterEach(() => vi.restoreAllMocks())

  it('saturates the window when Apple caps a preview', async () => {
    // The batch runner previews before it creates, so a run's first cap lands
    // here. Leaving the window untouched makes every later item repeat the trip.
    await storeStore().insert(seededAccount('icloud-preview-cap', { cookies: { session: 'value' } }))
    let validated = false
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (validated) return throttled()
      validated = true
      return serviceResponse()
    })

    const response = await previewICloudAlias(
      env, STORE_SESSION, aliasRequest({ accountId: 'icloud-preview-cap' }),
    )

    expect(response.status).toBe(429)
    await expect(webUsed('icloud-preview-cap')).resolves.toBe(ICLOUD_ALIAS_HOURLY_LIMITS.icloud_web)
  })

  it('restores the status of a session that refreshed before the claim failed', async () => {
    // An explicit channel bypasses the availability check, so this runs on a row
    // still marked expired. refresh() rotates scnt upstream and the catch has to
    // persist it — writing the rotated state back under the old 'expired' status
    // would hide a session Apple has just accepted until it is imported again.
    await storeStore().insert(seededAccount('icloud-refresh-claim', {
      appleAccountState: staleAppleState(), appleAccountStatus: 'expired',
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(appleRefreshOnly)
    const broken = { ...env, DB: failingDb(env.DB, 'icloud_alias_create_limits') } as typeof env

    const response = await createICloudAlias(broken, STORE_SESSION, aliasRequest({
      accountId: 'icloud-refresh-claim', channel: 'apple_account',
    }), '192.0.2.1')

    expect(response.status).toBe(502)
    await expect(appleStatus('icloud-refresh-claim'))
      .resolves.toMatchObject({ apple_account_status: 'active' })
  })

  it('marks the account when Apple rejects the jar at preview time', async () => {
    // The preview now persists the rotated cookies on failure, so it also has
    // to persist the failure; otherwise the list keeps showing the account as
    // healthy and the user walks into the same wall every time.
    await storeStore().insert(seededAccount('icloud-preview-dead', { cookies: { session: 'value' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 401 }))

    const response = await previewICloudAlias(
      env, STORE_SESSION, aliasRequest({ accountId: 'icloud-preview-dead' }),
    )

    expect(response.status).toBe(422)
    await expect(listed('icloud-preview-dead')).resolves.toMatchObject({ status: 'error' })
  })

  it('spends no slot when the service lookup is throttled on the draft path', async () => {
    // A draft card carries email+previewId, so generateAlias() is skipped and
    // reserveAlias() would resolve the service from inside the claim window.
    // validate() throttles for reasons unrelated to the cap, and settleWebClaim
    // can neither saturate nor refund that — the slot would simply burn.
    await storeStore().insert(seededAccount('icloud-draft-throttle', { cookies: { session: 'value' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => throttled())

    const response = await createICloudAlias(env, STORE_SESSION, aliasRequest({
      accountId: 'icloud-draft-throttle',
      email: 'candidate@icloud.com',
      previewId: '11111111-2222-4333-8444-555555555555',
    }), '192.0.2.1')

    expect(response.status).toBe(502)
    await expect(webUsed('icloud-draft-throttle')).resolves.toBe(0)
  })
})

describe('iCloud alias channel availability', () => {
  it('treats a rejected Apple session as unusable, matching the create path', () => {
    const base = { cookies: {}, appleAccountState: { scnt: 'x' } } as unknown as ICloudAccount
    expect(iCloudAliasChannels({ ...base, appleAccountStatus: 'active' }).appleAccount).toBe(true)
    expect(iCloudAliasChannels({ ...base, appleAccountStatus: 'expired' }).appleAccount).toBe(false)
    expect(iCloudAliasChannels({ ...base, cookies: {} }).icloudWeb).toBe(false)
    expect(iCloudAliasChannels({ ...base, cookies: { a: 'b' } }).icloudWeb).toBe(true)
  })
})
