CREATE TABLE icloud_alias_create_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('apple_account', 'icloud_web')),
  hour_started_at INTEGER NOT NULL,
  hour_count INTEGER NOT NULL DEFAULT 0 CHECK (hour_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, channel)
);
