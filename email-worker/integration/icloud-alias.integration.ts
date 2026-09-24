import { env } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  ICLOUD_ALIAS_HOURLY_LIMITS,
  readICloudAliasQuota,
} from '../src/features/icloud/icloud-alias-quota'
import { refreshICloudAliasSummary } from '../src/features/icloud/icloud-alias-summary'
import {
  createICloudAlias,
  listICloudAliases,
  previewICloudAlias,
} from '../src/features/icloud/icloud-api'
import type { ICloudClient } from '../src/features/icloud/icloud-apple'
import { encryptICloudCredential } from '../src/features/icloud/icloud-credentials'
import { ICloudAccountStore, iCloudAliasChannels } from '../src/features/icloud/icloud-store'
import type { AppleAccountState, ICloudAccount, ICloudAlias } from '../src/features/icloud/icloud-types'
import type { SessionUser } from '../src/app/types'

/*
 * The account store and the alias handlers' failure paths, against a real D1.
 * Each integration file runs on a fresh database of its own; the 'icloud-store'
 * user exists because every account row needs an owner.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare(
    `INSERT INTO users (
      id, email, display_name, password_hash, role, mailbox_limit,
      storage_quota_bytes, can_create_mailboxes, can_reply
    ) VALUES ('icloud-store', 'icloud-store@example.com', 'Store', 'test', 'user', 1, 1024, 1, 0)`,
  ).run()
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

/** A store whose first statement matching `needle` lets `before` land first. */
function racedStore(needle: string, before: () => Promise<unknown>): ICloudAccountStore {
  return new ICloudAccountStore(
    { ...env, DB: racingDb(env.DB, needle, before) } as typeof env,
    STORE_USER,
  )
}

/** What a listing reported, in the shape saveAliasSummary takes. */
function listing(id: string, total: number, active: number) {
  return { id, aliasTotal: total, aliasActive: active }
}

/**
 * A cookie client that only lists: `total` aliases, the first `active` of them
 * active. `during` runs while the listing is in flight.
 */
