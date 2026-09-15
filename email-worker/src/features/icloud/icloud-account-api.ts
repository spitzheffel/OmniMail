import { writeAudit } from '../../shared/audit/audit'
import {
  APPLE_ACCOUNT_ERROR_CODES,
  ICloudClient,
  ICLOUD_CREDENTIAL_ERROR_STATUS,
  ICloudRemoteError,
} from './icloud-apple'
import { AppleAccountClient } from './icloud-account-client'
import {
  ICloudAccountStore,
  ICloudStoreError,
  parseICloudCookies,
  publicICloudAccount,
} from './icloud-store'
import type { AppleAccountState, ICloudAccount } from './icloud-types'
import type { Env, SessionUser } from '../../app/types'

const APPLE_ACCOUNT_CREATE_COOLDOWN_MS = 2 * 60 * 1000
const appleAccountCreateGates = new Map<string, Promise<void>>()
const appleAccountCreateCooldowns = new Map<string, number>()

export async function withAppleAccountCreateGate<T>(accountId: string, operation: () => Promise<T>): Promise<T> {
  const previous = appleAccountCreateGates.get(accountId) || Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  const queued = previous.catch(() => undefined).then(() => current)
  appleAccountCreateGates.set(accountId, queued)
  await previous.catch(() => undefined)
  try {
    const until = appleAccountCreateCooldowns.get(accountId) || 0
    if (until > Date.now()) {
      const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000))
      throw new ICloudRemoteError(429, `Apple Account 创建上限冷却中，请约 ${seconds} 秒后再试。`, true, APPLE_ACCOUNT_ERROR_CODES.limit)
    }
    return await operation()
  } finally {
    release()
    if (appleAccountCreateGates.get(accountId) === queued) appleAccountCreateGates.delete(accountId)
  }
}

export function markAppleAccountCreateLimited(accountId: string): void {
  appleAccountCreateCooldowns.set(accountId, Date.now() + APPLE_ACCOUNT_CREATE_COOLDOWN_MS)
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function boundedSecret(value: unknown, field: string, maximum = 4096): string {
  const result = stringField(value)
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new ICloudStoreError(400, `${field} 无效。`)
  }
  return result
}

export function appleAccountStateBody(body: Record<string, unknown>): AppleAccountState {
  const source = body.state && typeof body.state === 'object' && !Array.isArray(body.state)
    ? body.state as Record<string, unknown> : body
  const cookies = parseICloudCookies(source.cookies)
  const scnt = boundedSecret(source.scnt, 'Apple Account scnt')
  const apiKey = boundedSecret(source.apiKey, 'Apple Account apiKey')
  const sessionId = stringField(source.sessionId)
  if (sessionId.length > 4096 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new ICloudStoreError(400, 'Apple Account sessionId 无效。')
  }
  const host = stringField(source.host) || 'appleid.apple.com'
  const origin = stringField(source.origin) || 'https://account.apple.com'
  const cleanHost = host.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const cleanOrigin = origin.replace(/\/$/, '')
  if (!/^(?:appleid|account)\.apple\.com(?:\.cn)?$/i.test(cleanHost)
    || !/^https:\/\/(?:account|appleid)\.apple\.com(?:\.cn)?$/i.test(cleanOrigin)) {
    throw new ICloudStoreError(400, 'Apple Account 服务地址无效。')
  }
  return {
    cookies, scnt, apiKey, sessionId,
    expiresAt: stringField(source.expiresAt),
    lastCheckedAt: stringField(source.lastCheckedAt),
    userAgent: stringField(source.userAgent), host: cleanHost, origin: cleanOrigin,
  }
}

function jsonBody(request: Request): Promise<Record<string, unknown>> {
  return request.json<unknown>().then((body) => {
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new ICloudStoreError(400, '请求体必须是 JSON 对象。')
    return body as Record<string, unknown>
  }).catch((error) => {
    if (error instanceof ICloudStoreError) throw error
    throw new ICloudStoreError(400, '请求体必须是 JSON 对象。')
  })
}

function auditDetail(account: Pick<ICloudAccount, 'name'>, detail: Record<string, unknown> = {}) {
  return { accountName: account.name, ...detail }
}

