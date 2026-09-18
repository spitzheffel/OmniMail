import type { AppleAccountState } from './icloud-types'
import {
  APPLE_ACCOUNT_ERROR_CODES,
  ICLOUD_CREDENTIAL_ERROR_STATUS,
  ICloudRemoteError,
} from './icloud-apple'

const APPLE_ACCOUNT_REQUEST_TIMEOUT_MS = 20_000
const APPLE_ACCOUNT_ORIGIN = 'https://account.apple.com'
const APPLE_ACCOUNT_HOST = 'appleid.apple.com'
const APPLE_ACCOUNT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

function mergeSetCookies(cookies: Record<string, string>, headers: Headers): void {
  const extended = headers as Headers & { getSetCookie?: () => string[] }
  const values = extended.getSetCookie?.() || []
  const fallback = headers.get('set-cookie')
  for (const header of values.length ? values : fallback ? fallback.split(/,(?=\s*[^;,=]+=[^;,]*)/) : []) {
    const pair = header.split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator < 1) continue
    const name = pair.slice(0, separator).trim()
    let value = pair.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (name && value) cookies[name] = value
  }
}

function ensureAppleAccountUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ICloudRemoteError(502, 'Apple Account 返回了无效的服务地址。', true, APPLE_ACCOUNT_ERROR_CODES.api)
  }
  const hostname = url.hostname.toLowerCase()
  const allowed = hostname === 'appleid.apple.com'
    || hostname.endsWith('.appleid.apple.com')
    || hostname === 'appleid.apple.com.cn'
    || hostname.endsWith('.appleid.apple.com.cn')
    || hostname === 'account.apple.com'
    || hostname.endsWith('.account.apple.com')
    || hostname === 'account.apple.com.cn'
    || hostname.endsWith('.account.apple.com.cn')
  if (url.protocol !== 'https:' || !allowed) {
    throw new ICloudRemoteError(502, 'Apple Account 服务地址不在允许域名内。', true, APPLE_ACCOUNT_ERROR_CODES.api)
  }
  url.port = ''
  return url
}

function appleAccountOrigin(state: AppleAccountState): string {
  const raw = state.origin?.trim()
  if (raw) {
    try {
      const origin = ensureAppleAccountUrl(raw).origin
      if (origin.endsWith('.cn')) return origin
      return origin
    } catch {
      // Fall through to the canonical global endpoint.
    }
  }
  return state.host?.toLowerCase().includes('.cn')
    ? 'https://account.apple.com.cn'
    : APPLE_ACCOUNT_ORIGIN
}

function appleAccountBase(state: AppleAccountState): string {
  // The management resources live on account.apple.com while the login
  // session's host header is appleid.apple.com. Never derive this base from
  // an arbitrary imported host, or a valid session would call the wrong API.
  return state.origin?.toLowerCase().includes('.cn')
    ? 'https://account.apple.com.cn'
    : APPLE_ACCOUNT_ORIGIN
}

function appleAccountCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([name, value]) => name && value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

function appleAccountResponseText(value: string): string {
  const compact = value.replace(/[\r\n\t]+/g, ' ').trim()
  if (!compact) return '空响应'
  return compact.length > 500 ? `${compact.slice(0, 500)}…` : compact
}

function appleAccountErrorCode(status: number, text: string): string {
  const lower = text.toLowerCase()
  if (status === 419 || status === 401 || status === 403
    || /authentication[_ ]failed|invalid[_ ]session|session[_ ]expired|scnt[_ ]expired/.test(lower)) {
    return APPLE_ACCOUNT_ERROR_CODES.auth
  }
  if (status === 429 || /limit|too many|rate.?limit|quota/.test(lower)) {
    return APPLE_ACCOUNT_ERROR_CODES.limit
  }
  return APPLE_ACCOUNT_ERROR_CODES.api
}

function appleAccountErrorStatus(code: string): number {
  if (code === APPLE_ACCOUNT_ERROR_CODES.auth) return ICLOUD_CREDENTIAL_ERROR_STATUS
  if (code === APPLE_ACCOUNT_ERROR_CODES.limit) return 429
  return 502
}

function appleAccountErrorMessage(code: string, status: number, text: string): string {
  if (code === APPLE_ACCOUNT_ERROR_CODES.auth) return 'Apple Account 管理态已失效，请重新导入登录态。'
  if (code === APPLE_ACCOUNT_ERROR_CODES.limit) return 'Apple Account 已达到当前隐私邮箱创建上限，请稍后再试。'
  return `Apple Account 请求失败（HTTP ${status}）：${appleAccountResponseText(text)}`
}

