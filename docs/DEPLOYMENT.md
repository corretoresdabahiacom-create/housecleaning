# Deployment (staging) and cost estimate

Nothing has been deployed. These steps require your Cloudflare account; do **not** run the production steps, change DNS, or buy a domain without deciding to.

## Staging deployment (PowerShell)

```powershell
npx wrangler login                                   # opens the browser to authorize
npx wrangler d1 create hcm-db-staging                # copy the database_id into wrangler.toml [env.staging]
npx wrangler r2 bucket create hcm-files-staging
npx wrangler d1 migrations apply hcm-db-staging --env staging --remote

# Secret: 32 random bytes, base64. Keep a secure copy — losing it makes access instructions unreadable.
$key = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
$key | npx wrangler secret put ENCRYPTION_KEY --env staging

npm run build
npx wrangler deploy --env staging                    # prints the *.workers.dev staging URL
```

Verify on staging: register a company, check the session cookie is `Secure`, create a property with access instructions, complete an appointment, compare DRE and cash flow, upload a message attachment, then confirm the cron jobs ran in **Settings → Platform admin** (set `is_platform_admin = 1` for your user with `wrangler d1 execute ... --remote`).

## Before production

- Configure an email provider (e.g. Cloudflare Email Service or another transactional provider) and wire `issueToken` in `worker/src/modules/auth.ts` to send verification and reset emails.
- Implement MFA, the company hard-purge job, and key-rotation procedure (see [SECURITY_AUDIT.md](SECURITY_AUDIT.md)).
- Have the legal drafts in [legal/](legal/) reviewed by a US attorney and the financial methodology reviewed by a CPA.
- Add Turnstile or Cloudflare Rate Limiting rules on `/api/auth/*`.

## Infrastructure cost estimate (prices verified 2026-11-03)

Source: Cloudflare's published pricing (developers.cloudflare.com Workers pricing page and cloudflare.com/plans).

| Product | Free plan | Paid plan |
|---|---|---|
| Workers | 100k requests/day, 10 ms CPU/request | $5/month minimum incl. 10M requests and 30M CPU-ms; then $0.30/M requests, $0.02/M CPU-ms |
| Static assets | free, unlimited | free, unlimited |
| D1 | 5M rows read/day, 100k rows written/day, 5 GB | incl. 25B rows read, 50M rows written, 5 GB; then $0.001/M reads, $1.00/M writes, $0.75/GB-month |
| R2 | 10 GB-month, 1M Class A, 10M Class B | $0.015/GB-month, $4.50/M Class A, $0.36/M Class B, no egress fees |
| Cron Triggers | billed as Worker requests/CPU | same |

**Estimate for staging / pilot (≤ 20 companies, ≤ 50 active users):** roughly 0.5–2M API requests and well under 1M D1 writes per month; attachments are deleted after 24 h so R2 storage stays near zero. This fits the **Free plan ($0)** for testing, and comfortably inside the **Workers Paid plan’s included usage ($5/month)** for a pilot. The cron runs every 15 minutes (~2,900 invocations/month), negligible against included usage.

**At 500 companies** (assumption: ~20M requests, ~10M D1 writes, < 5 GB data per month): $5 base + ~$3 extra requests + CPU likely inside or slightly above the included 30M CPU-ms → roughly **$8–15/month**. Actual usage should be measured on staging before relying on this estimate.
