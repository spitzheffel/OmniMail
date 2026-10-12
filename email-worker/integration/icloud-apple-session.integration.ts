import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { createSessionToken, storeSession } from '../src/features/auth/session/auth'
import { createICloudAlias, refreshICloudAppleAccount } from '../src/features/icloud/icloud-account-api'
import { readICloudAliasQuota } from '../src/features/icloud/icloud-alias-quota'
import { listICloudAliases } from '../src/features/icloud/icloud-api'
import { ICLOUD_CREDENTIAL_ERROR_MESSAGE } from '../src/features/icloud/icloud-apple'
import { withAppleAccountSessionGate } from '../src/features/icloud/icloud-apple-session'
import { encryptICloudCredential } from '../src/features/icloud/icloud-credentials'
import { ICloudAccountStore } from '../src/features/icloud/icloud-store'
import type { ICloudAccount } from '../src/features/icloud/icloud-types'
import type { SessionUser } from '../src/app/types'
import {
  APPLE_TOKEN_PATH,
  appleRefreshThen,
  appleTokenResponse,
  iCloudAccount,
  liveAppleState,
  noDefer,
  pathOf,
  seedUser,
} from './icloud-fixtures'
import { failingDb, racingDb, recordingDb } from './icloud-test-db'

/*
 * The Apple Account management session across requests, against a real D1.
 * Apple rotates scnt on every successful response, so what matters here is
 * which request's copy of the session ends up stored.
 */
const sessionToken = createSessionToken()

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await seedUser('apple-session')
  await storeSession(env.DB, 'apple-session', sessionToken)
})

afterEach(() => vi.restoreAllMocks())

const USER = 'apple-session'
const SESSION = { id: USER } as SessionUser
const LISTING_PATH = '/account/manage/email/private'

function store(): ICloudAccountStore {
  return new ICloudAccountStore(env, USER)
}

/** An account managed only through Apple Account: no cookie jar, no IMAP. */
function appleOnly(id: string, overrides: Partial<ICloudAccount> = {}): ICloudAccount {
  return iCloudAccount(USER, id, {
    name: 'Apple only', appPassword: '', appleAccountState: liveAppleState(), appleAccountStatus: 'active',
    ...overrides,
  })
}

function list(accountId: string, db = env.DB): Promise<Response> {
  return listICloudAliases({ ...env, DB: db } as typeof env, SESSION, new Request(
    `https://mail.example.com/api/icloud/aliases?accountId=${accountId}`,
  ), noDefer)
}

