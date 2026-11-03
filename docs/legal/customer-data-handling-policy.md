# Customer Data Handling Policy (draft)

> **DRAFT — requires review by a qualified US attorney before use.** It does not guarantee compliance with the laws of any state or of Washington, DC.

- Residential addresses, phone numbers, access instructions, and client details are treated as **sensitive business information**.
- Each cleaning company's data is logically isolated; the application enforces isolation on the server for every request.
- Access instructions (gate codes, key locations, alarm details) are stored encrypted (AES-256-GCM), visible only to roles with the access-information permission, never shown in lists, reports, exports, or notifications, and every view is logged.
- Staff permissions follow least privilege: schedulers cannot see financial data; helper accounts can only use their own private conversation.
- Exports are generated on demand for authorized users; once downloaded, the business is responsible for protecting them.
- Incidents involving unauthorized access will be investigated and notified as required by applicable state breach-notification laws. [Attorney to define timelines and process.]