function listingClient(total: number, active: number, during?: () => Promise<unknown>): ICloudClient {
  const aliases: ICloudAlias[] = Array.from({ length: total }, (_, index) => ({
    email: `alias-${index}@icloud.com`, anonymousId: `a${index}`, label: '', active: index < active,
  }))
  return {
    cookies: {},
    listAliases: async () => { await during?.(); return aliases },
  } as unknown as ICloudClient
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

    await racedStore("cookies_cipher = ''", () => storeStore().saveCookies(
      seededAccount('icloud-legacy-race', { cookies: { session: 'live' } }),
    )).get('icloud-legacy-race')

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

    await racedStore('alias_total = ?', () => store.addAliasSummary('icloud-summary-race', 1))
      .saveAliasSummary(listing('icloud-summary-race', 9, 9), { total: 10, active: 10 })

    await expect(listed('icloud-summary-race')).resolves.toMatchObject({
      aliasTotal: 11, aliasActive: 11,
    })
  })

  it('yields to a deactivate that landed after the listing was taken', async () => {
    // Deactivate moves alias_active and leaves the total alone, so a guard on
    // the total alone let an older listing (here one that also caught an alias
    // made on another device) overwrite the 10/9 the deactivate had written.
    const store = storeStore()
    await store.insert(seededAccount('icloud-summary-active', { aliasTotal: 10, aliasActive: 10 }))

    await racedStore('alias_total = ?', () => store.saveAliasSummary(
      listing('icloud-summary-active', 10, 9), { total: 10, active: 10 },
    )).saveAliasSummary(listing('icloud-summary-active', 11, 11), { total: 10, active: 10 })

    await expect(listed('icloud-summary-active')).resolves.toMatchObject({
      aliasTotal: 10, aliasActive: 9,
    })
  })

  it('yields to a delete that moved only the total', async () => {
    // Deleting an inactive alias leaves alias_active alone, so the total needs a
    // guard of its own: without it an older listing (here one that also caught
    // a deactivate) puts the deleted alias back.
    const store = storeStore()
    await store.insert(seededAccount('icloud-summary-total', { aliasTotal: 10, aliasActive: 9 }))

    await racedStore('alias_total = ?', () => store.saveAliasSummary(
      listing('icloud-summary-total', 9, 9), { total: 10, active: 9 },
    )).saveAliasSummary(listing('icloud-summary-total', 10, 8), { total: 10, active: 9 })

    await expect(listed('icloud-summary-total')).resolves.toMatchObject({
      aliasTotal: 9, aliasActive: 9,
    })
  })

  it('still applies a listing that found one alias fewer', async () => {
    // The guard must not block the legitimate case it exists alongside: a
    // delete lowers the count and nothing else touched the row. One alias is
    // already off, so each column is matched against a value of its own.
    const store = storeStore()
    await store.insert(seededAccount('icloud-summary-delete', { aliasTotal: 10, aliasActive: 9 }))

    await store.saveAliasSummary(listing('icloud-summary-delete', 9, 8), { total: 10, active: 9 })

    await expect(listed('icloud-summary-delete')).resolves.toMatchObject({
      aliasTotal: 9, aliasActive: 8,
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

describe('iCloud alias summary refresh', () => {
  it('applies a listing that already includes a change landed before it', async () => {
    // This request read 10/10, then another request's deactivate wrote 10/9
    // while this one was still talking to Apple, and the listing (10/8) already
    // counts it. Measured against the request's own read, the newer listing was
    // thrown away and the row kept 10/9.
    const store = storeStore()
    await store.insert(seededAccount('icloud-refresh-baseline', { aliasTotal: 10, aliasActive: 10 }))
    const account = await store.get('icloud-refresh-baseline')
    await store.saveAliasSummary(listing('icloud-refresh-baseline', 10, 9), { total: 10, active: 10 })

    await refreshICloudAliasSummary(store, account, listingClient(10, 8))

    await expect(listed('icloud-refresh-baseline')).resolves.toMatchObject({
      aliasTotal: 10, aliasActive: 8,
    })
  })

  it('still yields to a change that lands while the listing is in flight', async () => {
    // The listing (9/9) was taken before the create finished, so the create's
    // increment is the newer fact.
    const store = storeStore()
    await store.insert(seededAccount('icloud-refresh-race', { aliasTotal: 10, aliasActive: 10 }))
    const account = await store.get('icloud-refresh-race')

    await refreshICloudAliasSummary(store, account, listingClient(9, 9, () => (
      store.addAliasSummary('icloud-refresh-race', 1)
    )))

    await expect(listed('icloud-refresh-race')).resolves.toMatchObject({
      aliasTotal: 11, aliasActive: 11,
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

/** Apple accepting a preview: /v1/hme/generate with a candidate address. */
function generated(): Response {
  return Response.json({ success: true, result: { hme: 'fresh@icloud.com' } })
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
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(serviceResponse())
      .mockImplementation(async () => throttled())

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

  it('clears a recorded failure once Apple accepts a preview', async () => {
    // The failure branch marks the account; without the matching unmark a
    // jar that works again stays flagged, and list() keeps sorting it last.
    await storeStore().insert(seededAccount('icloud-preview-recovered', {
      cookies: { session: 'value' }, status: 'error', lastError: 'old failure',
    }))
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(serviceResponse())
      .mockImplementation(async () => generated())

    const response = await previewICloudAlias(
      env, STORE_SESSION, aliasRequest({ accountId: 'icloud-preview-recovered' }),
    )

    expect(response.status).toBe(200)
    await expect(listed('icloud-preview-recovered'))
      .resolves.toMatchObject({ status: 'active', lastError: '' })
  })

  it('leaves a listing failure alone when Apple accepts a preview', async () => {
    // Only the credential failure the preview's own catch records is unmarked.
    // This note was left by an alias operation whose follow-up listing failed,
    // and a freshly generated address says nothing about whether the counts
    // caught up since.
    await storeStore().insert(seededAccount('icloud-preview-stale-count', {
      cookies: { session: 'value' }, lastError: '隐藏邮箱操作已完成，但账号状态同步失败。',
    }))
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(serviceResponse())
      .mockImplementation(async () => generated())

    const response = await previewICloudAlias(
      env, STORE_SESSION, aliasRequest({ accountId: 'icloud-preview-stale-count' }),
    )

    expect(response.status).toBe(200)
    await expect(listed('icloud-preview-stale-count')).resolves.toMatchObject({
      status: 'active', lastError: '隐藏邮箱操作已完成，但账号状态同步失败。',
    })
  })

  it('keeps the rotated Apple session when the listing after a refresh fails', async () => {
    // A stale session is refreshed before listing, and where the list endpoint
    // is missing (the 404 here) the handler still answers with an empty list. It
    // used to drop the scnt the refresh had rotated, so the next create replayed
    // a dead one and marked the account expired.
    await storeStore().insert(seededAccount('icloud-list-refresh', {
      appleAccountState: staleAppleState(),
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(appleRefreshOnly)

    const response = await listICloudAliases(env, STORE_SESSION, new Request(
      'https://mail.example.com/api/icloud/aliases?accountId=icloud-list-refresh',
    ))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ aliases: [] })
    await expect(storeStore().get('icloud-list-refresh')).resolves.toMatchObject({
      appleAccountState: { scnt: 'scnt-manage', apiKey: 'api-fresh' },
    })
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