describe('Apple Account session writes', () => {
  it('starts a queued listing from the scnt the one before it rotated', async () => {
    // Both requests read the session on arrival. Replaying that copy after the
    // first had rotated it is what Apple answers with an expired session.
    await store().insert(appleOnly('apple-gate'))
    const sent: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(new Headers(init?.headers).get('scnt') || '')
      return Response.json({ hmeEmails: [] }, { headers: { scnt: `scnt-${sent.length}` } })
    })

    const responses = await Promise.all([list('apple-gate'), list('apple-gate')])

    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(sent).toEqual(['scnt-live', 'scnt-1'])
    await expect(store().get('apple-gate'))
      .resolves.toMatchObject({ appleAccountState: { scnt: 'scnt-2' } })
  })

  it('does not bring back a session removed while a listing was in flight', async () => {
    // The listing succeeds and rotates scnt, but the user has dropped the
    // session meanwhile; writing the rotation back would undo the removal.
    await store().insert(appleOnly('apple-removed'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await store().clearAppleAccountState('apple-removed')
      return Response.json({ hmeEmails: [] }, { headers: { scnt: 'scnt-rotated' } })
    })

    expect((await list('apple-removed')).status).toBe(200)

    await expect(store().get('apple-removed')).resolves.toMatchObject({
      appleAccountState: null, appleAccountStatus: 'none',
    })
  })

  it('does not mark expired a session replaced after the listing read it', async () => {
    // Apple rejected the copy this request held, but a fresh sign-in landed
    // before the failure was written; that one is live and must stay active.
    await store().insert(appleOnly('apple-replaced'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 401 }))
    const db = racingDb(env.DB, 'AND apple_account_state_cipher = ?', () => store().saveAppleAccountState(
      appleOnly('apple-replaced', { appleAccountState: liveAppleState('scnt-signed-in') }),
    ))

    expect((await list('apple-replaced', db)).status).toBe(422)

    await expect(store().get('apple-replaced')).resolves.toMatchObject({
      appleAccountStatus: 'active', appleAccountState: { scnt: 'scnt-signed-in' },
    })
  })

  it('keeps the rotation of a request that finishes after a stale one failed', async () => {
    // Two isolates, two gates. The winner rotated the session first, so the
    // loser's replayed scnt fails fast and writes its verdict first. That
    // verdict concerns a session nobody holds any more; it must not lock out
    // the winner's write of the session Apple actually rotated.
    await store().insert(appleOnly('apple-loser-first'))
    const winner = await store().get('apple-loser-first')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 401 }))

    expect((await list('apple-loser-first')).status).toBe(422)
    winner.appleAccountState = liveAppleState('scnt-winner')
    winner.appleAccountStatus = 'active'

    await expect(store().advanceAppleAccountState(winner, true)).resolves.toBe(true)
    await expect(store().get('apple-loser-first')).resolves.toMatchObject({
      appleAccountStatus: 'active', appleAccountState: { scnt: 'scnt-winner' },
    })
  })

  it('keeps a rotation across a key migration that re-encrypted the same session', async () => {
    // The migration writes the same session under a fresh IV. That is not a
    // newer session, so the scnt Apple just rotated still has to land.
    await store().insert(appleOnly('apple-migrated'))
    const adopted = (await store().get('apple-migrated')).appleAccountRead
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ hmeEmails: [] }, { headers: { scnt: 'scnt-rotated' } }),
    )
    const db = racingDb(env.DB, 'AND apple_account_state_cipher = ?', async () => {
      const row = await env.DB.prepare('SELECT apple_account_state_cipher FROM icloud_accounts WHERE id = ?')
        .bind('apple-migrated').first<{ apple_account_state_cipher: string }>()
      // Nothing has written the session since the listing adopted it, so what
      // gets re-encrypted below is that very session, as a migration would.
      expect(row?.apple_account_state_cipher).toBe(adopted?.cipher)
      await env.DB.prepare('UPDATE icloud_accounts SET apple_account_state_cipher = ? WHERE id = ?').bind(
        await encryptICloudCredential(env, adopted?.plaintext || '', `${USER}:apple-migrated:apple-account`),
        'apple-migrated',
      ).run()
    })

    expect((await list('apple-migrated', db)).status).toBe(200)

    await expect(store().get('apple-migrated'))
      .resolves.toMatchObject({ appleAccountState: { scnt: 'scnt-rotated' } })
  })
})

