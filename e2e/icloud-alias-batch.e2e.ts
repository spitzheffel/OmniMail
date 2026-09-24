import { expect, test } from '@playwright/test'
import { mockICloud } from './icloud-fixtures'

/** How long a test waits to show that a request was *not* made. */
const QUIET_WINDOW_MS = 600

test('switching channels mid-preview does not strand the draft cards', async ({ page }) => {
  const state = await mockICloud(page, {
    hasAppleAccount: true,
    quota: { apple: 20, web: 5 },
    previewDelayMs: 800,
  })
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await dialog.getByRole('button', { name: 'iCloud Cookie' }).click()
  // Entering the channel previews the first card, and '加到上限' is disabled for
  // the duration. Clicking into that window lands on a disabled button and does
  // nothing, so wait for the address itself rather than for the spinner to go.
  await expect(dialog.locator('.icloud-alias-preview').first()).toContainText('@')
  await dialog.getByRole('button', { name: '加到上限' }).click()
  await expect(dialog.locator('.icloud-alias-preview')).toHaveCount(5)

  // Leave and re-enter the cookie channel while the previews are still in
  // flight: every pending request is invalidated mid-flight.
  await dialog.getByRole('button', { name: 'Apple Account' }).click()
  await dialog.getByRole('button', { name: 'iCloud Cookie' }).click()

  // No card may be left spinning: a stuck `loading` disables both the create
  // button and the reroll button, which used to dead-end the dialog.
  await expect(dialog.getByText('正在生成候选地址…')).toHaveCount(0, { timeout: 15_000 })
  await expect(dialog.getByRole('button', { name: /创建 \d+ 个/ })).toBeEnabled()
  await expect(dialog.getByRole('button', { name: /换一个地址/ }).first()).toBeEnabled()

  // And the dialog is still usable end to end.
  await dialog.getByRole('button', { name: /创建 \d+ 个/ }).click()
  await expect(dialog.getByText(/成功 \d+ 个，失败 0 个。/)).toBeVisible()
  expect(state.createdChannels.every((channel) => channel === 'icloud_web')).toBe(true)
})

test('a spent hour keeps the drafted address and disables the reroll', async ({ page }) => {
  // Two ways this used to go wrong: the quota response landing after the first
  // preview invalidated it and left a blank card, and the reroll button stayed
  // clickable so the obvious recovery was a guaranteed 429.
  const state = await mockICloud(page, { quota: { apple: null, web: 0 } })
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await expect(dialog.getByText('本小时额度已用完')).toBeVisible()

  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '为隐藏邮箱 1 换一个地址' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: /创建 \d+ 个/ })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '增加邮箱' })).toBeDisabled()
  // Nothing may follow the mount preview. Absence needs a quiet window: checked
  // straight away, a preview fired a few hundred milliseconds later went unseen.
  await page.waitForTimeout(QUIET_WINDOW_MS)
  expect(state.previewedEmails).toEqual(['preview-one@icloud.com'])
})

test('continuing after the last slot is spent does not preview a new card', async ({ page }) => {
  // With every card created, prune reseeds one fresh card. The hour is spent by
  // then, so previewing it could only come back as a cap error.
  const state = await mockICloud(page, { quota: { apple: null, web: 1 } })
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: /创建 \d+ 个/ }).click()
  await expect(dialog.getByText(/成功 1 个，失败 0 个。/)).toBeVisible()

  await dialog.getByRole('button', { name: '继续创建' }).click()
  await expect(dialog.getByText('本小时额度已用完')).toBeVisible()
  await page.waitForTimeout(QUIET_WINDOW_MS)
  expect(state.previewedEmails).toEqual(['preview-one@icloud.com'])
})
