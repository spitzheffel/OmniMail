import { describe, expect, it } from 'vitest'
import { ApiError, type MicrosoftAccount } from '../../../shared/api'
import { microsoftAccountsNeedingAttention, verifyMicrosoftAccounts } from './microsoft-verify'

function account(id: string, status: MicrosoftAccount['status']): MicrosoftAccount {
  return { id, status } as MicrosoftAccount
}

function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

describe('Microsoft batch verification', () => {
  it('picks every account that needs attention and nothing else', () => {
    const accounts = [
      account('active', 'active'), account('credential', 'credential_error'),
      account('permission', 'permission_error'), account('error', 'error'),
      account('syncing', 'syncing'), account('pending', 'pending_validation'),
    ]
    expect(microsoftAccountsNeedingAttention(accounts).map(({ id }) => id))
      .toEqual(['credential', 'permission', 'error'])
  })

  it('checks every account, a few at a time, and counts the ones still failing', async () => {
    let running = 0
    let peak = 0
    const progress: number[] = []
    const outcome = await verifyMicrosoftAccounts(['a', 'b', 'c', 'd', 'e'], async (id) => {
      running += 1
      peak = Math.max(peak, running)
      await pause()
      running -= 1
      if (id === 'c') throw new ApiError('Microsoft 拒绝 IMAP OAuth2 登录。', 400)
    }, (done) => progress.push(done))

    expect(outcome).toEqual({ verified: 4, failed: 1, skipped: 0 })
    expect(peak).toBe(3)
    expect(progress).toEqual([1, 2, 3, 4, 5])
  })

  it('starts no further checks once the server refuses one for coming too often', async () => {
    const asked: string[] = []
    const outcome = await verifyMicrosoftAccounts(['a', 'b', 'c', 'd', 'e', 'f', 'g'], async (id) => {
      asked.push(id)
      if (id === 'a') throw new ApiError('Microsoft 凭据验证过于频繁，请稍后重试。', 429)
      await pause()
    })

    // The two already under way still finish.
    expect(asked).toEqual(['a', 'b', 'c'])
    expect(outcome).toEqual({ verified: 2, failed: 0, skipped: 5 })
  })
})
