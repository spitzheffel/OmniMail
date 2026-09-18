import { expect, test } from '@playwright/test'
import { mockICloud } from './icloud-fixtures'

test('iCloud workspace is available to a regular user and reads a message', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 1150 })
  const state = await mockICloud(page)
  await page.goto('/icloud')

  await expect(page.getByRole('button', { name: '回到列表顶部：iCloud' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'iCloud', exact: true })).toBeVisible()
  await expect(page.getByText('Personal')).toBeVisible()
  await expect(page.getByText('Your receipt')).toBeVisible()
  await expect(page.getByText('IMAP 完整邮件')).toBeVisible()
  const mailSearch = page.getByRole('searchbox', { name: '搜索邮件' })
  await mailSearch.fill('receipt')
  await expect.poll(() => state.inboxQueries.at(-1)).toBe('receipt')
  await expect(page.getByText('Your receipt')).toBeVisible()
  await mailSearch.fill('missing')
  await expect(page.getByRole('heading', { name: '没有匹配的 iCloud 邮件' })).toBeVisible()
  await mailSearch.fill('')
  await expect(page.getByText('Your receipt')).toBeVisible()
  const addAccount = page.getByRole('button', { name: '添加 iCloud 账号' })
  await addAccount.hover()
  await expect(page.getByRole('tooltip')).toHaveText('添加 iCloud 账号')

  await addAccount.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.locator('.icloud-modal-backdrop')).toHaveClass(/is-visible/)
  await expect(page.getByRole('dialog').getByRole('textbox', { name: '账号名称' }))
    .toBeFocused()
  const region = page.getByRole('dialog').getByRole('group', { name: 'iCloud 区域' })
  const globalRegion = region.getByRole('button', { name: /全球/ })
  const chinaRegion = region.getByRole('button', { name: /中国大陆/ })
  const indicator = region.locator('.icloud-region-select__indicator')
  const initialX = (await indicator.boundingBox())?.x || 0
  await expect(globalRegion).toHaveAttribute('aria-pressed', 'true')
  await expect(indicator).toHaveCSS('transition-property', 'transform')
  await chinaRegion.click()
  await expect(chinaRegion).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await indicator.boundingBox())?.x || 0).toBeGreaterThan(initialX)
  await globalRegion.focus()
  await globalRegion.press('Enter')
  await expect(globalRegion).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('.icloud-modal-backdrop')).not.toHaveClass(/is-visible/)
  await expect(page.getByRole('dialog')).toBeHidden()

  await page.getByRole('button', { name: /当前 iCloud.*Personal/ }).click()
  let scopeDialog = page.getByRole('dialog', { name: '选择查看范围' })
  await expect(scopeDialog).toBeVisible()
  const accountSettings = scopeDialog.getByRole('button', { name: '设置 iCloud 账号：Personal' })
  await expect(accountSettings).toHaveCSS('width', '44px')
  await expect(accountSettings).toHaveCSS('height', '44px')
  await accountSettings.click()
  await expect(scopeDialog).toBeHidden()

  const settingsDialog = page.locator('.icloud-modal')
  await expect(settingsDialog).toHaveAccessibleName('设置 Personal')
  const nameInput = settingsDialog.getByRole('textbox', { name: '备注名称' })
  await expect(nameInput).toBeFocused()
  await expect(nameInput).toHaveValue('Personal')
  const settingsHeight = await settingsDialog.evaluate((element: HTMLElement) => element.offsetHeight)
  await nameInput.fill('Work iCloud')
  await settingsDialog.getByRole('button', { name: '保存备注' }).click()
  await expect.poll(() => state.accountNames).toEqual(['Work iCloud'])
  await expect(page.locator('.toast')).toHaveText('备注名称已保存')
  expect(Math.abs(await settingsDialog.evaluate((element: HTMLElement) => element.offsetHeight)
    - settingsHeight)).toBeLessThanOrEqual(1)
  await expect(settingsDialog.getByRole('status')).toHaveCount(0)
  await expect(settingsDialog).toHaveAccessibleName('设置 Work iCloud')

  await settingsDialog.getByRole('textbox', { name: '新 Cookie' }).fill('session=new-cookie')
  await settingsDialog.getByRole('button', { name: '验证并覆盖' }).click()
  await expect.poll(() => state.cookieUpdates).toEqual(['session=new-cookie'])
  await expect(page.locator('.toast')).toHaveText('Cookie 已更新')

  await settingsDialog.getByRole('textbox', { name: 'iCloud 邮箱' }).fill('work@icloud.com')
  await settingsDialog.getByLabel('新应用专用密码').fill('abcd-efgh-ijkl-mnop')
  await settingsDialog.getByRole('button', { name: '测试并覆盖' }).click()
  await expect.poll(() => state.passwordUpdates).toEqual([{
    icloudEmail: 'work@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop',
  }])
  await expect(page.locator('.toast')).toHaveText('应用专用密码已更新')
  await expect(settingsDialog.getByRole('button', { name: '删除这个 iCloud 账号' }))
    .toHaveClass(/icloud-danger-button/)

  await page.setViewportSize({ width: 375, height: 812 })
  expect(await settingsDialog.evaluate((element) => element.scrollWidth <= element.clientWidth))
    .toBe(true)
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true)
  await page.setViewportSize({ width: 2048, height: 1150 })
  await settingsDialog.getByRole('button', { name: '关闭' }).click()

  await page.getByRole('button', { name: /当前 iCloud.*Work iCloud/ }).click()
  scopeDialog = page.getByRole('dialog', { name: '选择查看范围' })
  await scopeDialog.getByRole('button', { name: '复制邮箱地址：shop@icloud.com' }).click()
  await expect(page.getByRole('status')).toContainText('已复制：shop@icloud.com')
  await expect(scopeDialog).toBeVisible()
  await scopeDialog.getByRole('button', { name: /Shopping/ }).click()
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已复制：shop@icloud.com')

  await page.getByRole('button', { name: /Your receipt/ }).click()
  const sender = page.locator('.icloud-reader-sender')
  await expect(sender.locator('strong')).toHaveText('GitHub')
  const relay = sender.getByText('通过 iCloud 隐藏邮箱转发')
  await expect(sender.locator('strong')).toHaveCSS('font-size', '14px')
  await expect(relay).toHaveCSS('font-size', '12px')
  await expect(sender.locator('time')).toHaveCSS('font-size', '12px')
  await expect(relay).toHaveAttribute(
    'title',
    'noreply_at_github_com_22h56q5td86002_47bfb5aa@icloud.com',
  )
  await expect(sender).not.toContainText('noreply_at_github_com')
  const messageFrame = page.frameLocator('iframe[title^="邮件正文"]')
  await expect(messageFrame.getByRole('heading', { name: 'Full receipt body.' })).toBeVisible()
  await expect(messageFrame.getByRole('img', { name: 'GitHub' })).toHaveJSProperty('naturalWidth', 120)
  await expect(messageFrame.getByText('unsafe')).toHaveCount(0)
  const readerContent = page.locator('.icloud-reader .reader-content')
  await readerContent.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const toolbarSubject = page.getByRole('button', { name: '回到顶部：Your receipt' })
  const readerScrollTop = page.locator('.icloud-reader .reader-scroll-top')
  await expect(toolbarSubject).toBeVisible()
  await expect(readerScrollTop).toHaveClass(/is-visible/)
  await toolbarSubject.click()
  await expect.poll(() => readerContent.evaluate((element) => element.scrollTop)).toBe(0)
  await readerContent.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(readerScrollTop).toHaveClass(/is-visible/)
  await readerScrollTop.click()
  await expect.poll(() => readerContent.evaluate((element) => element.scrollTop)).toBe(0)
  await messageFrame.getByRole('link', { name: 'Open receipt' }).click()
  const externalLink = page.getByRole('alertdialog')
  await expect(externalLink).toContainText('github.com')
  await externalLink.getByRole('button', { name: '取消' }).click()
  await page.setViewportSize({ width: 375, height: 812 })
  await expect(page.getByRole('button', { name: '返回邮件列表' })).toBeVisible()
  await page.getByRole('button', { name: '返回邮件列表' }).click()
  await expect(page.locator('iframe[title^="邮件正文"]')).toBeHidden()
  await expect(page.getByRole('button', { name: /Your receipt/ })).toBeVisible()
  await page.getByRole('button', { name: /Your receipt/ }).click()
  await expect(page.locator('iframe[title^="邮件正文"]')).toBeVisible()
  expect(state.messageReads).toHaveLength(1)
})

