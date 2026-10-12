import { decryptICloudSecret, encryptICloudSecret } from './icloud-credentials'
import { ICloudStoreError } from './icloud-store-error'
import type { Env } from '../../app/types'

/** How long a sign-in waits for its verification code. */
export const CHALLENGE_TTL_SECONDS = 10 * 60
/** Apple calls one sign-in may make on its challenge: code guesses and SMS requests alike. */
export const CHALLENGE_MAX_ATTEMPTS = 5
/** The client starts the sign-in over when it sees this. */
export const APPLE_LOGIN_CHALLENGE_GONE = 'apple_login_challenge_gone'

export interface TrustedPhone {
  id: number
  /** As Apple shows it, with most digits masked. */
  number: string
}

export type TwoFactorMethod = 'trusted_device' | 'phone'

/** A sign-in waiting for its verification code, as the challenge row keeps it. */
export interface PendingAppleSignIn {
  appleId: string
  frameId: string
  cookies: Record<string, string>
  scnt: string
  sessionId: string
  authAttributes: string
  hcBits: number
  hcChallenge: string
  twoFactorMethod: TwoFactorMethod
  /** The trusted phone the code went to by SMS; 0 until one did. */
  phoneId: number
  phones: TrustedPhone[]
}

export interface ClaimedChallenge {
  state: PendingAppleSignIn
  /** Attempts spent, this one included. */
  attempts: number
  expiresAt: number
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** A challenge saved before phones were kept sent its SMS to phone 1, the only one it knew. */
function pendingFrom(plaintext: string): PendingAppleSignIn {
  const state = JSON.parse(plaintext) as Partial<PendingAppleSignIn>
  const phoneId = Number(state.phoneId) || (state.twoFactorMethod === 'phone' ? 1 : 0)
  return { ...state, phoneId, phones: Array.isArray(state.phones) ? state.phones : [] } as PendingAppleSignIn
}

export function appleLoginChallengeGone(exhausted: boolean): ICloudStoreError {
  return exhausted
    ? new ICloudStoreError(429, '验证码尝试次数过多，请重新开始登录。', '', APPLE_LOGIN_CHALLENGE_GONE)
    : new ICloudStoreError(410, '登录挑战已过期，请重新开始。', '', APPLE_LOGIN_CHALLENGE_GONE)
}

/** The 2FA challenges of one iCloud account. */
export class AppleLoginChallenges {
  constructor(
    private readonly env: Env,
    private readonly userId: string,
    private readonly accountId: string,
  ) {}

  private context(id: string): string {
    return `${this.userId}:${this.accountId}:apple-auth:${id}`
  }

  /** Start a challenge, replacing any the account still had and sweeping the user's expired ones. */
  async open(state: PendingAppleSignIn): Promise<{ id: string; expiresAt: number }> {
    const id = crypto.randomUUID()
    const now = nowSeconds()
    const cipher = await encryptICloudSecret(this.env, JSON.stringify(state), this.context(id))
    await this.env.DB.batch([
      this.env.DB.prepare(
        'DELETE FROM icloud_auth_challenges WHERE user_id = ? AND (expires_at <= ? OR account_id = ?)',
      ).bind(this.userId, now, this.accountId),
      this.env.DB.prepare(
        `INSERT INTO icloud_auth_challenges (id, user_id, account_id, state_cipher, expires_at, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      ).bind(id, this.userId, this.accountId, cipher, now + CHALLENGE_TTL_SECONDS, now),
    ])
    return { id, expiresAt: now + CHALLENGE_TTL_SECONDS }
  }

  /**
   * Spend one attempt and read the state, in a single statement: checking the
   * count and adding to it separately would let parallel submissions each pass
   * the check before either counted. A challenge that is gone (expired, out of
   * attempts, or not this account's) is deleted on the way out.
   */
  async claim(id: string): Promise<ClaimedChallenge> {
    const now = nowSeconds()
    const row = await this.env.DB.prepare(
      `UPDATE icloud_auth_challenges SET attempts = attempts + 1
       WHERE id = ? AND user_id = ? AND account_id = ? AND expires_at > ? AND attempts < ?
       RETURNING state_cipher, attempts, expires_at`,
    ).bind(id, this.userId, this.accountId, now, CHALLENGE_MAX_ATTEMPTS)
      .first<{ state_cipher: string; attempts: number; expires_at: number }>()
    if (!row) {
      // Expired stays expired and attempts only grow, so nothing deleted here
      // could have become usable again since the update above refused it.
      const gone = await this.env.DB.prepare(
        `DELETE FROM icloud_auth_challenges WHERE id = ? AND user_id = ? AND account_id = ?
         RETURNING attempts, expires_at`,
      ).bind(id, this.userId, this.accountId).first<{ attempts: number; expires_at: number }>()
      throw appleLoginChallengeGone(Boolean(gone && gone.expires_at > now && gone.attempts >= CHALLENGE_MAX_ATTEMPTS))
    }
    const plaintext = await decryptICloudSecret(this.env, row.state_cipher, this.context(id))
    return { state: pendingFrom(plaintext), attempts: row.attempts, expiresAt: row.expires_at }
  }

  /** Keep what Apple rotated, so the next attempt does not replay stale scnt, session id and cookies. */
  async save(id: string, state: PendingAppleSignIn): Promise<void> {
    const cipher = await encryptICloudSecret(this.env, JSON.stringify(state), this.context(id))
    await this.env.DB.prepare(
      'UPDATE icloud_auth_challenges SET state_cipher = ? WHERE id = ? AND user_id = ? AND account_id = ?',
    ).bind(cipher, id, this.userId, this.accountId).run()
  }

  async close(id: string): Promise<void> {
    await this.env.DB.prepare(
      'DELETE FROM icloud_auth_challenges WHERE id = ? AND user_id = ? AND account_id = ?',
    ).bind(id, this.userId, this.accountId).run()
  }
}
