import {
  decryptICloudCredential,
  encryptICloudCredential,
  iCloudCredentialsReady,
} from './icloud-credentials'
import type {
  AppleAccountRead,
  AppleAccountState,
  ICloudAccount,
  ICloudAccountRow,
  PublicICloudAccount,
} from './icloud-types'
import type { Env } from '../../app/types'

import { ICloudStoreError } from './icloud-store-error'

export { parseICloudCookies } from './icloud-cookies'
export { ICloudStoreError } from './icloud-store-error'

type PublicICloudAccountRow = Omit<
  ICloudAccountRow,
  'user_id' | 'cookies_cipher' | 'app_password_cipher' | 'apple_account_state_cipher' | 'updated_at'
> & {
  has_cookies: number
  has_app_password: number
  has_apple_account: number
}

export function publicICloudAccount(account: ICloudAccount): PublicICloudAccount {
  const {
    cookies,
    appPassword,
    appleAccountState: _appleAccountState,
    appleAccountRead: _appleAccountRead,
    cookiesRead: _cookiesRead,
    userId: _userId,
    ...safe
  } = account
  return {
    ...safe,
    hasCookies: Object.keys(cookies).length > 0,
    hasAppPassword: Boolean(appPassword),
    hasAppleAccount: Boolean(account.appleAccountState),
    appleAccountStatus: account.appleAccountStatus || 'none',
    appleAccountExpiresAt: account.appleAccountExpiresAt || '',
  }
}

/** The pair of counters a listing is measured against. */
export interface ICloudAliasCounts {
  total: number
  active: number
}

export function iCloudAliasCounts(
  account: Pick<ICloudAccount, 'aliasTotal' | 'aliasActive'>,
): ICloudAliasCounts {
  return { total: account.aliasTotal, active: account.aliasActive }
}

/**
 * An empty jar is stored as '' rather than as the ciphertext of '{}', so the
 * SQL-side `cookies_cipher <> ''` availability checks agree with the
 * `Object.keys(cookies).length` check the create path applies.
 */
function cookieJarText(cookies: Record<string, string>): string {
  return Object.keys(cookies).length ? JSON.stringify(cookies) : ''
}

/**
 * Which alias channels an account can actually use. The create handler and the
 * quota endpoint must agree on this or the client plans a batch onto a channel
 * the server then refuses, so both read it from here.
 *
 * `expired` is not recoverable: it is written only when Apple rejects the
 * stored scnt outright (after a refresh failed too), and refresh() replays
 * those same credentials. A jar Apple rejected leaves the account in `error`;
 * creating through it would only fail again, and the next listing that Apple
 * accepts puts the account back to `active`.
 */
export function iCloudAliasChannels(
  account: Pick<ICloudAccount, 'cookies' | 'status' | 'appleAccountState' | 'appleAccountStatus'>,
): { appleAccount: boolean; icloudWeb: boolean } {
  return {
    appleAccount: Boolean(account.appleAccountState) && account.appleAccountStatus !== 'expired',
    icloudWeb: Object.keys(account.cookies).length > 0 && account.status !== 'error',
  }
}

function appleStateFrom(text: string): AppleAccountState | null {
  if (!text) return null
  try {
    return JSON.parse(text) as AppleAccountState
  } catch {
    throw new ICloudStoreError(500, 'Apple Account 登录态已损坏。')
  }
}

function publicICloudAccountRow(row: PublicICloudAccountRow): PublicICloudAccount {
  return {
    id: row.id,
    name: row.name,
    realEmail: row.real_email,
    icloudEmail: row.icloud_email,
    host: row.host,
    status: row.status,
    aliasTotal: Number(row.alias_total),
    aliasActive: Number(row.alias_active),
    lastValidated: row.last_validated,
    lastError: row.last_error,
    createdAt: row.created_at,
    hasCookies: Boolean(row.has_cookies),
    hasAppPassword: Boolean(row.has_app_password),
    hasAppleAccount: Boolean(row.has_apple_account),
    appleAccountStatus: row.apple_account_status,
    appleAccountExpiresAt: row.apple_account_expires_at,
  }
}

