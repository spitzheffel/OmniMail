import { describe, expect, it } from 'vitest'
import type { ICloudAccount, ICloudAlias } from '../../src/shared/api/api-types'
import {
  canReadICloudMail,
  iCloudAccountAddress,
  iCloudAccountLabel,
  iCloudAliasAccounts,
  withCreatedICloudAlias,
} from './icloud-accounts'

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

// What an account that only signed in with an Apple Account looks like.
const appleOnly = account({
  id: 'apple-only', name: 'Apple only', realEmail: '', icloudEmail: '',
  status: 'pending', hasAppleAccount: true, appleAccountStatus: 'active',
})

describe('Float iCloud accounts', () => {
  it('offers Apple-Account-only accounts next to cookie accounts', () => {
    const cookie = account({ id: 'cookie', hasCookies: true })
    const appPasswordOnly = account({ id: 'imap', hasAppPassword: true })

    expect(iCloudAliasAccounts([cookie, appleOnly, appPasswordOnly])).toEqual({
      accounts: [cookie, appleOnly], unavailableReason: null,
    })
  })

  it('leaves out a rejected Apple session unless the account also has cookies', () => {
    const expired = { ...appleOnly, appleAccountStatus: 'expired' as const }
    const expiredWithCookies = { ...expired, id: 'both', hasCookies: true }

    expect(iCloudAliasAccounts([expired, expiredWithCookies]).accounts).toEqual([expiredWithCookies])
  })

  it('leaves out a cookie jar Apple rejected unless the Apple session still works', () => {
    const deadJar = account({ id: 'dead-jar', hasCookies: true, status: 'error' })
    const deadJarWithApple = { ...deadJar, id: 'dead-jar-apple', hasAppleAccount: true, appleAccountStatus: 'active' as const }

    expect(iCloudAliasAccounts([deadJar, deadJarWithApple]).accounts).toEqual([deadJarWithApple])
  })

  it('keeps the cookie rule for servers that predate Apple Account sign-in', () => {
    const legacy = account({ hasCookies: true }) as Partial<ICloudAccount>
    delete legacy.hasAppleAccount
    delete legacy.appleAccountStatus

    expect(iCloudAliasAccounts([legacy as ICloudAccount]).accounts).toHaveLength(1)
  })

  it('names why nothing can create an alias instead of blaming the cookie', () => {
    expect(iCloudAliasAccounts([]).unavailableReason).toBe('no-accounts')
    expect(iCloudAliasAccounts([
      account({ hasAppPassword: true }),
      { ...appleOnly, appleAccountStatus: 'expired' },
    ]).unavailableReason).toBe('apple-expired')
    expect(iCloudAliasAccounts([account({ hasCookies: true, status: 'error' })]).unavailableReason)
      .toBe('cookie-expired')
    // Signing in again beats copying cookies, so an expired session is named first.
    expect(iCloudAliasAccounts([
      account({ hasCookies: true, status: 'error' }),
      { ...appleOnly, appleAccountStatus: 'expired' },
    ]).unavailableReason).toBe('apple-expired')
    expect(iCloudAliasAccounts([account({ hasAppPassword: true })]).unavailableReason)
      .toBe('no-alias-login')
  })

  it('reads mail only through an app password or cookies', () => {
    expect(canReadICloudMail(appleOnly)).toBe(false)
    expect(canReadICloudMail({ ...appleOnly, hasAppPassword: true })).toBe(true)
    expect(canReadICloudMail(account({ hasCookies: true }))).toBe(true)
  })

  it('never presents the region host as the account address', () => {
    expect(iCloudAccountAddress(appleOnly)).toBe('')
    expect(iCloudAccountLabel(appleOnly)).toBe('Apple only')
    expect(iCloudAccountAddress(account({ realEmail: '', icloudEmail: 'me@icloud.com' })))
      .toBe('me@icloud.com')
    expect(iCloudAccountLabel(account())).toBe('Personal · owner@icloud.com')
  })

  it('keeps a just-created alias that the fresh listing does not include yet', () => {
    const listed: ICloudAlias[] = [{
      email: 'old@icloud.com', anonymousId: 'old', label: '', active: true,
    }]
    const created: ICloudAlias = {
      email: 'new@icloud.com', anonymousId: '', label: 'Shop', active: true,
    }

    expect(withCreatedICloudAlias([], created)).toEqual([created])
    expect(withCreatedICloudAlias(listed, created)).toEqual([created, ...listed])
    expect(withCreatedICloudAlias([...listed, { ...created, anonymousId: 'new' }], created))
      .toEqual([...listed, { ...created, anonymousId: 'new' }])
    expect(withCreatedICloudAlias(listed)).toBe(listed)
  })
})
