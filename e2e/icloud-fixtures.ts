import { type Page, type Route } from '@playwright/test'

function json(route: Route, body: unknown) {
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
}

export async function mockICloud(page: Page, options: {
  failCreateAt?: number
  hasAppPassword?: boolean
  hasAppleAccount?: boolean
  rejectAccountCreate?: boolean
  /** Remaining creations this hour; null marks the channel as unusable. */
  quota?: { apple?: number | null; web?: number | null }
  /** Hold every preview response so a test can act while requests are in flight. */
  previewDelayMs?: number
} = {}) {
  const hasAppPassword = options.hasAppPassword ?? true
  const hasAppleAccount = options.hasAppleAccount ?? false
  const appleRemaining = options.quota?.apple === undefined
    ? (hasAppleAccount ? 20 : null)
    : options.quota.apple
  const webRemaining = options.quota?.web === undefined ? 5 : options.quota.web
  const createdChannels: string[] = []
  const aliases = [{
    email: 'shop@icloud.com', anonymousId: 'alias-1', label: 'Shopping', active: true,
  }]
  const inboxAliases: string[] = []
  const inboxQueries: string[] = []
  const messageReads: string[] = []
  const createdLabels: string[] = []
  const createdEmails: string[] = []
  const createdPreviewIds: string[] = []
  const previewedEmails: string[] = []
  const accountNames: string[] = []
  const accountCreates: Array<{
    name: string
    host: string
    cookies: string
    icloudEmail?: string
    appPassword?: string
  }> = []
  const cookieUpdates: string[] = []
  const passwordUpdates: Array<{ icloudEmail: string; appPassword: string }> = []
  const deletedAccountIds: string[] = []
  let accountDeleted = false
  let createAttempts = 0
  let accountName = 'Personal'
  const previewCandidates = [
    'preview-one@icloud.com', 'github-1@icloud.com', 'github-2@icloud.com',
    'github-3@icloud.com', 'github-4@icloud.com', 'github-5@icloud.com',
  ]
  const previewIds = previewCandidates.map((_, index) => (
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  ))
  await page.addInitScript(() => {
    localStorage.setItem('omnimail.deployment-guide.v1', 'seen')
    localStorage.setItem('omnimail-locale', 'zh-CN')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => undefined },
    })
  })
  await page.route('**://*/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/api/config') return json(route, {
      appName: 'OmniMail', setupComplete: true, replyEnabled: false,
      iCloudEnabled: true, iCloudWorkspaceEnabled: true, linuxDoMailWorkspaceEnabled: true,
      registrationEnabled: false, registrationAvailable: false,
      registrationMethod: 'password', linuxDoLoginEnabled: false,
      registrationDomainPolicy: { mode: 'blocklist', domains: [] },
      registrationProtectionReady: false, turnstileSiteKey: '', mailRefreshInterval: 0,
      remoteImagesEnabled: true, unassignedMailEnabled: false, superAdminEmail: '',
      setupRequirements: { databaseReady: true, storageReady: true, queueReady: true,
        superAdminReady: true, setupTokenReady: false },
    })
    if (path === '/api/session') return json(route, { user: {
      id: 'user-1', email: 'user@example.com', displayName: 'User', role: 'user',
      mailboxLimit: 1, storageQuotaBytes: 1024, storageUsedBytes: 0,
      canCreateMailboxes: false, canReply: false, canTranslate: false,
      temporaryExpiresAt: null,
    } })
    if (path === '/api/mailboxes') return json(route, { mailboxes: [] })
    if (path === '/api/domains') return json(route, { domains: [] })
    if (path === '/api/remote-images') return route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" rx="6" fill="#24292f"/><text x="60" y="21" text-anchor="middle" fill="white">GitHub</text></svg>',
    })
    const account = {
      id: 'icloud-1', name: accountName, realEmail: 'owner@example.com',
      icloudEmail: 'owner@icloud.com', host: 'icloud.com', status: 'active',
      aliasTotal: 1, aliasActive: 1, lastValidated: '2026-08-13T00:00:00.000Z',
      lastError: '', createdAt: '2026-08-13T00:00:00.000Z',
      hasCookies: webRemaining !== null, hasAppPassword, hasAppleAccount,
      appleAccountStatus: hasAppleAccount ? 'active' : 'none', appleAccountExpiresAt: '',
    }
    if (path === '/api/icloud/accounts' && request.method() === 'POST') {
      accountCreates.push(request.postDataJSON())
      if (options.rejectAccountCreate) return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'iCloud Cookie 已失效，或账号未开通 iCloud+、没有 Hide My Email 权限。',
        }),
      })
      return json(route, { account })
    }
    if (path === '/api/icloud/accounts') return json(route, { accounts: accountDeleted ? [] : [account] })
    if (path === '/api/icloud/accounts/icloud-1' && request.method() === 'DELETE') {
      accountDeleted = true
      deletedAccountIds.push('icloud-1')
      return json(route, { ok: true })
    }
    if (path === '/api/icloud/accounts/icloud-1' && request.method() === 'PATCH') {
      const input = request.postDataJSON() as { name: string }
      accountName = input.name
      accountNames.push(input.name)
      return json(route, { ok: true, name: input.name })
    }
    if (path === '/api/icloud/accounts/icloud-1/cookies' && request.method() === 'PUT') {
      const input = request.postDataJSON() as { cookies: string }
      cookieUpdates.push(input.cookies)
      return json(route, { account })
    }
    if (path === '/api/icloud/accounts/icloud-1/app-password' && request.method() === 'PUT') {
      const input = request.postDataJSON() as { icloudEmail: string; appPassword: string }
      passwordUpdates.push(input)
      return json(route, { ok: true, icloudEmail: input.icloudEmail })
    }
    if (path === '/api/icloud/aliases/quota') {
      const channel = (name: string, limit: number, left: number | null) => ({
        channel: name, available: left !== null, limit, remaining: Math.max(0, left ?? 0),
        used: Math.max(0, limit - (left ?? 0)), resetsAt: '2026-08-13T01:00:00.000Z',
      })
      return json(route, { channels: [
        channel('apple_account', 20, appleRemaining), channel('icloud_web', 5, webRemaining),
      ] })
    }
    if (path === '/api/icloud/aliases/preview' && request.method() === 'POST') {
      if (options.previewDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.previewDelayMs))
      }
      const index = Math.min(previewedEmails.length, previewCandidates.length - 1)
      const email = previewCandidates[index]
      previewedEmails.push(email)
      return json(route, { email, previewId: previewIds[index] })
    }
    if (path === '/api/icloud/aliases' && request.method() === 'POST') {
      createAttempts += 1
      if (createAttempts === options.failCreateAt) return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'iCloud 暂时无法创建这个地址。' }),
      })
      const input = request.postDataJSON() as {
        email?: string; label: string; previewId?: string; channel: string
      }
      const channel = input.channel
      if (channel === 'apple_account' && createdChannels.filter((item) => item === channel).length
        >= Math.max(0, appleRemaining ?? 0)) {
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({
            error: '本小时 Apple Account 创建额度已用完，请稍后再试。',
            code: 'icloud_alias_hourly_quota', channel, retryAfter: 600,
          }),
        })
      }
      createdLabels.push(input.label)
      createdEmails.push(input.email || '')
      createdPreviewIds.push(input.previewId || '')
      createdChannels.push(channel)
      const email = input.email || `apple-${createdChannels.length}@icloud.com`
      const alias = {
        email, anonymousId: `alias-${aliases.length + 1}`,
        label: input.label || 'OmniMail 2026-08-18 10:00', active: true,
      }
      aliases.push(alias)
      const used = createdChannels.filter((item) => item === channel).length
      const budget = channel === 'apple_account' ? (appleRemaining ?? 0) : (webRemaining ?? 0)
      return json(route, { alias, channel, remaining: Math.max(0, budget - used) })
    }
    if (path === '/api/icloud/aliases') return json(route, { aliases })
    if (path === '/api/icloud/inbox') {
      const alias = url.searchParams.get('alias') || ''
      const query = url.searchParams.get('q') || ''
      inboxAliases.push(alias)
      inboxQueries.push(query)
      const messages = query === 'missing' ? [] : [{
      id: '42', from: 'GitHub <noreply_at_github_com_22h56q5td86002_47bfb5aa@icloud.com>', to: alias || 'shop@icloud.com',
      subject: 'Your receipt', date: '2026-08-13T00:00:00.000Z',
      preview: 'Thanks for your order.', body: 'Thanks for your order.', html: '',
      }]
      return json(route, { method: hasAppPassword ? 'imap' : 'web', messages })
    }
    if (path === '/api/icloud/inbox/42') {
      messageReads.push('42')
      return json(route, { message: {
      id: '42', from: 'GitHub <noreply_at_github_com_22h56q5td86002_47bfb5aa@icloud.com>', to: 'shop@icloud.com',
      subject: 'Your receipt', date: '2026-08-13T00:00:00.000Z',
      preview: 'Thanks for your order.', body: 'Full receipt body.',
      html: `<html><body><img src="https://github.com/logo.png" alt="GitHub"><h1>Full receipt body.</h1><p><a href="https://github.com/account_verifications">Open receipt</a></p>${'<p>Receipt details</p>'.repeat(80)}<script>document.body.textContent="unsafe"</script></body></html>`,
      } })
    }
    return route.abort()
  })
  return {
    accountCreates, accountNames, cookieUpdates, createdChannels, createdEmails, createdLabels,
    createdPreviewIds, deletedAccountIds,
    inboxAliases, inboxQueries, messageReads, passwordUpdates, previewedEmails,
  }
}
