import { expect, test } from '@playwright/test'
import { mockICloud } from './icloud-fixtures'

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