export class ICloudAccountStore {
  constructor(
    private readonly env: Env,
    private readonly userId: string,
  ) {
    if (!iCloudCredentialsReady(env)) {
      throw new ICloudStoreError(
        503,
        'iCloud 功能尚未配置 MAIL_CREDENTIALS_KEY 或 ICLOUD_CREDENTIALS_KEY。',
      )
    }
  }

  private context(accountId: string, field: 'cookies' | 'app-password' | 'apple-account'): string {
    return `${this.userId}:${accountId}:${field}`
  }

  private async fromRow(row: ICloudAccountRow): Promise<ICloudAccount> {
    if (row.user_id !== this.userId) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    const [cookiesText, appPassword, appleStateText] = await Promise.all([
      decryptICloudCredential(
        this.env,
        row.cookies_cipher,
        this.context(row.id, 'cookies'),
      ),
      decryptICloudCredential(
        this.env,
        row.app_password_cipher,
        this.context(row.id, 'app-password'),
      ),
      decryptICloudCredential(
        this.env,
        row.apple_account_state_cipher,
        this.context(row.id, 'apple-account'),
      ),
    ])
    let cookies: Record<string, string> = {}
    try {
      const parsed: unknown = cookiesText ? JSON.parse(cookiesText) : {}
      // JSON.parse('null') succeeds, and every reader below calls Object.keys on
      // the result. Without this the failure is a raw TypeError outside the
      // catch, which reaches the client as an unexplained 502.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      cookies = parsed as Record<string, string>
    } catch {
      throw new ICloudStoreError(500, 'iCloud 账号凭据已损坏。')
    }
    // Rows written before empty jars were stored as '' hold the ciphertext of
    // '{}', which is non-empty, so the SQL-side checks in list() keep offering
    // a cookie channel the account does not have. Normalize on read; the
    // compare-and-swap makes it a no-op once done and cannot clobber a jar
    // another request saved in the meantime.
    if (row.cookies_cipher && !Object.keys(cookies).length) {
      await this.env.DB.prepare(
        `UPDATE icloud_accounts SET cookies_cipher = ''
         WHERE id = ? AND user_id = ? AND cookies_cipher = ?`,
      ).bind(row.id, this.userId, row.cookies_cipher).run().catch(() => undefined)
    }
    const appleAccountState = appleStateFrom(appleStateText)
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      realEmail: row.real_email,
      icloudEmail: row.icloud_email,
      cookies,
      host: row.host,
      appPassword,
      status: row.status,
      aliasTotal: Number(row.alias_total),
      aliasActive: Number(row.alias_active),
      lastValidated: row.last_validated,
      lastError: row.last_error,
      appleAccountState,
      appleAccountStatus: row.apple_account_status,
      appleAccountExpiresAt: row.apple_account_expires_at,
      appleAccountError: row.apple_account_error,
      appleAccountRead: { cipher: row.apple_account_state_cipher, plaintext: appleStateText || '' },
      cookiesRead: { cipher: row.cookies_cipher, plaintext: cookiesText || '' },
      createdAt: row.created_at,
    }
  }

  /**
   * Only the Apple session columns, for a request that already holds the rest
   * of the row: adopting the session inside the gate needs nothing else, and a
   * full read would decrypt the jar and the app password for nothing.
   */
  async appleSession(id: string): Promise<Pick<ICloudAccount,
    'appleAccountState' | 'appleAccountStatus' | 'appleAccountExpiresAt' | 'appleAccountError'
    | 'appleAccountRead' | 'aliasTotal' | 'aliasActive'>> {
    const row = await this.env.DB.prepare(
      `SELECT apple_account_state_cipher, apple_account_status, apple_account_expires_at,
              apple_account_error, alias_total, alias_active
       FROM icloud_accounts WHERE id = ? AND user_id = ?`,
    ).bind(id, this.userId).first<Pick<ICloudAccountRow,
      'apple_account_state_cipher' | 'apple_account_status' | 'apple_account_expires_at'
      | 'apple_account_error' | 'alias_total' | 'alias_active'>>()
    if (!row) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    const plaintext = await decryptICloudCredential(
      this.env, row.apple_account_state_cipher, this.context(id, 'apple-account'),
    )
    return {
      appleAccountState: appleStateFrom(plaintext),
      appleAccountStatus: row.apple_account_status,
      appleAccountExpiresAt: row.apple_account_expires_at,
      appleAccountError: row.apple_account_error,
      appleAccountRead: { cipher: row.apple_account_state_cipher, plaintext: plaintext || '' },
      aliasTotal: Number(row.alias_total),
      aliasActive: Number(row.alias_active),
    }
  }

  /** The stored session's ciphertext, to tell whether anything replaced it since a read. */
  async appleSessionCipher(id: string): Promise<string> {
    const row = await this.env.DB.prepare(
      'SELECT apple_account_state_cipher FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(id, this.userId).first<Pick<ICloudAccountRow, 'apple_account_state_cipher'>>()
    return row?.apple_account_state_cipher ?? ''
  }

  /**
   * Another account of this user that already creates aliases as `appleId`:
   * through a cookie jar validated for it, or an Apple session signed in as it.
   * The hourly quota is kept per account, so a second account on the same
   * Apple ID would double the budget Apple enforces once. Returns its name.
   */
  async appleIdOwner(appleId: string, exceptId: string): Promise<string> {
    const wanted = appleId.trim().toLowerCase()
    if (!wanted) return ''
    const { results } = await this.env.DB.prepare(
      `SELECT id, name, real_email, cookies_cipher, apple_account_state_cipher
       FROM icloud_accounts WHERE user_id = ? AND id <> ?`,
    ).bind(this.userId, exceptId).all<Pick<ICloudAccountRow,
      'id' | 'name' | 'real_email' | 'cookies_cipher' | 'apple_account_state_cipher'>>()
    for (const row of results) {
      if (row.cookies_cipher && row.real_email.trim().toLowerCase() === wanted) return row.name
      if (!row.apple_account_state_cipher) continue
      const plaintext = await decryptICloudCredential(
        this.env, row.apple_account_state_cipher, this.context(row.id, 'apple-account'),
      ).catch(() => '')
      const state = plaintext ? appleStateFrom(plaintext) : null
      if (state?.appleId?.trim().toLowerCase() === wanted) return row.name
    }
    return ''
  }

  async list(): Promise<PublicICloudAccount[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT id, name, real_email, icloud_email, host, status,
              alias_total, alias_active, last_validated, last_error, created_at,
              CASE WHEN cookies_cipher <> '' THEN 1 ELSE 0 END AS has_cookies,
              CASE WHEN app_password_cipher <> '' THEN 1 ELSE 0 END AS has_app_password,
              CASE WHEN apple_account_state_cipher <> '' THEN 1 ELSE 0 END AS has_apple_account,
              apple_account_status, apple_account_expires_at
       FROM icloud_accounts WHERE user_id = ?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                created_at`,
    ).bind(this.userId).all<PublicICloudAccountRow>()
    return results.map(publicICloudAccountRow)
  }

  async get(id: string): Promise<ICloudAccount> {
    const row = await this.env.DB.prepare(
      'SELECT * FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(id, this.userId).first<ICloudAccountRow>()
    if (!row) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    return this.fromRow(row)
  }

  async getName(id: string): Promise<string> {
    const row = await this.env.DB.prepare(
      'SELECT name FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(id, this.userId).first<{ name: string }>()
    if (!row) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    return row.name
  }

  async insert(account: ICloudAccount): Promise<void> {
    const now = new Date().toISOString()
    const [cookiesCipher, passwordCipher, appleStateCipher] = await Promise.all([
      encryptICloudCredential(
        this.env,
        cookieJarText(account.cookies),
        this.context(account.id, 'cookies'),
      ),
      encryptICloudCredential(
        this.env,
        account.appPassword,
        this.context(account.id, 'app-password'),
      ),
      encryptICloudCredential(
        this.env,
        account.appleAccountState ? JSON.stringify(account.appleAccountState) : '',
        this.context(account.id, 'apple-account'),
      ),
    ])
    await this.env.DB.prepare(
      `INSERT INTO icloud_accounts (
        id, user_id, name, real_email, icloud_email, cookies_cipher, host,
        app_password_cipher, status, alias_total, alias_active,
        last_validated, last_error, apple_account_state_cipher,
        apple_account_expires_at, apple_account_status, apple_account_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      account.id,
      this.userId,
      account.name,
      account.realEmail,
      account.icloudEmail,
      cookiesCipher,
      account.host,
      passwordCipher,
      account.status,
      account.aliasTotal,
      account.aliasActive,
      account.lastValidated,
      account.lastError,
      appleStateCipher,
      account.appleAccountExpiresAt || '',
      account.appleAccountStatus || 'none',
      account.appleAccountError || '',
      account.createdAt,
      now,
    ).run()
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.env.DB.prepare(
      'DELETE FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(id, this.userId).run()
    return Boolean(result.meta.changes)
  }

  async saveName(id: string, name: string): Promise<void> {
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET name = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(name, new Date().toISOString(), id, this.userId).run()
    if (!result.meta.changes) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
  }

  /**
   * What a request did with the jar it read: the cookies Apple rotated and the
   * jar's health. Session state only. The counters are deliberately absent:
   * every caller holds an account read before its network round-trip, so
   * writing their snapshot here would revert an addAliasSummary a concurrent
   * create landed in the meantime — including the create this very call is
   * reporting on. The addresses are absent for the same reason: an app-password
   * update that lands meanwhile owns icloud_email. Callers that just read
   * Apple's authoritative list persist it via saveAliasSummary.
   *
   * Written only while the stored jar is still the one read, like
   * advanceAppleAccountState: a jar the user pasted meanwhile must not be
   * replaced by this older one, nor marked broken because the older one failed.
   * An unchanged jar keeps its ciphertext, so overlapping requests that rotated
   * nothing do not invalidate each other's version. Returns whether it wrote.
   */
  async saveCookies(account: ICloudAccount): Promise<boolean> {
    const read = account.cookiesRead
    const plaintext = cookieJarText(account.cookies)
    const cipher = read && read.plaintext === plaintext
      ? read.cipher
      : await encryptICloudCredential(this.env, plaintext, this.context(account.id, 'cookies'))
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET cookies_cipher = ?, status = ?, last_validated = ?, last_error = ?,
        updated_at = ? WHERE id = ? AND user_id = ?${read ? ' AND cookies_cipher = ?' : ''}`,
    ).bind(
      cipher,
      account.status,
      account.lastValidated,
      account.lastError,
      new Date().toISOString(),
      account.id,
      this.userId,
      ...(read ? [read.cipher] : []),
    ).run()
    if (!result.meta.changes) return false
    account.cookiesRead = { cipher, plaintext }
    return true
  }

  /**
   * A jar the user just supplied, with what validating it found. Replaces
   * whatever is stored. The iCloud address is only filled in when none is set:
   * the app password owns it once configured.
   */
  async replaceCookies(account: ICloudAccount): Promise<void> {
    const plaintext = cookieJarText(account.cookies)
    const cipher = await encryptICloudCredential(this.env, plaintext, this.context(account.id, 'cookies'))
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET cookies_cipher = ?, real_email = ?,
        icloud_email = CASE WHEN icloud_email = '' THEN ? ELSE icloud_email END,
        status = ?, last_validated = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(
      cipher, account.realEmail, account.icloudEmail, account.status, account.lastValidated,
      account.lastError, new Date().toISOString(), account.id, this.userId,
    ).run()
    if (!result.meta.changes) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    account.cookiesRead = { cipher, plaintext }
  }

  /**
   * An account added through the Apple Account sign-in alone starts out
   * `pending`, and nothing else validates it: once Apple accepts its session it
   * is as active as an account whose jar validated.
   */
  async promoteAppleOnly(id: string): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE icloud_accounts SET status = 'active', last_validated = ?, last_error = '', updated_at = ?
       WHERE id = ? AND user_id = ? AND status = 'pending'
         AND cookies_cipher = '' AND app_password_cipher = '' AND apple_account_state_cipher <> ''`,
    ).bind(new Date().toISOString(), new Date().toISOString(), id, this.userId).run()
  }

  async saveAppPassword(id: string, icloudEmail: string, password: string): Promise<void> {
    const cipher = await encryptICloudCredential(
      this.env,
      password,
      this.context(id, 'app-password'),
    )
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET icloud_email = ?, app_password_cipher = ?,
       status = 'active', last_error = '', last_error_code = '', last_error_at = NULL,
       next_sync_at = 0, sync_lease_id = NULL, sync_lease_until = NULL,
       updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(icloudEmail, cipher, new Date().toISOString(), id, this.userId).run()
    if (!result.meta.changes) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
  }

  /**
   * Replace the Apple session outright. Only for a session the user just
   * supplied (import, sign-in); a request that merely rotated the stored one
   * goes through advanceAppleAccountState instead.
   */
  async saveAppleAccountState(account: ICloudAccount): Promise<void> {
    if (!await this.writeAppleAccountState(account, null, true)) {
      throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    }
  }

  /**
   * Persist what a request did with the session it read, but only while the
   * stored one is still that session. Otherwise something newer landed
   * meanwhile — another request's rotation, a removal, a fresh sign-in — and
   * writing this older copy back would undo it, or mark a live session
   * expired. Returns whether the write happened.
   *
   * `rotated` says whether Apple handed the request new session values. When it
   * did not (typically a call Apple rejected outright), only the status is
   * written and the ciphertext stays as read: re-encrypting the same session
   * would draw a fresh IV and look like a newer version, so a stale request
   * that failed fast would lock out the concurrent one holding the session
   * Apple actually rotated.
   */
  async advanceAppleAccountState(account: ICloudAccount, rotated: boolean): Promise<boolean> {
    const read = account.appleAccountRead ?? { cipher: '', plaintext: '' }
    if (await this.writeAppleAccountState(account, read, rotated)) return true
    // A key migration re-encrypts the same session under a fresh IV. That
    // looks like a newer version but is not one, so retry against it once.
    const row = await this.env.DB.prepare(
      'SELECT apple_account_state_cipher FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(account.id, this.userId).first<Pick<ICloudAccountRow, 'apple_account_state_cipher'>>()
    if (!row || row.apple_account_state_cipher === read.cipher) return false
    const plaintext = await decryptICloudCredential(
      this.env, row.apple_account_state_cipher, this.context(account.id, 'apple-account'),
    ).catch(() => null)
    if (plaintext !== read.plaintext) return false
    return this.writeAppleAccountState(account, { cipher: row.apple_account_state_cipher, plaintext }, rotated)
  }

  private async writeAppleAccountState(
    account: ICloudAccount,
    expected: AppleAccountRead | null,
    rotated: boolean,
  ): Promise<boolean> {
    let next = expected
    if (rotated || !next) {
      const plaintext = account.appleAccountState ? JSON.stringify(account.appleAccountState) : ''
      next = {
        cipher: await encryptICloudCredential(this.env, plaintext, this.context(account.id, 'apple-account')),
        plaintext,
      }
    }
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET apple_account_state_cipher = ?,
        apple_account_expires_at = ?, apple_account_status = ?, apple_account_error = ?,
        updated_at = ? WHERE id = ? AND user_id = ?${expected ? ' AND apple_account_state_cipher = ?' : ''}`,
    ).bind(
      next.cipher,
      account.appleAccountExpiresAt || '',
      account.appleAccountStatus || 'none',
      account.appleAccountError || '',
      new Date().toISOString(),
      account.id,
      this.userId,
      ...(expected ? [expected.cipher] : []),
    ).run()
    if (!result.meta.changes) return false
    // Later writes in the same request are measured against this one.
    account.appleAccountRead = next
    return true
  }

  /**
   * The counters as they stand now. A caller whose own read happened several
   * round trips before its listing measures the listing against this instead:
   * a change that landed in between is already part of what Apple reports.
   */
  async aliasCounts(id: string): Promise<ICloudAliasCounts> {
    const row = await this.env.DB.prepare(
      'SELECT alias_total, alias_active FROM icloud_accounts WHERE id = ? AND user_id = ?',
    ).bind(id, this.userId).first<{ alias_total: number; alias_active: number }>()
    if (!row) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
    return { total: Number(row.alias_total), active: Number(row.alias_active) }
  }

  /**
   * Absolute counters, for callers that just read Apple's authoritative list.
   * Session writers must not use this: they load the account, wait on Apple,
   * then save, so their snapshot would regress a concurrent create.
   *
   * `known` is what the row said just before the listing was taken. A listing
   * is only authoritative for the state it observed, so if either counter has
   * moved since — a create's increment, another request's deactivate — that
   * change is the newer fact and the write is skipped; the next listing
   * reconciles. Both columns are compared because deactivate and reactivate
   * move alias_active without touching the total. The comparison is by value,
   * so a change undone before this write (deactivate, then reactivate) goes
   * unseen: the counters are a best-effort summary, not a ledger. Required
   * rather than optional so a new caller has to decide what its listing is
   * relative to.
   */
  async saveAliasSummary(
    account: Pick<ICloudAccount, 'id' | 'aliasTotal' | 'aliasActive'>,
    known: ICloudAliasCounts,
  ): Promise<void> {
    // Nothing to reconcile: had the row moved, the guard would skip the write,
    // and if it has not, the write would store the numbers it already holds.
    if (account.aliasTotal === known.total && account.aliasActive === known.active) return
    await this.env.DB.prepare(
      `UPDATE icloud_accounts SET alias_total = ?, alias_active = ?, updated_at = ?
       WHERE id = ? AND user_id = ? AND alias_total = ? AND alias_active = ?`,
    ).bind(
      Math.max(0, account.aliasTotal), Math.max(0, account.aliasActive), new Date().toISOString(),
      account.id, this.userId, known.total, known.active,
    ).run()
  }

  /**
   * Apply one create's delta in SQL. The caller's snapshot is read before the
   * per-account gate, so writing `snapshot + 1` as an absolute value would drop
   * a concurrent create's increment.
   */
  async addAliasSummary(id: string, activeDelta: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE icloud_accounts SET alias_total = alias_total + 1,
        alias_active = MAX(0, alias_active + ?), updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(activeDelta, new Date().toISOString(), id, this.userId).run()
  }

  /** Also drops a sign-in still waiting for its 2FA code, which would otherwise bring a session back. */
  async clearAppleAccountState(id: string): Promise<void> {
    const [result] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE icloud_accounts SET apple_account_state_cipher = '',
          apple_account_expires_at = '', apple_account_status = 'none', apple_account_error = '',
          updated_at = ? WHERE id = ? AND user_id = ?`,
      ).bind(new Date().toISOString(), id, this.userId),
      this.env.DB.prepare(
        'DELETE FROM icloud_auth_challenges WHERE account_id = ? AND user_id = ?',
      ).bind(id, this.userId),
    ])
    if (!result.meta.changes) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
  }
}
