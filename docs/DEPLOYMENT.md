# Deployment (staging) and cost estimate

Nothing has been deployed. These steps require your Cloudflare account; do **not** run the production steps, change DNS, or buy a domain without deciding to.

## Staging deployment (PowerShell)

The Cloudflare account ID (`38447d80d8f04048737c82c96665f780`) is already set in `wrangler.toml`. Authenticate either interactively (`npx wrangler login`) or with an API token:

```powershell
# Option A: interactive
npx wrangler login
# Option B: API token (dash.cloudflare.com → My Profile → API Tokens → "Edit Cloudflare Workers" template,
#           plus D1:Edit and Workers R2 Storage:Edit permissions)
$env:CLOUDFLARE_API_TOKEN = "<token>"

npx wrangler d1 create hcm-db-staging                # copy the database_id into wrangler.toml [env.staging]
npx wrangler r2 bucket create hcm-files-staging
npx wrangler d1 migrations apply hcm-db-staging --env staging --remote

# Secret: 32 random bytes, base64. Keep a secure copy — losing it makes access instructions unreadable.
$key = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])
$key | npx wrangler secret put ENCRYPTION_KEY --env staging

npm run build
npx wrangler deploy --env staging                    # prints the *.workers.dev staging URL
```

The deploy also creates the `RealtimeHub` Durable Object (SQLite-backed, available on the Workers Free plan).

### Optional features

| Feature | How to enable |
|---|---|
| Bot protection (Turnstile) | Dashboard → Turnstile → add widget for the staging hostname. Set var `TURNSTILE_SITE_KEY` and `npx wrangler secret put TURNSTILE_SECRET --env staging`. Login and registration then require the widget. |
| Message translation | Uncomment the `[env.staging.ai] binding = "AI"` block in `wrangler.toml`. Uses Workers AI model `@cf/meta/m2m100-1.2b`; usage beyond the daily free allocation is billed. |
| WhatsApp sending | Requires a Meta WhatsApp Business account. Set var `WHATSAPP_PHONE_NUMBER_ID` and `npx wrangler secret put WHATSAPP_TOKEN --env staging` (System User token). Then each company must turn it on in Settings. Meta only delivers free-form text within 24 h of the helper's last WhatsApp reply; otherwise an approved template is required (not implemented). |
| Company purge window | Var `PURGE_AFTER_DAYS` (default 30). |
| Key rotation | See [KEY_ROTATION.md](KEY_ROTATION.md). |

Verify on staging: register a company, check the session cookie is `Secure`, create a property with access instructions, complete an appointment, compare DRE and cash flow, upload a message attachment, then confirm the cron jobs ran in **Settings → Platform admin** (set `is_platform_admin = 1` for your user with `wrangler d1 execute ... --remote`).

## Before production

- Configure an email provider (e.g. Cloudflare Email Service or another transactional provider) and wire `issueToken` in `worker/src/modules/auth.ts` to send verification and reset emails.
- Have the legal drafts in [legal/](legal/) reviewed by a US attorney and the financial methodology reviewed by a CPA.
- Enable Turnstile (above) and consider Cloudflare Rate Limiting rules on `/api/auth/*`.
- Integrate a payment processor (e.g. Stripe) if subscription plans should be charged automatically.

## Infrastructure cost estimate (prices verified 2026-11-03)

Source: Cloudflare's published pricing (developers.cloudflare.com Workers pricing page and cloudflare.com/plans).

| Product | Free plan | Paid plan |
|---|---|---|
| Workers | 100k requests/day, 10 ms CPU/request | $5/month minimum incl. 10M requests and 30M CPU-ms; then $0.30/M requests, $0.02/M CPU-ms |
| Static assets | free, unlimited | free, unlimited |
| D1 | 5M rows read/day, 100k rows written/day, 5 GB | incl. 25B rows read, 50M rows written, 5 GB; then $0.001/M reads, $1.00/M writes, $0.75/GB-month |
| R2 | 10 GB-month, 1M Class A, 10M Class B | $0.015/GB-month, $4.50/M Class A, $0.36/M Class B, no egress fees |
| Cron Triggers | billed as Worker requests/CPU | same |
| Durable Objects (SQLite) | available on Free | billed by requests and duration beyond included usage; WebSocket hibernation keeps idle chat connections from accruing duration |
| Workers AI (translation, optional) | daily free allocation | billed per use beyond it |
| US Census geocoder | free, no key | — |

**Estimate for staging / pilot (≤ 20 companies, ≤ 50 active users):** roughly 0.5–2M API requests and well under 1M D1 writes per month; attachments are deleted after 24 h so R2 storage stays near zero. This fits the **Free plan ($0)** for testing, and comfortably inside the **Workers Paid plan’s included usage ($5/month)** for a pilot. The cron runs every 15 minutes (~2,900 invocations/month), negligible against included usage.

**At 500 companies** (assumption: ~20M requests, ~10M D1 writes, < 5 GB data per month): $5 base + ~$3 extra requests + CPU likely inside or slightly above the included 30M CPU-ms → roughly **$8–15/month**. Actual usage should be measured on staging before relying on this estimate.
