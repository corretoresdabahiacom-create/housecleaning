-- 0003: Google sign-in (Firebase Auth) and expense attachments
ALTER TABLE users ADD COLUMN google_uid TEXT;
CREATE UNIQUE INDEX idx_users_google_uid ON users(google_uid) WHERE google_uid IS NOT NULL;
ALTER TABLE accounts_payable ADD COLUMN attachment_name TEXT;
ALTER TABLE accounts_payable ADD COLUMN attachment_type TEXT;
