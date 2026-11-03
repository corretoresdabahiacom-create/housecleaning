# Encryption key rotation

`ENCRYPTION_KEY` protects property access instructions and MFA secrets (AES-256-GCM). Every encrypted row stores the `key_version` used. The Worker can read the current version and the one before it, and a cron job (every 15 minutes) re-encrypts anything still on the old version.

## Procedure (PowerShell)

Current state example: `ENCRYPTION_KEY` = key **v1**, `ENCRYPTION_KEY_VERSION` = `1` (or unset).

```powershell
# 1. Generate the new key and keep a secure offline copy of BOTH keys.
$new = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])

# 2. Move the current key to ENCRYPTION_KEY_PREVIOUS (paste the existing v1 value).
npx wrangler secret put ENCRYPTION_KEY_PREVIOUS --env staging

# 3. Install the new key as ENCRYPTION_KEY and bump the version (wrangler.toml [vars] or the dashboard).
$new | npx wrangler secret put ENCRYPTION_KEY --env staging
#    ENCRYPTION_KEY_VERSION = "2"
npx wrangler deploy --env staging

# 4. Wait for the next cron run (≤ 15 min). Confirm in Platform admin → Background jobs that
#    "reencrypt_old_key_versions" is ok, then verify nothing is left on v1:
npx wrangler d1 execute hcm-db-staging --env staging --remote --command "SELECT COUNT(*) FROM property_access_instructions WHERE key_version<>2"
npx wrangler d1 execute hcm-db-staging --env staging --remote --command "SELECT COUNT(*) FROM users WHERE mfa_secret_enc IS NOT NULL AND mfa_key_version<>2"

# 5. When both counts are 0, retire the old key.
npx wrangler secret delete ENCRYPTION_KEY_PREVIOUS --env staging
```

Rules:
- Rotate one version at a time (only `current` and `current − 1` are readable).
- Never delete the previous key before both counts are zero, or those records become unreadable.
- Losing the current key makes all encrypted data unreadable — keep an offline backup.

Covered by the automated test “encryption key rotation”.
