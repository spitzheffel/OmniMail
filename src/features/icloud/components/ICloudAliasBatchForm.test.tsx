import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ICloudAccount } from '../../../shared/api'
import { ensureEnglishTranslations, translate } from '../../../shared/i18n'
import type { AliasBatchItem } from '../model/icloud-alias-batch'
import { ICloudAliasBatchForm } from './ICloudAliasBatchForm'
import { ICloudAliasBatchProgress } from './ICloudAliasBatchProgress'

function account(overrides: Partial<ICloudAccount>): ICloudAccount {
  return {
    id: 'icloud-account-1',
    name: 'Personal',
    realEmail: 'owner@icloud.com',
    icloudEmail: 'owner@icloud.com',
    host: 'icloud.com',
    status: 'active',
    aliasTotal: 0,
    aliasActive: 0,
    lastValidated: '',
    lastError: '',
    createdAt: '2026-09-17T10:00:00.000Z',
    hasCookies: false,
    hasAppPassword: false,
    hasAppleAccount: false,
    appleAccountStatus: 'none',
    appleAccountExpiresAt: '',
    ...overrides,
  }
}

function render(overrides: Partial<ICloudAccount>): string {
  return renderToStaticMarkup(
    <ICloudAliasBatchForm account={account(overrides)} close={() => undefined}
      onCreated={async () => undefined} />,
  )
}

describe('ICloudAliasBatchForm', () => {
  it('offers a quantity field and no preview cards on the Apple Account channel', () => {
    const html = render({ hasAppleAccount: true })

    expect(html).toContain('type="number"')
    expect(html).toContain('创建数量')
    expect(html).not.toContain('icloud-alias-preview')
    expect(html).not.toContain('换一个')
  })

  it('keeps the preview cards on the legacy cookie channel', () => {
    const html = render({ hasCookies: true })

    expect(html).toContain('icloud-alias-drafts')
    expect(html).toContain('icloud-alias-preview')
    expect(html).toContain('增加邮箱')
    expect(html).not.toContain('创建数量')
  })

  it('lets an account with both login states pick a channel', () => {
    const html = render({ hasAppleAccount: true, hasCookies: true })

    expect(html).toContain('icloud-alias-channel-switch')
    expect(html).toContain('Apple Account')
    expect(html).toContain('iCloud Cookie')
    // Auto is the default, so the quantity form leads.
    expect(html).toContain('创建数量')
  })

  it('shows the remaining hourly budget for every usable channel', () => {
    const html = render({ hasAppleAccount: true, hasCookies: true })

    expect(html).toContain('新接口本小时剩余 20/20')
    expect(html).toContain('旧接口本小时剩余 5/5')
    // Nothing is pre-selected beyond a single alias.
    expect(html).toContain('创建 1 个')
  })

  it('drops an expired Apple session from the fallback channels', () => {
    // The initial render runs on fallbackChannels; advertising 20 Apple slots
    // for a session Apple has already rejected sizes the batch to 20 failures.
    const html = render({
      hasAppleAccount: true, appleAccountStatus: 'expired', hasCookies: true,
    })

    expect(html).not.toContain('新接口本小时剩余')
    expect(html).toContain('旧接口本小时剩余 5/5')
    expect(html).toContain('创建项目 1/5')
  })

  it('names the expired session rather than blaming the hourly budget', () => {
    // No usable channel at all, so there is no correct window: reporting a
    // spent budget sends the user off to wait for a reset that changes nothing.
    const html = render({ hasAppleAccount: true, appleAccountStatus: 'expired' })

    expect(html).toContain('Apple Account 登录态已过期，请重新登录。')
    expect(html).not.toContain('本小时额度已用完')
  })

  it('asks for the cookies to be replaced when the jar is the only channel and Apple rejected it', () => {
    const html = render({ hasCookies: true, status: 'error' })

    expect(html).toContain('iCloud Cookie 已失效，请在账号设置中更新。')
    expect(html).not.toContain('本小时额度已用完')
  })

  it('asks for credentials rather than a new sign-in when there are none', () => {
    const html = render({})

    expect(html).toContain('配置 Cookie 或 Apple Account 后可创建隐藏邮箱')
    expect(html).not.toContain('Apple Account 登录态已过期')
  })

  it('keeps the budget wording while one channel is still usable', () => {
    const html = render({ hasCookies: true, hasAppleAccount: true, appleAccountStatus: 'expired' })

    expect(html).not.toContain('Apple Account 登录态已过期，请重新登录。')
  })

  it('derives the ceiling from the usable channels rather than a fixed cap', () => {
    expect(render({ hasAppleAccount: true, hasCookies: true })).toContain('创建项目 1/25')
    expect(render({ hasAppleAccount: true })).toContain('创建项目 1/20')
    expect(render({ hasCookies: true })).not.toContain('创建项目 1/25')
    // The old dialog advertised a per-batch maximum; the budget is hourly now.
    expect(render({ hasAppleAccount: true, hasCookies: true })).not.toContain('一次最多')
  })

  it('words the idle summary in English as a plan, not as a run in progress', async () => {
    await ensureEnglishTranslations()
    const idle = translate('创建项目 {count}/{max}', { count: 1, max: 5 }, 'en-US')

    expect(idle).not.toMatch(/creating/i)
    expect(idle).not.toBe(translate('正在创建 {completed}/{total}', { completed: 1, total: 5 }, 'en-US'))
  })

  it('says what a blank base label becomes instead of crediting Apple', () => {
    // Both server create paths fill in "OmniMail <UTC time>" themselves.
    const html = render({ hasAppleAccount: true })

    expect(html).toContain('留空时标签为 OmniMail 加创建时间（UTC）。')
    expect(html).not.toContain('由 Apple 自动命名')
  })

  it('keeps one announcer mounted before there is anything to announce', () => {
    const html = render({ hasAppleAccount: true })

    expect(html.match(/role="status"/g)).toHaveLength(1)
    expect(html).toMatch(/<p class="sr-only" role="status"><\/p>/)
  })
})

