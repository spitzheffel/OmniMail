import {
  ICLOUD_CREDENTIAL_ERROR_STATUS,
  ICloudRemoteError,
  type ICloudClient,
} from './icloud-apple'
import type { ICloudAccountStore } from './icloud-store'
import type { ICloudAccount } from './icloud-types'

/**
 * Persist the cookie session after an alias operation, plus the counts Apple
 * reported — but only when Apple actually answered the listing. A failed
 * listing leaves the pre-request snapshot on `account`, and writing that back
 * would undo an increment a concurrent create landed meanwhile.
 *
 * The absolute write is guarded by the total this request started from, so even
 * a successful listing yields to a create that arrived after it was taken: that
 * increment is the newer fact, and the next listing reconciles the rest.
 */
export async function refreshICloudAliasSummary(
  store: ICloudAccountStore,
  account: ICloudAccount,
  client: ICloudClient,
): Promise<void> {
  const knownTotal = account.aliasTotal
  account.cookies = client.cookies
  account.status = 'active'
  account.lastError = ''
  let listed = false
  try {
    const aliases = await client.listAliases()
    account.cookies = client.cookies
    account.aliasTotal = aliases.length
    account.aliasActive = aliases.filter((alias) => alias.active).length
    account.lastValidated = new Date().toISOString()
    listed = true
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
  await store.saveCookies(account)
  if (listed) {
    await store.saveAliasSummary(account.id, account.aliasTotal, account.aliasActive, knownTotal)
  }
}
