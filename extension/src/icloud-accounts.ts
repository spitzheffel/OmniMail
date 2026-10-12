import type { ICloudAccount, ICloudAlias } from '../../src/shared/api/api-types'

type AliasChannelFields = Pick<ICloudAccount, 'hasCookies' | 'status' | 'hasAppleAccount' | 'appleAccountStatus'>

export type ICloudAliasUnavailableReason = 'no-accounts' | 'apple-expired' | 'cookie-expired' | 'no-alias-login'

/**
 * Whether the Worker can create an alias from the plain { accountId, label }
 * request Float sends. Same rule as its iCloudAliasChannels(): a cookie jar
 * Apple has not rejected (a rejected one leaves the account in `error` until a
 * listing on the web finds it working again), or an Apple Account session
 * Apple has not rejected. Without email or previewId the Worker creates through
 * that session itself, so an account that only signed in with an Apple Account
 * qualifies without ever touching the cookie-only preview. Servers that predate
 * Apple Account sign-in omit the flag, which leaves the cookie rule as it was.
 */
export function canCreateICloudAlias(account: AliasChannelFields): boolean {
  return (Boolean(account.hasCookies) && account.status !== 'error')
    || (Boolean(account.hasAppleAccount) && account.appleAccountStatus !== 'expired')
}

/**
 * Whether /api/icloud/inbox has anything to read this account with: IMAP
 * through an app-specific password, or the cookie jar's Web summaries. An Apple
 * Account session only manages aliases.
 */
export function canReadICloudMail(
  account: Pick<ICloudAccount, 'hasCookies' | 'hasAppPassword'>,
): boolean {
  return Boolean(account.hasCookies || account.hasAppPassword)
}

/**
 * The accounts Float offers, plus why there are none when nothing qualifies, so
 * the empty state names what actually needs fixing on the web. Credentials
 * still on file at that point were rejected: a live one would have qualified.
 * An expired Apple session is named first, since signing in again needs no
 * cookies copied out of a browser.
 */
export function iCloudAliasAccounts<T extends AliasChannelFields>(accounts: T[]): {
  accounts: T[]
  unavailableReason: ICloudAliasUnavailableReason | null
} {
  const usable = accounts.filter(canCreateICloudAlias)
  if (usable.length) return { accounts: usable, unavailableReason: null }
  return { accounts: usable, unavailableReason: unavailableReason(accounts) }
}

function unavailableReason(accounts: AliasChannelFields[]): ICloudAliasUnavailableReason {
  if (!accounts.length) return 'no-accounts'
  if (accounts.some((account) => account.hasAppleAccount)) return 'apple-expired'
  return accounts.some((account) => account.hasCookies) ? 'cookie-expired' : 'no-alias-login'
}

/**
 * The account's own mail address, or '' when it has none. An account that only
 * signed in with an Apple Account carries neither address, and `host` names the
 * iCloud region: showing it in place of an address would offer "icloud.com" to
 * copy or fill into a page.
 */
export function iCloudAccountAddress(account: Pick<ICloudAccount, 'realEmail' | 'icloudEmail'>): string {
  return account.realEmail || account.icloudEmail || ''
}

export function iCloudAccountLabel(
  account: Pick<ICloudAccount, 'name' | 'realEmail' | 'icloudEmail'>,
): string {
  const address = iCloudAccountAddress(account)
  return address ? `${account.name} · ${address}` : account.name
}

/**
 * Keep an alias that was just created selectable even when the fresh listing
 * leaves it out. Apple's list can lag behind a create, and in regions without
 * it an Apple-Account-only account lists nothing at all, which would hide the
 * address the user asked for before they could copy or fill it.
 */
export function withCreatedICloudAlias(listed: ICloudAlias[], created?: ICloudAlias): ICloudAlias[] {
  if (!created || listed.some((alias) => alias.email === created.email)) return listed
  return [created, ...listed]
}
