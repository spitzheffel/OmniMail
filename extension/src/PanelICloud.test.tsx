import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ICloudAccount } from '../../src/shared/api/api-types'
import type { ICloudAliasUnavailableReason } from './icloud-accounts'
import { PanelICloudGenerate } from './PanelICloudGenerate'
import { PanelICloudInbox } from './PanelICloudInbox'

function account(overrides: Partial<ICloudAccount> = {}): ICloudAccount {
  return {
    id: 'icloud-1', name: 'Personal', realEmail: 'owner@icloud.com',
    icloudEmail: 'owner@icloud.com', host: 'icloud.com', status: 'active',
    aliasTotal: 0, aliasActive: 0, lastValidated: '', lastError: '', createdAt: '',
    hasCookies: false, hasAppPassword: false, hasAppleAccount: false,
    appleAccountStatus: 'none', appleAccountExpiresAt: '',
    ...overrides,
  }
}

const appleOnly = account({
  id: 'apple-only', name: 'Apple only', realEmail: '', icloudEmail: '',
  hasAppleAccount: true, appleAccountStatus: 'active',
})

function noop() {}

function generate(
  accounts: ICloudAccount[],
  unavailableReason: ICloudAliasUnavailableReason | null = null,
): string {
  return renderToStaticMarkup(
    <PanelICloudGenerate accountId={accounts[0]?.id ?? ''} accounts={accounts} aliases={[]}
      authorized busy={false} creating={false} enabled loadingAccounts={false}
      loadingAliases={false} selectedAlias="" unavailableReason={unavailableReason}
      onAccount={noop} onAlias={noop} onCopy={noop} onFill={noop}
      onGenerate={async () => ''} onOpenWeb={noop} onReauthorize={noop}
      onRetry={noop} onRetryAliases={noop} />,
  )
}

function inbox(selected: ICloudAccount): string {
  return renderToStaticMarkup(
    <PanelICloudInbox accountId={selected.id} accounts={[selected]} aliases={[]}
      authorized enabled loadingAccounts={false} loadingAliases={false} preferredAlias=""
      onAccount={noop} onOpenWeb={noop} onReauthorize={noop}
      onCopyVerificationCode={noop} onFillVerificationCode={noop} />,
  )
}

describe('Float iCloud panels', () => {
  it('explains an empty account list by what actually blocks alias creation', () => {
    expect(generate([], 'apple-expired')).toContain('Apple Account 登录已过期')
    expect(generate([], 'cookie-expired')).toContain('iCloud Cookie 已失效')
    expect(generate([], 'no-alias-login')).toContain('登录 Apple Account 或配置 Cookie')
    expect(generate([], 'no-accounts')).toContain('请先在网页端连接 iCloud 账号')
    for (const reason of ['apple-expired', 'cookie-expired', 'no-alias-login', 'no-accounts', null] as const) {
      expect(generate([], reason)).not.toContain('确认 Cookie')
    }
  })

  it('offers an Apple-Account-only account by name rather than its region host', () => {
    const html = generate([appleOnly])

    expect(html).toContain('<span>Apple only</span>')
    expect(html).not.toContain('Apple only · ')
    expect(generate([account()])).toContain('<span>Personal · owner@icloud.com</span>')
  })

  it('shows why an account without mail access has no inbox', () => {
    const html = inbox(appleOnly)

    expect(html).toContain('这个账号还不能收信')
    expect(html).not.toContain('iCloud 收件地址')
  })

  it('keeps the inbox filters for accounts that can read mail', () => {
    for (const reader of [account({ hasCookies: true }), { ...appleOnly, hasAppPassword: true }]) {
      const html = inbox(reader)
      expect(html).toContain('iCloud 收件地址')
      expect(html).not.toContain('这个账号还不能收信')
    }
  })
})