function appleAccountStateUsable(state: AppleAccountState): boolean {
  if (!state.scnt || !state.apiKey) return false
  if (!state.expiresAt) return false
  const expiresAt = Date.parse(state.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

export interface AppleAccountAlias {
  email: string
  label: string
  note: string
  anonymousId: string
  active: boolean
  createdAt: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function objectRows(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value) && value.every(isPlainObject)
    ? value as Record<string, unknown>[]
    : undefined
}

/**
 * Apple's own key, at any depth. Deliberately more tolerant than objectRows:
 * the key names the list, so a stray null or a plain string entry must not
 * demote us to the positional search, which would then pick whichever array
 * comes first in key order — typically forwardToEmails.
 */
function namedRows(value: unknown): Record<string, unknown>[] | undefined {
  if (!isPlainObject(value)) return undefined
  const own = value.hmeEmails
  if (Array.isArray(own) && (!own.length || own.some(isPlainObject))) return own.filter(isPlainObject)
  for (const child of Object.values(value)) {
    const nested = namedRows(child)
    if (nested) return nested
  }
  return undefined
}

/** Positional fallback for envelopes that do not name the list at all. */
function firstObjectArray(value: unknown): { rows: Record<string, unknown>[]; found: boolean } {
  const direct = objectRows(value)
  if (direct) return { rows: direct, found: true }
  if (!isPlainObject(value)) return { rows: [], found: false }
  for (const child of Object.values(value)) {
    const nested = firstObjectArray(child)
    if (nested.found) return nested
  }
  return { rows: [], found: false }
}

/**
 * Locate the alias array in Apple's envelope. `found` distinguishes a genuinely
 * empty list from a payload shape we do not understand — callers must not treat
 * the latter as "this account has zero aliases".
 *
 * hmeEmails wins outright wherever it sits, empty or not: `[].every()` is
 * vacuously true, so the positional search cannot tell an empty alias list from
 * a populated sibling such as forwardToEmails, and picking the sibling would
 * publish the user's real forwarding address as a Hide My Email alias.
 */
function aliasArray(value: unknown): { rows: Record<string, unknown>[]; found: boolean } {
  const named = namedRows(value)
  if (named) return { rows: named, found: true }
  return firstObjectArray(value)
}

function aliasFromValue(value: Record<string, unknown>): AppleAccountAlias | null {
  const email = String(value.emailAddress || value.email || value.hme || value.address || '').trim().toLowerCase()
  if (!email.includes('@')) return null
  const status = String(value.status || value.state || '').toLowerCase()
  return {
    email,
    label: String(value.label || '').trim(),
    note: String(value.note || '').trim(),
    anonymousId: String(value.id || value.anonymousId || '').trim(),
    active: value.active !== false && value.isActive !== false && status !== 'inactive' && status !== 'deleted',
    createdAt: String(value.createdAt || '').trim(),
  }
}

/**
 * Client for the private Apple Account management endpoints used by Hide My
 * Email. This deliberately keeps its state separate from the legacy iCloud
 * Web client because Apple issues different cookies and short-lived scnt/apiKey
 * values for the two sessions.
 */
export class AppleAccountClient {
  readonly state: AppleAccountState

  constructor(state: AppleAccountState) {
    this.state = {
      cookies: { ...(state.cookies || {}) },
      scnt: state.scnt?.trim() || '',
      sessionId: state.sessionId?.trim() || '',
      apiKey: state.apiKey?.trim() || '',
      expiresAt: state.expiresAt?.trim() || '',
      lastCheckedAt: state.lastCheckedAt?.trim() || '',
      userAgent: state.userAgent?.trim() || APPLE_ACCOUNT_USER_AGENT,
      host: state.host?.trim() || APPLE_ACCOUNT_HOST,
      origin: state.origin?.trim() || APPLE_ACCOUNT_ORIGIN,
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    includeApiKey = false,
  ): Promise<T> {
    if (!path.startsWith('/')) throw new ICloudRemoteError(400, 'Apple Account 请求路径无效。', true, APPLE_ACCOUNT_ERROR_CODES.api)
    const url = ensureAppleAccountUrl(`${appleAccountBase(this.state)}${path}`)
    const headers = new Headers({
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Origin: appleAccountOrigin(this.state),
      Referer: `${appleAccountOrigin(this.state)}/`,
      'User-Agent': this.state.userAgent || APPLE_ACCOUNT_USER_AGENT,
      'X-Apple-I-Request-Context': 'ca',
      'X-Apple-I-TimeZone': 'Asia/Shanghai',
      'X-Apple-I-FD-Client-Info': JSON.stringify({
        U: this.state.userAgent || APPLE_ACCOUNT_USER_AGENT,
        L: 'zh', Z: 'GMT+08:00', V: '1.1',
      }),
    })
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    if (this.state.scnt) headers.set('scnt', this.state.scnt)
    if (this.state.sessionId) headers.set('X-Apple-ID-Session-Id', this.state.sessionId)
    if (includeApiKey && this.state.apiKey) headers.set('X-Apple-Api-Key', this.state.apiKey)
    const cookie = appleAccountCookieHeader(this.state.cookies)
    if (cookie) headers.set('Cookie', cookie)
    let response: Response
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(APPLE_ACCOUNT_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new ICloudRemoteError(504, '连接 Apple Account 超时。', false, APPLE_ACCOUNT_ERROR_CODES.api)
      }
      throw new ICloudRemoteError(502, '连接 Apple Account 失败。', false, APPLE_ACCOUNT_ERROR_CODES.api)
    }
    const text = await response.text()
    if (!response.ok) {
      const code = appleAccountErrorCode(response.status, text)
      throw new ICloudRemoteError(
        appleAccountErrorStatus(code),
        appleAccountErrorMessage(code, response.status, text),
        true,
        code,
      )
    }
    // Apple only advances these short-lived values on successful responses.
    // Keeping that rule avoids overwriting a usable state after a failed write.
    mergeSetCookies(this.state.cookies, response.headers)
    const nextScnt = response.headers.get('scnt')?.trim()
    const nextSessionId = response.headers.get('X-Apple-ID-Session-Id')?.trim()
    if (nextScnt) this.state.scnt = nextScnt
    if (nextSessionId) this.state.sessionId = nextSessionId
    if (!text.trim()) return {} as T
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ICloudRemoteError(502, 'Apple Account 返回了无法解析的 JSON。', true, APPLE_ACCOUNT_ERROR_CODES.api)
    }
  }

  async refresh(): Promise<AppleAccountState> {
    if (!this.state.scnt) {
      throw new ICloudRemoteError(
        ICLOUD_CREDENTIAL_ERROR_STATUS,
        'Apple Account 管理态缺少 scnt，请重新导入登录态。',
        true,
        APPLE_ACCOUNT_ERROR_CODES.missing,
      )
    }
    const token = await this.request<{ timeOutInterval?: number | string }>(
      'GET', '/account/manage/gs/ws/token', undefined, false,
    )
    const timeoutMinutes = Number(token.timeOutInterval)
    if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
      this.state.expiresAt = new Date(Date.now() + timeoutMinutes * 60_000).toISOString()
    }
    const manage = await this.request<{ apiKey?: string }>(
      'GET', '/account/manage', undefined, false,
    )
    if (manage.apiKey?.trim()) this.state.apiKey = manage.apiKey.trim()
    if (!this.state.apiKey) {
      throw new ICloudRemoteError(
        ICLOUD_CREDENTIAL_ERROR_STATUS,
        'Apple Account 管理接口未返回 apiKey，请重新导入登录态。',
        true,
        APPLE_ACCOUNT_ERROR_CODES.auth,
      )
    }
    this.state.lastCheckedAt = new Date().toISOString()
    return this.state
  }

  async createAlias(label: string, note = ''): Promise<AppleAccountAlias> {
    if (!appleAccountStateUsable(this.state)) await this.refresh()
    const generated = await this.request<{ emailAddress?: string }>(
      'POST', '/account/manage/email/private/add', {}, true,
    )
    const email = generated.emailAddress?.trim().toLowerCase() || ''
    if (!email) {
      throw new ICloudRemoteError(502, 'Apple Account 未返回候选隐私邮箱。', true, APPLE_ACCOUNT_ERROR_CODES.api)
    }
    const finalLabel = label.trim() || `OmniMail ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
    const completed = await this.request<{
      emailAddress?: string; label?: string; note?: string; id?: string; active?: boolean
    }>('PUT', '/account/manage/email/private/add/complete', {
      emailAddress: email,
      label: finalLabel,
      note: note.trim(),
    }, true)
    let confirmed = completed
    if (completed.id?.trim()) {
      try {
        confirmed = await this.request<typeof completed>(
          'GET', `/account/manage/email/private/${encodeURIComponent(completed.id.trim())}.em`, undefined, true,
        )
      } catch {
        // Creation already succeeded; detail lookup is best effort.
      }
    }
    const resultEmail = confirmed.emailAddress?.trim().toLowerCase() || email
    if (!resultEmail.includes('@')) {
      throw new ICloudRemoteError(502, 'Apple Account 创建后未返回隐私邮箱。', true, APPLE_ACCOUNT_ERROR_CODES.api)
    }
    this.state.lastCheckedAt = new Date().toISOString()
    return {
      email: resultEmail,
      label: confirmed.label?.trim() || finalLabel,
      note: confirmed.note?.trim() || note.trim(),
      anonymousId: confirmed.id?.trim() || completed.id?.trim() || '',
      active: confirmed.active !== false,
      createdAt: new Date().toISOString(),
    }
  }

  async listAliases(): Promise<AppleAccountAlias[]> {
    if (!appleAccountStateUsable(this.state)) await this.refresh()
    const data = await this.request<unknown>('GET', '/account/manage/email/private', undefined, true)
    const { rows, found } = aliasArray(data)
    if (!found) {
      // Reported as an API failure so callers fall back to their "listing
      // unavailable" path instead of persisting a bogus count of zero.
      throw new ICloudRemoteError(
        502,
        'Apple Account 未返回可识别的隐私邮箱列表。',
        true,
        APPLE_ACCOUNT_ERROR_CODES.api,
      )
    }
    return rows.map(aliasFromValue).filter((alias): alias is AppleAccountAlias => Boolean(alias))
  }

  isUsable(): boolean {
    return appleAccountStateUsable(this.state)
  }
}
