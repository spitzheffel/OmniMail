import { type Page, type Route } from '@playwright/test'

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

/**
 * Holds responses from the moment a test calls `hold()` until `release()`. A
 * switch the test flips, never a request count: StrictMode doubles the mount
 * requests, so "the Nth request" is not something a test controls.
 */
function gate() {
  let held: Promise<void> | null = null
  let open: () => void = () => undefined
  return {
    hold: () => { held = new Promise<void>((resolve) => { open = () => resolve() }) },
    release: () => { open(); held = null },
    wait: () => held,
  }
}

type AliasChannel = 'apple_account' | 'icloud_web'
const QUOTA_LIMITS: Record<AliasChannel, number> = { apple_account: 20, icloud_web: 5 }

export async function mockICloud(page: Page, options: {
  failCreateAt?: number
  /** Answer this create attempt with a Worker timeout, after Apple has created the alias. */
  timeoutCreateAt?: number
  /** Reject every Apple Account create as an expired session, and mark it expired. */
  rejectAppleCreates?: boolean
  /** Reject every cookie-channel create as a dead jar; the quota still lists the channel. */
  rejectWebCreates?: boolean
  /** Report the quota window as resetting this long after each read. */
  quotaResetsInMs?: number
  /** List a second account, "Second", with an alias of its own. */
  secondAccount?: boolean
  hasAppPassword?: boolean
  hasAppleAccount?: boolean
  /** Status of the Apple session when one is configured. */
  appleAccountStatus?: 'active' | 'expired'
  /** Fail the alias listing with this message. */
  aliasListError?: string
  /** List aliases through Apple in place of a rejected jar, reporting this jar error. */
  aliasListCookieError?: string
  /** Answer a manual Apple session refresh with a rejection that marks it expired. */
  rejectAppleRefresh?: boolean
  rejectAccountCreate?: boolean
  /** Remaining creations this hour; null marks the channel as unusable. */
  quota?: { apple?: number | null; web?: number | null }
  /** Hold every preview response so a test can act while requests are in flight. */
  previewDelayMs?: number
  /** Apple has rejected the account's cookie jar: the account reports `error`. */
  cookieJarRejected?: boolean
  /** Script the Apple Account sign-in. */
  appleSignIn?: {
    /** Ask for a verification code after the password. */
    twoFactor?: boolean
    /** Trusted phones Apple can text, numbers masked. */
    phones?: Array<{ id: number; number: string }>
    /** How the next code submissions are answered, in order; later ones are accepted. */
    codeAnswers?: Array<'wrong' | 'gone'>
  }
} = {}) {
  const hasAppPassword = options.hasAppPassword ?? true
  const hasAppleAccount = options.hasAppleAccount ?? false
  const appleRemaining = options.quota?.apple === undefined
    ? (hasAppleAccount ? 20 : null)
    : options.quota.apple
  const webRemaining = options.quota?.web === undefined ? 5 : options.quota.web
  // What each channel had left when the window opened, and what was spent from
  // it since: quota reads and create responses must agree, or a dialog that
  // re-reads the quota after a run undoes what the run just spent.
  const windowStart: Record<AliasChannel, number | null> = {
    apple_account: appleRemaining, icloud_web: webRemaining,
  }
  const windowUsed: Record<AliasChannel, number> = { apple_account: 0, icloud_web: 0 }
  const left = (channel: AliasChannel) => Math.max(0, (windowStart[channel] ?? 0) - windowUsed[channel])
  const quotaGate = gate()
  const createGate = gate()
  const createdChannels: string[] = []
  const createAttemptChannels: string[] = []
  /** Channels whose create the fixture refused with its hourly 429. */
  const quotaRejections: string[] = []
  const aliasListAccounts: string[] = []
  let previewsInFlight = 0
  let maxPreviewsInFlight = 0
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
    cookies?: string
    icloudEmail?: string
    appPassword?: string
    appleAccountLogin?: boolean
  }> = []
  const cookieUpdates: string[] = []
  const passwordUpdates: Array<{ icloudEmail: string; appPassword: string }> = []
  const deletedAccountIds: string[] = []
  const appleAccountDeletes: string[] = []
  let accountDeleted = false
  /** Accounts the page created through the Apple Account sign-in, listed until deleted. */
  const signInAccounts = new Map<string, Record<string, unknown>>()
  const appleSignIns: Array<{ accountId: string; appleId: string }> = []
  const appleSmsRequests: Array<{ accountId: string; challengeId: string; phoneId?: number }> = []
  const appleCodes: Array<{ accountId: string; challengeId: string; code: string }> = []
  const codeAnswers = [...(options.appleSignIn?.codeAnswers ?? [])]
  let signInChallenges = 0
  let createAttempts = 0
  let accountName = 'Personal'
  let appleAccountStatus = options.appleAccountStatus ?? 'active'
  let accountLoadsFail = false
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
      icloudEmail: 'owner@icloud.com', host: 'icloud.com', status: options.cookieJarRejected ? 'error' : 'active',
      aliasTotal: 1, aliasActive: 1, lastValidated: '2026-08-13T00:00:00.000Z',
      lastError: '', createdAt: '2026-08-13T00:00:00.000Z',
      hasCookies: webRemaining !== null, hasAppPassword,
      hasAppleAccount: hasAppleAccount && !appleAccountDeletes.length,
      appleAccountStatus: hasAppleAccount && !appleAccountDeletes.length ? appleAccountStatus : 'none',
      appleAccountExpiresAt: '',
    }
    if (path === '/api/icloud/accounts' && request.method() === 'POST') {
      const input = request.postDataJSON() as (typeof accountCreates)[number]
      accountCreates.push(input)
      if (options.rejectAccountCreate) return route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'iCloud Cookie 已失效，或账号未开通 iCloud+、没有 Hide My Email 权限。',
        }),
      })
      if (input.appleAccountLogin) {
        // A row of its own, holding only what the dialog sent until the sign-in finishes.
        const created = {
          ...account, id: 'icloud-new', name: input.name, status: 'pending', aliasTotal: 0, aliasActive: 0,
          hasCookies: Boolean(input.cookies), hasAppPassword: Boolean(input.appPassword),
          hasAppleAccount: false, appleAccountStatus: 'none',
        }
        signInAccounts.set(created.id, created)
        return json(route, { account: created })
      }
      return json(route, { account })
    }
    if (path === '/api/icloud/accounts/icloud-new' && request.method() === 'DELETE') {
      signInAccounts.delete('icloud-new')
      deletedAccountIds.push('icloud-new')
      return json(route, { ok: true })
    }
    const signIn = /^\/api\/icloud\/accounts\/([^/]+)\/apple-account\/login\/(start|sms|2fa)$/.exec(path)
    if (signIn && request.method() === 'POST') {
      const [, accountId, step] = signIn
      const input = request.postDataJSON() as { appleId?: string; challengeId?: string; phoneId?: number; code?: string }
      const phones = options.appleSignIn?.phones ?? []
      const challenge = (method: 'trusted_device' | 'phone', phoneId?: number) => ({
        needs2FA: true, challengeId: `challenge-${signInChallenges}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(), method, phones, ...(phoneId ? { phoneId } : {}),
      })
      const finish = () => {
        const signedIn = {
          ...(signInAccounts.get(accountId) ?? account), status: 'active', hasAppleAccount: true, appleAccountStatus: 'active',
        }
        if (signInAccounts.has(accountId)) signInAccounts.set(accountId, signedIn)
        return json(route, { needs2FA: false, account: signedIn })
      }
      if (step === 'start') {
        appleSignIns.push({ accountId, appleId: input.appleId || '' })
        if (!options.appleSignIn?.twoFactor) return finish()
        signInChallenges += 1
        return json(route, challenge('trusted_device'))
      }
      if (step === 'sms') {
        appleSmsRequests.push({ accountId, challengeId: input.challengeId || '', phoneId: input.phoneId })
        return json(route, challenge('phone', input.phoneId ?? phones[0]?.id))
      }
      appleCodes.push({ accountId, challengeId: input.challengeId || '', code: input.code || '' })
      const answer = codeAnswers.shift()
      if (answer === 'wrong') return json(route, { error: '验证码不正确，请重新输入。' }, 422)
      if (answer === 'gone') {
        return json(route, { error: '登录挑战已过期，请重新开始。', code: 'apple_login_challenge_gone' }, 410)
      }
      return finish()
    }
    if (path === '/api/icloud/accounts') {
      if (accountLoadsFail) return route.fulfill({
        status: 500, contentType: 'application/json', body: JSON.stringify({ error: '读取 iCloud 账号失败。' }),
      })
      const second = {
        ...account, id: 'icloud-2', name: 'Second', realEmail: 'second@example.com',
        icloudEmail: 'second@icloud.com', hasCookies: true, hasAppleAccount: false, appleAccountStatus: 'none',
      }
      return json(route, {
        accounts: [
          ...(accountDeleted ? [] : [account]), ...(options.secondAccount ? [second] : []), ...signInAccounts.values(),
        ],
      })
    }
    if (path === '/api/icloud/accounts/icloud-1/apple-account/refresh' && options.rejectAppleRefresh) {
      appleAccountStatus = 'expired'
      return route.fulfill({
        status: 422, contentType: 'application/json',
        body: JSON.stringify({ error: 'Apple Account 管理态已失效，请重新登录。' }),
      })
    }
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
    if (path === '/api/icloud/accounts/icloud-1/apple-account' && request.method() === 'DELETE') {
      appleAccountDeletes.push('icloud-1')
      return json(route, { ok: true })
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
      await quotaGate.wait()
      // Mirrors the server: the window floors to the hour unless a test needs
      // the rollover to come sooner, and an expired session is not offered.
      const now = Date.now()
      const resetsAt = new Date(options.quotaResetsInMs === undefined
        ? Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000
        : now + options.quotaResetsInMs).toISOString()
      const channel = (name: AliasChannel) => {
        const available = windowStart[name] !== null
          && (name !== 'apple_account' || (appleAccountStatus !== 'expired' && !appleAccountDeletes.length))
          && (name !== 'icloud_web' || !options.cookieJarRejected)
        const remaining = available ? left(name) : 0
        return {
          channel: name, available, limit: QUOTA_LIMITS[name], remaining,
          used: QUOTA_LIMITS[name] - remaining, resetsAt,
        }
      }
      // A held read may belong to a request the page has since aborted.
      return json(route, { channels: [channel('apple_account'), channel('icloud_web')] })
        .catch(() => undefined)
    }
    if (path === '/api/icloud/aliases/preview' && request.method() === 'POST') {
      previewsInFlight += 1
      maxPreviewsInFlight = Math.max(maxPreviewsInFlight, previewsInFlight)
      if (options.previewDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.previewDelayMs))
      }
      const index = Math.min(previewedEmails.length, previewCandidates.length - 1)
      const email = previewCandidates[index]
      previewedEmails.push(email)
      // Counted down before the answer goes out, so the next queued preview can
      // never be seen overlapping one that has in fact finished.
      previewsInFlight -= 1
      return json(route, { email, previewId: previewIds[index] })
    }
    if (path === '/api/icloud/aliases' && request.method() === 'POST') {
      createAttempts += 1
      const attempt = createAttempts
      const input = request.postDataJSON() as {
        email?: string; label: string; previewId?: string; channel: AliasChannel
      }
      const channel = input.channel
      createAttemptChannels.push(channel)
      await createGate.wait()
      if (attempt === options.failCreateAt) return route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'iCloud 暂时无法创建这个地址。' }),
      })
      if (channel === 'apple_account' && options.rejectAppleCreates) {
        appleAccountStatus = 'expired'
        return json(route, { error: 'Apple Account 管理态已失效，请重新登录。' }, 422)
      }
      if (channel === 'icloud_web' && options.rejectWebCreates) {
        return json(route, { error: 'iCloud Cookie 已失效，或账号未开通 iCloud+、没有 Hide My Email 权限。' }, 422)
      }
      if (left(channel) <= 0) {
        // Recorded before answering: an auto run reroutes the refused item and
        // still ends with the same aliases, so only this shows the wasted call.
        quotaRejections.push(channel)
        return json(route, {
          error: channel === 'apple_account'
            ? '本小时 Apple Account 创建额度已用完，请稍后再试。'
            : '本小时 iCloud Cookie 创建额度已用完，请稍后再试。',
          code: 'icloud_alias_hourly_quota', channel, retryAfter: 600,
        }, 429)
      }
      createdLabels.push(input.label)
      createdEmails.push(input.email || '')
      createdPreviewIds.push(input.previewId || '')
      createdChannels.push(channel)
      windowUsed[channel] += 1
      const email = input.email || `apple-${createdChannels.length}@icloud.com`
      const alias = {
        email, anonymousId: `alias-${aliases.length + 1}`,
        label: input.label || 'OmniMail 2026-08-18 10:00', active: true,
      }
      aliases.push(alias)
      // Apple committed the alias, but the Worker gave up waiting to say so.
      if (attempt === options.timeoutCreateAt) return json(route, { error: '连接 iCloud 超时。' }, 504)
      return json(route, { alias, channel, remaining: left(channel) })
    }
    if (path === '/api/icloud/aliases') aliasListAccounts.push(url.searchParams.get('accountId') || '')
    if (path === '/api/icloud/aliases' && url.searchParams.get('accountId') === 'icloud-2') {
      return json(route, { aliases: [{
        email: 'second-alias@icloud.com', anonymousId: 'second-1', label: 'Second alias', active: true,
      }] })
    }
    if (path === '/api/icloud/aliases' && options.aliasListError) return route.fulfill({
      status: 502, contentType: 'application/json', body: JSON.stringify({ error: options.aliasListError }),
    })
    if (path === '/api/icloud/aliases' && options.aliasListCookieError) {
      return json(route, { aliases, cookieError: options.aliasListCookieError })
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
    accountCreates, accountNames, appleAccountDeletes, cookieUpdates, createdChannels, createdEmails, createdLabels,
    /** Every sign-in started, code submitted and SMS requested, in order. */
    appleSignIns, appleCodes, appleSmsRequests,
    /** Fail every account-list load from now on. */
    failAccountLoads: () => { accountLoadsFail = true },
    createdPreviewIds, deletedAccountIds,
    inboxAliases, inboxQueries, messageReads, passwordUpdates, previewedEmails,
    /** Every create request that arrived, refused ones included. */
    createAttempts: () => createAttempts,
    createAttemptChannels, quotaRejections,
    /** accountId of every alias-list read. */
    aliasListAccounts,
    /** Most preview requests the fixture was holding at once. */
    maxConcurrentPreviews: () => maxPreviewsInFlight,
    holdQuota: quotaGate.hold, releaseQuota: quotaGate.release,
    holdCreates: createGate.hold, releaseCreates: createGate.release,
    /** The Apple session expires server-side, as when another tab's refresh fails. */
    expireAppleSession: () => { appleAccountStatus = 'expired' },
    /** Roll the hour over: every usable channel gets its full limit back. */
    resetQuotaWindow: () => {
      for (const channel of ['apple_account', 'icloud_web'] as const) {
        if (windowStart[channel] !== null) windowStart[channel] = QUOTA_LIMITS[channel]
        windowUsed[channel] = 0
      }
    },
  }
}
