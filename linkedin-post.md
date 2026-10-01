# LinkedIn Post — Payment and Subscription Slice

Floating-point numbers should never be used to represent money.

In JavaScript, `0.1 + 0.2 === 0.30000000000000004`. If your payment system uses floating-point decimals to store account balances or calculate mid-cycle subscription prorations, you are compounding rounding errors with every transaction. Over thousands of billing cycles, that drift produces reconciliation discrepancies, broken audit logs, and accounting nightmares.

For Assessment 2 of our software engineering bootcamp, I built a production-minded subscription slice with Next.js (App Router), TypeScript, Prisma, PostgreSQL, and Flutterwave. The slice handles Free, Pro Monthly (₦5,000.00), and Pro Yearly (₦50,000.00) plans, mid-cycle proration, scheduled downgrades, and cancellation flows.

The foundational rule? Every monetary value is stored strictly as an integer in minor units (kobo).

When a user upgrades from Monthly to Yearly mid-cycle, the server doesn't guess a discount. It executes a to-the-day mathematical proration:
1. It calculates total cycle days (30) and remaining days (e.g. 18 days).
2. It computes the daily rate in minor units: `500,000 kobo / 30 = 16,666 kobo/day`.
3. It derives the exact unused credit: `18 * 16,666 = 299,988 kobo` (₦2,999.88).
4. It subtracts that credit from the new Yearly cost (5,000,000 kobo), charging net `4,700,012 kobo` (₦47,000.12).

Not a single floating-point decimal touched the database. Every lifecycle stage (`INITIATION`, `VERIFICATION`, `FULFILMENT`) was recorded as an immutable row in an append-only payment ledger.

Furthermore, we hardened the webhook against replay attacks using an idempotency table (`ProcessedWebhook`). If Flutterwave retries a webhook delivery three times, the second and third deliveries return `200 OK` with zero duplicate ledger entries and zero duplicate entitlements.

Check out the code, the live proration engine, and the 8-section technical documentation here: https://github.com/leksyd-ux/02-payment-subscription-slice

#SoftwareEngineering #FinTech #WebDevelopment #PostgreSQL #NextJS #TypeScript #CleanCode
