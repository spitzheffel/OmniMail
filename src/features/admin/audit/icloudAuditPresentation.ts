import type { AuditLog } from '../../../shared/api'
import { t } from '../../../shared/i18n'

export const iCloudAuditActionLabels: Record<string, string> = {
  'icloud.credentials.apple_account': '已更新 Apple Account 登录态',
  'icloud.credentials.apple_account.delete': '已移除 Apple Account 登录态',
}

/** Which way an alias was created. */
const aliasChannels: Record<string, string> = {
  apple_account: '经 Apple Account 创建',
  icloud_web: '经 iCloud 网页 Cookie 创建',
}

/** How an Apple Account session was obtained when it was not imported. */
const signIns: Record<string, string> = {
  password: '密码登录',
  two_factor: '双重认证登录',
}

export function iCloudAuditDetailParts(log: AuditLog): string[] {
  if (!log.action.startsWith('icloud.')) return []
  const detail = log.detail
  const parts: string[] = []
  const channel = aliasChannels[String(detail.channel)]
  if (channel) parts.push(t(channel))
  const signIn = signIns[String(detail.signIn)]
  if (signIn) parts.push(t(signIn))
  if (detail.appleAccountHost) {
    parts.push(t('Apple Account 服务：{host}', { host: String(detail.appleAccountHost) }))
  }
  return parts
}
