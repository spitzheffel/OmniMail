import { env } from 'cloudflare:workers'
import type { AppleAccountState, ICloudAccount } from '../src/features/icloud/icloud-types'

/*
 * Builders and Apple stubs shared by the iCloud integration suites, so a
 * change to what refresh() calls or what an account row holds lands in one
 * place: a stale copy would quietly fall through to some other branch and test
 * a different path while its assertions still pass. Each suite runs on a fresh
 * database and seeds its own user.
 */

export async function seedUser(id: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (
      id, email, display_name, password_hash, role, mailbox_limit,
      storage_quota_bytes, can_create_mailboxes, can_reply
    ) VALUES (?, ?, ?, 'test', 'user', 1, 1024, 1, 0)`,
  ).bind(id, `${id}@example.com`, id).run()
}

/** An account row: an app password and nothing else unless overridden. */
export function iCloudAccount(userId: string, id: string, overrides: Partial<ICloudAccount> = {}): ICloudAccount {
  return {
    id, userId, name: 'Personal', realEmail: '', icloudEmail: 'owner@icloud.com',
    cookies: {}, host: 'icloud.com', appPassword: 'app-secret', status: 'active',
    aliasTotal: 0, aliasActive: 0, lastValidated: '', lastError: '',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as ICloudAccount
}

/** A session inside its timeout, so no call refreshes it first. */
export function liveAppleState(scnt = 'scnt-live'): AppleAccountState {
  return {
    cookies: { session: 'cookie-value' }, scnt, sessionId: 'session-live', apiKey: 'api-live',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), lastCheckedAt: '', userAgent: '',
    host: 'appleid.apple.com', origin: 'https://account.apple.com',
  }
}

/** A session past its timeout but still refreshable: the next call refreshes it first. */
export function staleAppleState(): AppleAccountState {
  return {
    cookies: { session: 'cookie-value' }, scnt: 'scnt-old', sessionId: 'session-old',
    apiKey: 'api-old', expiresAt: '', lastCheckedAt: '', userAgent: '',
    host: 'appleid.apple.com', origin: 'https://account.apple.com',
  }
}

export function pathOf(input: RequestInfo | URL): string {
  return new URL(input instanceof Request ? input.url : String(input)).pathname
}

export const APPLE_TOKEN_PATH = '/account/manage/gs/ws/token'
export const APPLE_MANAGE_PATH = '/account/manage'

/** refresh()'s token call: rotates scnt to scnt-fresh. */
export function appleTokenResponse(): Response {
  return new Response('{"timeOutInterval":15}', { headers: { scnt: 'scnt-fresh' } })
}

/** refresh()'s management call: hands out api-fresh and rotates scnt to scnt-manage. */
export function appleManageResponse(): Response {
  return new Response('{"apiKey":"api-fresh"}', { headers: { scnt: 'scnt-manage' } })
}

/** Answer the two calls refresh() makes, and anything else with `otherwise`. */
export function appleRefreshThen(otherwise: (input: RequestInfo | URL) => Response | Promise<Response>) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const path = pathOf(input)
    if (path === APPLE_TOKEN_PATH) return appleTokenResponse()
    if (path === APPLE_MANAGE_PATH) return appleManageResponse()
    return otherwise(input)
  }
}

/** A defer that drops the task: for direct handler calls with no client to outlive. */
export function noDefer(): void {}
