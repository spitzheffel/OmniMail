import { expect, test, type Page } from '@playwright/test'
import { mockICloud } from './icloud-fixtures'

/** How long a test waits to show that a request was *not* made. */
const QUIET_WINDOW_MS = 600

async function openCreateDialog(page: Page) {
  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  return page.getByRole('dialog', { name: '创建隐藏邮箱' })
}

test('a spent hour unlocks when the window rolls over, and says when', async ({ page }) => {
  const state = await mockICloud(page, { quota: { apple: null, web: 0 }, quotaResetsInMs: 1_500 })
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await expect(dialog.getByText(/^本小时额度已用完，\d{2}:\d{2} 恢复$/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: /创建 \d+ 个/ })).toBeDisabled()

  // No reopening: the dialog reads the quota again once the window has passed.
  state.resetQuotaWindow()
  await expect(dialog.getByText('创建项目 1/5')).toBeVisible({ timeout: 10_000 })
  await expect(dialog.getByRole('button', { name: '创建 1 个' })).toBeEnabled()
})

test('cards added against the guessed budget are cut back to the real one', async ({ page }) => {
  // The quota read is held, so cards get added against the fallback of 5.
  const state = await mockICloud(page, { quota: { apple: null, web: 2 } })
  state.holdQuota()
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '加到上限' }).click()
  await expect(dialog.locator('.icloud-alias-preview')).toHaveCount(5)

  state.releaseQuota()
  await expect(dialog.locator('.icloud-alias-preview')).toHaveCount(2)
  await expect(dialog.getByText('创建项目 2/2')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '创建 2 个' })).toBeVisible()
})

test("a closed dialog's queued previews neither run nor race the next dialog's", async ({ page }) => {
  const state = await mockICloud(page, { previewDelayMs: 800 })
  await page.goto('/icloud')

  let dialog = await openCreateDialog(page)
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  // Four previews queue up behind each other; close while the first is out.
  await dialog.getByRole('button', { name: '加到上限' }).click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  dialog = await openCreateDialog(page)
  await expect(dialog.locator('.icloud-alias-preview').first())
    .toContainText('@icloud.com', { timeout: 10_000 })
  await page.waitForTimeout(QUIET_WINDOW_MS)
  // Every preview rewrites the account's cookie jar, so they must take turns
  // even across dialogs; the three still queued at close never go out.
  expect(state.maxConcurrentPreviews()).toBe(1)
  expect(state.previewedEmails.length).toBeLessThanOrEqual(4)
})

test('removing the first card hands the re-entry preview to a card that exists', async ({ page }) => {
  const state = await mockICloud(page, { hasAppleAccount: true, quota: { apple: 20, web: 5 } })
  await page.goto('/icloud')

  const dialog = await openCreateDialog(page)
  await dialog.getByRole('button', { name: 'iCloud Cookie' }).click()
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '增加邮箱' }).click()
  await expect(dialog.getByText('github-1@icloud.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '移除第 1 个隐藏邮箱' }).click()
  await expect(dialog.locator('.icloud-alias-preview')).toHaveCount(1)

  // Re-entering the channel previews its first card, which must be one that
  // is still on screen rather than the removed one.
  await dialog.getByRole('button', { name: 'Apple Account' }).click()
  await dialog.getByRole('button', { name: 'iCloud Cookie' }).click()
  await expect(dialog.locator('.icloud-alias-preview')).toContainText('github-2@icloud.com')
  expect(state.previewedEmails).toEqual([
    'preview-one@icloud.com', 'github-1@icloud.com', 'github-2@icloud.com',
  ])
})
