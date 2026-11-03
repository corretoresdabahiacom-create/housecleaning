-- HOUSE CLEANING MANAGEMENT — initial schema (Cloudflare D1 / SQLite)
-- Conventions:
--   * Every tenant-owned row carries company_id; the API always filters by it server-side.
--   * Money is stored as INTEGER cents (exact). Currency stored explicitly (ISO 4217).
--   * Timestamps are UTC ISO-8601 strings. Scheduling dates/times are local to companies.timezone.
PRAGMA foreign_keys = ON;

-- ───────────── Auth & company ─────────────
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en','pt','es')),
  email_verified_at TEXT,
  mfa_secret_enc TEXT,                 -- reserved for optional MFA (architecture only)
  is_platform_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  phone TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  created_at TEXT NOT NULL
);

CREATE TABLE company_members (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','manager','scheduler','finance','helper')),
  helper_id TEXT,                      -- set when role = helper
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (company_id, user_id)
);

-- Per-company permission overrides (role -> permission -> allowed)
CREATE TABLE company_roles (
  company_id TEXT NOT NULL REFERENCES companies(id),
  role TEXT NOT NULL,
  permission TEXT NOT NULL,
  allowed INTEGER NOT NULL,
  PRIMARY KEY (company_id, role, permission)
);

CREATE TABLE user_sessions (
  id TEXT PRIMARY KEY,                 -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);
CREATE INDEX idx_sessions_user ON user_sessions(user_id);

CREATE TABLE user_tokens (                -- email verification + password reset
  id TEXT PRIMARY KEY,                 -- sha256(token)
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('verify_email','reset_password')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);

-- ───────────── Customers & properties ─────────────
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  full_name TEXT NOT NULL,
  phone TEXT,
  whatsapp TEXT,
  email TEXT,
  language TEXT NOT NULL DEFAULT 'en',
  contact_person TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived','pending')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_company ON customers(company_id, full_name);

