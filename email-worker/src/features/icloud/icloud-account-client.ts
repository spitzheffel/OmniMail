import type { AppleAccountState } from './icloud-types'
import {
  APPLE_ACCOUNT_ERROR_CODES,
  ICLOUD_CREDENTIAL_ERROR_STATUS,
  ICloudRemoteError,
  iCloudHmeLimitReason,
} from './icloud-apple'

export const APPLE_ACCOUNT_REQUEST_TIMEOUT_MS = 20_000
// When the token response does not say how long the session lives, assume a
// short life rather than none: an empty expiry makes the very next call refresh
// again, and on the create path that second refresh runs after the hourly slot
// was claimed.
const APPLE_ACCOUNT_DEFAULT_SESSION_MS = 5 * 60_000
// Refresh a little before the advertised expiry, so a call does not start on a
// session that lapses while it is in flight.
const APPLE_ACCOUNT_EXPIRY_MARGIN_MS = 30_000
// The calls that create an address, where a bare 429 is the hourly cap.
const METERED_PATHS = new Set(['/account/manage/email/private/add', '/account/manage/email/private/add/complete'])
export const APPLE_ACCOUNT_ORIGIN = 'https://account.apple.com'
const APPLE_ACCOUNT_HOST = 'appleid.apple.com'
export const APPLE_ACCOUNT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
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

export function appleAccountCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([name, value]) => name && value)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/**
 * Apple's own wording, for `detail`: tags stripped, since a failure can come
 * back as a whole HTML page, and short enough to read beside the message.
 */
function appleAccountResponseText(status: number, value: string): string {
  const compact = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  const text = compact.length > 200 ? `${compact.slice(0, 200)}…` : compact
  return text ? `HTTP ${status}: ${text}` : `HTTP ${status}`
}

/**
 * `optional` marks an endpoint some regions do not serve (the alias list): only
 * there does a missing endpoint mean `unavailable`. `metered` marks the calls
 * that create an address: only there is a bare 429 the hourly cap; anywhere
 * else it is Apple throttling that call. The cap's own wording wins everywhere.
 */
function appleAccountErrorCode(
  status: number,
  text: string,
  { optional = false, metered = false }: { optional?: boolean; metered?: boolean } = {},
): string {
  const lower = text.toLowerCase()
  if (status === 419 || status === 401 || status === 403
    || /authentication[_ ]failed|invalid[_ ]session|session[_ ]expired|scnt[_ ]expired/.test(lower)) {
    return APPLE_ACCOUNT_ERROR_CODES.auth
  }
  if (iCloudHmeLimitReason(text)) return APPLE_ACCOUNT_ERROR_CODES.limit
  if (status === 429 || /\btoo many requests\b|\brate[ -]?limit/.test(lower)) {
    return metered ? APPLE_ACCOUNT_ERROR_CODES.limit : APPLE_ACCOUNT_ERROR_CODES.throttled
  }
  if (optional && (status === 404 || status === 405 || status === 410 || status === 501)) {
    return APPLE_ACCOUNT_ERROR_CODES.unavailable
  }
  return APPLE_ACCOUNT_ERROR_CODES.api
}

function appleAccountErrorStatus(code: string): number {
  if (code === APPLE_ACCOUNT_ERROR_CODES.auth) return ICLOUD_CREDENTIAL_ERROR_STATUS
  if (code === APPLE_ACCOUNT_ERROR_CODES.limit) return 429
  if (code === APPLE_ACCOUNT_ERROR_CODES.throttled) return 503
  return 502
}

function appleAccountErrorMessage(code: string): string {
  if (code === APPLE_ACCOUNT_ERROR_CODES.auth) return 'Apple Account 管理态已失效，请重新登录。'
  if (code === APPLE_ACCOUNT_ERROR_CODES.limit) return 'Apple Account 已达到当前隐私邮箱创建上限，请稍后再试。'
  if (code === APPLE_ACCOUNT_ERROR_CODES.throttled) return 'Apple Account 请求过于频繁，请稍后再试。'
  return 'Apple Account 请求失败。'
}

function appleAccountStateUsable(state: AppleAccountState): boolean {
  if (!state.scnt || !state.apiKey) return false
  if (!state.expiresAt) return false
  const expiresAt = Date.parse(state.expiresAt)
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + APPLE_ACCOUNT_EXPIRY_MARGIN_MS
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

/**
 * An empty array is no evidence here: `[].every()` is vacuously true, so an
 * `errors: []` ahead of the real list would otherwise read as "zero aliases".
 */
function objectRows(value: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject)
    ? value as Record<string, unknown>[]
    : undefined
}

/**
 * Apple's own key, at any depth. The key names the list, so finding it settles
 * the question: whatever it holds is the answer, even if that answer is "no
 * rows I can read". Demanding readable rows here would hand a ragged or empty
 * hmeEmails back to the positional search, which then picks whichever array
 * comes first in key order — typically forwardToEmails, the user's own address.
 *
 * Every hmeEmails in the payload is collected, so neither key order nor depth
 * picks the answer: an empty one elsewhere (a summary, a previous page) must not
 * hide the populated list, wherever either sits. If every one is empty, the
 * account has none. Populated lists that disagree are reported as unrecognised
 * rather than guessed between, and the caller then persists nothing.
 */
