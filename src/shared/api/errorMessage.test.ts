import { describe, expect, it } from 'vitest'
import { ApiError } from './api-client'
import { errorMessage } from './errorMessage'

describe('errorMessage', () => {
  it('appends the untranslated server detail after the translated message', () => {
    const error = new ApiError('iCloud 无法生成隐藏邮箱。', 502, undefined, 'Service unavailable in region')
    expect(errorMessage(error)).toBe('iCloud 无法生成隐藏邮箱。（Service unavailable in region）')
  })

  it('leaves a message without detail untouched', () => {
    expect(errorMessage(new ApiError('iCloud 无法生成隐藏邮箱。', 502)))
      .toBe('iCloud 无法生成隐藏邮箱。')
  })

  it('falls back for values that are not errors', () => {
    expect(errorMessage('boom')).toBe('发生了未知错误。')
  })
})
