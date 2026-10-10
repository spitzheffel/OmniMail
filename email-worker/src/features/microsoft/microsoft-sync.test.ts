import { describe, expect, it } from 'vitest'
import { ImapConnectionError } from '../../platform/imap/imap-errors'
import { MicrosoftStoreError } from './microsoft-store'
import { MicrosoftTokenError } from './microsoft-token'
import { microsoftFailureState, microsoftSyncErrorCode, missingMicrosoftUids } from './microsoft-sync'

describe('Microsoft synchronization decisions', () => {
  it('binds deletion reconciliation to the remote UID set', () => {
    expect(missingMicrosoftUids([10, 11, 12], [10, 12, 13])).toEqual([11])
  })

  it('distinguishes token, OAuth2 IMAP, password, and transient failures', () => {
    expect(microsoftSyncErrorCode(new MicrosoftTokenError('invalid_grant', false)))
      .toBe('invalid_grant')
    expect(microsoftSyncErrorCode(new ImapConnectionError(400, 'secret'), 'oauth2'))
      .toBe('imap_access_rejected')
    expect(microsoftSyncErrorCode(new ImapConnectionError(400, 'secret'), 'password'))
      .toBe('basic_auth_rejected')
    expect(microsoftSyncErrorCode(new ImapConnectionError(504, 'timeout'), 'oauth2'))
      .toBe('timeout')
    expect(microsoftSyncErrorCode(
      new MicrosoftStoreError(503, 'credential_key_unavailable', 'key'),
    )).toBe('credential_key_unavailable')
    expect(microsoftSyncErrorCode(new Error('mail subject'))).toBe('sync_failed')
  })

  it('believes a refused token only once the refusals persist, and keeps checking even then', () => {
    const now = 1_000_000
    const hour = 60 * 60
    expect(microsoftFailureState('imap_access_rejected', now, now))
      .toEqual({ status: 'error', retryAt: now + 15 * 60 })
    expect(microsoftFailureState('imap_access_rejected', now - 6 * hour + 1, now))
      .toEqual({ status: 'error', retryAt: now + 15 * 60 })
    expect(microsoftFailureState('imap_access_rejected', now - 6 * hour, now))
      .toEqual({ status: 'permission_error', retryAt: now + 6 * hour })
    // Other permission answers are believed at once; credentials wait for the user.
    expect(microsoftFailureState('imap_scope_missing', now, now).status).toBe('permission_error')
    expect(microsoftFailureState('invalid_grant', now, now).status).toBe('credential_error')
    expect(microsoftFailureState('timeout', now - 7 * hour, now))
      .toEqual({ status: 'error', retryAt: now + 5 * 60 })
  })
})
