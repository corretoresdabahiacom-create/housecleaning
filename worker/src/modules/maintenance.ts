import { Env, nowIso } from '../lib/core';

// Tenant tables in foreign-key-safe deletion order (children first). Every one has company_id.
const TENANT_TABLES = [
  'appointment_helpers', 'appointment_price_items', 'appointment_status_history', 'receipts', 'payments',
  'accounts_receivable', 'accounts_payable', 'cleaning_appointments', 'recurring_service_rules', 'property_service_prices',
  'property_default_helpers', 'helper_payment_rates', 'property_access_instructions', 'property_photos', 'team_members', 'teams',
  'helper_private_notes', 'message_delivery_events', 'messages', 'conversations', 'residential_properties', 'customers',
  'helper_records', 'cleaning_services', 'financial_categories', 'opening_balances', 'company_roles', 'user_sessions',
] as const;

/**
 * Hard-deletes all data of companies deleted more than PURGE_AFTER_DAYS ago (default 30).
 * Removes R2 objects, every tenant row, memberships, and users who belong to no other company.
 * The company row is kept as an anonymized tombstone (id, purged_at) so the purge is auditable and idempotent.
 */
export async function purgeDeletedCompanies(env: Env, now = Date.now()) {
  const days = parseInt(env.PURGE_AFTER_DAYS || '30', 10);
  const cutoff = new Date(now - days * 864e5).toISOString();
  const { results } = await env.DB.prepare("SELECT id FROM companies WHERE status='deleted' AND purged_at IS NULL AND deleted_at IS NOT NULL AND deleted_at<=?").bind(cutoff).all<any>();
  for (const { id } of results) {
    if (env.FILES) {
      const photos = (await env.DB.prepare('SELECT r2_key FROM property_photos WHERE company_id=?').bind(id).all<any>()).results.map((r) => r.r2_key);
      const atts = (await env.DB.prepare('SELECT attachment_key FROM messages WHERE company_id=? AND attachment_key IS NOT NULL').bind(id).all<any>()).results.map((r) => r.attachment_key);
      const keys = [...photos, ...atts];
      for (let i = 0; i < keys.length; i += 500) await env.FILES.delete(keys.slice(i, i + 500));
    }
    const members = (await env.DB.prepare('SELECT user_id FROM company_members WHERE company_id=?').bind(id).all<any>()).results.map((r) => r.user_id as string);
    await env.DB.batch([
      ...TENANT_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE company_id=?`).bind(id)),
      env.DB.prepare('DELETE FROM company_members WHERE company_id=?').bind(id),
      env.DB.prepare("UPDATE companies SET name='[purged]', phone=NULL, city='-', purged_at=? WHERE id=?").bind(nowIso(), id),
      env.DB.prepare("UPDATE audit_logs SET details=NULL WHERE company_id=?").bind(id),
    ]);
    for (const u of members) {
      const other = await env.DB.prepare('SELECT 1 FROM company_members WHERE user_id=?').bind(u).first();
      if (other) continue;
      await env.DB.batch([
        env.DB.prepare('DELETE FROM user_sessions WHERE user_id=?').bind(u),
        env.DB.prepare('DELETE FROM user_tokens WHERE user_id=?').bind(u),
        env.DB.prepare('DELETE FROM mfa_recovery_codes WHERE user_id=?').bind(u),
        env.DB.prepare('DELETE FROM mfa_challenges WHERE user_id=?').bind(u),
        env.DB.prepare('DELETE FROM consent_records WHERE user_id=?').bind(u),
        env.DB.prepare('DELETE FROM users WHERE id=?').bind(u),
      ]);
    }
  }
  // housekeeping
  await env.DB.prepare('DELETE FROM mfa_challenges WHERE expires_at<?').bind(nowIso()).run();
  return results.length;
}
