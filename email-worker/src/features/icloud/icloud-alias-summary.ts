import {
  ICLOUD_CREDENTIAL_ERROR_STATUS,
  ICloudRemoteError,
  type ICloudClient,
} from './icloud-apple'
import type { ICloudAccountStore, ICloudAliasCounts } from './icloud-store'
import type { ICloudAccount } from './icloud-types'

/**
 * Persist the cookie session after an alias operation, plus the counts Apple
 * reported — but only when Apple actually answered the listing. A failed
 * listing leaves the request-start snapshot on `account`, and writing that back
 * would regress a change another request landed since.
 *
 * The absolute write is measured against the row as it stood just before the
 * listing, not as this request first read it. The operation ahead of it took
 * several round trips, and a change another request landed in that time is
 * already part of what Apple reports; only one that lands while the listing is
 * in flight is newer, and the write yields to it until the next listing.
 */
export async function refreshICloudAliasSummary(
  store: ICloudAccountStore,
  account: ICloudAccount,
  client: ICloudClient,
): Promise<void> {
  account.cookies = client.cookies
  account.status = 'active'
  account.lastError = ''
  let known: ICloudAliasCounts | undefined
  try {
    const before = await store.aliasCounts(account.id)
    const aliases = await client.listAliases()
    account.cookies = client.cookies
    account.aliasTotal = aliases.length
    account.aliasActive = aliases.filter((alias) => alias.active).length
    account.lastValidated = new Date().toISOString()
    known = before
  } catch (error) {
    account.lastError = '隐藏邮箱操作已完成，但账号状态同步失败。'
    if (error instanceof ICloudRemoteError && error.status === ICLOUD_CREDENTIAL_ERROR_STATUS) {
      account.status = 'error'
    }
    console.warn('iCloud alias statistics refresh failed', {
      accountId: account.id,
      message: error instanceof Error ? error.message : String(error),
    })
  }
  // Only updated_at overlaps and nothing reads it, so the counts need not wait
  // for the cookie encryption and its round trip.
  const writes = [store.saveCookies(account)]
  if (known) writes.push(store.saveAliasSummary(account, known))
  await Promise.all(writes)
}