describe('Apple Account alias listing', () => {
  it('reports an outage instead of answering with an empty list', async () => {
    // Only a missing endpoint means "this region has no list". An empty answer
    // here reads as "no aliases" and hides the failure.
    await store().insert(appleOnly('apple-outage'))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }))

    const response = await list('apple-outage')

    expect(response.status).toBe(502)
    // Apple's status rides in `detail`, so the message itself stays translatable.
    await expect(response.json()).resolves.toMatchObject({
      error: 'Apple Account 请求失败。', detail: expect.stringContaining('HTTP 503'),
    })
  })

  it('lists through a working Apple session when Apple rejects the cookie jar', async () => {
    // Creation already prefers the Apple session; the pane should not go blank
    // because the other credential died.
    await store().insert(appleOnly('apple-fallback', { cookies: { session: 'dead' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => (
      pathOf(input) === LISTING_PATH
        ? Response.json({ hmeEmails: [{ emailAddress: 'Shop@icloud.com', id: 'a1' }] })
        : new Response('', { status: 401 })
    ))

    const response = await list('apple-fallback')

    expect(response.status).toBe(200)
    // The list is real, but nothing else would tell the user the jar is dead.
    await expect(response.json()).resolves.toMatchObject({
      aliases: [expect.objectContaining({ email: 'shop@icloud.com' })],
      cookieError: ICLOUD_CREDENTIAL_ERROR_MESSAGE,
    })
    await expect(store().get('apple-fallback')).resolves.toMatchObject({
      status: 'error', aliasTotal: 1, aliasActive: 1,
    })
  })

  it('keeps the scnt from a 200 whose list it cannot read', async () => {
    // The response was successful, so Apple rotated the session even though the
    // body holds no list this code recognises; the empty answer is fine, losing
    // the rotation is not.
    await store().insert(appleOnly('apple-unreadable'))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ unexpected: { shape: true } }, { headers: { scnt: 'scnt-rotated' } }),
    )

    const response = await list('apple-unreadable')

    await expect(response.json()).resolves.toEqual({ aliases: [] })
    await expect(store().get('apple-unreadable'))
      .resolves.toMatchObject({ appleAccountState: { scnt: 'scnt-rotated' } })
  })

  it('runs a gated listing under waitUntil when it comes through the worker', async () => {
    // Workers drops a request whose client disconnects; only waitUntil lets the
    // holder persist what Apple rotated and release the gate. Through the real
    // worker, so auth, scopes and the /api mount sit in between as in production.
    await store().insert(appleOnly('apple-route'))
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ hmeEmails: [] }, { headers: { scnt: 'scnt-route' } }))
    const context = createExecutionContext()
    const waitUntil = vi.spyOn(context, 'waitUntil')

    const response = await worker.fetch(
      new Request('https://mail.example.com/api/icloud/aliases?accountId=apple-route', {
        headers: { Cookie: `omnimail_session=${sessionToken}` },
      }),
      env, context,
    )
    await waitOnExecutionContext(context)

    expect(response.status).toBe(200)
    expect(waitUntil).toHaveBeenCalled()
    await expect(store().get('apple-route')).resolves.toMatchObject({ appleAccountState: { scnt: 'scnt-route' } })
  })

  it('reports the dead jar when the Apple session is removed before it can stand in', async () => {
    await store().insert(appleOnly('apple-fallback-removed', { cookies: { session: 'dead' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 401 }))
    const db = racingDb(env.DB, 'cookies_cipher = ?, status = ?', () => (
      store().clearAppleAccountState('apple-fallback-removed')
    ))

    const response = await list('apple-fallback-removed', db)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: ICLOUD_CREDENTIAL_ERROR_MESSAGE })
  })

  it.each([404, 503])('reports the dead jar when the Apple listing answers %i in its place', async (status) => {
    // Where Apple has no list, the jar is the only way to list aliases, so an
    // empty answer would hide the one thing the user has to fix; Apple's own
    // outage message would point them at the wrong credential.
    await store().insert(appleOnly(`apple-fallback-${status}`, { cookies: { session: 'dead' } }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => (
      new Response('', { status: pathOf(input) === LISTING_PATH ? status : 401 })
    ))

    const response = await list(`apple-fallback-${status}`)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: ICLOUD_CREDENTIAL_ERROR_MESSAGE })
  })
})

describe('Apple Account create after a disconnect', () => {
  const SETTLED = '-- kept-alive task settled'

  /**
   * Run a create whose kept-alive task marks, in the statement log, the point
   * a request whose client disconnected stops at: Workers keeps it running only
   * until that task settles, and the Apple create inside it commits regardless.
   */
  async function createKeptAlive(accountId: string) {
    const log: string[] = []
    const response = await createICloudAlias(
      { ...env, DB: recordingDb(env.DB, log) } as typeof env, SESSION,
      new Request('https://mail.example.com/api/icloud/aliases', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, channel: 'apple_account' }),
      }),
      '192.0.2.1',
      (task) => { void task.then(() => log.push(SETTLED)) },
    )
    return { response, log }
  }

  function doneBeforeSettled(log: string[], needle: string): boolean {
    const issued = log.findIndex((sql) => sql.includes(needle))
    return issued >= 0 && issued < log.indexOf(SETTLED)
  }

  it('counts and audits a create before its kept-alive task settles', async () => {
    // Otherwise a disconnect leaves an alias at Apple with no audit row and
    // counters that miss it.
    await store().insert(appleOnly('apple-create-kept'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      emailAddress: 'fresh@icloud.com', id: 'alias-1', label: 'Shop', active: true,
    }))

    const { response, log } = await createKeptAlive('apple-create-kept')

    expect(response.status).toBe(201)
    expect(doneBeforeSettled(log, 'INSERT INTO audit_logs')).toBe(true)
    expect(doneBeforeSettled(log, 'alias_total = alias_total + 1')).toBe(true)
  })

  it('refunds the claim of a refused create before its kept-alive task settles', async () => {
    // Apple refused the session after the claim; a refund issued after the
    // task settles never runs for a disconnected request, burning the slot.
    await store().insert(appleOnly('apple-create-refused'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 401 }))

    const { response, log } = await createKeptAlive('apple-create-refused')

    expect(response.status).toBe(422)
    expect(doneBeforeSettled(log, 'hour_count = hour_count - 1')).toBe(true)
  })
})

