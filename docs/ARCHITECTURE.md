# Architecture

## Overview

One Cloudflare Worker serves both the API (`/api/*`) and the built React app (static assets, free on Workers). It is a modular monolith: each business area is a module that registers routes on a small in-house router. No web framework, no ORM — dependencies are React only at runtime.

```
Browser (React SPA, EN/PT/ES)
   │  HTTPS, HttpOnly SameSite=Strict session cookie, X-Requested-With: hcm
   ▼
Worker  ── index.ts: CSRF check → session load → route → module handler
   ├─ auth      registration, login, verification, reset, sessions, members, roles, company deletion
   ├─ crm       customers, properties, encrypted access instructions, default teams, services, helpers, teams
   ├─ schedule  recurrence rules, appointments, conflicts, completion → receivable + helper payables
   ├─ finance   receivables, receipts, payables, payments, DRE, cash flow, profitability, reconciliation
   ├─ messages  1:1 conversations, private bulk announcements, R2 attachments, 24h expiry
   └─ reports   CSV exports, dashboard, platform admin (aggregate only), job recorder
   │
   ├─ D1 (SQLite)  all relational data
   ├─ R2           message attachments (magic-byte validated)
   └─ Cron (*/15)  purge expired messages · extend recurring horizon · recurring expenses · prune rate limits
```

Cloudflare Queues and Durable Objects were deliberately **not** used: the background work is small, idempotent batch work that Cron Triggers handle with retries, and messaging uses 15-second polling. Both can be added later without schema changes (see [STATUS.md](STATUS.md)).

## Tenant isolation model

- Every tenant-owned table has `company_id NOT NULL`. The company comes **only** from the server-side session, never from the request body (tested: a `company_id` in the body is ignored).
- Every query filters by `company_id`. Referenced IDs (customer, property, helper, service…) go through `owned()` which checks `id AND company_id` and returns **404** (not 403) so IDs cannot be probed.
- Helpers with logins (`role=helper`) are further restricted to their own conversation.
- Platform administrators see aggregate counts only; suspensions require a reason and are audited.
- The test suite creates two companies and verifies 19 cross-tenant read/write probes and all list/report endpoints (see [TEST_REPORT.md](TEST_REPORT.md)).

## Roles and permissions

Defaults (enforced in `security.ts`, overridable per company in `company_roles`; the owner cannot be locked out):

| Permission | owner/admin | manager | scheduler | finance | helper |
|---|:-:|:-:|:-:|:-:|:-:|
| customers / properties read | ✓ | ✓ | ✓ | ✓ | |
| customers / properties write | ✓ | ✓ | | | |
| property access instructions | ✓ | ✓ | | | |
| schedule read / write | ✓ | ✓ | ✓ | read | |
| helpers private notes & evaluations | ✓ | ✓ | | | |
| finance read | ✓ | ✓ | | ✓ | |
| finance write | ✓ | | | ✓ | |
| reports | ✓ | ✓ | | ✓ | |
| messages | ✓ | ✓ | ✓ | | own only |
| members / company settings | ✓ | | | | |

## Data model (key decisions)

Full schema: [`migrations/0001_init.sql`](../migrations/0001_init.sql).

- **Customer ≠ property.** `customers` 1─N `residential_properties`; each property has its own address, negotiated price, frequency, team, history, and profitability.
- **Prices are snapshots.** `cleaning_appointments.base_price_cents` is copied at scheduling time; add-ons and discounts live in `appointment_price_items`. Editing a property price or a service default price never changes existing appointments. A service default price never overrides a negotiated `property_service_prices` row.
- **Two assignment concepts.** `property_default_helpers` (default team) vs. `appointment_helpers` (actual helpers per appointment, with pay basis and rate snapshot, attendance, and minutes worked). Changing the default team never rewrites appointments.
- **Recurrence without duplicates.** `recurring_service_rules` generate appointments for a 90-day horizon; `UNIQUE(rule_id, occurrence_date)` makes generation idempotent. Editing a rule only replaces future, still-open, non-manually-edited (`detached=0`) appointments with no invoice. Completed history is never touched. Rescheduling keeps the original as `rescheduled` and creates a linked new appointment.
- **Money is integer cents** everywhere (DB `INTEGER`, API accepts `"180.50"` strings or integer cents, UI never parses floats). Currency stored on every money row; a company has one currency and mixing is rejected.
- **Accrual vs cash are separate tables.** `accounts_receivable` / `accounts_payable` hold obligations (accrual); `receipts` / `payments` hold actual cash. Statuses are recomputed from cash records. Duplicate protection: `UNIQUE(appointment_id)` on receivables, `UNIQUE(appointment_id, helper_id)` on helper payables, and `UNIQUE(company_id, idempotency_key)` on receipts and payments.
- **Time.** System timestamps are UTC ISO-8601. Scheduling dates and times are local to `companies.timezone`.
- **Sensitive access info** (`property_access_instructions`) is AES-256-GCM encrypted with the company and property IDs as associated data, readable only with `properties.access_info`, never included in lists, history, reports, or notifications; every read is audited.

