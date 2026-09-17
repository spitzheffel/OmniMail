export const ICLOUD_ALIAS_QUOTA_MIGRATION = '0039_icloud_alias_quota.sql'

export const ICLOUD_ALIAS_QUOTA_RECOVERY = {
  name: ICLOUD_ALIAS_QUOTA_MIGRATION,
  statements: [
    `CREATE TABLE IF NOT EXISTS icloud_alias_create_limits (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,
      hour_started_at INTEGER NOT NULL,
      hour_count INTEGER NOT NULL DEFAULT 0 CHECK (hour_count >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, channel)
    )`,
  ],
} as const