describe('Apple Account create', () => {
  function create(accountId: string, channel?: string, db = env.DB): Promise<Response> {
    return createICloudAlias({ ...env, DB: db } as typeof env, SESSION, new Request('https://mail.example.com/api/icloud/aliases', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId, channel }),
    }), '192.0.2.1', noDefer)
  }

  /** Apple accepting every call of a create, without handing out a new scnt. */
  function acceptingCreate() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      emailAddress: 'fresh@icloud.com', id: 'alias-1', label: 'Shop', active: true,
    }))
  }

  it('still records a committed create when saving the session fails', async () => {
    // Answering 502 for an alias Apple has created invites a retry, which
    // creates a second one, and leaves the first without an audit row.
    await store().insert(appleOnly('apple-create-persist-down'))
    acceptingCreate()

    const response = await create('apple-create-persist-down', 'apple_account',
      failingDb(env.DB, 'AND apple_account_state_cipher = ?'))

    expect(response.status).toBe(201)
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE target_id = ? AND action = 'icloud.alias.create'",
    ).bind('apple-create-persist-down').first<{ count: number }>()
    expect(audit?.count).toBe(1)
  })

  it('still answers 201 for a committed create when the audit row cannot be written', async () => {
    await store().insert(appleOnly('apple-create-audit-down'))
    acceptingCreate()

    const response = await create('apple-create-audit-down', 'apple_account', failingDb(env.DB, 'INSERT INTO audit_logs'))

    expect(response.status).toBe(201)
  })

  it('keeps the ciphertext when Apple handed out no new session values', async () => {
    // lastCheckedAt is a local timestamp; counting it as a rotation re-encrypts
    // the same session, which reads as a newer version to a concurrent writer.
    await store().insert(appleOnly('apple-create-unrotated'))
    const before = (await store().get('apple-create-unrotated')).appleAccountRead
    acceptingCreate()

    expect((await create('apple-create-unrotated', 'apple_account')).status).toBe(201)

    await expect(store().get('apple-create-unrotated'))
      .resolves.toMatchObject({ appleAccountRead: { cipher: before?.cipher } })
  })

  it('keeps the session its refresh rotated when the create then hits the cap', async () => {
    // The refresh succeeded, so the session is live and its new scnt has to
    // land; the cap hit afterwards says nothing against it.
    await store().insert(appleOnly('apple-create-recovered', {
      appleAccountState: { ...liveAppleState(), expiresAt: '' },
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(appleRefreshThen(() => new Response('', { status: 429 })))

    expect((await create('apple-create-recovered', 'apple_account')).status).toBe(429)

    await expect(store().get('apple-create-recovered')).resolves.toMatchObject({
      appleAccountStatus: 'active', appleAccountState: { scnt: 'scnt-manage', apiKey: 'api-fresh' },
    })
  })

  it('closes the Apple window when Apple reports its cap on the create', async () => {
    // add is metered, so its bare 429 is the hourly cap; settling it as a
    // refund would keep advertising slots Apple has closed.
    await store().insert(appleOnly('apple-create-capped'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 429 }))

    expect((await create('apple-create-capped', 'apple_account')).status).toBe(429)

    const quota = await readICloudAliasQuota(env.DB, USER, 'apple-create-capped')
    expect(quota.find((item) => item.channel === 'apple_account')).toMatchObject({ remaining: 0 })
  })

  it.each(['apple_account', undefined])('refuses at once to create through a session already marked expired (channel %s)', async (channel) => {
    // By the time a session is marked expired, Apple has refused it even after
    // a refresh; replaying it once per remaining item of a batch only collects
    // more refusals. The user is told to sign in again, in the session's own
    // words, whether or not the request named the channel.
    const id = `apple-create-expired-${channel ?? 'inferred'}`
    await store().insert(appleOnly(id, {
      appleAccountStatus: 'expired', appleAccountError: 'Apple Account 管理态已失效，请重新登录。',
    }))
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const response = await create(id, channel)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: 'Apple Account 管理态已失效，请重新登录。' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('marks an expired session active again once a listing gets through', async () => {
    // Creation no longer retries an expired session; the listing every sync
    // makes is how one that works after all comes back.
    await store().insert(appleOnly('apple-list-revived', { appleAccountStatus: 'expired' }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ hmeEmails: [] }))

    expect((await list('apple-list-revived')).status).toBe(200)

    await expect(store().get('apple-list-revived')).resolves.toMatchObject({ appleAccountStatus: 'active' })
  })

  it('leaves a session that expired while it queued to the cookie jar', async () => {
    // The inferred channel was picked from the arrival read; the request ahead
    // in the gate has since found the session dead.
    await store().insert(appleOnly('apple-create-queued', { cookies: { session: 'jar' } }))
    const hosts: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      hosts.push(new URL(input instanceof Request ? input.url : String(input)).hostname)
      return new Response('', { status: 401 })
    })
    const statements: string[] = []
    const ahead = withAppleAccountSessionGate('apple-create-queued', async () => {
      // Only once the create has read the account on arrival, still active.
      await vi.waitFor(() => expect(statements.some((sql) => sql.includes('FROM icloud_accounts'))).toBe(true))
      const account = await store().get('apple-create-queued')
      account.appleAccountStatus = 'expired'
      await store().saveAppleAccountState(account)
    }, noDefer)

    const response = await create('apple-create-queued', undefined, recordingDb(env.DB, statements))
    await ahead

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ error: ICLOUD_CREDENTIAL_ERROR_MESSAGE })
    expect(hosts).not.toContain('appleid.apple.com')
  })
})

