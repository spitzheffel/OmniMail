/**
 * Hourly creation quota for iCloud Hide My Email, per account and per channel.
 *
 * Apple enforces its own limits per Apple ID, so the quota is keyed on
 * (account_id, channel) rather than on the OmniMail user. The window start is a
 * fixed hour floor, never `now + delta`: a repeated rejection therefore cannot
 * push the deadline out, which is what made the previous in-memory cooldown
 * extend itself forever.
 *
 * Structure mirrors ../outbound/outbound-rate-limit.ts.
 */

import { ICloudRemoteError } from './icloud-apple'

export type ICloudAliasChannel = 'apple_account' | 'icloud_web'

export const ICLOUD_ALIAS_CHANNELS: readonly ICloudAliasChannel[] = ['apple_account', 'icloud_web']

/**
 * Advisory hourly budgets. Apple never publishes these; they come from field
 * observation, so upstream 429s stay the authority via exhaustICloudAliasChannel.
 */
export const ICLOUD_ALIAS_HOURLY_LIMITS: Record<ICloudAliasChannel, number> = {
  apple_account: 20,
  icloud_web: 5,
}

export const ICLOUD_ALIAS_HOUR_SECONDS = 3_600

export type ICloudAliasQuota = {
  channel: ICloudAliasChannel
  limit: number
  used: number
  remaining: number
  /** Unix seconds at which the current window rolls over. */
  resetsAt: number
}

export type ICloudAliasQuotaOverrides = Partial<Record<ICloudAliasChannel, number>>

export type ICloudAliasQuotaRow = {
  channel: string
  hour_started_at: number
  hour_count: number
}

export type ICloudAliasClaim =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfter: number }

const TABLE = 'icloud_alias_create_limits'

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function hourStart(now: number): number {
  return Math.floor(now / ICLOUD_ALIAS_HOUR_SECONDS) * ICLOUD_ALIAS_HOUR_SECONDS
}

export function iCloudAliasChannelLimit(
  channel: ICloudAliasChannel,
  limits?: ICloudAliasQuotaOverrides,
): number {
  const override = limits?.[channel]
  return typeof override === 'number' && Number.isSafeInteger(override) && override >= 0
    ? override
    : ICLOUD_ALIAS_HOURLY_LIMITS[channel]
}

/** Pure projection of stored rows onto the current window. */
export function iCloudAliasQuotaState(
  rows: ICloudAliasQuotaRow[],
  now = nowSeconds(),
  limits?: ICloudAliasQuotaOverrides,
): ICloudAliasQuota[] {
  const startedAt = hourStart(now)
  return ICLOUD_ALIAS_CHANNELS.map((channel) => {
    const row = rows.find((item) => item.channel === channel)
    const used = row && row.hour_started_at === startedAt ? Math.max(0, row.hour_count) : 0
    const limit = iCloudAliasChannelLimit(channel, limits)
    return {
      channel,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetsAt: startedAt + ICLOUD_ALIAS_HOUR_SECONDS,
    }
  })
}

export async function readICloudAliasQuota(
  db: D1Database,
  userId: string,
  accountId: string,
  now = nowSeconds(),
  limits?: ICloudAliasQuotaOverrides,
): Promise<ICloudAliasQuota[]> {
  const result = await db.prepare(
    `SELECT channel, hour_started_at, hour_count FROM ${TABLE}
       WHERE account_id = ? AND user_id = ?`,
  ).bind(accountId, userId).all<ICloudAliasQuotaRow>()
  return iCloudAliasQuotaState(result.results || [], now, limits)
}

/**
 * Reserve one creation on `channel`. A single guarded upsert decides it, and
 * RETURNING hands back the new count so no extra read is needed.
 *
 * The reservation is taken before Apple is called, so a burst cannot exceed the
 * budget. Callers must refund with releaseICloudAliasCreate() when the attempt
 * provably never reached Apple's create endpoint.
 */
