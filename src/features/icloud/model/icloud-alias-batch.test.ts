import { describe, expect, it, vi } from 'vitest'
import type { ICloudAliasChannel, ICloudAliasQuotaChannel } from '../../../shared/api'
import {
  accountChannelAvailability,
  aliasBatchLabel,
  availableChannels,
  batchSummary,
  buildAliasBatch,
  hasUsableAliasChannel,
  planAliasBatch,
  remainingFor,
  type AliasBatchItem,
  type AliasChannelAccount,
} from './icloud-alias-batch'
import { runAliasBatch, type AliasBatchApi } from './icloud-alias-batch-run'

function quota(
  apple: Partial<ICloudAliasQuotaChannel>,
  web: Partial<ICloudAliasQuotaChannel>,
): ICloudAliasQuotaChannel[] {
  return [
    { channel: 'apple_account', available: true, limit: 20, used: 0, remaining: 20, resetsAt: '', ...apple },
    { channel: 'icloud_web', available: true, limit: 5, used: 0, remaining: 5, resetsAt: '', ...web },
  ]
}

describe('account channel availability', () => {
  function channels(overrides: Partial<AliasChannelAccount>): AliasChannelAccount {
    return { hasCookies: false, hasAppleAccount: false, appleAccountStatus: 'none', ...overrides }
  }

  it('drops an Apple session the server has already marked expired', () => {
    // Mirrors iCloudAliasChannels(): the create handler refuses it, so planning
    // a batch onto it only produces a run of identical failures.
    expect(accountChannelAvailability(channels({ hasAppleAccount: true })).apple_account).toBe(true)
    expect(accountChannelAvailability(
      channels({ hasAppleAccount: true, appleAccountStatus: 'expired' }),
    ).apple_account).toBe(false)
  })

  it('reports no usable channel for an expired session with no cookie jar', () => {
    expect(hasUsableAliasChannel(channels({ hasCookies: true }))).toBe(true)
    expect(hasUsableAliasChannel(channels({ hasAppleAccount: true }))).toBe(true)
    expect(hasUsableAliasChannel(
      channels({ hasAppleAccount: true, appleAccountStatus: 'expired' }),
    )).toBe(false)
    expect(hasUsableAliasChannel(
      channels({ hasAppleAccount: true, appleAccountStatus: 'expired', hasCookies: true }),
    )).toBe(true)
  })
})

let counter = 0
const newId = () => `item-${++counter}`

describe('aliasBatchLabel', () => {
  it('numbers a batch with a width that fits the total', () => {
    expect(aliasBatchLabel('GITHUB', 3, 25)).toBe('GITHUB-03')
    expect(aliasBatchLabel('GITHUB', 7, 120)).toBe('GITHUB-007')
  })

  it('leaves a single alias unnumbered', () => {
    expect(aliasBatchLabel('GITHUB', 1, 1)).toBe('GITHUB')
    expect(aliasBatchLabel('  GITHUB  ', 1, 1)).toBe('GITHUB')
  })

  it('returns empty so the server auto-names when no base is given', () => {
    expect(aliasBatchLabel('', 1, 5)).toBe('')
    expect(aliasBatchLabel('   ', 4, 5)).toBe('')
  })
})

describe('planAliasBatch', () => {
  it('fills the Apple budget before spilling to cookies', () => {
    expect(planAliasBatch(7, quota({ remaining: 5 }, { remaining: 5 }), 'auto')).toEqual([
      'apple_account', 'apple_account', 'apple_account', 'apple_account', 'apple_account',
      'icloud_web', 'icloud_web',
    ])
  })

  it('plans only what the hour can cover', () => {
    expect(planAliasBatch(7, quota({ remaining: 0 }, { remaining: 5 }), 'auto'))
      .toEqual(['icloud_web', 'icloud_web', 'icloud_web', 'icloud_web', 'icloud_web'])
  })

  it('never crosses channels when one was chosen explicitly', () => {
    expect(planAliasBatch(7, quota({ remaining: 2 }, { remaining: 5 }), 'apple_account'))
      .toEqual(['apple_account', 'apple_account'])
  })

  it('ignores a channel the account has no credentials for', () => {
    expect(planAliasBatch(3, quota({ available: false }, { remaining: 5 }), 'auto'))
      .toEqual(['icloud_web', 'icloud_web', 'icloud_web'])
  })
})

describe('quota helpers', () => {
  it('sums both channels for auto and reads one for an explicit choice', () => {
    const channels = quota({ remaining: 12 }, { remaining: 3 })
    expect(remainingFor(channels, 'auto')).toBe(15)
    expect(remainingFor(channels, 'apple_account')).toBe(12)
    expect(remainingFor(channels, 'icloud_web')).toBe(3)
  })

  it('treats an unavailable channel as having nothing left', () => {
    const channels = quota({ available: false, remaining: 20 }, {})
    expect(availableChannels(channels)).toEqual(['icloud_web'])
    expect(remainingFor(channels, 'auto')).toBe(5)
    expect(remainingFor(channels, 'apple_account')).toBe(0)
  })
})