describe('Apple Account manual refresh', () => {
  /** The token call succeeds and rotates scnt; /account/manage answers `status`. */
  function tokenThen(status: number) {
    return async (input: RequestInfo | URL) => (
      pathOf(input) === APPLE_TOKEN_PATH ? appleTokenResponse() : new Response('', { status })
    )
  }

  function refresh(accountId: string, db = env.DB): Promise<Response> {
    return refreshICloudAppleAccount({ ...env, DB: db } as typeof env, SESSION, accountId, noDefer)
  }

  it('keeps the scnt the token call rotated when the next step fails', async () => {
    await store().insert(appleOnly('apple-refresh-partial'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(tokenThen(503))

    expect((await refresh('apple-refresh-partial')).status).toBe(502)

    await expect(store().get('apple-refresh-partial')).resolves.toMatchObject({
      appleAccountStatus: 'active', appleAccountState: { scnt: 'scnt-fresh' },
    })
  })

  it('does not report a refresh superseded by a removal as refreshed', async () => {
    await store().insert(appleOnly('apple-refresh-removed'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(appleRefreshThen(() => new Response('', { status: 404 })))
    const db = racingDb(env.DB, 'AND apple_account_state_cipher = ?', () => (
      store().clearAppleAccountState('apple-refresh-removed')
    ))

    const response = await refresh('apple-refresh-removed', db)

    expect(response.status).toBe(400)
  })

  it('marks the session expired when Apple rejects it', async () => {
    await store().insert(appleOnly('apple-refresh-rejected'))
    vi.spyOn(globalThis, 'fetch').mockImplementation(tokenThen(401))

    expect((await refresh('apple-refresh-rejected')).status).toBe(422)

    await expect(store().get('apple-refresh-rejected')).resolves.toMatchObject({
      appleAccountStatus: 'expired', appleAccountState: { scnt: 'scnt-fresh' },
    })
  })
})
