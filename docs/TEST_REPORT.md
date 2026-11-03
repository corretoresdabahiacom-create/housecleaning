# Test execution report

**Date:** 2026-11-03 · **Runner:** Vitest (latest) on Node 22.23 · **Command:** `npm test`
**Result:** 2 files, **29 tests, 29 passed, 0 failed.**

## How the tests run

The API tests call the real Worker request handler (`handleApi`) — the same code that runs in production — against an in-memory SQLite database built from the real `migrations/0001_init.sql`. A small adapter gives `node:sqlite` the D1 interface, including transactional `batch()`. R2 is an in-memory fake. Nothing is mocked inside the application.

In addition, the app was run on the actual Workers runtime (`wrangler dev`, workerd + local D1): registration, encrypted access instructions, appointment completion, DRE, static asset serving, and all four cron jobs were exercised and returned the expected results. Screenshots in `docs/screenshots/` were captured from that running instance with headless Chrome.

## Coverage against the requested test list

| Area | Tests | Status |
|---|---|---|
| Money | decimal parsing, float rejection, 0.10 + 0.20, hourly rounding, basis points | ✓ |
| Recurrence engine | weekly, twice weekly, biweekly, triweekly, monthly (31st clamp), bimonthly, custom interval, daily, one-time, end date, holidays, pauses, determinism, no duplicates, overlap detection | ✓ |
| CSV | formula-injection neutralization, quoting | ✓ |
| Auth | register, weak password, duplicate email (case-insensitive), hashed storage, verify email (single use), logout, wrong password, forgot/reset (revokes sessions), rate limiting, CSRF header, revoke other sessions | ✓ |
| Customers & properties | customer with multiple properties, address/ZIP validation, search by customer/address/city, LIKE-wildcard escaping, edit, archive | ✓ |
| Access instructions | encrypted at rest, readable by owner, hidden from lists/detail/audit, denied to scheduler | ✓ |
| Pricing | negotiated property price beats service default; editing defaults doesn't change it | ✓ |
| Tenant isolation | two companies; 19 cross-tenant read/write probes (customers, properties, access, history, helpers, notes, appointments, receivables, payables, messages, export, creation with foreign IDs) → 403/404; lists, 8 report exports, and DRE show none of the other company's data | ✓ |
| Scheduling | recurring creation, idempotent regeneration, modify future recurrence, completed history preserved, manual edits preserved, change default team and price without rewriting history, actual helper snapshot kept, conflict detection with authorized override, cancel, reschedule (original kept), completed immutable | ✓ |
| Helper payments | fixed, daily, hourly, property-specific rate, multiple helpers, absent helper not paid, scheduled not payable, duplicate completion blocked, partial and full payment, idempotency, over-payment rejected, batch pay idempotent, period report and period boundary | ✓ |
| Financial | revenue, add-ons, discounts, partial receipts, refunds, AR/AP summaries, accrual vs cash DRE, cash flow with opening balance and roll-forward, reconciliation, profitability, overview consistency, currency rejection, installments, write-off, cancellation rules, recurring expenses (idempotent) | ✓ |
| Messaging | bulk = N private conversations (no group), helper sees only own conversation, helper denied customers/finance/private notes, attachment upload, spoofed file type rejected, attachment authorization across helpers, verbatim storage, expired messages hidden immediately, purge removes rows and R2 objects, purge retry-safe, expiry = created + 24 h | ✓ |
| Security | SQL-injection payloads inert, XSS stored as data with JSON + nosniff, unknown IDs 404, oversized body 413, mass-assignment of `company_id` ignored, platform admin aggregate-only + audited suspension revoking sessions, permission overrides enforced server-side | ✓ |

## Also verified

- `npm run typecheck` — no errors.
- `npm run build` — production bundle builds (≈296 kB JS, 88 kB gzip).
- `npm audit` — **0 vulnerabilities** after upgrading dev tooling (Wrangler 4, Vite 7, Vitest latest).
- i18n coverage script — every UI string has PT and ES translations (only the language names themselves are intentionally untranslated).

## Not covered by automated tests

- Browser-level end-to-end tests (UI flows were checked manually via the running app and screenshots, not with an automated E2E suite).
- Load/performance testing and D1 limits under concurrency.
- Real email delivery (no provider configured).
- Deployed staging environment (not deployed).
