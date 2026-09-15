import type { AppleAccountState, ICloudAccount, ICloudAlias, ICloudHost, ICloudMessage } from '../../../shared/api/api-types'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>

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
      request<{
        needs2FA: boolean
        challengeId?: string
        expiresAt?: string
        account?: ICloudAccount
      }>(`/api/icloud/accounts/${encodeURIComponent(id)}/apple-account/login/start`, {
        method: 'POST', body: jsonBody({ appleId, password }),
      })
    ),
    completeICloudAppleAccountLogin: (id: string, challengeId: string, code: string) => (
      request<{ needs2FA: false; account?: ICloudAccount }>(
        `/api/icloud/accounts/${encodeURIComponent(id)}/apple-account/login/2fa`,
        { method: 'POST', body: jsonBody({ challengeId, code }) },
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
    iCloudAliases: (accountId: string, signal?: AbortSignal) => request<{ aliases: ICloudAlias[] }>(
      `/api/icloud/aliases?accountId=${encodeURIComponent(accountId)}`,
      { signal },
    ),
    previewICloudAlias: (accountId: string) => request<{ email: string; previewId: string }>(
      '/api/icloud/aliases/preview',
      { method: 'POST', body: jsonBody({ accountId }) },
    ),
    createICloudAlias: (
      accountId: string,
      label: string,
      email?: string,
      previewId?: string,
    ) => request<{
      alias: Pick<ICloudAlias, 'email' | 'label' | 'createdAt'>
    }>(
      '/api/icloud/aliases',
      { method: 'POST', body: jsonBody({ accountId, label, email, previewId }) },
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