Tables: users, companies, company_members, company_roles, user_sessions, user_tokens, rate_limits · customers, residential_properties, property_access_instructions, property_default_helpers · cleaning_services, property_service_prices · helper_records, helper_private_notes, helper_payment_rates, teams, team_members · recurring_service_rules, cleaning_appointments, appointment_price_items, appointment_helpers, appointment_status_history · financial_categories, accounts_receivable, receipts, accounts_payable, payments, opening_balances · conversations, messages · audit_logs, security_events, consent_records, background_job_records.

Compared with the suggested table list, some tables were merged for simplicity: expenses and helper obligations share `accounts_payable` (`kind`), revenue records are the receivables, installments are separate receivable/payable rows, and verification/reset tokens share `user_tokens`.

## API (summary)

All routes are JSON, under `/api`, authenticated by cookie; non-GET requests require header `X-Requested-With: hcm`.

| Area | Endpoints |
|---|---|
| Auth | `POST auth/register, auth/login, auth/logout, auth/verify-email, auth/resend-verification, auth/forgot-password, auth/reset-password` · `GET auth/me, auth/sessions` · `POST auth/sessions/revoke-others` · `PUT auth/language` |
| Company | `GET/POST members` · `PUT members/:id` · `PUT roles/permissions` · `POST company/delete` |
| Customers | `GET/POST customers` (search `q`, `status`, pagination) · `GET/PUT customers/:id` |
| Properties | `GET/POST properties` (filters q, city, state, zip, frequency, status, helper_id, customer_id) · `GET/PUT properties/:id` · `GET/PUT properties/:id/access` · `PUT properties/:id/team` · `PUT properties/:id/service-prices` · `GET properties/:id/history` |
| Services | `GET/POST services` · `PUT services/:id` |
| Helpers | `GET/POST helpers` · `GET/PUT helpers/:id` · `PUT helpers/:id/rates` · `GET/POST helpers/:id/notes` |
| Teams | `GET/POST teams` · `PUT teams/:id/members` · `DELETE teams/:id` |
| Schedule | `GET/POST appointments` (409 `schedule_conflict` unless `force`) · `GET/PUT appointments/:id` · `PUT appointments/:id/helpers` · `POST/DELETE appointments/:id/items` · `POST appointments/:id/status` (completion with attendance) · `POST appointments/:id/reschedule` · `GET/POST rules` · `PUT rules/:id` · `POST rules/:id/generate` |
| Finance | `GET/POST finance/categories` · `GET/POST finance/receivables` · `GET finance/receivables/:id` · `POST finance/receivables/:id/receipts` · `POST finance/receivables/:id/status` · `GET finance/payables` · `POST finance/expenses` · `POST finance/payables/:id/payments` · `POST finance/payables/:id/cancel` · `GET finance/helper-payments` · `POST finance/helper-payments/pay` · `GET finance/dre?basis=accrual|cash` · `GET finance/cashflow` · `GET/POST finance/opening-balances` · `GET finance/reconcile` · `GET finance/profitability` · `GET finance/overview` |
| Messages | `GET/POST conversations` · `GET/POST conversations/:id/messages` (JSON or multipart) · `GET conversations/:id/export` · `POST messages/bulk` · `GET messages/:id/attachment` |
| Reports | `GET reports/:name?format=csv` (22 reports) · `GET dashboard` |
| Admin | `GET admin/companies` · `POST admin/companies/:id/status` · `GET admin/health` |

## Screen map

Login / Register / Forgot / Reset → Dashboard (KPIs, quick actions, today) · Customers (list, detail) · Properties (search + filters, detail with default team, encrypted access, recurring rules, history) · Cleaning Services · Calendar (day / week / month; filters for helper, team, property, service, city, state, status; group by city; appointment drawer: complete with attendance, reschedule, change helpers, add-ons and discounts, maps and WhatsApp links) · Helpers (list, detail with rates, private notes and evaluations, work history) · Teams · Messages (1:1 chat, private announcements, attachments, export) · Financial Management (Overview, Revenue and Receipts, Expenses, Accounts Receivable, Accounts Payable, Helper Payments, DRE, Cash Flow with reconciliation, Property Profitability) · Reports · Settings (language, sessions, users and roles, company deletion) · Platform admin. Helper accounts see Messages only.
