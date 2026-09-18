import {
  decryptICloudCredential,
  encryptICloudCredential,
  iCloudCredentialsReady,
} from './icloud-credentials'
import type {
  ICloudAccount,
  ICloudAccountRow,
  PublicICloudAccount,
} from './icloud-types'
import type { Env } from '../../app/types'

const MAX_COOKIE_COUNT = 64
const MAX_COOKIE_NAME_LENGTH = 128
const MAX_COOKIE_VALUE_BYTES = 8 * 1024
const MAX_COOKIE_HEADER_BYTES = 32 * 1024
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/

type PublicICloudAccountRow = Omit<
  ICloudAccountRow,
  'user_id' | 'cookies_cipher' | 'app_password_cipher' | 'apple_account_state_cipher' | 'updated_at'
> & {
  has_cookies: number
  has_app_password: number
  has_apple_account: number
}

export class ICloudStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function validatedCookies(entries: Array<[string, string]>): Record<string, string> {
  if (!entries.length) throw new ICloudStoreError(400, 'Cookie 中没有可用值。')
  if (entries.length > MAX_COOKIE_COUNT) {
    throw new ICloudStoreError(400, `Cookie 数量不能超过 ${MAX_COOKIE_COUNT} 个。`)
  }
  const encoder = new TextEncoder()
  let totalBytes = 0
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    const trimmedValue = rawValue.trim()
    const value = trimmedValue.startsWith('"') && trimmedValue.endsWith('"')
      ? trimmedValue.slice(1, -1)
      : trimmedValue
    const valueBytes = encoder.encode(value).byteLength
    if (
      !name
      || name.length > MAX_COOKIE_NAME_LENGTH
      || !COOKIE_NAME.test(name)
      || !value
      || valueBytes > MAX_COOKIE_VALUE_BYTES
      || !COOKIE_VALUE.test(value)
    ) throw new ICloudStoreError(400, 'Cookie 包含无效名称或值。')
    // Includes `=`, quotes, and the `; ` separator used by the outbound header.
    totalBytes += encoder.encode(name).byteLength + valueBytes + 5
    result[name] = value
  }
  if (totalBytes > MAX_COOKIE_HEADER_BYTES) {
    throw new ICloudStoreError(400, 'Cookie 总大小不能超过 32 KiB。')
  }
  return result
}

export function parseICloudCookies(raw: unknown): Record<string, string> {
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const entries = Object.entries(raw)
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
      throw new ICloudStoreError(400, 'Cookie 包含无效名称或值。')
    }
    return validatedCookies(entries)
  }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) throw new ICloudStoreError(400, '请填写 iCloud Cookie。')
  if (new TextEncoder().encode(value).byteLength > MAX_COOKIE_HEADER_BYTES) {
    throw new ICloudStoreError(400, 'Cookie 总大小不能超过 32 KiB。')
  }
  if (value.startsWith('{')) {
    try {
      return parseICloudCookies(JSON.parse(value) as unknown)
    } catch (error) {
      if (error instanceof ICloudStoreError) throw error
      throw new ICloudStoreError(400, 'Cookie JSON 格式无效。')
    }
  }
  const entries = value.split(';').flatMap((item): Array<[string, string]> => {
    const separator = item.indexOf('=')
    if (separator < 1) return []
    const name = item.slice(0, separator).trim()
    const cookieValue = item.slice(separator + 1).trim()
    return name && cookieValue ? [[name, cookieValue]] : []
  })
  if (!entries.length) throw new ICloudStoreError(400, '无法解析 iCloud Cookie。')
  return validatedCookies(entries)
}

export function publicICloudAccount(account: ICloudAccount): PublicICloudAccount {
  const {
    cookies,
    appPassword,
    appleAccountState: _appleAccountState,
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
 * stored scnt outright, and refresh() replays those same credentials.
 */
export function iCloudAliasChannels(
  account: Pick<ICloudAccount, 'cookies' | 'appleAccountState' | 'appleAccountStatus'>,
): { appleAccount: boolean; icloudWeb: boolean } {
  return {
    appleAccount: Boolean(account.appleAccountState) && account.appleAccountStatus !== 'expired',
    icloudWeb: Object.keys(account.cookies).length > 0,
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
    let appleAccountState = null
    if (appleStateText) {
      try {
        appleAccountState = JSON.parse(appleStateText)
      } catch {
        throw new ICloudStoreError(500, 'Apple Account 登录态已损坏。')
      }
    }
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
      createdAt: row.created_at,
    }
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
   * Session state only. The counters are deliberately absent: every caller
   * holds an account read before its network round-trip, so writing their
   * snapshot here would revert an addAliasSummary a concurrent create landed in
   * the meantime — including the create this very call is reporting on. Callers
   * that just read Apple's authoritative list persist it via saveAliasSummary.
   */
  async saveCookies(account: ICloudAccount): Promise<void> {
    const cipher = await encryptICloudCredential(
      this.env,
      cookieJarText(account.cookies),
      this.context(account.id, 'cookies'),
    )
    await this.env.DB.prepare(
      `UPDATE icloud_accounts SET
        cookies_cipher = ?, real_email = ?, icloud_email = ?, status = ?,
        last_validated = ?, last_error = ?,
        updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(
      cipher,
      account.realEmail,
      account.icloudEmail,
      account.status,
      account.lastValidated,
      account.lastError,
      new Date().toISOString(),
      account.id,
      this.userId,
    ).run()
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

  async saveAppleAccountState(account: ICloudAccount): Promise<void> {
    const cipher = await encryptICloudCredential(
      this.env,
      account.appleAccountState ? JSON.stringify(account.appleAccountState) : '',
      this.context(account.id, 'apple-account'),
    )
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET apple_account_state_cipher = ?,
        apple_account_expires_at = ?, apple_account_status = ?, apple_account_error = ?,
        updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(
      cipher,
      account.appleAccountExpiresAt || '',
      account.appleAccountStatus || 'none',
      account.appleAccountError || '',
      new Date().toISOString(),
      account.id,
      this.userId,
    ).run()
    if (!result.meta.changes) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
  }

  /**
   * Absolute counters, for callers that just read Apple's authoritative list.
   * Session writers must not use this: they load the account, wait on Apple,
   * then save, so their snapshot would regress a concurrent create.
   */
  async saveAliasSummary(id: string, total: number, active: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE icloud_accounts SET alias_total = ?, alias_active = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).bind(Math.max(0, total), Math.max(0, active), new Date().toISOString(), id, this.userId).run()
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

  async clearAppleAccountState(id: string): Promise<void> {
    const result = await this.env.DB.prepare(
      `UPDATE icloud_accounts SET apple_account_state_cipher = '',
        apple_account_expires_at = '', apple_account_status = 'none', apple_account_error = '',
        updated_at = ? WHERE id = ? AND user_id = ?`,
    ).bind(new Date().toISOString(), id, this.userId).run()
    if (!result.meta.changes) throw new ICloudStoreError(404, 'iCloud 账号不存在。')
  }
}