export async function claimICloudAliasCreate(
  db: D1Database,
  userId: string,
  accountId: string,
  channel: ICloudAliasChannel,
  now = nowSeconds(),
  limits?: ICloudAliasQuotaOverrides,
): Promise<ICloudAliasClaim> {
  const startedAt = hourStart(now)
  const limit = iCloudAliasChannelLimit(channel, limits)
  if (limit <= 0) {
    return { allowed: false, retryAfter: Math.max(1, startedAt + ICLOUD_ALIAS_HOUR_SECONDS - now) }
  }
  const row = await db.prepare(
    `INSERT INTO ${TABLE} (user_id, account_id, channel, hour_started_at, hour_count, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(account_id, channel) DO UPDATE SET
       hour_started_at = excluded.hour_started_at,
       hour_count = CASE
         WHEN ${TABLE}.hour_started_at = excluded.hour_started_at
           THEN ${TABLE}.hour_count + 1
         ELSE 1
       END,
       updated_at = excluded.updated_at
     WHERE ${TABLE}.hour_started_at != excluded.hour_started_at
        OR ${TABLE}.hour_count < ?
     RETURNING hour_count`,
  ).bind(userId, accountId, channel, startedAt, now, limit).first<{ hour_count: number }>()
  // No row means the guard rejected the upsert, which can only happen when the
  // window is current and already full, so the reset time is deterministic.
  if (!row) {
    return { allowed: false, retryAfter: Math.max(1, startedAt + ICLOUD_ALIAS_HOUR_SECONDS - now) }
  }
  return { allowed: true, remaining: Math.max(0, limit - row.hour_count) }
}

/** Give back a reservation for an attempt that never reached Apple. */
export async function releaseICloudAliasCreate(
  db: D1Database,
  userId: string,
  accountId: string,
  channel: ICloudAliasChannel,
  now = nowSeconds(),
): Promise<void> {
  await db.prepare(
    `UPDATE ${TABLE} SET hour_count = hour_count - 1, updated_at = ?
       WHERE account_id = ? AND channel = ? AND user_id = ?
         AND hour_started_at = ? AND hour_count > 0`,
  ).bind(now, accountId, channel, userId, hourStart(now)).run()
}

/** Saturate the current window after Apple answered with its own limit error. */
export async function exhaustICloudAliasChannel(
  db: D1Database,
  userId: string,
  accountId: string,
  channel: ICloudAliasChannel,
  now = nowSeconds(),
  limits?: ICloudAliasQuotaOverrides,
): Promise<void> {
  const startedAt = hourStart(now)
  const limit = iCloudAliasChannelLimit(channel, limits)
  await db.prepare(
    `INSERT INTO ${TABLE} (user_id, account_id, channel, hour_started_at, hour_count, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, channel) DO UPDATE SET
       hour_started_at = excluded.hour_started_at,
       hour_count = CASE
         WHEN ${TABLE}.hour_started_at = excluded.hour_started_at
           THEN MAX(${TABLE}.hour_count, excluded.hour_count)
         ELSE excluded.hour_count
       END,
       updated_at = excluded.updated_at`,
  ).bind(userId, accountId, channel, startedAt, limit, now).run()
}

/** Our own quota rejection — distinct from Apple's upstream limit codes. */
export const ICLOUD_ALIAS_QUOTA_CODE = 'icloud_alias_hourly_quota'

const QUOTA_MESSAGES: Record<ICloudAliasChannel, string> = {
  apple_account: '本小时 Apple Account 创建额度已用完，请稍后再试。',
  icloud_web: '本小时 iCloud Cookie 创建额度已用完，请稍后再试。',
}

/**
 * Carries `retryAfter` alongside a static, translatable message. Interpolating
 * the countdown into the sentence would defeat t(), which keys on the source
 * string, so the client formats the countdown itself.
 */
export class ICloudAliasQuotaError extends ICloudRemoteError {
  constructor(readonly channel: ICloudAliasChannel, readonly retryAfter: number) {
    super(429, QUOTA_MESSAGES[channel], true, ICLOUD_ALIAS_QUOTA_CODE)
  }
}