test('uses the branded danger dialog before deleting an iCloud account', async ({ page }) => {
  const state = await mockICloud(page)
  await page.goto('/icloud')

  await page.getByRole('button', { name: /当前 iCloud.*Personal/ }).click()
  const scopeDialog = page.getByRole('dialog', { name: '选择查看范围' })
  await scopeDialog.getByRole('button', { name: '设置 iCloud 账号：Personal' }).click()
  const settingsDialog = page.getByRole('dialog', { name: '设置 Personal' })
  const deleteButton = settingsDialog.getByRole('button', { name: '删除这个 iCloud 账号' })
  await deleteButton.click()

  let confirm = page.getByRole('alertdialog', { name: '删除 iCloud 账号？' })
  await expect(confirm).toContainText('账号“Personal”将从 OmniMail 中移除。')
  await expect(confirm).toContainText('此操作无法撤销')
  await expect(confirm).toContainText('Apple 账号和已有隐藏邮箱不会受影响')
  await expect(confirm.getByRole('button', { name: '取消' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(settingsDialog).toBeVisible()
  await expect(deleteButton).toBeFocused()

  await deleteButton.click()
  confirm = page.getByRole('alertdialog', { name: '删除 iCloud 账号？' })
  await confirm.getByRole('button', { name: '删除账号' }).click()
  await expect.poll(() => state.deletedAccountIds).toEqual(['icloud-1'])
  await expect(confirm).toBeHidden()
  await expect(page.getByText('还没有 iCloud 账号')).toBeVisible()
})
test('rejects an iCloud account without membership access without signing out', async ({ page }) => {
  await mockICloud(page, { rejectAccountCreate: true })
  await page.goto('/icloud')

  await page.getByRole('button', { name: '添加 iCloud 账号' }).click()
  const dialog = page.getByRole('dialog', { name: '添加 iCloud 账号' })
  await expect(dialog).toContainText('Cookie 仅用于管理隐藏邮箱')
  await dialog.getByRole('textbox', { name: '账号名称' }).fill('Web only')
  await dialog.locator('textarea').fill('session=web-only')
  await dialog.getByRole('button', { name: '验证并添加' }).click()

  await expect(dialog.getByRole('alert')).toContainText('添加失败')
  await expect(dialog.getByRole('alert')).toContainText('未开通 iCloud+')
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL(/\/icloud$/)
  await expect(page.getByRole('heading', { name: 'iCloud', exact: true })).toBeVisible()
  await expect(page.getByText('Personal')).toBeVisible()
})

test('adds optional IMAP credentials together with an iCloud account', async ({ page }) => {
  const state = await mockICloud(page)
  await page.goto('/icloud')

  await page.getByRole('button', { name: '添加 iCloud 账号' }).click()
  const dialog = page.getByRole('dialog', { name: '添加 iCloud 账号' })
  const warning = dialog.locator('.icloud-account-warning')
  await expect(warning).toContainText('至少配置一种')
  expect(Number.parseFloat(await warning.evaluate((element) => getComputedStyle(element).fontSize)))
    .toBeGreaterThanOrEqual(13)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await dialog.locator('.icloud-app-password-fields').evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  )))).toBe(1)
  await dialog.getByRole('textbox', { name: '账号名称' }).fill('Work')
  await dialog.locator('textarea').fill('session=valid-cookie')
  await dialog.getByRole('textbox', { name: 'iCloud 邮箱' }).fill('work@icloud.com')
  await dialog.getByLabel('应用专用密码', { exact: true }).fill('abcd-efgh-ijkl-mnop')
  await dialog.getByRole('button', { name: '验证并添加' }).click()

  await expect.poll(() => state.accountCreates).toEqual([{
    name: 'Work',
    host: 'icloud.com',
    cookies: 'session=valid-cookie',
    icloudEmail: 'work@icloud.com',
    appPassword: 'abcd-efgh-ijkl-mnop',
  }])
  await expect(dialog).toBeHidden()
})

