-- 0002: MFA, company purge, key rotation, photos, coordinates, plans, WhatsApp delivery log, translations cache

-- MFA (TOTP). mfa_secret_enc already exists on users; add enabled flag, IV, recovery codes.
ALTER TABLE users ADD COLUMN mfa_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mfa_secret_iv TEXT;
ALTER TABLE users ADD COLUMN mfa_key_version INTEGER;
ALTER TABLE users ADD COLUMN mfa_last_step INTEGER;      -- replay protection
CREATE TABLE mfa_recovery_codes (
  id TEXT PRIMARY KEY,                                   -- sha256(code)
  user_id TEXT NOT NULL REFERENCES users(id),
  used_at TEXT
);
CREATE TABLE mfa_challenges (                            -- short-lived token between password and TOTP step
  id TEXT PRIMARY KEY,                                   -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

-- Company deletion lifecycle
ALTER TABLE companies ADD COLUMN deleted_at TEXT;
ALTER TABLE companies ADD COLUMN purged_at TEXT;

-- Encryption key versioning for access instructions
ALTER TABLE property_access_instructions ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;

-- Property photos (R2) and optional coordinates for route ordering
CREATE TABLE property_photos (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  property_id TEXT NOT NULL REFERENCES residential_properties(id),
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  caption TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_photos_property ON property_photos(company_id, property_id);
ALTER TABLE residential_properties ADD COLUMN latitude REAL;
ALTER TABLE residential_properties ADD COLUMN longitude REAL;

-- Subscription plans (configuration only; no payment processor integrated)
CREATE TABLE subscription_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  max_properties INTEGER,                                -- NULL = unlimited
  max_users INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
ALTER TABLE companies ADD COLUMN plan_id TEXT REFERENCES subscription_plans(id);
ALTER TABLE companies ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'trial'
  CHECK (subscription_status IN ('trial','active','past_due','canceled'));
ALTER TABLE companies ADD COLUMN trial_ends_at TEXT;

-- WhatsApp (Cloud API) delivery log
CREATE TABLE message_delivery_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  message_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp')),
  status TEXT NOT NULL CHECK (status IN ('sent','failed')),
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

-- Company integration settings (WhatsApp opt-in)
ALTER TABLE companies ADD COLUMN whatsapp_enabled INTEGER NOT NULL DEFAULT 0;
