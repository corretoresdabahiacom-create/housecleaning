# Status — technical report (updated 2026-11-03, round 2)

## Phase summary

| Phase | Outcome |
|---|---|
| 0 Environment audit | Empty repository; Node 22.23 / npm 10.9; no Cloudflare configuration or credentials; target dev OS Windows. Work done on branch `develop`. |
| 1 Product & architecture | [ARCHITECTURE.md](ARCHITECTURE.md), [FINANCIAL_METHODOLOGY.md](FINANCIAL_METHODOLOGY.md), schema in `migrations/0001_init.sql` |
| 2 Foundation | Worker router, auth, sessions, RBAC, i18n (EN/PT/ES), responsive design system |
| 3 Customers & properties | Multi-property customers, encrypted access instructions, search/filters/pagination, history |
| 4 Services & scheduling | Editable services, negotiated prices, recurrence engine, calendar (day/week/month, helper/property/team filters), reschedule/cancel, conflicts |
| 5 Helpers & teams | Helpers, favorites, archive, private notes/evaluations, teams, default vs actual assignments, rates per property |
| 6 Financial | Receivables, receipts, refunds, write-offs, installments, expenses, payables, helper payments, DRE (accrual/cash), cash flow, reconciliation, profitability, overview with charts |
| 7 Messaging | 1:1 conversations, private bulk announcements, attachments in R2, export, WhatsApp links, 24 h expiry job |
| 8 Admin & reports | 22 CSV reports, dashboard, platform admin (aggregate only), job monitoring |
| 9 Security & QA | 29 automated tests passing, security self-audit, `npm audit` clean |
| 11 Round 2 | MFA, company purge, key rotation, Turnstile, browser E2E tests, PDF/XLSX export, real-time chat, translation, property photos, time zone setting, autocomplete, subscription plans, WhatsApp Cloud API, route suggestion |
| 12 Staging deployed | https://house-cleaning-management-staging.pintolimadistribuidora.workers.dev (2026-11-04). D1 migrated, ENCRYPTION_KEY secret set, cron and Durable Object active. R2 pending activation in the dashboard (photos/attachments disabled until then). |
| 10 Staging | Prepared (`wrangler.toml` staging env, [DEPLOYMENT.md](DEPLOYMENT.md)); **not deployed** — needs your Cloudflare login |

## Implemented and tested (automated)

Authentication and sessions · rate limiting · CSRF protection · company registration · roles and permission overrides · members · customers · multiple properties per customer · encrypted access instructions · search · services and negotiated prices · recurring rules (all frequencies, pauses, holidays, end dates) · idempotent generation · rule changes that preserve history · conflicts with override · cancel and reschedule · helpers, rates, attendance · completion → receivable + helper payables · duplicate prevention · receipts, refunds, idempotency, over-payment protection · installments, write-offs · expenses, recurring expenses · payables and payments · helper payment reports and batch pay · DRE accrual and cash · cash flow, opening balance, reconciliation · property profitability · overview · messaging privacy, attachments, expiry purge · CSV exports with injection protection · tenant isolation · platform admin.

## Added in round 2 (implemented and tested)

| Item | What exists | Tests |
|---|---|---|
| Two-step verification | TOTP (RFC 6238) with encrypted secret, 8 single-use recovery codes, replay protection, 5-attempt cap per challenge, enable/disable in Settings | RFC test vectors, API flow, browser E2E |
| Company hard purge | Cron deletes all data, files and orphan users of companies deleted > `PURGE_AFTER_DAYS` (30) ago; anonymized tombstone kept | API test incl. R2 files and other tenant untouched |
| Key rotation | Versioned keys, previous key readable, automatic re-encryption job, [procedure](KEY_ROTATION.md) | API test |
| Turnstile | Server-side siteverify on login/registration when configured; widget in UI | API test with mocked Cloudflare response |
| Browser E2E tests | Playwright against the real Worker + D1 + Durable Object: full business flow, PT/ES switch, real-time chat, MFA login, mobile layout | 5 tests, `npm run test:e2e` |
| PDF and XLSX export | Dependency-free generators for all 22 reports | Validated with openpyxl and pypdf; E2E download |
| Real-time chat | Durable Object WebSocket hub per company (hibernation); events carry IDs only; polling fallback | DO unit test, API test, browser E2E (< 5 s delivery) |
| Translation | On-demand Workers AI translation; original never altered or stored translated | API test with mocked AI binding |
| Property photos | R2, images only (magic bytes), 8 MB, 20 per property, tenant-scoped | API test |
| Time zone | Company setting (IANA, validated); "today", schedules and dashboards use it | API test |
| Autocomplete | Server-side search selectors replace 200-item dropdowns in all forms | Browser E2E |
| Subscription plans | Admin plans, assignment, trial/active/past_due/canceled, property and user limits enforced (402) | API test |
| WhatsApp | Meta WhatsApp Cloud API text sending, opt-in per company, delivery log, failures never block in-app delivery | API test with mocked Meta API |
| Route suggestion | US Census geocoding; nearest-neighbor order by straight-line distance; Google Maps directions link | Unit + API test |

## Implemented but not fully tested

- **Turnstile, WhatsApp, Workers AI and Census geocoder against the real services** — integrations tested against mocked responses that follow the providers' documented formats; not exercised live (no credentials / network access from the build environment).
- **Durable Object in production** — tested on local workerd; not yet deployed.
- **Cron retry/backoff** — verified locally; long-running behavior not observed.
- **Company deletion purge on remote D1** — tested on SQLite; not run on a deployed database.

## Not implemented

- Real email sending (needs a provider).
- WhatsApp template messages (needed to reach helpers outside Meta's 24-hour window) and inbound WhatsApp webhooks.
- Automatic charging of subscription plans (needs a payment processor such as Stripe).
- QR code in MFA setup (manual key and `otpauth://` link are provided).
- Route optimization with real driving times/traffic (only straight-line ordering + Google Maps link).
- Bank connectivity and card payment processing.

## Blocked by external credentials or authorization

- Cloudflare staging deployment, remote D1/R2 creation, and the verified staging URL (needs `wrangler login` or an API token; the account ID is configured).
- Email provider configuration.
- WhatsApp sending in production (code ready; needs a Meta WhatsApp Business account, phone number ID and token).
- Turnstile keys and Workers AI binding (code ready; needs enabling in the Cloudflare account).
- Bank connectivity (manual reconciliation only).
- Payment processing (payments are recorded manually; no card data is collected or stored).

## Requiring legal or accounting review

- All documents in [legal/](legal/) are drafts for attorney review; they do not guarantee compliance in any state.
- DRE and profitability methodology should be reviewed by a qualified US accountant/CPA, including the classification of sales tax and the treatment of write-offs.
- Helper classification (employee vs independent contractor) and payroll obligations are outside the app’s scope.

## Known limitations

- One currency per company; no multi-currency.
- Recurring appointments are generated 90 days ahead (extended every 15 minutes by cron); past dates are not back-filled when a rule starts in the past.
- Reopening a completed appointment is intentionally impossible; corrections are refunds, write-offs, or cancellations.
- Rate limiting is D1-based (fine for MVP scale); Turnstile adds bot protection when enabled.
- Route suggestions ignore appointment times and roads; they are a starting point, not a dispatch plan.
- The E2E suite needs Playwright with Chromium installed locally (`npm i -D playwright; npx playwright install chromium`).
