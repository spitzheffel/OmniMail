import { env } from 'cloudflare:workers'
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import worker from '../src/index'
import { createSessionToken, storeSession } from '../src/features/auth/session/auth'
import { consumeAppleAccountLoginRateLimit } from '../src/features/auth/registration/registration-security'
import {
  sendAppleAccountLoginSms,
  startAppleAccountLogin,
  submitAppleAccountLogin2FA,
} from '../src/features/icloud/icloud-account-auth'
import { ICloudAccountStore } from '../src/features/icloud/icloud-store'
import type { ICloudAccount } from '../src/features/icloud/icloud-types'
import type { SessionUser } from '../src/app/types'
import { cleanup } from '../src/platform/scheduling/cleanup'
import { iCloudAccount, liveAppleState, noDefer, pathOf, seedUser } from './icloud-fixtures'

/*
 * The Apple Account sign-in against a real D1: the challenge row that carries
 * a sign-in across its verification code, the rate limits, and what a
 * finished sign-in leaves behind. Apple itself is a scripted fetch.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})

afterEach(() => vi.restoreAllMocks())

const IP = '198.51.100.7'
const GONE = 'apple_login_challenge_gone'
let users = 0

/** A user of its own per test: every sign-in spends that user's hourly allowance. */
async function signInFixture(overrides: Partial<ICloudAccount> = {}) {
  const userId = `sign-in-${users += 1}`
  await seedUser(userId)
  const session = { id: userId } as SessionUser
  const store = new ICloudAccountStore(env, userId)
  const accountId = `${userId}-account`
  await store.insert(iCloudAccount(userId, accountId, overrides))
  return { userId, session, store, accountId }
}

function post(body: unknown): Request {
  return new Request('https://mail.example.com/api/icloud/accounts/x/apple-account/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

type Fixture = Awaited<ReturnType<typeof signInFixture>>

function start({ session, accountId }: Fixture, appleId = 'owner@icloud.com', twoFactorMethod?: string) {
  return startAppleAccountLogin(env, session, accountId, post({ appleId, password: 'secret', twoFactorMethod }), IP, noDefer)
}

function submit({ session, accountId }: Fixture, challengeId: string, code = '123456') {
  return submitAppleAccountLogin2FA(env, session, accountId, post({ challengeId, code }), IP, noDefer)
}

function sms({ session, accountId }: Fixture, challengeId: string, phoneId?: number) {
  return sendAppleAccountLoginSms(env, session, accountId, post({ challengeId, phoneId }), noDefer)
}

interface AppleScript {
  /** signin/complete asks for a verification code. */
  twoFactor?: boolean
  phones?: Array<{ id: number; obfuscatedNumber: string }>
  noTrustedDevices?: boolean
  /** No trusted device takes the push. */
  pushFails?: boolean
  /** Whether Apple accepts the next code submitted. */
  codeAccepted?: () => boolean
}

interface AppleCall { method: string; path: string; body: Record<string, unknown>; sent: string; answered: string }

/**
 * Apple's side of a sign-in. Like Apple it rotates scnt on every answer,
 * refusals included, so a test can see which scnt each request presented.
 */
function apple(script: AppleScript = {}) {
  const calls: AppleCall[] = []
  let rotation = 0
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = pathOf(input)
    const method = init?.method || 'GET'
    const answered = `scnt-${rotation += 1}`
    const headers = { scnt: answered }
    calls.push({
      method, path, answered,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
      sent: new Headers(init?.headers).get('scnt') || '',
    })
    if (path.endsWith('/signin/init')) {
      return Response.json({ salt: 'c2FsdC1zYWx0LXNhbHQ=', b: 'Ag==', c: 'challenge-c', iteration: 1000, protocol: 's2k' }, { headers })
    }
    if (path.endsWith('/signin/complete')) return new Response(null, { status: script.twoFactor ? 409 : 200, headers })
    if (path === '/appleauth/auth' && method === 'GET') {
      return Response.json({ trustedPhoneNumbers: script.phones ?? [], noTrustedDevices: script.noTrustedDevices ?? false }, { headers })
    }
    if (path.endsWith('/verify/trusteddevice/securitycode') && method === 'PUT') {
      return new Response(null, { status: script.pushFails ? 412 : 202, headers })
    }
    if (path.endsWith('/securitycode') && method === 'POST') {
      return script.codeAccepted?.() === false
        ? Response.json({ service_errors: [{ code: '-21669', message: 'Incorrect verification code.' }] }, { status: 400, headers })
        : new Response(null, { status: 204, headers })
    }
    if (path === '/account/manage/gs/ws/token') return Response.json({ timeOutInterval: 15 }, { headers })
    if (path === '/account/manage') return Response.json({ apiKey: 'api-signed-in' }, { headers })
    return new Response('{}', { headers })
  })
  const to = (method: string, suffix: string) => calls.filter((call) => call.method === method && call.path.endsWith(suffix))
  return { calls, fetch, to }
}

