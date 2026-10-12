import { describe, expect, it } from 'vitest'
import type { ICloudAliasChannel, ICloudAliasQuotaChannel } from '../../../shared/api'
import { batchSummary, buildAliasBatch } from './icloud-alias-batch'
import { runAliasBatch, type AliasBatchApi } from './icloud-alias-batch-run'

let counter = 0
const newId = () => `run-item-${++counter}`

function quota(apple: number, web: number): ICloudAliasQuotaChannel[] {
  return [
    { channel: 'apple_account', available: true, limit: 20, used: 20 - apple, remaining: apple, resetsAt: '' },
    { channel: 'icloud_web', available: true, limit: 5, used: 5 - web, remaining: web, resetsAt: '' },
  ]
}

function failure(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status })
}

type Call = { kind: 'preview' | 'create'; channel?: ICloudAliasChannel }

/**
 * A server that answers like the real one: each create spends one slot of
 * `left` and reports what remains, a channel with nothing left answers 429, and
 * `fail` can turn any call into an error first.
 */
function server(options: {
  left?: Partial<Record<ICloudAliasChannel, number>>
  fail?: (call: Call) => Error | undefined
} = {}): { api: AliasBatchApi; calls: Call[] } {
  const calls: Call[] = []
  const left: Record<ICloudAliasChannel, number> = { apple_account: 20, icloud_web: 5, ...options.left }
  let previews = 0
  return {
    calls,
    api: {
      previewICloudAlias: async () => {
        const call: Call = { kind: 'preview' }
        calls.push(call)
        const error = options.fail?.(call)
        if (error) throw error
        previews += 1
        return { email: `preview${previews}@icloud.com`, previewId: `preview-${previews}` }
      },
      createICloudAlias: async (input) => {
        const call: Call = { kind: 'create', channel: input.channel }
        calls.push(call)
        const error = options.fail?.(call)
        if (error) throw error
        if (left[input.channel] <= 0) throw failure(429, '本小时创建额度已用完')
        left[input.channel] -= 1
        return {
          alias: {
            email: input.email || `apple${calls.length}@icloud.com`,
            label: input.label,
            createdAt: '2026-10-10T00:00:00.000Z',
          },
          channel: input.channel,
          remaining: left[input.channel],
        }
      },
    },
  }
}

const EXPIRED = 'Apple Account 管理态已失效，请重新登录。'

describe('runAliasBatch: a create that never answers', () => {
  it('is unknown rather than failed, and keeps the address it reserved', async () => {
    const { api } = server({
      fail: (call) => (call.kind === 'create' ? failure(408, '连接超时，请检查网络后重试。') : undefined),
    })
    const items = buildAliasBatch(['icloud_web'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'icloud_web', quota: quota(20, 5) })

    expect(result.items[0]).toMatchObject({
      status: 'unknown', email: 'preview1@icloud.com', previewId: 'preview-1',
    })
    expect(batchSummary(result.items)).toMatchObject({ success: 0, failed: 0, unknown: 1 })
  })

  it('reads a Worker timeout on Apple the same way', async () => {
    const { api } = server({ fail: () => failure(504, '连接 iCloud 超时。') })
    const items = buildAliasBatch(['apple_account'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'apple_account', quota: quota(20, 5) })

    expect(result.items[0].status).toBe('unknown')
  })

  it('still fails a preview that timed out, since nothing was created yet', async () => {
    const { api, calls } = server({
      fail: (call) => (call.kind === 'preview' ? failure(408, '连接超时，请检查网络后重试。') : undefined),
    })
    const items = buildAliasBatch(['icloud_web'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'icloud_web', quota: quota(20, 5) })

    expect(result.items[0].status).toBe('error')
    expect(calls.filter((call) => call.kind === 'create')).toHaveLength(0)
  })
})

describe('runAliasBatch: a credential rejection', () => {
  it('stops using the channel and moves the rest of an auto batch', async () => {
    const { api, calls } = server({
      fail: (call) => (call.channel === 'apple_account' ? failure(422, EXPIRED) : undefined),
    })
    const items = buildAliasBatch(['apple_account', 'apple_account', 'apple_account'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'auto', quota: quota(20, 5) })

    // One rejection is enough to know; the item that hit it shows why.
    expect(calls.filter((call) => call.channel === 'apple_account')).toHaveLength(1)
    expect(result.items.map((item) => [item.status, item.channel])).toEqual([
      ['error', 'apple_account'], ['success', 'icloud_web'], ['success', 'icloud_web'],
    ])
    expect(result.items[0].error).toBe(EXPIRED)
    expect(result.unusable).toEqual(['apple_account'])
  })

  it('skips the rest of an explicitly chosen channel and says why', async () => {
    const { api, calls } = server({ fail: () => failure(422, EXPIRED) })
    const items = buildAliasBatch(['apple_account', 'apple_account', 'apple_account'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'apple_account', quota: quota(20, 5) })

    expect(calls).toHaveLength(1)
    expect(result.items.map((item) => item.status)).toEqual(['error', 'skipped', 'skipped'])
    expect(result.items[1].error).toBe('这个通道的登录态已失效，未再尝试。')
  })

  it('counts a cookie jar Apple rejects while previewing', async () => {
    const { api, calls } = server({
      fail: (call) => (call.kind === 'preview' ? failure(422, 'iCloud Cookie 已失效') : undefined),
    })
    const items = buildAliasBatch(['icloud_web', 'icloud_web'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'icloud_web', quota: quota(20, 5) })

    expect(calls).toHaveLength(1)
    expect(result.items.map((item) => item.status)).toEqual(['error', 'skipped'])
    expect(result.unusable).toEqual(['icloud_web'])
  })
})

describe('runAliasBatch: budgets', () => {
  it('reports only the channels the server answered for', async () => {
    // The cookie channel was never touched, so its snapshot (maybe the 20/5
    // fallback) must not be written back over a quota read that landed mid-run.
    const { api } = server({ left: { apple_account: 7 } })
    const items = buildAliasBatch(['apple_account', 'apple_account'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'apple_account', quota: quota(20, 5) })

    expect(result.remaining).toEqual({ apple_account: 5 })
  })

  it('reports a channel a 429 closed as spent', async () => {
    const { api } = server({ left: { apple_account: 0 } })
    const items = buildAliasBatch(['apple_account'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'apple_account', quota: quota(20, 5) })

    expect(result.remaining).toEqual({ apple_account: 0 })
  })

  it('does not preview for a channel its own successes used up', async () => {
    // Apple turns out to be spent at the first create. The rerouted items then
    // spend the cookie budget, so the item planned on cookies has nowhere to go
    // and must not burn a preview and a jar write on a guaranteed 429.
    const { api, calls } = server({ left: { apple_account: 0, icloud_web: 2 } })
    const items = buildAliasBatch(['apple_account', 'apple_account', 'icloud_web'], '', newId)

    const result = await runAliasBatch({ api, accountId: 'a', items, choice: 'auto', quota: quota(2, 2) })

    expect(result.items.map((item) => item.status)).toEqual(['success', 'success', 'skipped'])
    expect(calls.filter((call) => call.kind === 'preview')).toHaveLength(2)
    expect(calls.filter((call) => call.kind === 'create')).toHaveLength(3)
  })
})
