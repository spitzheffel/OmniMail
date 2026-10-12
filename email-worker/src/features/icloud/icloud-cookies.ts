import { ICloudStoreError } from './icloud-store-error'

const MAX_COOKIE_COUNT = 64
const MAX_COOKIE_NAME_LENGTH = 128
const MAX_COOKIE_VALUE_BYTES = 8 * 1024
const MAX_COOKIE_HEADER_BYTES = 32 * 1024
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/

function validatedCookies(entries: Array<[string, string]>): Record<string, string> {
  if (!entries.length) throw new ICloudStoreError(400, 'Cookie 中没有可用值。')
  if (entries.length > MAX_COOKIE_COUNT) {
    throw new ICloudStoreError(400, `Cookie 数量不能超过 ${MAX_COOKIE_COUNT} 个。`)
  }
  const encoder = new TextEncoder()
  let totalBytes = 0
  const result: Record<string, string> = {}
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim()
    const trimmedValue = rawValue.trim()
    const value = trimmedValue.startsWith('"') && trimmedValue.endsWith('"')
      ? trimmedValue.slice(1, -1)
      : trimmedValue
    const valueBytes = encoder.encode(value).byteLength
    if (
      !name
      || name.length > MAX_COOKIE_NAME_LENGTH
      || !COOKIE_NAME.test(name)
      || !value
      || valueBytes > MAX_COOKIE_VALUE_BYTES
      || !COOKIE_VALUE.test(value)
    ) throw new ICloudStoreError(400, 'Cookie 包含无效名称或值。')
    // Includes `=`, quotes, and the `; ` separator used by the outbound header.
    totalBytes += encoder.encode(name).byteLength + valueBytes + 5
    result[name] = value
  }
  if (totalBytes > MAX_COOKIE_HEADER_BYTES) {
    throw new ICloudStoreError(400, 'Cookie 总大小不能超过 32 KiB。')
  }
  return result
}

export function parseICloudCookies(raw: unknown): Record<string, string> {
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    const entries = Object.entries(raw)
    if (!entries.every((entry): entry is [string, string] => typeof entry[1] === 'string')) {
      throw new ICloudStoreError(400, 'Cookie 包含无效名称或值。')
    }
    return validatedCookies(entries)
  }
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) throw new ICloudStoreError(400, '请填写 iCloud Cookie。')
  if (new TextEncoder().encode(value).byteLength > MAX_COOKIE_HEADER_BYTES) {
    throw new ICloudStoreError(400, 'Cookie 总大小不能超过 32 KiB。')
  }
  if (value.startsWith('{')) {
    try {
      return parseICloudCookies(JSON.parse(value) as unknown)
    } catch (error) {
      if (error instanceof ICloudStoreError) throw error
      throw new ICloudStoreError(400, 'Cookie JSON 格式无效。')
    }
  }
  const entries = value.split(';').flatMap((item): Array<[string, string]> => {
    const separator = item.indexOf('=')
    if (separator < 1) return []
    const name = item.slice(0, separator).trim()
    const cookieValue = item.slice(separator + 1).trim()
    return name && cookieValue ? [[name, cookieValue]] : []
  })
  if (!entries.length) throw new ICloudStoreError(400, '无法解析 iCloud Cookie。')
  return validatedCookies(entries)
}
