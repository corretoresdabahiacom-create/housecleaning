# Financial Data Handling Policy (draft)

> **DRAFT — requires review by a qualified US attorney before use.** It does not guarantee compliance with the laws of any state or of Washington, DC.

- The Service records payments that happened outside it (cash, check, bank transfer, Zelle, manually recorded card payments). It does **not** initiate payments, connect to bank accounts, or collect or store card numbers.
- Amounts are stored as exact integer cents with an explicit currency; reports never mix currencies.
- Completed financial records cannot be silently edited; corrections are recorded as refunds, write-offs, or cancellations and logged in the audit trail.
- Reports identify their basis (accrual or cash) and are management information, not tax filings or GAAP statements. Review with a qualified US accountant or CPA.
- Helper payment records track amounts agreed and paid between the business and its helpers. The Service does not determine worker classification, withholding, or payroll tax obligations.