test('explains Cookie summary mode before an app-specific password is configured', async ({ page }) => {
  await mockICloud(page, { hasAppPassword: false })
  await page.goto('/icloud')

  const status = page.locator('.icloud-mail-status')
  await expect(status).toHaveText(/Web 摘要/)
  await expect(page.locator('.icloud-list-context')).toHaveCount(0)
  const statusBox = await status.boundingBox()
  const actionsBox = await page.locator('.icloud-header-action-buttons').boundingBox()
  expect(Math.abs(
    (statusBox?.x || 0) + (statusBox?.width || 0)
      - (actionsBox?.x || 0) - (actionsBox?.width || 0),
  )).toBeLessThanOrEqual(1)
  expect((statusBox?.y || 0) + (statusBox?.height || 0)).toBeLessThanOrEqual(actionsBox?.y || 0)
  await page.getByRole('button', { name: /Your receipt/ }).click()
  await expect(page.getByText('当前显示 iCloud Web 摘要')).toBeVisible()
})

test('creates five labeled Hide My Email addresses in one batch', async ({ page }) => {
  const state = await mockICloud(page)
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: /换一个地址/ }).click()
  await expect(dialog.getByText('github-1@icloud.com', { exact: true })).toBeVisible()
  const firstDraftWidth = await dialog.locator('.icloud-alias-preview').first()
    .evaluate((element) => element.getBoundingClientRect().width)
  // One click fills the remaining budget instead of four separate clicks.
  await dialog.getByRole('button', { name: '加到上限' }).click()
  for (let index = 2; index <= 5; index += 1) {
    await expect(dialog.getByText(`github-${index}@icloud.com`, { exact: true })).toBeVisible()
  }
  expect(await dialog.locator('.icloud-alias-preview').first()
    .evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(firstDraftWidth, 1)
  await expect(dialog.getByText('创建项目 5/5')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '增加邮箱' })).toBeDisabled()
  await expect(dialog.getByText('旧接口本小时剩余 5/5')).toBeVisible()
  expect(state.previewedEmails).toEqual([
    'preview-one@icloud.com', 'github-1@icloud.com', 'github-2@icloud.com',
    'github-3@icloud.com', 'github-4@icloud.com', 'github-5@icloud.com',
  ])
  const draftGrid = dialog.locator('.icloud-alias-drafts')
  expect((await draftGrid.evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  )))).toBe(2)
  await page.setViewportSize({ width: 375, height: 812 })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await draftGrid.evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(' ').length
  )))).toBe(1)
  await page.setViewportSize({ width: 1280, height: 720 })
  const labelInputs = dialog.getByRole('textbox', { name: '用途标签（可选）' })
  await expect(dialog.getByRole('button', { name: '自动生成' })).toHaveAttribute('aria-pressed', 'true')
  await labelInputs.nth(0).focus()
  await dialog.getByRole('button', { name: '购物' }).click()
  await expect(labelInputs.nth(0)).toHaveValue('购物')
  for (let index = 0; index < 5; index += 1) {
    await labelInputs.nth(index).fill(`GITHUB${index + 1}`)
  }
  await dialog.getByRole('button', { name: '创建 5 个' }).click()
  await expect(dialog.getByText(/创建进度 \d\/5/)).toBeVisible()
  // Rows stay put and fill in with the address that was actually created.
  await expect(dialog.locator('.icloud-alias-preview.is-success')).toHaveCount(5)
  await expect(dialog.locator('.icloud-alias-preview')).toHaveCount(5)
  await expect(dialog.getByText('成功 5 个，失败 0 个。')).toBeVisible()
  await expect(dialog.getByRole('button', { name: '继续创建' })).toBeEnabled()

  await expect(page.locator('.icloud-list-context'))
    .toContainText('github-5@icloud.com')
  expect(state.createdLabels).toEqual(['GITHUB1', 'GITHUB2', 'GITHUB3', 'GITHUB4', 'GITHUB5'])
  expect(state.createdEmails).toEqual([
    'github-1@icloud.com', 'github-2@icloud.com', 'github-3@icloud.com',
    'github-4@icloud.com', 'github-5@icloud.com',
  ])
  expect(state.createdPreviewIds).toEqual([
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000006',
  ])
  await expect.poll(() => state.inboxAliases.at(-1)).toBe('github-5@icloud.com')
})