function responseError(error: unknown): Response {
  if (error instanceof ICloudStoreError || error instanceof ICloudRemoteError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  console.error('Apple Account request failed', error)
  return Response.json({ error: 'Apple Account 暂时无法处理这个请求。' }, { status: 502 })
}

export async function updateICloudAppleAccount(env: Env, user: SessionUser, id: string, request: Request, ip: string): Promise<Response> {
  try {
    const body = await jsonBody(request)
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(id)
    const client = new AppleAccountClient(appleAccountStateBody(body))
    await client.refresh()
    account.appleAccountState = client.state; account.appleAccountStatus = 'active'
    account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
    await store.saveAppleAccountState(account)
    await writeAudit(env, user.id, 'icloud.credentials.apple_account', id, ip, auditDetail(account, { appleAccountHost: client.state.host }))
    return Response.json({ account: publicICloudAccount(account) })
  } catch (error) { return responseError(error) }
}

export async function refreshICloudAppleAccount(env: Env, user: SessionUser, id: string): Promise<Response> {
  try {
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(id)
    if (!account.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
    const client = new AppleAccountClient(account.appleAccountState)
    await client.refresh()
    account.appleAccountState = client.state; account.appleAccountStatus = 'active'
    account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
    await store.saveAppleAccountState(account)
    return Response.json({ account: publicICloudAccount(account) })
  } catch (error) { return responseError(error) }
}

export async function deleteICloudAppleAccount(env: Env, user: SessionUser, id: string, ip: string): Promise<Response> {
  try {
    const store = new ICloudAccountStore(env, user.id)
    const account = { name: await store.getName(id) }
    await store.clearAppleAccountState(id)
    await writeAudit(env, user.id, 'icloud.credentials.apple_account.delete', id, ip, auditDetail(account))
    return Response.json({ ok: true })
  } catch (error) { return responseError(error) }
}

function appleAccountFailure(error: unknown): boolean {
  return error instanceof ICloudRemoteError && (
    error.code === APPLE_ACCOUNT_ERROR_CODES.auth
      || error.code === APPLE_ACCOUNT_ERROR_CODES.limit
      || error.code === APPLE_ACCOUNT_ERROR_CODES.missing
  )
}

async function refreshAliasSummaryForCreate(
  store: ICloudAccountStore,
  account: ICloudAccount,
  client: ICloudClient,
): Promise<void> {
  account.cookies = client.cookies
  account.status = 'active'
  account.lastError = ''
  try {
    const aliases = await client.listAliases()
    account.aliasTotal = aliases.length
    account.aliasActive = aliases.filter((alias) => alias.active).length
    account.lastValidated = new Date().toISOString()
  } catch (error) {
    account.lastError = '隐藏邮箱操作已完成，但账号状态同步失败。'
    if (error instanceof ICloudRemoteError && error.status === ICLOUD_CREDENTIAL_ERROR_STATUS) account.status = 'error'
  }
  await store.saveCookies(account)
}

export async function createICloudAlias(
  env: Env,
  user: SessionUser,
  request: Request,
  ip: string,
): Promise<Response> {
  try {
    const body = await request.json<Record<string, unknown>>()
    const accountId = stringField(body.accountId)
    const label = stringField(body.label)
    const email = stringField(body.email).toLowerCase()
    const previewId = stringField(body.previewId).toLowerCase()
    const requestedChannel = body.channel === 'apple_account' || body.channel === 'icloud_web' ? body.channel : ''
    if (!accountId || label.length > 80 || Boolean(email) !== Boolean(previewId)
      || (email && !/^[^@\s]{1,64}@icloud\.com$/.test(email))
      || (previewId && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(previewId))) {
      throw new ICloudStoreError(400, '隐藏邮箱参数无效。')
    }
    const store = new ICloudAccountStore(env, user.id)
    const account = await store.get(accountId)
    const useAppleAccount = requestedChannel === 'apple_account'
      || (!requestedChannel && !email && Boolean(account.appleAccountState))
    if (useAppleAccount) {
      if (email || previewId) throw new ICloudStoreError(400, 'Apple Account 新接口创建不接受旧接口预览地址。')
      if (!account.appleAccountState) throw new ICloudStoreError(400, '该账号尚未配置 Apple Account 管理态。')
      const client = new AppleAccountClient(account.appleAccountState)
      try {
        const created = await withAppleAccountCreateGate(accountId, () => client.createAlias(label))
        account.appleAccountState = client.state; account.appleAccountStatus = 'active'
        account.appleAccountExpiresAt = client.state.expiresAt; account.appleAccountError = ''
        account.aliasTotal += 1; account.aliasActive += created.active ? 1 : 0
        await store.saveAppleAccountState(account)
        await writeAudit(env, user.id, 'icloud.alias.create', accountId, ip, auditDetail(account, {
          alias: created.email, label: created.label, channel: 'apple_account',
        }))
        return Response.json({ alias: { email: created.email, label: created.label, createdAt: created.createdAt } }, { status: 201 })
      } catch (error) {
        if (error instanceof ICloudRemoteError && error.code === APPLE_ACCOUNT_ERROR_CODES.limit) markAppleAccountCreateLimited(accountId)
        if (error instanceof ICloudRemoteError) {
          // Persist only values received from successful requests. This keeps
          // a refreshed scnt/Cookie usable even when the subsequent create
          // step is rate-limited or fails validation.
          account.appleAccountState = client.state
          account.appleAccountExpiresAt = client.state.expiresAt
          if (error.code === APPLE_ACCOUNT_ERROR_CODES.auth) account.appleAccountStatus = 'expired'
          account.appleAccountError = error.message.slice(0, 300)
          await store.saveAppleAccountState(account).catch(() => undefined)
        }
        if (requestedChannel === 'apple_account' || !Object.keys(account.cookies).length || !appleAccountFailure(error)) throw error
      }
    }
    if (!Object.keys(account.cookies).length) throw new ICloudStoreError(400, '该账号尚未配置可创建隐藏邮箱的登录态。')
    const client = new ICloudClient(account.cookies, account.host, previewId || undefined)
    const alias = email ? await client.reserveAlias(email, label) : await client.createAlias(label)
    await refreshAliasSummaryForCreate(store, account, client)
    await writeAudit(env, user.id, 'icloud.alias.create', accountId, ip, auditDetail(account, {
      alias: alias.email, label: alias.label, channel: 'icloud_web',
    }))
    return Response.json({ alias }, { status: 201 })
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: '请求体必须是 JSON 对象。' }, { status: 400 })
    return responseError(error)
  }
}
