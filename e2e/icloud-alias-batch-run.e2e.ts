import { expect, test, type Page } from '@playwright/test'
import { mockICloud } from './icloud-fixtures'

/** How long a test waits to show that a request was *not* made. */
const QUIET_WINDOW_MS = 600

async function openCreateDialog(page: Page) {
  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  return page.getByRole('dialog', { name: '创建隐藏邮箱' })
}

test('a create whose answer never came is unknown, not failed, and still re-syncs', async ({ page }) => {
  // Apple committed the alias but the Worker timed out waiting to say so.
  const state = await mockICloud(page, {
    hasAppleAccount: true, quota: { apple: 20, web: null }, timeoutCreateAt: 1,
  })
  await page.goto('/icloud')
  await expect(page.getByText('Your receipt')).toBeVisible()
  const listed = state.aliasListAccounts.length

  const dialog = await openCreateDialog(page)
  await dialog.getByRole('button', { name: '创建 1 个' }).click()

  await expect(dialog.getByText('成功 0 个，失败 0 个。')).toBeVisible()
  await expect(dialog.locator('.icloud-alias-preview.is-unknown')).toHaveCount(1)
  await expect(dialog.getByText('结果未知', { exact: true })).toBeVisible()
  await expect(dialog.getByText('创建失败', { exact: true })).toHaveCount(0)
  // Nothing was reported created, yet the list is read again: that is the only
  // way the user learns the alias exists.
  await expect.poll(() => state.aliasListAccounts.length).toBeGreaterThan(listed)
  await dialog.getByRole('button', { name: '完成' }).click()
  await page.getByRole('button', { name: /当前 iCloud.*Personal/ }).click()
  await expect(page.getByRole('dialog', { name: '选择查看范围' })).toContainText('apple-1@icloud.com')
})

test('a rejected Apple session stops the run using it and leaves the next plan', async ({ page }) => {
  const state = await mockICloud(page, {
    hasAppleAccount: true, quota: { apple: 20, web: 5 }, rejectAppleCreates: true,
  })
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await dialog.getByRole('spinbutton', { name: '创建数量' }).fill('3')
  await dialog.getByRole('button', { name: '创建 3 个' }).click()

  // One rejection is enough: the rest move to the cookie channel instead of
  // each repeating it, and the item that hit it says why.
  await expect(dialog.getByText('成功 2 个，失败 1 个。')).toBeVisible()
  await expect(dialog.locator('.icloud-alias-preview.is-error'))
    .toContainText('Apple Account 管理态已失效')
  expect(state.createAttemptChannels).toEqual(['apple_account', 'icloud_web', 'icloud_web'])

  // 继续创建 plans without the dead session: no channel choice is left, and
  // the cookie channel's preview cards take over.
  await dialog.getByRole('button', { name: '继续创建' }).click()
  await expect(dialog.getByRole('group', { name: '创建通道' })).toHaveCount(0)
  await expect(dialog.getByText(/新接口本小时剩余/)).toHaveCount(0)
  await expect(dialog.locator('.icloud-alias-preview').first()).toContainText('@icloud.com')
  await dialog.getByRole('button', { name: '创建 1 个' }).click()
  await expect(dialog.getByText('成功 1 个，失败 0 个。')).toBeVisible()
  expect(state.createAttemptChannels.filter((channel) => channel === 'apple_account')).toHaveLength(1)
})

test('a cookie jar rejected mid-run stays out of the next plan', async ({ page }) => {
  // The quota endpoint only knows a jar is stored, so it keeps listing the
  // channel; the dialog has to remember what the run found out.
  const state = await mockICloud(page, { quota: { apple: null, web: 5 }, rejectWebCreates: true })
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '增加邮箱' }).click()
  await expect(dialog.getByText('github-1@icloud.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '创建 2 个' }).click()

  await expect(dialog.getByText('成功 0 个，失败 1 个。')).toBeVisible()
  await expect(dialog.getByText('这个通道的登录态已失效，未再尝试。')).toBeVisible()
  expect(state.createAttempts()).toBe(1)
  await dialog.getByRole('button', { name: '继续创建' }).click()
  // Not "this hour is used up": no reset will bring a rejected jar back.
  await expect(dialog.getByText('登录态已失效，请在账号设置中更新后再创建。')).toBeVisible()
  await expect(dialog.getByRole('button', { name: /创建 \d+ 个/ })).toBeDisabled()
})

