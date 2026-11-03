# Financial methodology

> Management reports only. They are **not** GAAP-compliant or tax-ready financial statements. Review with a qualified US accountant or CPA. Every DRE response and export carries this disclaimer and states its basis.

## Principles

1. **Integer cents.** All amounts are stored and computed as integer cents. Hourly pay is `floor((rate_cents × minutes + 30) / 60)` (half-up); percentages are integer basis points. No floating-point arithmetic touches money.
2. **One currency per company** (USD by default). Any request with another currency is rejected (`currency_mismatch`); no conversion without a defined rate and date.
3. **Obligations vs cash are separate records.** Receivables/payables are obligations; receipts/payments are cash. An unpaid invoice is never cash received; an unpaid helper obligation is never cash paid.
4. **Revenue is recognized once.** Each completed appointment creates exactly one receivable (`UNIQUE(appointment_id)`); partial payments only change its collection status.
5. **History is immutable.** Completed appointments cannot be edited (except free-text notes) or uncompleted. Corrections are refunds, write-offs, or cancellations, all audited.

## Where revenue and costs come from

| Event | Accrual record | Cash record |
|---|---|---|
| Appointment marked completed | Receivable: gross = base price + add-ons; discount = sum of discounts; amount = gross − discount; issue date = service date | — |
| Helper attended (not absent) a completed appointment | Helper payable at the snapshot rate (fixed, daily, other = rate; hourly = rate × minutes) | — |
| Manual invoice (optional installments) | Receivable(s); installments split exactly, remainder cents on the first | — |
| Expense (optional installments, optional property allocation) | Payable with category; issue date = expense date | Optional immediate payment |
| Customer payment / refund | — | Receipt (`receipt` or `refund`) |
| Bill / helper payment | — | Payment |

Scheduled but not completed appointments never create payables or revenue. Canceled appointments create nothing.

## DRE (income statement) by period

Available daily, weekly, monthly, quarterly, annually, or any custom range, in two bases.

**Accrual basis** (default): receivables by issue date (excluding canceled); refunds by refund date; payables by issue date (excluding canceled).
**Cash basis**: receipts and refunds by date, classified by the related receivable's revenue class; payments by payment date, classified by the payable's category.

| Line | Content |
|---|---|
| 1. Gross revenue | By class: residential, deep, move-in/out, additional services, other |
| 2. Revenue deductions | Discounts · refunds · taxes collected on behalf of government (categories in group `tax_deduction`) · write-offs (accrual only: written-off balance net of amounts received) |
| 3. Net revenue | 1 − 2 |
| 4. Direct costs | Helper labor (helper payables) + categories in group `direct_cost` (supplies, detergents, …) |
| 5. Gross profit | 3 − 4 |
| 6. Operating expenses | Categories in group `operating_expense`, itemized by category |
| 7. Operating result | 5 − 6 |
| 8. Financial result | − categories in group `financial` (bank charges, interest) |
| 9. Net result | 7 + 8 |

Categories are editable; each belongs to one DRE group, so custom account classifications flow into the right line automatically.

## Cash flow

- **Opening balance** = latest manually registered opening balance on or before the period start, rolled forward with all receipts, refunds, and payments between that date and the day before the period. With no registered balance, it starts at zero (and the UI says so).
- **Receipts** = customer receipts in the period. **Payments** = bill/helper payments + customer refunds in the period.
- **Net movement** = receipts − payments. **Closing balance** = opening + net movement.
- **Reconciliation**: the user enters the bank statement closing balance; the system shows the difference or “Reconciled”. There is no bank connection.

## Property profitability (gross contribution)

For each property and period:

```
net revenue        = gross (receivables issued in period) − discounts − refunds (dated in period)
gross contribution = net revenue − helper labor − direct supplies − other directly allocated expenses
margin             = gross contribution ÷ net revenue   (basis points)
```

Only expenses explicitly allocated to a property (`property_id`) are included. **Indirect company expenses are never allocated automatically**, so gross contribution is not net profit, and the UI says this on the page. A by-customer view aggregates the property rows.

Spec example (tested): Johnson Residence, price $180, Maria $70, Ana $70, direct supplies $10 → gross contribution **$30**.

## Reconciliation report (from the automated test “Johnson example”)

The test builds a full month and asserts every figure, including cross-checks between reports:

| Check | Expected | Result |
|---|---|---|
| Invoice = 180 + 30 add-on − 10 discount | $200.00 | ✓ |
| Accrual gross revenue / discounts / net | $210.00 / $10.00 / $200.00 | ✓ |
| Helper labor (2 × $70) + direct supplies | $140.00 + $10.00 | ✓ |
| Gross profit / operating expenses (fuel, unpaid) / net result | $50.00 / $25.50 / $24.50 | ✓ |
| Cash DRE after a $50 partial receipt | revenue $50.00; direct costs $10.00 (unpaid helpers excluded) | ✓ |
| Cash flow (opening $1,000) | receipts $50.00, payments $10.00, closing $1,040.00 | ✓ |
| Duplicate receipt with same idempotency key | ignored | ✓ |
| Over-payment / foreign currency | rejected | ✓ |
| After full payment and a $20 refund | refunds $20.00; net revenue $180.00; closing $1,170.00 | ✓ |
| Next-period opening balance roll-forward | $1,170.00 | ✓ |
| Reconcile with statement $1,170.00 | reconciled | ✓ |
| Profitability: 210 − 10 − 20 − 140 − 10 | contribution $30.00, margin 16.67% | ✓ |
| Overview net result = DRE net result; overview cash receipts = cash flow receipts | equal | ✓ |
| Installments $100 / 3 | $33.34 + $33.33 + $33.33 | ✓ |
| Write-off of $33.33 with $10 received | write-offs $23.33 | ✓ |
| Helper payroll (fixed $70, property rate $75, hourly $25 × 2.5 h, absent daily helper) | $70.00, $75.00, $62.50, nothing | ✓ |