async function challengeOf(response: Response): Promise<string> {
  const body = await response.json<{ challengeId?: string }>()
  expect(body.challengeId).toEqual(expect.any(String))
  return body.challengeId || ''
}

function challengeRows(accountId: string): Promise<number> {
  return env.DB.prepare('SELECT COUNT(*) AS count FROM icloud_auth_challenges WHERE account_id = ?')
    .bind(accountId).first<{ count: number }>().then((row) => row?.count ?? 0)
}

describe('Apple Account sign-in verification code', () => {
  it('spends at most five guesses on one challenge, however many arrive at once', async () => {
    // Checking the count and adding to it in separate statements let parallel
    // submissions each pass the check and forward their code to Apple.
    const fixture = await signInFixture()
    const { to } = apple({ twoFactor: true, codeAccepted: () => false })
    const challengeId = await challengeOf(await start(fixture))

    const responses = await Promise.all(Array.from({ length: 7 }, () => submit(fixture, challengeId, '000000')))
    const bodies = await Promise.all(responses.map((response) => response.json<{ error: string; code?: string }>()))

    expect(to('POST', '/securitycode')).toHaveLength(5)
    expect(bodies.filter((body) => body.error === '验证码不正确，请重新输入。')).toHaveLength(4)
    expect(bodies.filter((body) => body.code === GONE)).toHaveLength(3)
    // Spent, so it is gone rather than waiting for its expiry.
    await expect(challengeRows(fixture.accountId)).resolves.toBe(0)
    await expect((await submit(fixture, challengeId)).json()).resolves.toMatchObject({ code: GONE })
  })

  it('says a wrong code is wrong, and retries with what Apple rotated on the refusal', async () => {
    const fixture = await signInFixture()
    let accept = false
    const { to } = apple({ twoFactor: true, codeAccepted: () => accept })
    const challengeId = await challengeOf(await start(fixture))

    const wrong = await submit(fixture, challengeId, '000000')
    expect(wrong.status).toBe(422)
    await expect(wrong.json()).resolves.toEqual({ error: '验证码不正确，请重新输入。' })
    accept = true
    expect((await submit(fixture, challengeId)).status).toBe(200)

    const [refused, accepted] = to('POST', '/securitycode')
    expect(accepted.sent).toBe(refused.answered)
  })

  it('tells the client to start over once the challenge has expired', async () => {
    const fixture = await signInFixture()
    apple({ twoFactor: true })
    const challengeId = await challengeOf(await start(fixture))
    await env.DB.prepare('UPDATE icloud_auth_challenges SET expires_at = 1 WHERE id = ?').bind(challengeId).run()

    const response = await submit(fixture, challengeId)

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toEqual({ error: '登录挑战已过期，请重新开始。', code: GONE })
    await expect(challengeRows(fixture.accountId)).resolves.toBe(0)
  })

  it('drops a waiting sign-in with the session it would have replaced', async () => {
    // Otherwise completing it after the user removed the Apple Account brings a
    // session back.
    const fixture = await signInFixture()
    apple({ twoFactor: true })
    const challengeId = await challengeOf(await start(fixture))

    await fixture.store.clearAppleAccountState(fixture.accountId)

    await expect((await submit(fixture, challengeId)).json()).resolves.toMatchObject({ code: GONE })
  })

  it('sweeps expired challenges on the scheduled cleanup', async () => {
    const fixture = await signInFixture()
    apple({ twoFactor: true })
    const expired = await challengeOf(await start(fixture))
    await env.DB.prepare('UPDATE icloud_auth_challenges SET expires_at = 1 WHERE id = ?').bind(expired).run()

    // The run goes on to jobs this environment lacks bindings for; the sweep comes first.
    await cleanup(env).catch(() => undefined)

    await expect(challengeRows(fixture.accountId)).resolves.toBe(0)
  })
})

