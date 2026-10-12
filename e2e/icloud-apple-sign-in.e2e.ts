import { expect, test, type Page } from '@playwright/test'
import { mockICloud } from './icloud-fixtures'
import { watchTransientState } from './transient-state'

const PHONES = [{ id: 1, number: '+86 ••• •••• ••12' }, { id: 2, number: '+1 (•••) •••-••34' }]

async function openAddDialog(page: Page) {
  await page.getByRole('button', { name: '添加 iCloud 账号' }).click()
  const dialog = page.getByRole('dialog', { name: '添加 iCloud 账号' })
  await dialog.getByRole('textbox', { name: '账号名称' }).fill('Apple only')
  await dialog.getByRole('textbox', { name: 'Apple ID', exact: true }).fill('owner@icloud.com')
  await dialog.getByLabel('Apple ID 密码').fill('secret')
  await dialog.getByRole('button', { name: '验证并添加' }).click()
  return dialog
}

test('starts the sign-in over when its challenge can no longer be answered', async ({ page }) => {
  // An expired or exhausted challenge used to leave the dialog re-sending a
  // dead challenge id, with the password fields gone and Cancel the only way out.
  const state = await mockICloud(page, { appleSignIn: { twoFactor: true, codeAnswers: ['gone'] } })
  await page.goto('/icloud')

  const dialog = await openAddDialog(page)
  await dialog.getByRole('textbox', { name: '受信任设备验证码' }).fill('123456')
  await dialog.getByRole('button', { name: '验证并完成登录' }).click()
  await expect(dialog.getByRole('alert')).toContainText('登录挑战已过期，请重新开始。')

  await expect(dialog.getByRole('textbox', { name: 'Apple ID', exact: true })).toHaveValue('owner@icloud.com')
  await dialog.getByLabel('Apple ID 密码').fill('secret')
  await dialog.getByRole('button', { name: '验证并添加' }).click()
  await dialog.getByRole('textbox', { name: '受信任设备验证码' }).fill('654321')
  await dialog.getByRole('button', { name: '验证并完成登录' }).click()

  await expect(dialog).toBeHidden()
  await expect(page.locator('.toast')).toHaveText('iCloud 账号已添加')
  // One account, signed in twice: the restart reuses the row it created.
  expect(state.accountCreates).toHaveLength(1)
  expect(state.appleSignIns.map((entry) => entry.accountId)).toEqual(['icloud-new', 'icloud-new'])
})

test('leaves no account behind when the sign-in is abandoned at the code', async ({ page }) => {
  // The account was created only to sign in to; kept, it would sit in the list
  // with no credential as a dead "pending".
  const state = await mockICloud(page, { appleSignIn: { twoFactor: true } })
  await page.goto('/icloud')
  // A toast lasts three seconds, so waiting for it to be absent proves nothing:
  // record whether one ever appeared instead.
  await watchTransientState(page.locator('.icloud-mail-view'), 'data-saw-toast', ':has(.toast)')

  const dialog = await openAddDialog(page)
  await expect(dialog.getByRole('textbox', { name: '受信任设备验证码' })).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()

  await expect(dialog).toBeHidden()
  await expect.poll(() => state.deletedAccountIds).toEqual(['icloud-new'])
  // Never announced: the attribute only ever turns true, and stays so.
  await expect(page.locator('body')).toHaveAttribute('data-saw-toast', 'false')
})