describe('batchSummary', () => {
  it('counts outcomes and splits successes by channel', () => {
    const items = [
      { status: 'success', channel: 'apple_account' },
      { status: 'success', channel: 'icloud_web' },
      { status: 'error', channel: 'apple_account' },
      { status: 'skipped', channel: 'icloud_web' },
    ] as AliasBatchItem[]
    expect(batchSummary(items)).toEqual({ success: 2, failed: 1, skipped: 1, apple: 1, web: 1 })
  })
})

type StubCall = { channel: ICloudAliasChannel; label: string }

function stubApi(behaviour: {
  create?: (input: StubCall) => Promise<void>
} = {}): AliasBatchApi & { calls: StubCall[] } {
  const calls: StubCall[] = []
  let seq = 0
  return {
    calls,
    previewICloudAlias: async () => {
      seq += 1
      return { email: `preview${seq}@icloud.com`, previewId: `preview-${seq}` }
    },
    createICloudAlias: async (input) => {
      calls.push({ channel: input.channel, label: input.label })
      if (behaviour.create) await behaviour.create({ channel: input.channel, label: input.label })
      return {
        alias: {
          email: `made${calls.length}@icloud.com`,
          label: input.label,
          createdAt: '2026-09-17T10:00:00.000Z',
        },
        channel: input.channel,
        remaining: 9,
      }
    },
  }
}

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

const QUOTA_MESSAGE = '本小时 Apple Account 创建额度已用完，请稍后再试。'

describe('runAliasBatch', () => {
  it('keeps going after a failure instead of abandoning the rest', async () => {
    const api = stubApi({
      create: async ({ label }) => {
        if (label === 'B-02') throw apiError(502, 'iCloud 无法保留隐藏邮箱。')
      },
    })
    const items = buildAliasBatch(['apple_account', 'apple_account', 'apple_account'], 'B', newId)

    const result = await runAliasBatch({
      api, accountId: 'acct-1', items, choice: 'apple_account', quota: quota({}, {}),
    })

    expect(result.items.map((item) => item.status)).toEqual(['success', 'error', 'success'])
    expect(result.created).toHaveLength(2)
    expect(api.calls).toHaveLength(3)
  })

  it('reserves a preview address only for the cookie channel', async () => {
    const api = stubApi()
    const preview = vi.spyOn(api, 'previewICloudAlias')
    const items = buildAliasBatch(['apple_account', 'icloud_web'], '', newId)

    await runAliasBatch({ api, accountId: 'acct-1', items, choice: 'auto', quota: quota({}, {}) })

    expect(preview).toHaveBeenCalledOnce()
  })

  it('moves the remaining items to the other channel when auto hits a cap', async () => {
    const api = stubApi({
      create: async ({ channel }) => {
        if (channel === 'apple_account') throw apiError(429, QUOTA_MESSAGE)
      },
    })
    const items = buildAliasBatch(['apple_account', 'apple_account'], 'X', newId)

    const result = await runAliasBatch({
      api, accountId: 'acct-1', items, choice: 'auto', quota: quota({}, {}),
    })

    expect(result.items.map((item) => item.channel)).toEqual(['icloud_web', 'icloud_web'])
    expect(result.items.every((item) => item.status === 'success')).toBe(true)
    // One failed Apple attempt, then everything routes straight to cookies.
    expect(api.calls.filter((call) => call.channel === 'apple_account')).toHaveLength(1)
  })

  it('skips instead of rerouting when the channel was chosen explicitly', async () => {
    const api = stubApi({
      create: async () => { throw apiError(429, QUOTA_MESSAGE) },
    })
    const items = buildAliasBatch(['apple_account', 'apple_account'], 'X', newId)

    const result = await runAliasBatch({
      api, accountId: 'acct-1', items, choice: 'apple_account', quota: quota({}, {}),
    })

    expect(result.items.map((item) => item.status)).toEqual(['skipped', 'skipped'])
    expect(api.calls).toHaveLength(1)
  })

  it('stops at the next boundary when the dialog is closed', async () => {
    const api = stubApi()
    const items = buildAliasBatch(['apple_account', 'apple_account', 'apple_account'], 'X', newId)
    let done = 0

    const result = await runAliasBatch({
      api,
      accountId: 'acct-1',
      items,
      choice: 'apple_account',
      quota: quota({}, {}),
      shouldStop: () => done >= 1,
      onItems: (current) => { done = current.filter((item) => item.status === 'success').length },
    })

    expect(result.created).toHaveLength(1)
    expect(result.items.map((item) => item.status)).toEqual(['success', 'skipped', 'skipped'])
  })
})