test('finishes the rest of the batch after one alias fails', async ({ page }) => {
  const state = await mockICloud(page, { failCreateAt: 3 })
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  for (let index = 1; index <= 3; index += 1) {
    await dialog.getByRole('button', { name: '增加邮箱' }).click()
    await expect(dialog.getByText(`github-${index}@icloud.com`, { exact: true })).toBeVisible()
  }
  const labels = dialog.getByRole('textbox', { name: '用途标签（可选）' })
  for (const [index, label] of ['ONE', 'TWO', 'THREE', 'FOUR'].entries()) {
    await labels.nth(index).fill(label)
  }
  await dialog.getByRole('button', { name: '创建 4 个' }).click()

  await expect(dialog).toBeVisible()
  // The third item fails, and the fourth still runs instead of being dropped.
  await expect(dialog.getByText('成功 3 个，失败 1 个。')).toBeVisible()
  await expect(dialog.locator('.icloud-alias-preview.is-success')).toHaveCount(3)
  await expect(dialog.locator('.icloud-alias-preview.is-error')).toHaveCount(1)
  expect(state.createdLabels).toEqual(['ONE', 'TWO', 'FOUR'])

  // 继续创建 brings back only the card that did not go through, label and
  // reserved address intact; the three created ones must not be replayed.
  await dialog.getByRole('button', { name: '继续创建' }).click()
  await expect(dialog.locator('.icloud-alias-preview')).toHaveCount(1)
  await expect(dialog.getByRole('textbox', { name: '用途标签（可选）' })).toHaveValue('THREE')
  await expect(dialog.getByText('github-2@icloud.com', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '创建 1 个' })).toBeEnabled()
})