test('signs in a phone-number Apple ID and takes the code by SMS', async ({ page }) => {
  const state = await mockICloud(page, { appleSignIn: { twoFactor: true, phones: PHONES, codeAnswers: ['wrong'] } })
  await page.goto('/icloud')
  await page.getByLabel('账号设置', { exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置 Personal' })

  // type="email" used to stop a phone number in the browser before it was sent.
  await settings.getByRole('textbox', { name: 'Apple ID', exact: true }).fill('+8613800000000')
  await settings.getByLabel('Apple ID 密码').fill('secret')
  await settings.getByRole('button', { name: '连接 Apple Account' }).click()
  await expect.poll(() => state.appleSignIns).toEqual([{ accountId: 'icloud-1', appleId: '+8613800000000' }])

  await settings.getByRole('combobox', { name: '接收短信的手机号' }).selectOption('2')
  await settings.getByRole('button', { name: '改用短信接收验证码' }).click()
  await expect.poll(() => state.appleSmsRequests).toEqual([{ accountId: 'icloud-1', challengeId: 'challenge-1', phoneId: 2 }])
  await expect(settings).toContainText('验证码已通过短信发送到 +1 (•••) •••-••34')

  // A wrong code keeps the challenge; only a gone one sends the form back.
  const code = settings.getByRole('textbox', { name: '短信验证码' })
  await code.fill('000000')
  await settings.getByRole('button', { name: '验证并完成登录' }).click()
  await expect(settings.getByRole('alert')).toContainText('验证码不正确，请重新输入。')
  await code.fill('654321')
  await settings.getByRole('button', { name: '验证并完成登录' }).click()

  await expect(page.locator('.toast')).toHaveText('Apple Account 已连接')
  expect(state.appleCodes.map((entry) => entry.code)).toEqual(['000000', '654321'])
})

test('offers no deactivate, delete or create on a cookie jar Apple has rejected', async ({ page }) => {
  await mockICloud(page, { cookieJarRejected: true })
  await page.goto('/icloud')

  await page.getByRole('button', { name: /当前 iCloud.*Personal/ }).click()
  await page.getByRole('dialog', { name: '选择查看范围' }).getByRole('button', { name: /Shopping/ }).click()

  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '停用', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '删除', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'iCloud Cookie 已失效，请在账号设置中更新。' })).toBeDisabled()
})

test('keeps a failed account reload in view while the inbox reloads', async ({ page }) => {
  // Reloading the inbox resets the inbox error; the account list's failure is
  // not its to clear, and the list stays stale until a reload succeeds.
  const state = await mockICloud(page)
  await page.goto('/icloud')
  await expect(page.getByText('Your receipt')).toBeVisible()

  state.failAccountLoads()
  const syncButton = page.getByRole('button', { name: '同步' })
  await syncButton.click()
  await expect(syncButton).toBeEnabled()
  await page.getByRole('searchbox', { name: '搜索邮件' }).fill('receipt')
  await expect.poll(() => state.inboxQueries.at(-1)).toBe('receipt')
  await expect(page.getByText('Your receipt')).toBeVisible()

  await expect(page.getByRole('alert')).toContainText('读取 iCloud 账号失败。')
})

test('keeps the cached mail when an Apple session refresh fails', async ({ page }) => {
  // Mail comes through the app password or the jar; the Apple session reads
  // none, so a failure there is no reason to fetch every message again.
  const state = await mockICloud(page, { hasAppleAccount: true, rejectAppleRefresh: true })
  await page.goto('/icloud')
  await page.getByRole('button', { name: /Your receipt/ }).click()
  const reader = page.frameLocator('iframe[title^="邮件正文"]')
  await expect(reader.getByRole('heading', { name: 'Full receipt body.' })).toBeVisible()

  await page.getByLabel('账号设置', { exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置 Personal' })
  await settings.getByRole('button', { name: '刷新登录态' }).click()
  await expect(settings.getByText('需要重新登录')).toBeVisible()
  await settings.getByRole('button', { name: '关闭' }).click()
  await page.getByRole('button', { name: /Your receipt/ }).click()
  await expect(reader.getByRole('heading', { name: 'Full receipt body.' })).toBeVisible()

  // A read the reopening sent would have been answered before this sync's listing.
  const listings = state.aliasListAccounts.length
  await page.getByRole('button', { name: '同步' }).click()
  await expect.poll(() => state.aliasListAccounts.length).toBeGreaterThan(listings)
  expect(state.messageReads).toHaveLength(1)
})