describe('ICloudAliasBatchProgress', () => {
  function item(status: AliasBatchItem['status'], error = ''): AliasBatchItem {
    return { id: `item-${status}`, label: '', channel: 'apple_account', email: '', previewId: '', status, error }
  }

  it('settles rows without a live region or an alert apiece', () => {
    // A channel running dry skips every remaining row in one commit; a region
    // per row made that a burst of up to nineteen assertive announcements.
    const html = renderToStaticMarkup(<ICloudAliasBatchProgress complete items={[
      item('error', 'iCloud 暂时无法创建这个地址。'), item('skipped', '本小时创建额度已用完'),
    ]} />)

    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('aria-live')
    expect(html).not.toContain('role="status"')
  })

  it('tells when the budget comes back once items were left over', () => {
    const skipped = [item('skipped', '本小时创建额度已用完')]

    expect(renderToStaticMarkup(<ICloudAliasBatchProgress complete items={skipped} resetTime="10:00" />))
      .toContain('额度将于 10:00 恢复。')
    // Nothing left over, nothing to wait for.
    const created = [{ ...item('success'), email: 'made@icloud.com' }]
    expect(renderToStaticMarkup(<ICloudAliasBatchProgress complete items={created} resetTime="10:00" />))
      .not.toContain('恢复')
  })

  it('stops waiting for Apple once a row has ended without an address', () => {
    const html = renderToStaticMarkup(<ICloudAliasBatchProgress complete={false} items={[
      item('error', 'iCloud 暂时无法创建这个地址。'), item('skipped', '已取消'), item('unknown', '请求超时'),
    ]} />)

    expect(html).not.toContain('等待 Apple 生成地址')
  })
})