describe('Apple Account sign-in by SMS', () => {
  const PHONES = [{ id: 7, obfuscatedNumber: '+86 ••• •••• ••12' }, { id: 9, obfuscatedNumber: '+1 (•••) •••-••34' }]

  it('texts the code to an Apple ID without trusted devices, and checks it as an SMS code', async () => {
    const fixture = await signInFixture()
    const { to } = apple({ twoFactor: true, noTrustedDevices: true, phones: PHONES })

    const response = await start(fixture)

    await expect(response.clone().json()).resolves.toMatchObject({
      needs2FA: true, method: 'phone', phoneId: 7,
      phones: [{ id: 7, number: '+86 ••• •••• ••12' }, { id: 9, number: '+1 (•••) •••-••34' }],
    })
    expect(to('PUT', '/verify/trusteddevice/securitycode')).toHaveLength(0)
    expect(to('PUT', '/verify/phone').map((call) => call.body)).toEqual([{ phoneNumber: { id: 7 }, mode: 'sms' }])

    expect((await submit(fixture, await challengeOf(response), '654321')).status).toBe(200)
    expect(to('POST', '/verify/phone/securitycode').map((call) => call.body)).toEqual([
      { phoneNumber: { id: 7 }, securityCode: { code: '654321' }, mode: 'sms' },
    ])
  })

  it('falls back to SMS when no trusted device takes the push', async () => {
    const fixture = await signInFixture()
    apple({ twoFactor: true, pushFails: true, phones: PHONES })

    await expect((await start(fixture)).json()).resolves.toMatchObject({ method: 'phone', phoneId: 7 })
  })

  it('does not report a code as sent when the push failed and there is no phone to text', async () => {
    const fixture = await signInFixture()
    apple({ twoFactor: true, pushFails: true })

    const response = await start(fixture)

    expect(response.status).toBe(502)
    await expect(challengeRows(fixture.accountId)).resolves.toBe(0)
  })

  it('switches a waiting sign-in to SMS on the phone the user picked', async () => {
    const fixture = await signInFixture()
    const { to } = apple({ twoFactor: true, phones: PHONES })
    const challengeId = await challengeOf(await start(fixture))

    expect((await sms(fixture, challengeId, 4)).status).toBe(400)
    const switched = await sms(fixture, challengeId, 9)

    await expect(switched.json()).resolves.toMatchObject({ challengeId, method: 'phone', phoneId: 9 })
    expect(to('PUT', '/verify/phone').map((call) => call.body)).toEqual([{ phoneNumber: { id: 9 }, mode: 'sms' }])
    expect((await submit(fixture, challengeId)).status).toBe(200)
    expect(to('POST', '/verify/phone/securitycode')[0].body).toMatchObject({ phoneNumber: { id: 9 } })
  })

  it('sends no SMS on the last attempt, which would leave none to enter the code with', async () => {
    const fixture = await signInFixture()
    const { to } = apple({ twoFactor: true, phones: PHONES, codeAccepted: () => false })
    const challengeId = await challengeOf(await start(fixture))
    for (let attempt = 0; attempt < 4; attempt += 1) await submit(fixture, challengeId, '000000')

    const response = await sms(fixture, challengeId)

    await expect(response.json()).resolves.toMatchObject({ code: GONE })
    expect(to('PUT', '/verify/phone')).toHaveLength(0)
  })
})

