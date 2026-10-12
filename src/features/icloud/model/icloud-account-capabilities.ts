import type { ICloudAccount } from '../../../shared/api'

/** Mail comes through the app password (IMAP) or the cookie jar (web summaries); an Apple session reads none. */
export function accountReadsMail(account: ICloudAccount | undefined): boolean {
  return Boolean(account?.hasCookies || account?.hasAppPassword)
}

/**
 * Whether there is anything to list aliases through. An Apple session counts
 * even once expired: the server says why it fails, and a listing Apple accepts
 * marks it active again.
 */
export function accountListsAliases(account: ICloudAccount | undefined): boolean {
  return Boolean(account?.hasCookies || account?.hasAppleAccount)
}

/**
 * Deactivate, reactivate and delete exist only on the cookie channel, and a jar
 * Apple has rejected cannot use it until it is replaced or a listing shows it
 * working again.
 */
export function accountManagesAliases(account: ICloudAccount | undefined): boolean {
  return Boolean(account?.hasCookies && account.status !== 'error')
}
