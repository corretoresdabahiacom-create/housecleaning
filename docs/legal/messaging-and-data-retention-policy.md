# Messaging and Data Retention Policy (draft)

> **DRAFT — requires review by a qualified US attorney before use.** It does not guarantee compliance with the laws of any state or of Washington, DC.

| Data | Retention |
|---|---|
| Messages and attachments | Hidden from all users exactly 24 hours after each message's own creation time; permanently deleted from the active database and file storage by a background job that runs every 15 minutes. |
| Database backups | The database provider keeps point-in-time recovery history (Cloudflare D1 Time Travel) for a limited period defined by the provider; expired messages may exist in that history until it ages out. Backups are not used to restore expired messages. |
| Message exports | Generated on request from currently active messages and not stored by the Service. A downloaded export is the user's own copy and is outside this retention period. |
| Business records (customers, properties, appointments, financial records) | Kept while the company account is active. Completed financial records are immutable for audit integrity. |
| Deleted company accounts | Deactivated immediately; data purged after [N] days. [Purge job pending implementation.] |
| Audit logs and security events | [N] months. |
| Session records | Until expiry or revocation, then eligible for deletion. |