describe('Apple Account sign-in outcome', () => {
  it('records who signed in from where, keeps the Apple ID, and activates an Apple-only account', async () => {
    const fixture = await signInFixture({ appPassword: '', status: 'pending' })
    apple()

    const response = await start(fixture, 'Owner@iCloud.com')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      needs2FA: false, account: { status: 'active', appleAccountStatus: 'active' },
    })
    await expect(fixture.store.get(fixture.accountId)).resolves.toMatchObject({
      status: 'active', appleAccountState: { appleId: 'owner@icloud.com', apiKey: 'api-signed-in' },
    })
    const audit = await env.DB.prepare(
      "SELECT ip, detail_json FROM audit_logs WHERE target_id = ? AND action = 'icloud.credentials.apple_account'",
    ).bind(fixture.accountId).first<{ ip: string; detail_json: string }>()
    expect(audit?.ip).toBe(IP)
    expect(JSON.parse(audit?.detail_json || '{}')).toMatchObject({ signIn: 'password', appleAccountHost: 'appleid.apple.com' })
  })

  it('refuses an Apple ID the account cannot take before anything reaches Apple', async () => {
    const jar = await signInFixture({ cookies: { token: 'jar' }, realEmail: 'jar@icloud.com' })
    const { fetch } = apple()

    const response = await start(jar, 'other@icloud.com')

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ detail: 'jar@icloud.com' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses an Apple ID another account of the user already signed in as', async () => {
    const fixture = await signInFixture({ appPassword: '' })
    await fixture.store.insert(iCloudAccount(fixture.userId, `${fixture.accountId}-twin`, {
      name: 'Twin', appleAccountState: { ...liveAppleState(), appleId: 'owner@icloud.com' }, appleAccountStatus: 'active',
    }))
    apple()

    const response = await start(fixture, 'OWNER@icloud.com')

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ detail: 'Twin' })
  })

  it('answers a body that is not a JSON object with 400, not a server error', async () => {
    const fixture = await signInFixture()
    const nullBody = () => new Request('https://mail.example.com', { method: 'POST', body: 'null' })

    for (const response of await Promise.all([
      startAppleAccountLogin(env, fixture.session, fixture.accountId, nullBody(), IP, noDefer),
      submitAppleAccountLogin2FA(env, fixture.session, fixture.accountId, nullBody(), IP, noDefer),
      sendAppleAccountLoginSms(env, fixture.session, fixture.accountId, nullBody(), noDefer),
    ])) {
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: '请求体必须是 JSON 对象。' })
    }
  })

  it('finishes a sign-in under waitUntil and audits the caller IP through the worker', async () => {
    const fixture = await signInFixture()
    const token = createSessionToken()
    await storeSession(env.DB, fixture.userId, token)
    apple()
    const context = createExecutionContext()
    const waitUntil = vi.spyOn(context, 'waitUntil')

    const response = await worker.fetch(new Request(
      `https://mail.example.com/api/icloud/accounts/${fixture.accountId}/apple-account/login/start`, {
        method: 'POST',
        headers: {
          Cookie: `omnimail_session=${token}`, 'Content-Type': 'application/json',
          Origin: 'https://mail.example.com', 'CF-Connecting-IP': '203.0.113.9',
        },
        body: JSON.stringify({ appleId: 'owner@icloud.com', password: 'secret' }),
      },
    ), env, context)
    await waitOnExecutionContext(context)

    expect(response.status).toBe(200)
    expect(waitUntil).toHaveBeenCalled()
    const audit = await env.DB.prepare(
      "SELECT ip FROM audit_logs WHERE target_id = ? AND action = 'icloud.credentials.apple_account'",
    ).bind(fixture.accountId).first<{ ip: string }>()
    expect(audit?.ip).toBe('203.0.113.9')
  })
})

describe('Apple Account sign-in rate limits', () => {
  it('stops SRP attempts against one Apple ID before they reach Apple', async () => {
    // Every SRP round counts toward that Apple ID's lockout and can push a 2FA
    // prompt to whoever owns it. Warm-up failures never get that far, so they
    // must not spend the allowance either.
    const fixture = await signInFixture({ appPassword: '' })
    const warmUpDown = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 500 }))
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect((await start(fixture, 'person@icloud.com')).status).toBe(502)
    }
    warmUpDown.mockRestore()
    let srpRounds = 0
    const appleUp = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (pathOf(input).endsWith('/signin/init')) { srpRounds += 1; return new Response('', { status: 500 }) }
      return new Response('{}')
    })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await start(fixture, 'Person@icloud.com')).status).toBe(502)
    }
    const calls = appleUp.mock.calls.length
    const throttled = await start(fixture, 'person@icloud.com')

    expect(throttled.status).toBe(429)
    expect(Number(throttled.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(srpRounds).toBe(5)
    // Refused up front: not even the warm-up requests go out.
    expect(appleUp.mock.calls.length).toBe(calls)
    // The bucket is the Apple ID's, not the account's.
    expect((await start(fixture, 'other@icloud.com')).status).toBe(502)
  })

  it('keeps one user from locking another out of an Apple ID', async () => {
    // A bucket shared across users let anyone spend another user's attempts;
    // attempts the Apple ID bucket refuses must not drain the user's own.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(consumeAppleAccountLoginRateLimit(env.DB, 'user-x', 'victim@icloud.com'))
        .resolves.toMatchObject({ allowed: true })
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(consumeAppleAccountLoginRateLimit(env.DB, 'user-x', 'victim@icloud.com'))
        .resolves.toMatchObject({ allowed: false })
    }

    await expect(consumeAppleAccountLoginRateLimit(env.DB, 'user-v', 'victim@icloud.com'))
      .resolves.toMatchObject({ allowed: true })
    await expect(consumeAppleAccountLoginRateLimit(env.DB, 'user-x', 'other@icloud.com'))
      .resolves.toMatchObject({ allowed: true })
  })
})