CREATE TABLE residential_properties (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  name TEXT NOT NULL,
  street TEXT NOT NULL,
  unit TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  phone TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  pricing_model TEXT NOT NULL DEFAULT 'fixed' CHECK (pricing_model IN ('fixed','hourly','custom')),
  currency TEXT NOT NULL,
  frequency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived','pending')),
  property_type TEXT CHECK (property_type IN ('house','apartment','condo','townhouse','other')),
  bedrooms INTEGER, bathrooms INTEGER, size_sqft INTEGER, floors INTEGER,
  parking TEXT, pets TEXT, special_instructions TEXT,
  preferred_time TEXT, estimated_minutes INTEGER,
  private_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_props_company ON residential_properties(company_id, status);
CREATE INDEX idx_props_customer ON residential_properties(company_id, customer_id);

-- Sensitive access information: AES-GCM encrypted, restricted permission, never in lists/notifications.
CREATE TABLE property_access_instructions (
  property_id TEXT PRIMARY KEY REFERENCES residential_properties(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE property_default_helpers (   -- default property team
  company_id TEXT NOT NULL REFERENCES companies(id),
  property_id TEXT NOT NULL REFERENCES residential_properties(id),
  helper_id TEXT NOT NULL REFERENCES helper_records(id),
  pay_basis TEXT NOT NULL DEFAULT 'fixed' CHECK (pay_basis IN ('fixed','daily','hourly','other')),
  rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
  PRIMARY KEY (property_id, helper_id)
);

-- ───────────── Services ─────────────
CREATE TABLE cleaning_services (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'residential' CHECK (category IN ('residential','deep','move','additional','other')),
  description TEXT,
  estimated_minutes INTEGER,
  default_price_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_price_cents >= 0),
  currency TEXT NOT NULL,
  checklist TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE property_service_prices (     -- negotiated per-property price per service
  company_id TEXT NOT NULL REFERENCES companies(id),
  property_id TEXT NOT NULL REFERENCES residential_properties(id),
  service_id TEXT NOT NULL REFERENCES cleaning_services(id),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (property_id, service_id)
);

-- ───────────── Helpers & teams ─────────────
CREATE TABLE helper_records (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  full_name TEXT NOT NULL,
  state TEXT NOT NULL,
  city TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  phone TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  main_function TEXT NOT NULL,
  email TEXT, experience TEXT, skills TEXT, availability TEXT, certifications TEXT, description TEXT,
  favorite INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  default_pay_basis TEXT NOT NULL DEFAULT 'fixed' CHECK (default_pay_basis IN ('fixed','daily','hourly','other')),
  default_rate_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_rate_cents >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_helpers_company ON helper_records(company_id, status);

CREATE TABLE helper_private_notes (        -- notes & evaluations: never visible to helpers
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  helper_id TEXT NOT NULL REFERENCES helper_records(id),
  kind TEXT NOT NULL CHECK (kind IN ('note','evaluation')),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE helper_payment_rates (        -- negotiated rate per helper per property
  company_id TEXT NOT NULL REFERENCES companies(id),
  helper_id TEXT NOT NULL REFERENCES helper_records(id),
  property_id TEXT NOT NULL REFERENCES residential_properties(id),
  pay_basis TEXT NOT NULL CHECK (pay_basis IN ('fixed','daily','hourly','other')),
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
  PRIMARY KEY (helper_id, property_id)
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id),
  helper_id TEXT NOT NULL REFERENCES helper_records(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  PRIMARY KEY (team_id, helper_id)
);

-- ───────────── Scheduling ─────────────
CREATE TABLE recurring_service_rules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  property_id TEXT NOT NULL REFERENCES residential_properties(id),
  service_id TEXT REFERENCES cleaning_services(id),
  frequency TEXT NOT NULL CHECK (frequency IN ('once','daily','weekly','twice_weekly','biweekly','triweekly','monthly','bimonthly','custom')),
  interval_days INTEGER,               -- for custom
  weekdays TEXT,                       -- CSV of 0..6 (0 = Sunday)
  start_date TEXT NOT NULL,            -- YYYY-MM-DD (company local)
  end_date TEXT,
  start_time TEXT NOT NULL,            -- HH:MM
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  paused_from TEXT, paused_until TEXT,
  exceptions TEXT,                     -- CSV of YYYY-MM-DD skipped dates (holidays)
  active INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE cleaning_appointments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  property_id TEXT NOT NULL REFERENCES residential_properties(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  service_id TEXT REFERENCES cleaning_services(id),
  rule_id TEXT REFERENCES recurring_service_rules(id),
  occurrence_date TEXT,                -- original generated date (dedupe key)
  detached INTEGER NOT NULL DEFAULT 0, -- manually edited; never auto-regenerated
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  base_price_cents INTEGER NOT NULL CHECK (base_price_cents >= 0),   -- snapshot at scheduling
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','in_progress','completed','canceled','rescheduled','customer_unavailable','pending_confirmation')),
  internal_instructions TEXT,
  customer_instructions TEXT,
  notes TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (rule_id, occurrence_date)
);
CREATE INDEX idx_appt_company_date ON cleaning_appointments(company_id, date);
CREATE INDEX idx_appt_property ON cleaning_appointments(company_id, property_id, date);

CREATE TABLE appointment_price_items (     -- add-ons (+) and discounts (-)
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  appointment_id TEXT NOT NULL REFERENCES cleaning_appointments(id),
  kind TEXT NOT NULL CHECK (kind IN ('addon','discount')),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0)
);

CREATE TABLE appointment_helpers (         -- ACTUAL helpers of this appointment (snapshot)
  company_id TEXT NOT NULL REFERENCES companies(id),
  appointment_id TEXT NOT NULL REFERENCES cleaning_appointments(id),
  helper_id TEXT NOT NULL REFERENCES helper_records(id),
  pay_basis TEXT NOT NULL CHECK (pay_basis IN ('fixed','daily','hourly','other')),
  rate_cents INTEGER NOT NULL CHECK (rate_cents >= 0),
  worked_minutes INTEGER,
  attendance TEXT NOT NULL DEFAULT 'assigned' CHECK (attendance IN ('assigned','completed','absent','canceled')),
  PRIMARY KEY (appointment_id, helper_id)
);
CREATE INDEX idx_appt_helpers_helper ON appointment_helpers(company_id, helper_id);

CREATE TABLE appointment_status_history (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  appointment_id TEXT NOT NULL REFERENCES cleaning_appointments(id),
  from_status TEXT, to_status TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

-- ───────────── Financial ─────────────
CREATE TABLE financial_categories (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  dre_group TEXT NOT NULL CHECK (dre_group IN ('direct_cost','operating_expense','financial','tax_deduction')),
  is_system INTEGER NOT NULL DEFAULT 0,
  UNIQUE (company_id, name)
);

CREATE TABLE accounts_receivable (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  property_id TEXT REFERENCES residential_properties(id),
  appointment_id TEXT UNIQUE REFERENCES cleaning_appointments(id),  -- one invoice per appointment
  description TEXT NOT NULL,
  revenue_class TEXT NOT NULL DEFAULT 'residential' CHECK (revenue_class IN ('residential','deep','move','additional','other')),
  gross_cents INTEGER NOT NULL CHECK (gross_cents >= 0),       -- base + add-ons
  discount_cents INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),     -- gross - discounts (amount due)
  currency TEXT NOT NULL,
  issue_date TEXT NOT NULL,            -- accrual/recognition date (= service date)
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partially_paid','paid','canceled','written_off')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ar_company ON accounts_receivable(company_id, status, due_date);

CREATE TABLE receipts (                    -- actual cash in (kind=receipt) or out (kind=refund)
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  receivable_id TEXT NOT NULL REFERENCES accounts_receivable(id),
  kind TEXT NOT NULL DEFAULT 'receipt' CHECK (kind IN ('receipt','refund')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','check','bank_transfer','zelle','credit_card_manual','other')),
  notes TEXT,
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, idempotency_key)
);
CREATE INDEX idx_receipts_company_date ON receipts(company_id, date);

CREATE TABLE accounts_payable (            -- expenses and helper obligations
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK (kind IN ('expense','helper')),
  category_id TEXT REFERENCES financial_categories(id),
  payee TEXT NOT NULL,
  supplier TEXT,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  issue_date TEXT NOT NULL,            -- accrual date (expense date / service date)
  due_date TEXT NOT NULL,
  property_id TEXT REFERENCES residential_properties(id),
  appointment_id TEXT REFERENCES cleaning_appointments(id),
  helper_id TEXT REFERENCES helper_records(id),
  recurring_monthly INTEGER NOT NULL DEFAULT 0,
  recurring_parent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partially_paid','paid','canceled')),
  notes TEXT,
  attachment_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (appointment_id, helper_id)  -- no duplicate helper payable per appointment
);
CREATE INDEX idx_ap_company ON accounts_payable(company_id, kind, status, due_date);

CREATE TABLE payments (                    -- actual cash out against payables
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  payable_id TEXT NOT NULL REFERENCES accounts_payable(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL,
  date TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('cash','check','bank_transfer','zelle','credit_card_manual','other')),
  notes TEXT,
  idempotency_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, idempotency_key)
);
CREATE INDEX idx_payments_company_date ON payments(company_id, date);

CREATE TABLE opening_balances (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (company_id, date)
);

-- ───────────── Messaging (24h expiry) ─────────────
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  helper_id TEXT NOT NULL REFERENCES helper_records(id),
  created_at TEXT NOT NULL,
  UNIQUE (company_id, helper_id)       -- strictly 1:1; bulk = N private conversations
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_user_id TEXT NOT NULL,
  sender_side TEXT NOT NULL CHECK (sender_side IN ('company','helper')),
  body TEXT NOT NULL,                  -- stored verbatim, never altered
  attachment_key TEXT,
  attachment_name TEXT,
  attachment_type TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
CREATE INDEX idx_messages_expiry ON messages(expires_at);

-- ───────────── Security & administration ─────────────
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  user_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,                        -- never contains secrets/access instructions
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_company ON audit_logs(company_id, created_at);

CREATE TABLE security_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT,
  ip_hash TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE consent_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  document TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at TEXT NOT NULL
);

CREATE TABLE background_job_records (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','error')),
  attempts INTEGER NOT NULL,
  details TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);
