ALTER TABLE icloud_accounts ADD COLUMN apple_account_state_cipher TEXT NOT NULL DEFAULT '';
ALTER TABLE icloud_accounts ADD COLUMN apple_account_expires_at TEXT NOT NULL DEFAULT '';
ALTER TABLE icloud_accounts ADD COLUMN apple_account_status TEXT NOT NULL DEFAULT 'none'
  CHECK (apple_account_status IN ('none', 'active', 'expired', 'error'));
ALTER TABLE icloud_accounts ADD COLUMN apple_account_error TEXT NOT NULL DEFAULT '';

CREATE TABLE icloud_auth_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES icloud_accounts(id) ON DELETE CASCADE,
  state_cipher TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_icloud_auth_challenges_expiry
  ON icloud_auth_challenges(expires_at);
CREATE INDEX idx_icloud_auth_challenges_owner
  ON icloud_auth_challenges(user_id, account_id);
