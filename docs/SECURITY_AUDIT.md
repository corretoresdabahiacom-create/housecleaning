# Security audit (internal, pre-staging)

Scope: worker code, schema, frontend, dependencies, as of 2026-11-03. This is a self-review by the development team, not an independent penetration test; an external review is recommended before production.

## Controls implemented

| Area | Control |
|---|---|
| Passwords | PBKDF2-SHA256, 100,000 iterations (WebCrypto maximum on Workers), 16-byte random salt, constant-time compare; policy ≥10 chars with letters and digits; never stored or logged in plaintext |
| Sessions | 256-bit random token in `HttpOnly; Secure; SameSite=Strict` cookie; only its SHA-256 is stored; 14-day expiry; logout, revoke-other-sessions, revocation on password reset, member disable, and company suspension |
| CSRF | SameSite=Strict cookie **and** mandatory `X-Requested-With: hcm` header on every non-GET request; no CORS enabled |
| Account flows | Email verification and reset tokens: random, hashed at rest, single-use, expiring (48 h / 1 h). Forgot-password response is identical whether the account exists |
| Rate limiting | D1 fixed-window counters: login per IP and per email, registration, forgot-password, resend verification |
| Authorization | Server-side RBAC per route with per-company overrides; owner cannot be locked out; UI checks are hints only |
| Tenant isolation | `company_id` from session only; every query scoped; cross-tenant IDs return 404; tested with two companies |
| Injection | All SQL uses bound parameters; dynamic column names come only from validation schemas; LIKE wildcards escaped; table names for ownership checks allow-listed |
| XSS | React escapes output; no `dangerouslySetInnerHTML`; API responses are JSON with `nosniff`; strict CSP on the app shell (`default-src 'self'`, `frame-ancestors 'none'`) |
| Sensitive data | Access instructions AES-256-GCM encrypted with company+property as AAD, separate permission, never in lists/reports/notifications, reads audited. Private helper notes require a separate permission |
| Files | 5 MB limit, type determined by magic bytes (JPEG/PNG/WEBP/PDF), random keys scoped by company/conversation, served as attachment with `nosniff` after authorization, deleted with the message |
| Input | Schema validation on every write; 1 MB body cap; strict date/time/ZIP/email/money formats |
| Logging | Errors logged by name and truncated message only; audit details never include secrets or access instructions (tested) |
| Admin | Platform admin endpoints return 404 to non-admins, expose aggregates only, require a reason for suspension, and are audited |
| Headers | `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on API |
| Dependencies | `npm audit`: 0 vulnerabilities (production and dev) |

## Findings and status

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | Dev tooling (Wrangler 3, Vite 5, Vitest 2) had 13 known advisories (2 critical) | **Fixed** — upgraded; audit clean |
| 2 | Medium | MFA is not implemented (schema field `mfa_secret_enc` reserved) | Open — recommended before production |
| 3 | Medium | Email delivery not configured; verification is not enforced as a login requirement (banner only) | Open — blocked on choosing an email provider |
| 4 | Medium | Rate limiting uses D1 counters (eventually consistent under very high concurrency) | Accepted for MVP; consider Cloudflare Rate Limiting rules / Turnstile on auth endpoints |
| 5 | Low | `ENCRYPTION_KEY` rotation procedure not automated (single key) | Open — document rotation before production |
| 6 | Low | Messages exported by users leave the system (user-owned copy) | By design; disclosed in retention policy |
| 7 | Low | Backups: D1 Time Travel retains history for a limited window, so expired messages may persist in backups for that window | Documented in retention policy |
| 8 | Info | Company deletion deactivates immediately; hard purge job not yet implemented | Open — see STATUS.md |

No critical or high findings remain open.
