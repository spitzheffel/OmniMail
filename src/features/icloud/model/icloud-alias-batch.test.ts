import { describe, expect, it, vi } from 'vitest'
import type { ICloudAliasChannel, ICloudAliasQuotaChannel } from '../../../shared/api'
import {
  accountChannelAvailability,
  aliasBatchLabel,
  aliasItemHeadline,
  availableChannels,
  batchSummary,
  buildAliasBatch,
  draftsAfterRun,
  exhaustedResetAt,
  hasUsableAliasChannel,
  newAliasDraft,
  planAliasBatch,
  quotaRefreshDelay,
  remainingFor,
  shouldResyncAfterRun,
  type AliasBatchItem,
  type AliasChannelAccount,
  type AliasDraft,
  type AliasItemStatus,
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

  it('drops a cookie jar Apple has rejected, as the server does', () => {
    // The quota endpoint stops offering it too; planning onto it would only
    // replay the same credential failure once per item.
    expect(accountChannelAvailability(channels({ hasCookies: true, status: 'active' })).icloud_web).toBe(true)
    expect(accountChannelAvailability(channels({ hasCookies: true, status: 'error' })).icloud_web).toBe(false)
    expect(hasUsableAliasChannel(channels({ hasCookies: true, status: 'error' }))).toBe(false)
    expect(hasUsableAliasChannel(channels({ hasCookies: true, status: 'error', hasAppleAccount: true }))).toBe(true)
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
      { status: 'unknown', channel: 'apple_account' },
    ] as AliasBatchItem[]
    expect(batchSummary(items)).toEqual({ success: 2, failed: 1, skipped: 1, unknown: 1, apple: 1, web: 1 })
  })
})

describe('aliasItemHeadline', () => {
  it('waits for Apple only while the item can still produce an address', () => {
    expect(aliasItemHeadline({ email: '', label: '', status: 'pending' })).toBe('等待 Apple 生成地址')
    expect(aliasItemHeadline({ email: '', label: '', status: 'running' })).toBe('等待 Apple 生成地址')
    // Ended without an address: the badge says failed or skipped, and for a
    // cookie item whose preview failed Apple was never the one being waited on.
    expect(aliasItemHeadline({ email: '', label: '', status: 'error' })).toBe('未创建')
    expect(aliasItemHeadline({ email: '', label: '', status: 'skipped' })).toBe('未创建')
    expect(aliasItemHeadline({ email: '', label: '', status: 'unknown' })).toBe('地址未知')
  })

  it('leads with the address, then the label', () => {
    expect(aliasItemHeadline({ email: 'a@icloud.com', label: 'Shop', status: 'error' })).toBe('a@icloud.com')
    expect(aliasItemHeadline({ email: '', label: 'Shop', status: 'skipped' })).toBe('Shop')
  })
})

describe('draftsAfterRun', () => {
  const card = (id: string): AliasDraft => ({
    ...newAliasDraft(id), label: id.toUpperCase(), email: `${id}@icloud.com`, previewId: `p-${id}`,
  })
  const outcome = (id: string, status: AliasItemStatus, error = ''): AliasBatchItem => ({
    id, label: '', channel: 'icloud_web', email: `${id}@icloud.com`, previewId: `p-${id}`, status, error,
  })

  it('drops created cards, and the reservation Apple refused while showing why', () => {
    const next = draftsAfterRun([card('a'), card('b'), card('c')], [
      outcome('a', 'success'),
      outcome('b', 'error', 'iCloud 无法保留隐藏邮箱。'),
      outcome('c', 'skipped', '已取消'),
    ])

    expect(next.map(({ id, label, email, previewId, error }) => ({ id, label, email, previewId, error }))).toEqual([
      // A fresh address next time instead of the one Apple just turned down.
      { id: 'b', label: 'B', email: '', previewId: '', error: 'iCloud 无法保留隐藏邮箱。' },
      { id: 'c', label: 'C', email: 'c@icloud.com', previewId: 'p-c', error: '' },
    ])
  })

  it('keeps the reservation of a card whose result never came', () => {
    // The run may have reserved the address itself; re-sending that one cannot
    // make a second alias if the first went through.
    const next = draftsAfterRun([newAliasDraft('d')], [outcome('d', 'unknown', '请求超时')])

    expect(next[0]).toMatchObject({ email: 'd@icloud.com', previewId: 'p-d', error: '请求超时' })
  })
})

describe('shouldResyncAfterRun', () => {
  const run = (status: AliasItemStatus, created: unknown[] = []) => ({
    items: [{ status } as AliasBatchItem], created,
  })

  it('re-syncs after anything that may have changed the account', () => {
    expect(shouldResyncAfterRun(run('success', [{}]))).toBe(true)
    // Nothing to show, but the alias may exist, or the session was marked expired.
    expect(shouldResyncAfterRun(run('unknown'))).toBe(true)
    expect(shouldResyncAfterRun(run('error'))).toBe(true)
    expect(shouldResyncAfterRun(run('skipped'))).toBe(false)
  })
})

describe('quota reset timing', () => {
  const resetsAt = '2026-10-10T10:00:00.000Z'
  const now = Date.parse('2026-10-10T09:59:30.000Z')

  it('re-reads just after a window something was spent from rolls over', () => {
    expect(quotaRefreshDelay(quota({ remaining: 0, resetsAt }, { resetsAt }), now)).toBe(31_000)
    expect(quotaRefreshDelay(quota({ resetsAt }, { remaining: 4, resetsAt }), now)).toBe(31_000)
  })

  it('leaves an untouched window, and the resetless fallback, alone', () => {
    expect(quotaRefreshDelay(quota({ resetsAt }, { resetsAt }), now)).toBeUndefined()
    expect(quotaRefreshDelay(quota({ remaining: 0 }, {}), now)).toBeUndefined()
  })

  it('backs off instead of spinning when the server still reports a past reset', () => {
    expect(quotaRefreshDelay(quota({ remaining: 0, resetsAt }, {}), Date.parse(resetsAt) + 5_000))
      .toBe(15_000)
  })

  it('never schedules past what setTimeout can hold', () => {
    expect(quotaRefreshDelay(quota({ remaining: 0, resetsAt: '2099-01-01T00:00:00.000Z' }, {}), now))
      .toBe(3_601_000)
  })

  it('names the reset only for a usable channel with nothing left', () => {
    const later = '2026-10-10T11:00:00.000Z'
    expect(exhaustedResetAt(quota({ remaining: 0, resetsAt }, { resetsAt: later })))
      .toBe(Date.parse(resetsAt))
    expect(exhaustedResetAt(quota({ remaining: 3, resetsAt }, { resetsAt }))).toBeUndefined()
    expect(exhaustedResetAt(quota({ available: false, remaining: 0, resetsAt }, { resetsAt })))
      .toBeUndefined()
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
