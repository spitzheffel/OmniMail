import { t } from '../i18n'

export function errorMessage(error: unknown): string {
  const message = t(error instanceof Error ? error.message : '发生了未知错误。')
  // Servers keep dynamic upstream wording in `detail` so `message` stays a
  // translatable key; append it untranslated rather than losing it.
  const detail = (error as { detail?: unknown } | null)?.detail
  return typeof detail === 'string' && detail ? `${message}（${detail}）` : message
}