function namedRows(value: unknown): { rows: Record<string, unknown>[]; found: boolean } | undefined {
  const lists: Record<string, unknown>[][] = []
  // Arrays are walked as well as objects, since Apple wraps its payload
  // differently per region; only isPlainObject decides what counts as a row.
  // A queue rather than recursion, and push in a loop rather than
  // push(...values): spreading a large alias list can exceed the argument limit.
  const pending: unknown[] = [value]
  for (let index = 0; index < pending.length; index += 1) {
    const node = pending[index]
    if (!node || typeof node !== 'object') continue
    for (const [key, child] of Object.entries(node)) {
      if (key === 'hmeEmails' && Array.isArray(child)) lists.push(child.filter(isPlainObject))
      else pending.push(child)
    }
  }
  if (!lists.length) return undefined
  const [first, ...others] = lists.filter((rows) => rows.length)
  if (!first) return { rows: [], found: true }
  const expected = JSON.stringify(first)
  return others.every((rows) => JSON.stringify(rows) === expected)
    ? { rows: first, found: true }
    : { rows: [], found: false }
}

/** Positional fallback for envelopes that do not name the list at all. */
function firstObjectArray(value: unknown): { rows: Record<string, unknown>[]; found: boolean } {
  const direct = objectRows(value)
  if (direct) return { rows: direct, found: true }
  // Same reason as above: a mixed array can still hold the object that carries
  // the list, and refusing to descend into it reports the whole payload as
  // unrecognised — a 502 for a shape we could have read.
  if (!value || typeof value !== 'object') return { rows: [], found: false }
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
 * hmeEmails beats the positional search wherever it sits, empty or not: the
 * positional search cannot tell an empty alias list from a populated sibling
 * such as forwardToEmails, and picking the sibling would publish the user's
 * real forwarding address as a Hide My Email alias.
 */
function aliasArray(value: unknown): { rows: Record<string, unknown>[]; found: boolean } {
  return namedRows(value) ?? firstObjectArray(value)
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
  /** Whether this client has tried a refresh, so a caller retrying an auth failure does not try twice. */
  refreshAttempted = false

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
      // Carried through every rotation: the session is bound to it (assertAppleIdBindable).
      ...(state.appleId?.trim() ? { appleId: state.appleId.trim().toLowerCase() } : {}),
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    { apiKey: includeApiKey = false, optional = false }: { apiKey?: boolean; optional?: boolean } = {},
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
    let text: string
    try {
      response = await fetch(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(APPLE_ACCOUNT_REQUEST_TIMEOUT_MS),
      })
      // The body streams under the same timeout; a stall or reset there is a
      // transport failure too, not an unexplained exception for the caller.
      text = await response.text()
    } catch (error) {
      if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new ICloudRemoteError(504, '连接 Apple Account 超时。', false, APPLE_ACCOUNT_ERROR_CODES.api)
      }
      throw new ICloudRemoteError(502, '连接 Apple Account 失败。', false, APPLE_ACCOUNT_ERROR_CODES.api)
    }
    if (!response.ok) {
      const code = appleAccountErrorCode(response.status, text, { optional, metered: METERED_PATHS.has(path) })
      throw new ICloudRemoteError(
        appleAccountErrorStatus(code),
        appleAccountErrorMessage(code),
        true,
        code,
        code === APPLE_ACCOUNT_ERROR_CODES.api ? appleAccountResponseText(response.status, text) : '',
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
    this.refreshAttempted = true
    if (!this.state.scnt) {
      throw new ICloudRemoteError(
        ICLOUD_CREDENTIAL_ERROR_STATUS,
        'Apple Account 管理态缺少 scnt，请重新登录。',
        true,
        APPLE_ACCOUNT_ERROR_CODES.missing,
      )
    }
    const token = await this.request<{ timeOutInterval?: number | string }>(
      'GET', '/account/manage/gs/ws/token',
    )
    const timeoutMinutes = Number(token.timeOutInterval)
    const lifetimeMs = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
      ? timeoutMinutes * 60_000
      : APPLE_ACCOUNT_DEFAULT_SESSION_MS
    this.state.expiresAt = new Date(Date.now() + lifetimeMs).toISOString()
    const manage = await this.request<{ apiKey?: string }>(
      'GET', '/account/manage',
    )
    if (manage.apiKey?.trim()) this.state.apiKey = manage.apiKey.trim()
    if (!this.state.apiKey) {
      throw new ICloudRemoteError(
        ICLOUD_CREDENTIAL_ERROR_STATUS,
        'Apple Account 管理接口未返回 apiKey，请重新登录。',
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
      'POST', '/account/manage/email/private/add', {}, { apiKey: true },
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
    }, { apiKey: true })
    let confirmed = completed
    if (completed.id?.trim()) {
      try {
        confirmed = await this.request<typeof completed>(
          'GET', `/account/manage/email/private/${encodeURIComponent(completed.id.trim())}.em`, undefined, { apiKey: true },
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
    const data = await this.request<unknown>('GET', '/account/manage/email/private', undefined, { apiKey: true, optional: true })
    const { rows, found } = aliasArray(data)
    if (!found) {
      // Reported as an unavailable listing so callers take their "no list
      // here" path instead of persisting a bogus count of zero.
      throw new ICloudRemoteError(
        502,
        'Apple Account 未返回可识别的隐私邮箱列表。',
        true,
        APPLE_ACCOUNT_ERROR_CODES.unavailable,
      )
    }
    return rows.map(aliasFromValue).filter((alias): alias is AppleAccountAlias => Boolean(alias))
  }

  isUsable(): boolean {
    return appleAccountStateUsable(this.state)
  }
}
