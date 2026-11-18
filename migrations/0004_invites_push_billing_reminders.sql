-- Round 4: transactional email log, invitations by link, web push, helper "my day", Stripe billing / payment links, appointment reminders.

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,                 -- sha256(token); the token itself is never stored
  company_id TEXT NOT NULL REFERENCES companies(id),
  email TEXT NOT NULL COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','scheduler','finance','helper')),
  helper_id TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invitations_company ON invitations(company_id, created_at);

CREATE TABLE email_log (                -- delivery outcomes only; subjects, bodies and links are never stored
  id TEXT PRIMARY KEY,
  company_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','disabled')),
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE push_subscriptions (        -- standard Web Push (VAPID); one row per browser/device
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_push_company_user ON push_subscriptions(company_id, user_id);

-- Helper "my day": the helper reports completion; the company decides whether that finalizes the appointment.
ALTER TABLE appointment_helpers ADD COLUMN done_at TEXT;
ALTER TABLE appointment_helpers ADD COLUMN done_minutes INTEGER;
ALTER TABLE companies ADD COLUMN helpers_can_complete INTEGER NOT NULL DEFAULT 0;

-- Appointment reminders (customers opt in; company chooses the channel)
ALTER TABLE companies ADD COLUMN reminder_channel TEXT NOT NULL DEFAULT 'off' CHECK (reminder_channel IN ('off','whatsapp','sms'));
ALTER TABLE customers ADD COLUMN reminder_opt_in INTEGER NOT NULL DEFAULT 0;
CREATE TABLE appointment_reminders (
  appointment_id TEXT NOT NULL REFERENCES cleaning_appointments(id),
  kind TEXT NOT NULL,                  -- '24h'
  company_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (appointment_id, kind)
);

-- Stripe: platform subscriptions (platform key in Worker secrets) and per-company payment links (company's own Stripe key, encrypted)
ALTER TABLE subscription_plans ADD COLUMN stripe_price_id TEXT;
ALTER TABLE companies ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE companies ADD COLUMN stripe_subscription_id TEXT;
CREATE TABLE company_payment_settings (
  company_id TEXT PRIMARY KEY REFERENCES companies(id),
  stripe_key_enc TEXT, stripe_key_iv TEXT, stripe_key_version INTEGER,
  stripe_whsec_enc TEXT, stripe_whsec_iv TEXT, stripe_whsec_version INTEGER,
  updated_at TEXT NOT NULL
);
CREATE TABLE payment_links (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  receivable_id TEXT NOT NULL REFERENCES accounts_receivable(id),
  stripe_session_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','expired')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_payment_links_receivable ON payment_links(company_id, receivable_id);
CREATE TABLE stripe_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);   -- webhook idempotency
