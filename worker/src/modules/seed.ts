import { Env, nowIso, uid } from '../lib/core';

// Editable defaults created for each new company (catalog entries, NOT business data).
const SERVICES: [string, string, number][] = [
  ['Standard House Cleaning', 'residential', 150], ['Deep Cleaning', 'deep', 240], ['Recurring Weekly Cleaning', 'residential', 120],
  ['Biweekly Cleaning', 'residential', 150], ['Monthly Cleaning', 'residential', 180], ['Move-In Cleaning', 'move', 300],
  ['Move-Out Cleaning', 'move', 300], ['Post-Construction Cleaning', 'deep', 480], ['Apartment Cleaning', 'residential', 120],
  ['Vacation Home Cleaning', 'residential', 180], ['Airbnb Turnover Cleaning', 'residential', 120], ['Kitchen Deep Cleaning', 'deep', 90],
  ['Bathroom Deep Cleaning', 'deep', 60], ['Interior Window Cleaning', 'additional', 90], ['Laundry Assistance', 'additional', 60],
  ['Customized Cleaning', 'other', 180],
];
const CATEGORIES: [string, string][] = [
  ['Helper labor', 'direct_cost'], ['Cleaning supplies', 'direct_cost'], ['Detergents', 'direct_cost'], ['Disinfectants', 'direct_cost'],
  ['Paper products', 'direct_cost'], ['Gloves and protective equipment', 'direct_cost'], ['Other direct service costs', 'direct_cost'],
  ['Cleaning tools', 'operating_expense'], ['Vacuum cleaners', 'operating_expense'], ['Equipment maintenance', 'operating_expense'],
  ['Fuel', 'operating_expense'], ['Vehicle maintenance', 'operating_expense'], ['Vehicle insurance', 'operating_expense'],
  ['Transportation', 'operating_expense'], ['Parking', 'operating_expense'], ['Accommodation', 'operating_expense'], ['Meals', 'operating_expense'],
  ['Rent', 'operating_expense'], ['Utilities', 'operating_expense'], ['Telephone', 'operating_expense'], ['Internet', 'operating_expense'],
  ['Software', 'operating_expense'], ['Marketing', 'operating_expense'], ['Insurance', 'operating_expense'], ['Professional services', 'operating_expense'],
  ['Licenses and permits', 'operating_expense'], ['Administrative costs', 'operating_expense'], ['Other expenses', 'operating_expense'],
  ['Bank charges', 'financial'], ['Interest', 'financial'], ['Taxes and fees', 'operating_expense'],
  ['Sales tax collected (remitted)', 'tax_deduction'],
];

export async function seedCompanyDefaults(env: Env, companyId: string) {
  const now = nowIso();
  const stmts = [
    ...SERVICES.map(([n, cat, usd]) => env.DB.prepare('INSERT INTO cleaning_services (id,company_id,name,category,default_price_cents,currency,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(uid(), companyId, n, cat, usd * 100, 'USD', now)),
    ...CATEGORIES.map(([n, g]) => env.DB.prepare('INSERT INTO financial_categories (id,company_id,name,dre_group,is_system) VALUES (?,?,?,?,?)')
      .bind(uid(), companyId, n, g, n === 'Helper labor' ? 1 : 0)),
  ];
  await env.DB.batch(stmts);
}

export async function helperLaborCategory(env: Env, companyId: string) {
  const r = await env.DB.prepare("SELECT id FROM financial_categories WHERE company_id=? AND name='Helper labor'").bind(companyId).first<any>();
  return r?.id ?? null;
}
