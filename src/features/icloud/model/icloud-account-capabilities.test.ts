import { describe, expect, it } from 'vitest'
import type { ICloudAccount } from '../../../shared/api'
import { accountListsAliases, accountManagesAliases, accountReadsMail } from './icloud-account-capabilities'

function account(overrides: Partial<ICloudAccount>): ICloudAccount {
  return {
    id: 'icloud-1', name: 'Personal', realEmail: '', icloudEmail: '', host: 'icloud.com', status: 'active',
    aliasTotal: 0, aliasActive: 0, lastValidated: '', lastError: '', createdAt: '',
    hasCookies: false, hasAppPassword: false, hasAppleAccount: false,
    appleAccountStatus: 'none', appleAccountExpiresAt: '',
    ...overrides,
  }
}

describe('iCloud account capabilities', () => {
  it('reads mail through an app password or a cookie jar, never through the Apple session', () => {
    expect(accountReadsMail(account({ hasAppPassword: true }))).toBe(true)
    expect(accountReadsMail(account({ hasCookies: true }))).toBe(true)
    expect(accountReadsMail(account({ hasAppleAccount: true, appleAccountStatus: 'active' }))).toBe(false)
    expect(accountReadsMail(undefined)).toBe(false)
  })

  it('lists aliases through an expired Apple session too, since a listing is how one comes back', () => {
    expect(accountListsAliases(account({ hasAppleAccount: true, appleAccountStatus: 'expired' }))).toBe(true)
    expect(accountListsAliases(account({ hasCookies: true, status: 'error' }))).toBe(true)
    expect(accountListsAliases(account({ hasAppPassword: true }))).toBe(false)
  })

  it('offers deactivate and delete only on a cookie jar Apple has not rejected', () => {
    expect(accountManagesAliases(account({ hasCookies: true }))).toBe(true)
    expect(accountManagesAliases(account({ hasCookies: true, status: 'error' }))).toBe(false)
    expect(accountManagesAliases(account({ hasAppleAccount: true, appleAccountStatus: 'active' }))).toBe(false)
  })
})
