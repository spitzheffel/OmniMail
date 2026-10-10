import { ApiError, type MicrosoftAccount } from '../../../shared/api'

const CONCURRENT_CHECKS = 3
const ATTENTION_STATUSES: ReadonlyArray<MicrosoftAccount['status']> = [
  'credential_error', 'permission_error', 'error',
]

export type MicrosoftVerifyOutcome = { verified: number; failed: number; skipped: number }

export function microsoftAccountsNeedingAttention(accounts: MicrosoftAccount[]): MicrosoftAccount[] {
  return accounts.filter(({ status }) => ATTENTION_STATUSES.includes(status))
}

/**
 * Checks the accounts a few at a time. The server allows only so many checks
 * per window; once it refuses one for that, the rest are left for later
 * instead of being refused one by one.
 */
export async function verifyMicrosoftAccounts(
  accountIds: string[],
  verify: (accountId: string) => Promise<unknown>,
  onProgress: (done: number) => void = () => undefined,
): Promise<MicrosoftVerifyOutcome> {
  const outcome: MicrosoftVerifyOutcome = { verified: 0, failed: 0, skipped: 0 }
  let next = 0
  let throttled = false
  async function checkInTurn(): Promise<void> {
    while (!throttled && next < accountIds.length) {
      const accountId = accountIds[next]
      next += 1
      try {
        await verify(accountId)
        outcome.verified += 1
      } catch (error) {
        if (error instanceof ApiError && error.status === 429) {
          throttled = true
          outcome.skipped += 1
        } else {
          outcome.failed += 1
        }
      }
      onProgress(outcome.verified + outcome.failed + outcome.skipped)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_CHECKS, accountIds.length) }, checkInTurn))
  outcome.skipped += accountIds.length - next
  return outcome
}