test('creates a numbered batch through the Apple Account channel', async ({ page }) => {
  const state = await mockICloud(page, { hasAppleAccount: true, quota: { apple: 20, web: null } })
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  // No preview round-trips at all on this channel.
  await expect(dialog.locator('.icloud-alias-preview')).toHaveCount(0)
  await expect(dialog.getByText('新接口本小时剩余 20/20')).toBeVisible()
  const quantity = dialog.getByRole('spinbutton', { name: '创建数量' })
  // Clearing the field must not snap back to "1" and prefix the next digit.
  await quantity.fill('3')
  await quantity.press('End')
  await quantity.press('Backspace')
  await expect(quantity).toHaveValue('')
  await quantity.press('5')
  await expect(quantity).toHaveValue('5')
  await expect(dialog.getByRole('button', { name: '创建 5 个' })).toBeVisible()
  // Implicit submission from a blank field must resolve it back to the number
  // the button promises rather than silently creating the previous quantity.
  await quantity.press('End')
  await quantity.press('Backspace')
  await expect(quantity).toHaveValue('')
  await quantity.press('Enter')
  await expect(quantity).toHaveValue('5')
  await quantity.fill('3')
  await dialog.getByRole('textbox', { name: '基础标签（可选）' }).fill('GITHUB')
  await dialog.getByRole('button', { name: '创建 3 个' }).click()

  await expect(dialog.getByText('成功 3 个，失败 0 个。')).toBeVisible()
  expect(state.createdLabels).toEqual(['GITHUB-01', 'GITHUB-02', 'GITHUB-03'])
  expect(state.createdChannels).toEqual(['apple_account', 'apple_account', 'apple_account'])
  expect(state.previewedEmails).toEqual([])
})

test('spills to the cookie channel once the Apple budget runs out', async ({ page }) => {
  const state = await mockICloud(page, { hasAppleAccount: true, quota: { apple: 2, web: 5 } })
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await expect(dialog.getByRole('button', { name: '自动', exact: true }))
    .toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('spinbutton', { name: '创建数量' }).fill('4')
  await dialog.getByRole('button', { name: '创建 4 个' }).click()

  await expect(dialog.getByText('成功 4 个，失败 0 个。')).toBeVisible()
  // Planned up front from the quota, so no Apple request is wasted.
  expect(state.createdChannels).toEqual([
    'apple_account', 'apple_account', 'icloud_web', 'icloud_web',
  ])
  await expect(dialog.getByText('新接口 2 个 · 旧接口 2 个')).toBeVisible()
})

test('allows iCloud to create an automatic purpose label', async ({ page }) => {
  const state = await mockICloud(page)
  await page.goto('/icloud')

  await page.getByRole('button', { name: '创建隐藏邮箱' }).click()
  const dialog = page.getByRole('dialog', { name: '创建隐藏邮箱' })
  await expect(dialog.getByText('preview-one@icloud.com', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('textbox', { name: '用途标签（可选）' }))
    .not.toHaveAttribute('required')
  await dialog.getByRole('button', { name: '创建 1 个' }).click()

  expect(state.createdLabels).toEqual([''])
  expect(state.createdEmails).toEqual(['preview-one@icloud.com'])
  expect(state.createdPreviewIds).toEqual(['00000000-0000-4000-8000-000000000001'])
  await expect(page.locator('.icloud-list-context'))
    .toContainText('preview-one@icloud.com')
})
