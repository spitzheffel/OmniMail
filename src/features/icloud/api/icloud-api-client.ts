import type {
  AppleAccountState, ICloudAccount, ICloudAlias, ICloudAliasChannel,
  ICloudAliasQuotaChannel, ICloudHost, ICloudMessage,
} from '../../../shared/api/api-types'

type Request = <T>(path: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>

/**
 * An Apple Account create can queue behind the account's session gate, refresh
 * the session and then add and complete the alias: up to five Apple calls of
 * 20 s each, plus D1 writes. Giving up sooner turns aliases Apple did create
 * into failures the user retries.
 */
const ALIAS_CREATE_TIMEOUT_MS = 120_000

/**
 * A sign-in step makes up to ten sequential Apple calls and gives up on its own
 * after 90 s. Waiting less would let the server push a code to a user whose
 * browser had already stopped listening for the challenge it belongs to.
 */
const APPLE_SIGN_IN_TIMEOUT_MS = 120_000

/** A sign-in waiting for its verification code. */
export interface ICloudAppleTwoFactor {
  needs2FA: true
  challengeId: string
  expiresAt: string
  /** Where the code went: a push to trusted devices, or an SMS to `phoneId`. */
  method: 'trusted_device' | 'phone'
  /** The trusted phones Apple can text, numbers masked; empty when it did not say. */
  phones: { id: number; number: string }[]
  phoneId?: number
}

export type ICloudAppleSignIn = ICloudAppleTwoFactor | { needs2FA: false; account: ICloudAccount }

export function createICloudApi(request: Request, jsonBody: (value: unknown) => string) {
  return {
    iCloudAccounts: (signal?: AbortSignal) => request<{ accounts: ICloudAccount[] }>(
      '/api/icloud/accounts', { signal },
    ),
    createICloudAccount: (input: {
      name: string
      host: ICloudHost
      cookies?: string
      icloudEmail?: string
      appPassword?: string
      appleAccountLogin?: boolean
    }) => (
      request<{ account: ICloudAccount }>('/api/icloud/accounts', {
        method: 'POST', body: jsonBody(input),
      })
    ),
    updateICloudAccountName: (id: string, name: string) => request<{ ok: true; name: string }>(
      `/api/icloud/accounts/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: jsonBody({ name }) },
    ),
    deleteICloudAccount: (id: string) => request<{ ok: true }>(
      `/api/icloud/accounts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),
    updateICloudCookies: (id: string, cookies: string) => request<{ account: ICloudAccount }>(
      `/api/icloud/accounts/${encodeURIComponent(id)}/cookies`,
      { method: 'PUT', body: jsonBody({ cookies }) },
    ),
    updateICloudAppPassword: (id: string, icloudEmail: string, appPassword: string) => (
      request<{ ok: true; icloudEmail: string }>(
        `/api/icloud/accounts/${encodeURIComponent(id)}/app-password`,
        { method: 'PUT', body: jsonBody({ icloudEmail, appPassword }) },
      )
    ),
    startICloudAppleAccountLogin: (id: string, appleId: string, password: string) => (
      request<ICloudAppleSignIn>(`/api/icloud/accounts/${encodeURIComponent(id)}/apple-account/login/start`, {
        method: 'POST', body: jsonBody({ appleId, password }), timeoutMs: APPLE_SIGN_IN_TIMEOUT_MS,
      })
    ),
    /** Have the code for a waiting sign-in sent by SMS instead, or sent again. */
    sendICloudAppleAccountLoginSms: (id: string, challengeId: string, phoneId?: number) => (
      request<ICloudAppleTwoFactor>(`/api/icloud/accounts/${encodeURIComponent(id)}/apple-account/login/sms`, {
        method: 'POST', body: jsonBody({ challengeId, phoneId }), timeoutMs: APPLE_SIGN_IN_TIMEOUT_MS,
      })
    ),
    completeICloudAppleAccountLogin: (id: string, challengeId: string, code: string) => (
      request<{ needs2FA: false; account: ICloudAccount }>(
        `/api/icloud/accounts/${encodeURIComponent(id)}/apple-account/login/2fa`,
        { method: 'POST', body: jsonBody({ challengeId, code }), timeoutMs: APPLE_SIGN_IN_TIMEOUT_MS },
      )
    ),
    updateICloudAppleAccount: (id: string, state: AppleAccountState) => request<{ account: ICloudAccount }>(
      `/api/icloud/accounts/${encodeURIComponent(id)}/apple-account`,
      { method: 'PUT', body: jsonBody({ state }) },
    ),
    refreshICloudAppleAccount: (id: string) => request<{ account: ICloudAccount }>(
      `/api/icloud/accounts/${encodeURIComponent(id)}/apple-account/refresh`,
      { method: 'POST' },
    ),
    deleteICloudAppleAccount: (id: string) => request<{ ok: true }>(
      `/api/icloud/accounts/${encodeURIComponent(id)}/apple-account`,
      { method: 'DELETE' },
    ),
    iCloudAliases: (accountId: string, signal?: AbortSignal) => request<{ aliases: ICloudAlias[]; cookieError?: string }>(
      `/api/icloud/aliases?accountId=${encodeURIComponent(accountId)}`,
      { signal },
    ),
    previewICloudAlias: (accountId: string) => request<{ email: string; previewId: string }>(
      '/api/icloud/aliases/preview',
      { method: 'POST', body: jsonBody({ accountId }) },
    ),
    iCloudAliasQuota: (accountId: string, signal?: AbortSignal) => request<{
      channels: ICloudAliasQuotaChannel[]
    }>(
      `/api/icloud/aliases/quota?accountId=${encodeURIComponent(accountId)}`,
      { signal },
    ),
    createICloudAlias: (input: {
      accountId: string
      label: string
      /** Sent explicitly so the server never has to discover the channel by failing. */
      channel: ICloudAliasChannel
      email?: string
      previewId?: string
    }) => request<{
      alias: Pick<ICloudAlias, 'email' | 'label' | 'createdAt'>
      channel: ICloudAliasChannel
      remaining: number
    }>(
      '/api/icloud/aliases',
      { method: 'POST', body: jsonBody(input), timeoutMs: ALIAS_CREATE_TIMEOUT_MS },
    ),
    updateICloudAlias: (
      anonymousId: string,
      accountId: string,
      action: 'deactivate' | 'reactivate',
    ) => request<{ ok: true }>(`/api/icloud/aliases/${encodeURIComponent(anonymousId)}`, {
      method: 'PATCH', body: jsonBody({ accountId, action }),
    }),
    deleteICloudAlias: (anonymousId: string, accountId: string) => request<{ ok: true }>(
      `/api/icloud/aliases/${encodeURIComponent(anonymousId)}`,
      { method: 'DELETE', body: jsonBody({ accountId }) },
    ),
    iCloudInbox: (accountId: string, alias = '', query = '', signal?: AbortSignal) => {
      const search = new URLSearchParams({ accountId, limit: '20', days: '7' })
      if (alias) search.set('alias', alias)
      if (query) search.set('q', query)
      return request<{ messages: ICloudMessage[]; method: 'imap' | 'web' }>(
        `/api/icloud/inbox?${search}`,
        { signal },
      )
    },
    iCloudMessage: (accountId: string, uid: string, signal?: AbortSignal) => (
      request<{ message: ICloudMessage }>(
        `/api/icloud/inbox/${encodeURIComponent(uid)}?accountId=${encodeURIComponent(accountId)}`,
        { signal },
      )
    ),
  }
}