test('reads channel availability again after a run', async ({ page }) => {
  // The session expires server-side while the run uses it; nothing in the
  // run's own answers says so.
  const state = await mockICloud(page, { hasAppleAccount: true, quota: { apple: 20, web: 5 } })
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await dialog.getByRole('button', { name: 'Apple Account' }).click()
  state.holdCreates()
  await dialog.getByRole('button', { name: '创建 1 个' }).click()
  await expect.poll(() => state.createAttempts()).toBe(1)
  state.expireAppleSession()
  state.releaseCreates()
  await expect(dialog.getByText('成功 1 个，失败 0 个。')).toBeVisible()

  await dialog.getByRole('button', { name: '继续创建' }).click()
  await expect(dialog.getByRole('group', { name: '创建通道' })).toHaveCount(0)
  await expect(dialog.getByText(/新接口本小时剩余/)).toHaveCount(0)
  await expect(dialog.getByText('旧接口本小时剩余 5/5')).toBeVisible()
})

test('stopping mid-run starts no further create inside the close animation', async ({ page }) => {
  const state = await mockICloud(page, { hasAppleAccount: true, quota: { apple: 20, web: null } })
  await page.clock.install()
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await dialog.getByRole('spinbutton', { name: '创建数量' }).fill('3')
  state.holdCreates()
  await dialog.getByRole('button', { name: '创建 3 个' }).click()
  await expect.poll(() => state.createAttempts()).toBe(1)

  // Freeze the page's timers so the 210 ms exit animation cannot finish: the
  // first create then always settles inside it, while the form is still there.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000))
  await dialog.getByRole('button', { name: '停止并关闭' }).click()
  state.releaseCreates()
  await page.waitForTimeout(QUIET_WINDOW_MS)
  expect(state.createAttempts()).toBe(1)

  await page.clock.resume()
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(QUIET_WINDOW_MS)
  expect(state.createAttempts()).toBe(1)
})

test('a run closed mid-flight leaves the account selected afterwards alone', async ({ page }) => {
  const state = await mockICloud(page, {
    hasAppleAccount: true, quota: { apple: 20, web: null }, secondAccount: true,
  })
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await dialog.getByRole('spinbutton', { name: '创建数量' }).fill('2')
  state.holdCreates()
  await dialog.getByRole('button', { name: '创建 2 个' }).click()
  await expect.poll(() => state.createAttempts()).toBe(1)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await page.getByRole('button', { name: /当前 iCloud.*Personal/ }).click()
  await page.getByRole('dialog', { name: '选择查看范围' }).getByRole('button', { name: /^Second/ }).click()
  await expect(page.getByRole('button', { name: /当前 iCloud.*Second/ })).toBeVisible()
  await expect.poll(() => state.aliasListAccounts.at(-1)).toBe('icloud-2')
  const listed = state.aliasListAccounts.length

  // The first create lands only now. Syncing it would read the old account's
  // aliases into the view of the one on screen.
  state.releaseCreates()
  await expect.poll(() => state.createdChannels.length).toBe(1)
  await page.waitForTimeout(QUIET_WINDOW_MS)
  expect(state.aliasListAccounts.slice(listed)).toEqual([])
  await page.getByRole('button', { name: /当前 iCloud.*Second/ }).click()
  const scope = page.getByRole('dialog', { name: '选择查看范围' })
  await expect(scope).toContainText('second-alias@icloud.com')
  await expect(scope).not.toContainText('shop@icloud.com')
})

test('announces the outcome once and keeps focus inside the dialog', async ({ page }) => {
  const state = await mockICloud(page, {
    hasAppleAccount: true, quota: { apple: 20, web: null }, failCreateAt: 2,
  })
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await dialog.getByRole('spinbutton', { name: '创建数量' }).fill('2')
  state.holdCreates()
  await dialog.getByRole('button', { name: '创建 2 个' }).click()
  // The announcer is already there, empty, before there is anything to say;
  // the submit button just went disabled, so focus moved to the progress bar.
  const announcer = dialog.getByRole('status')
  await expect(announcer).toHaveText('')
  await expect(dialog.locator('progress')).toBeFocused()

  state.releaseCreates()
  await expect(announcer).toHaveText('创建已结束：1 个成功，1 个失败。')
  await expect(dialog.getByRole('button', { name: '完成' })).toBeFocused()
  // The rows themselves stay quiet: no live region, no alert apiece.
  await expect(dialog.locator('.icloud-alias-drafts [aria-live], .icloud-alias-drafts [role="alert"]'))
    .toHaveCount(0)
})
