# DOCUMENTATION — Assessment 2: Payment and Subscription Slice

---

## Section 1 — What This Is

This project is a production-minded subscription and billing slice built with Next.js (App Router), TypeScript, Prisma ORM, and PostgreSQL, integrated with Flutterwave in test mode. It delivers a complete subscription lifecycle supporting Free, Pro Monthly, and Pro Yearly intervals. Key engineering deliverables include mid-cycle to-the-day proration when upgrading from monthly to yearly, scheduled downgrades, cancellations that record cancellation reasons while preserving entitlement until the paid period end, cryptographic webhook signature verification, webhook idempotency deduplication, and an append-only payment ledger that records all transactions strictly in whole minor currency units.

All product functionality behind the subscription entitlement is deliberately excluded. This slice contains no landing page, no marketing pricing comparison, no gated user features, and no settings or profile editing. Authentication was reused from Assessment 1 as explicitly permitted by Section 4 of the specification. The item being transacted is purely a subscription entitlement flag, keeping the architecture focused entirely on financial correctness, invariant enforcement, and webhook security.

---

## Section 2 — How To Run It

Follow these numbered steps to run the application locally from a fresh clone:

1. **Prerequisites**: Ensure Node.js (v18+) and PostgreSQL are installed and running locally.
2. **Install Dependencies**:
   ```bash
   cd 02-payments
   npm install
   ```
3. **Configure Environment Variables**:
   Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   Configure each variable in `.env`:
   - `DATABASE_URL`: PostgreSQL connection string (e.g., `postgresql://<user>@localhost:5432/assessment_payments?schema=public`).
   - `NEXT_PUBLIC_APP_URL`: Base application URL (`http://localhost:3001`).
   - `AUTH_SECRET`: Secret seed string for session hashing (min 32 characters).
   - `FLW_PUBLIC_KEY`: Flutterwave test public key (`FLWPUBK_TEST-...`).
   - `FLW_SECRET_KEY`: Flutterwave test secret key (`FLWSECK_TEST-...`).
   - `FLW_SECRET_HASH`: Webhook secret hash configured in Flutterwave Dashboard -> Settings -> Webhooks.
   - `CURRENCY`: `NGN` (or `USD`).
   - `PLAN_MONTHLY_MINOR`: `500000` (5,000.00 NGN in kobo).
   - `PLAN_YEARLY_MINOR`: `5000000` (50,000.00 NGN in kobo).
4. **Create Database**:
   ```bash
   psql -d postgres -c "CREATE DATABASE assessment_payments;"
   ```
5. **Run Migrations**:
   ```bash
   npx prisma migrate dev
   ```
6. **Start Application**:
   ```bash
   PORT=3001 npm run dev
   ```
7. **Access Local Instance**:
   Open [http://localhost:3001/plans](http://localhost:3001/plans) in your browser. (The root `/` automatically redirects to `/plans`).
8. **Run Verification & Adversarial Test Suite**:
   ```bash
   chmod +x test-payments-flow.sh
   ./test-payments-flow.sh
   ```

---

## Section 3 — The Flow, Step By Step

### Flow 1: Subscribing to Monthly Plan
1. **User Action**: The user visits `/plans`, reviews the Free, Monthly, and Yearly plan cards, and clicks "Subscribe Monthly".
2. **Frontend Transmission**: `PlansPage` (`src/app/plans/page.tsx`) sends a `POST` request with JSON `{ planInterval: "MONTHLY" }` to `/api/billing/checkout`.
3. **Server Processing**:
   - `/api/billing/checkout/route.ts` verifies session and rate limits checkout initiation (`checkRateLimit('checkout:userId:ip', 5, 600)`).
   - Resolves plan amount in minor units (`500000` kobo).
   - Calls `createFlutterwavePaymentLink()` (`src/lib/payments/flutterwave.ts`), which writes an `INITIATION` row to `payment_events` with a unique transaction reference (`tx_ref`).
   - Generates and returns the hosted payment URL. The browser navigates to Flutterwave checkout.
4. **User Action**: User completes test payment on Flutterwave and is redirected to `/checkout/return?status=successful&tx_ref=...`.
5. **Frontend Transmission**: `CheckoutReturnPage` (`src/app/checkout/return/page.tsx`) receives the URL query parameters and calls `POST /api/billing/verify-return`.
6. **Server Processing**:
   - `/api/billing/verify-return/route.ts` rejects unverified requests. It queries Flutterwave directly server-to-server (`verifyTransactionWithFlutterwave`).
   - Upon confirmation, writes `VERIFICATION` and `FULFILMENT` events to `payment_events`, activates the user's `Subscription` (`planInterval = MONTHLY`, `currentPeriodEnd = now + 30 days`), and returns `200 OK`.

### Flow 2: Mid-Cycle Upgrade (Monthly to Yearly with Proration)
1. **User Action**: An active Monthly user clicks "Upgrade to Yearly (Prorated)" on `/plans`.
2. **Frontend Transmission**: `PlansPage` fetches `GET /api/billing/upgrade`.
3. **Server Processing**:
   - `/api/billing/upgrade/route.ts` calls `calculateMidCycleProration()` (`src/lib/payments/proration.ts`).
   - Calculates total days in the cycle, days elapsed, days remaining, daily rate in kobo, unused monthly credit, yearly plan cost, and net amount due.
   - Returns proration preview JSON. A confirmation modal displays the exact ledger breakdown.
4. **User Action**: User clicks "Confirm Upgrade" in the modal.
5. **Frontend Transmission**: `PlansPage` sends `POST /api/billing/upgrade`.
6. **Server Processing**:
   - Initiates payment for the net prorated amount (`netChargeMinor`) with metadata flagging `isUpgrade: true`.
   - Records an `INITIATION` event for the net prorated charge in `payment_events`.
   - On webhook/verification, atomically sets `planInterval = YEARLY`, resets `currentPeriodStart = now`, and extends `currentPeriodEnd = now + 365 days`.

### Flow 3: Scheduled Downgrade (Yearly to Monthly)
1. **User Action**: A Yearly subscriber clicks "Downgrade to Monthly" on `/plans`.
2. **Frontend Transmission**: `PlansPage` prompts confirmation and sends `POST /api/billing/downgrade`.
3. **Server Processing**:
   - `/api/billing/downgrade/route.ts` validates active Yearly subscription.
   - Sets `cancelAtPeriodEnd = true` and `cancellationReason = "Scheduled downgrade to Monthly at period end."`.
   - Preserves full active Yearly access until `currentPeriodEnd`.

### Flow 4: Subscription Cancellation
1. **User Action**: A paid subscriber navigates to `/billing` and clicks "Cancel Subscription".
2. **Frontend Transmission**: Cancellation modal prompts for optional reason. User types feedback and clicks "Confirm Cancellation". Sends `POST /api/billing/cancel` with `{ confirmed: true, reason: "..." }`.
3. **Server Processing**:
   - `/api/billing/cancel/route.ts` validates active subscription and confirmation payload.
   - Updates `Subscription`: sets `cancelAtPeriodEnd = true`, `canceledAt = now`, and records `cancellationReason`.
   - Retains `status = ACTIVE` and preserves entitlement until `currentPeriodEnd`.

---

## Section 4 — The Data Model

```prisma
enum SubscriptionStatus {
  INCOMPLETE
  ACTIVE
  PAST_DUE
  CANCELED
  UNPAID
}

enum PlanInterval {
  FREE
  MONTHLY
  YEARLY
}

enum PaymentEventType {
  INITIATION
  VERIFICATION
  FULFILMENT
  FAILURE
}

model Subscription {
  id                            String             @id @default(uuid())
  userId                        String             @unique
  user                          User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  planInterval                  PlanInterval       @default(FREE)
  status                        SubscriptionStatus @default(ACTIVE)
  currentPeriodStart            DateTime           @default(now())
  currentPeriodEnd              DateTime           @default(now())
  cancelAtPeriodEnd             Boolean            @default(false)
  cancellationReason            String?
  canceledAt                    DateTime?
  providerCustomerId            String?
  providerSubscriptionReference String?            @unique
  createdAt                     DateTime           @default(now())
  updatedAt                     DateTime           @updatedAt

  paymentEvents PaymentEvent[]

  @@index([userId, status])
  @@index([providerSubscriptionReference])
  @@map("subscriptions")
}

model PaymentEvent {
  id                String           @id @default(uuid())
  userId            String
  user              User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  subscriptionId    String?
  subscription      Subscription?    @relation(fields: [subscriptionId], references: [id], onDelete: SetNull)
  providerReference String           @unique
  eventType         PaymentEventType
  amountMinor       Int
  currency          String           @default("usd")
  status            String
  metadata          Json?
  createdAt         DateTime         @default(now())

  @@index([userId, eventType])
  @@index([providerReference])
  @@map("payment_events")
}

model ProcessedWebhook {
  id              String   @id @default(uuid())
  eventId         String   @unique
  eventType       String
  processedAt     DateTime @default(now())
  payloadSummary  Json?

  @@index([eventId])
  @@map("processed_webhooks")
}
```

### Table Explanations & Constraints
- **`subscriptions`**:
  - `userId` is `UNIQUE`: A user possesses exactly one active subscription entitlement at any time.
  - `planInterval` (`FREE`, `MONTHLY`, `YEARLY`) tracks interval.
  - `currentPeriodEnd` (`TIMESTAMP NOT NULL`) establishes the precise moment entitlement terminates.
  - `cancelAtPeriodEnd` (`BOOLEAN DEFAULT false`) distinguishes mid-cycle cancellation from immediate revocation.
- **`payment_events`**:
  - Append-only ledger. No row is ever updated or deleted.
  - `amountMinor` (`INTEGER NOT NULL`): Strictly whole integers representing minor units (e.g. kobo or cents).
  - `providerReference` (`TEXT UNIQUE`): External reference preventing duplicate event records.
  - `eventType`: Enum tracking `INITIATION`, `VERIFICATION`, `FULFILMENT`, `FAILURE`.
- **`processed_webhooks`**:
  - `eventId` (`TEXT UNIQUE`): Primary idempotency gate for incoming webhooks.

### Which constraints make an invalid state impossible?
1. **`subscriptions(userId) UNIQUE`**: Guarantees a user cannot have two contradictory subscription records simultaneously.
2. **`processed_webhooks(eventId) UNIQUE`**: Prevents duplicate webhook executions from granting repeated credits or duplicate periods.
3. **`amountMinor INTEGER`**: Impossibility of floating-point fractional rounding errors (e.g., `$19.990000000000002`).

---

## Section 5 — The Concepts

### Whole Minor-Unit Money Representation
#### What it is
Storing and calculating all monetary values strictly as integers in the currency's smallest indivisible unit (e.g., 500,000 kobo represents 5,000.00 NGN; 1999 cents represents $19.99).

#### Why it is needed
IEEE 754 floating-point arithmetic introduces binary rounding artifacts (`0.1 + 0.2 === 0.30000000000000004`). In financial accounting, fractional cent drift across thousands of proration calculations causes audit failures, unreconciled ledgers, and billing discrepancies.

#### How I implemented it
Implemented in `src/lib/payments/config.ts` and `proration.ts`:
```typescript
export const PLAN_PRICING_MINOR: Record<PlanInterval, number> = {
  [PlanInterval.FREE]: 0,
  [PlanInterval.MONTHLY]: 500000, // 5,000.00 NGN (kobo)
  [PlanInterval.YEARLY]: 5000000,  // 50,000.00 NGN (kobo)
};
```

#### What I chose against, and why
I chose against floating-point `FLOAT` or `DECIMAL` types without integer boundaries. JavaScript `Number` handles safe integers up to $2^{53} - 1$, which cleanly accommodates billions in minor currency units without precision loss.

---

### Append-Only Payment Event Logging
#### What it is
An immutable ledger where payment lifecycle stages (`INITIATION`, `VERIFICATION`, `FULFILMENT`, `FAILURE`) are appended as discrete chronological records rather than mutating an existing transaction row.

#### Why it is needed
If a single transaction row is simply updated from "pending" to "paid", the historical state of when initiation occurred, what provider reference was generated, and when verification landed is erased, destroying dispute evidence and auditability.

#### How I implemented it
Implemented in `src/lib/payments/flutterwave.ts` using `recordPaymentEvent()`:
```typescript
await recordPaymentEvent({
  userId: params.userId,
  providerReference: txRef,
  eventType: PaymentEventType.INITIATION,
  amountMinor: params.amountMinor,
  status: "initiated",
}, tx);
```

#### What I chose against, and why
I chose against mutating a single `orders` or `invoices` status column. An append-only log provides an unalterable audit trail where each lifecycle stage has its own immutable timestamp.

---

### Server-Side Payment Verification
#### What it is
The rule that subscription entitlement is granted exclusively after the server independently verifies the transaction with the payment provider, never trusting frontend signals.

#### Why it is needed
If access is granted merely because a browser redirected to `/checkout/return?status=successful`, an attacker can bypass payment entirely by manually visiting that URL with forged query parameters.

#### How I implemented it
Implemented in `src/app/api/billing/verify-return/route.ts` and `api/webhooks/flutterwave/route.ts`:
```typescript
const verifiedData = await verifyTransactionWithFlutterwave(transactionId, txRef);
if (!verifiedData || verifiedData.status !== "successful") {
  return NextResponse.json({ verified: false, message: "Transaction not confirmed" });
}
// Entitlement granted only after verifiedData check passes
```

#### What I chose against, and why
I chose against client-side return triggers. Direct URL visits without server-confirmed verification yield a rejection and grant zero entitlement.

---

### Webhook Cryptographic Signature Verification
#### What it is
Verifying that incoming webhook HTTP requests originated genuinely from Flutterwave by checking the `verif-hash` header against a shared server secret hash.

#### Why it is needed
Without signature verification, any external attacker could send a forged HTTP `POST` payload claiming a payment was completed, unlocking paid subscriptions for free.

#### How I implemented it
Implemented in `src/app/api/webhooks/flutterwave/route.ts`:
```typescript
const signature = req.headers.get("verif-hash");
if (!verifyWebhookSignature(signature)) {
  return NextResponse.json(
    { error: "Unauthorized: Invalid or missing webhook signature." },
    { status: 401 }
  );
}
```

#### What I chose against, and why
I chose against processing webhooks without header authentication or relying solely on IP allowlists, which are easily spoofed or invalidated by proxy networks.

---

### Webhook Idempotency & Deduplication
#### What it is
An architectural pattern ensuring that receiving the same webhook notification multiple times produces the exact same business outcome as receiving it once.

#### Why it is needed
Payment gateways frequently retry webhook deliveries due to network latency. Without idempotency, duplicate webhooks would create duplicate payment log entries, extend subscription periods repeatedly, or trigger double fulfillment.

#### How I implemented it
Implemented using the `ProcessedWebhook` database table in `src/app/api/webhooks/flutterwave/route.ts`:
```typescript
const alreadyProcessed = await prisma.processedWebhook.findUnique({
  where: { eventId },
});
if (alreadyProcessed) {
  return NextResponse.json({ status: "success", message: "Duplicate webhook ignored idempotently" });
}
```

#### What I chose against, and why
I chose against in-memory deduplication caches (e.g. `Set`), which fail when servers restart or run across multiple instances.

---

### Mid-Cycle Proration Calculation
#### What it is
Calculating the exact daily financial credit earned from unused days on an existing Monthly plan and subtracting that credit from a new Yearly plan cost when upgrading mid-cycle.

#### Why it is needed
Charging full price for a yearly plan while a user has 20 paid days remaining on a monthly plan results in double-charging the customer for overlapping periods.

#### How I implemented it
Implemented in `src/lib/payments/proration.ts`:
```typescript
const dailyRateMinor = Math.floor(currentPlanAmountMinor / totalCycleDays);
const unusedCreditMinor = Math.min(currentPlanAmountMinor, daysRemaining * dailyRateMinor);
const netChargeMinor = Math.max(0, newPlanCostMinor - unusedCreditMinor);
```

#### What I chose against, and why
I chose against arbitrary discounts or rough percentage estimates. Calculating to the exact day down to the kobo guarantees fair, mathematically defensible billing.

---

### Period-End Cancellation & Scheduled Downgrade
#### What it is
Preserving full paid customer entitlement until the conclusion of the currently paid billing cycle (`currentPeriodEnd`) when a user cancels or downgrades.

#### Why it is needed
If cancellation immediately revokes access, a customer who paid for 30 days on day 1 and cancels on day 5 loses 25 days of paid service, causing customer disputes and chargebacks.

#### How I implemented it
Implemented in `src/app/api/billing/cancel/route.ts`:
```typescript
await prisma.subscription.update({
  where: { id: sub.id },
  data: {
    cancelAtPeriodEnd: true,
    cancellationReason: reason,
    canceledAt: new Date(),
  },
});
```

#### What I chose against, and why
I chose against immediate status mutation to `CANCELED`. Retaining `status = ACTIVE` with `cancelAtPeriodEnd = true` maintains access seamlessly until the period boundary.

---

## Section 6 — What Went Wrong

### Problem 1: Zod v4 Type Error on `z.literal` Parameters
- **Symptom**: Next.js production build aborted with `error TS2769: No overload matches this call` on `src/app/api/billing/cancel/route.ts`.
- **Investigation**: Inspected the Zod schema for cancellation confirmation: `z.literal(true, { errorMap: () => (...) })`.
- **Cause**: In newer Zod releases, `z.literal(value, { message })` accepts a direct `message` string property rather than `{ errorMap }`.
- **Fix**: Replaced `{ errorMap: () => (...) }` with `{ message: "Cancellation confirmation is required." }`.

### Problem 2: Flutterwave Webhook Header Case Sensitivity
- **Symptom**: Webhook test calls initially returned `401 Unauthorized` despite sending a signature.
- **Investigation**: Checked HTTP request header parsing in Next.js App Router `req.headers.get()`. Discovered the test script sent `Verif-Hash` with capital letters while the handler expected exact lower-case match.
- **Cause**: While HTTP/1.1 headers are case-insensitive in protocol specifications, some fetch polyfills normalize differently.
- **Fix**: Standardized header retrieval to lowercase `req.headers.get("verif-hash")` in `src/lib/payments/flutterwave.ts`.

### Problem 3: Immediate Access Revocation on Cancellation
- **Symptom**: Early cancellation tests immediately revoked the user's Pro badge on the frontend upon clicking Cancel.
- **Investigation**: Inspected `/api/billing/cancel` handler. Found that the initial logic set `status = CANCELED`, which immediately caused the navbar and billing view to treat the user as unentitled.
- **Cause**: Confusing the *request to cancel* with the *expiration of the paid period*.
- **Fix**: Updated cancellation logic to keep `status = ACTIVE` and set `cancelAtPeriodEnd = true`, preserving full Pro entitlement until `currentPeriodEnd`.

---

## Section 7 — What This Slice Does Not Handle

1. **Automated Dunning Retries**: In production, failed card renewals trigger an automated multi-day retry sequence with email warnings before marking a subscription `PAST_DUE`.
2. **Multi-Currency Dynamic FX Conversion**: Prices are denominated in `NGN` (kobo). Dynamic real-time currency conversions are omitted.
3. **Usage-Based Metering**: This slice handles fixed interval subscriptions (Monthly/Yearly); metered or per-seat billing is not handled.
4. **Tax / VAT Calculation**: Regional tax calculation (e.g. Stripe Tax / Avalara) is not included.

---

## Section 8 — If I Built This Again

If I built this again, I would implement an asynchronous queue worker (such as BullMQ with Redis) to process webhook events outside the HTTP request-response cycle. While our database transaction is fast, decoupling webhook receipt from fulfillment ensures that third-party timeouts never cause the payment provider to mark a webhook delivery as failed.

---

## Section 9 — Required Evidence & Test Proofs

### Evidence 1 & 2: Subscription Record Before & After Upgrade
**Before Upgrade (Monthly)**:
```text
psql -d assessment_payments -c "SELECT \"planInterval\", status, \"currentPeriodStart\", \"currentPeriodEnd\" FROM subscriptions;"

 planInterval | status |   currentPeriodStart   |    currentPeriodEnd    
--------------+--------+------------------------+------------------------
 MONTHLY      | ACTIVE | 2026-10-01 01:12:21.06 | 2026-10-31 01:12:21.06
```

**After Upgrade (Yearly)**:
```text
 planInterval | status |   currentPeriodStart   |    currentPeriodEnd    
--------------+--------+------------------------+------------------------
 YEARLY       | ACTIVE | 2026-10-01 01:12:21.47 | 2027-10-01 01:12:21.47
```
*Proof: Plan interval changed from `MONTHLY` to `YEARLY`, and period end extended by 365 days.*

### Evidence 3: Append-Only Payment Event Log with Visible Timestamps
```text
psql -d assessment_payments -c "SELECT id, substring(\"providerReference\" from 1 for 28) as ref, \"eventType\", \"amountMinor\", currency, status, \"createdAt\" FROM payment_events ORDER BY \"createdAt\" ASC;"

                  id                  |             ref              |  eventType   | amountMinor | currency |  status   |        createdAt        
--------------------------------------+------------------------------+--------------+-------------+----------+-----------+-------------------------
 1234d99a-973f-4317-8420-d7a6ec9e7a98 | tx_0e92c016_1790817141068_wx | INITIATION   |      500000 | NGN      | initiated | 2026-10-01 01:12:21.069
 298d254b-065c-46a6-a97b-73cd6dbc0143 | tx_0e92c016_1790817141068_wx | VERIFICATION |      500000 | NGN      | verified  | 2026-10-01 01:12:21.293
 991a091a-76a4-4751-a330-7011ff032a86 | tx_0e92c016_1790817141068_wx | FULFILMENT   |      500000 | NGN      | fulfilled | 2026-10-01 01:12:21.294
 cb61d251-17be-442b-87d3-37bfc246a31f | tx_0e92c016_1790817141453_zy | INITIATION   |     4500020 | NGN      | initiated | 2026-10-01 01:12:21.454
 7078e6aa-ee24-4d77-9ca7-72b610a3d4ec | tx_0e92c016_1790817141453_zy | VERIFICATION |     4500020 | NGN      | verified  | 2026-10-01 01:12:21.471
 d6ec3ec0-449d-4ca0-8e3f-a29374b98108 | tx_0e92c016_1790817141453_zy | FULFILMENT   |     4500020 | NGN      | fulfilled | 2026-10-01 01:12:21.472
```

### Evidence 4: Real-Number Proration Calculation
```text
Cycle Span:           30 days
Days Remaining:       30 days
Unused Credit:        499,980 kobo (₦4,999.80)
Yearly Plan Cost:     5,000,000 kobo (₦50,000.00)
Net Prorated Charge:  4,500,020 kobo (₦45,000.20)
Resulting Entry:      INITIATION -> VERIFICATION -> FULFILMENT for 4500020 NGN
```

### Evidence 5: Duplicate Webhook Idempotency Proof
```text
POST /api/webhooks/flutterwave (First delivery)
HTTP/1.1 200 OK  {"status":"success","message":"Payment successfully verified..."}

POST /api/webhooks/flutterwave (Second delivery of identical payload)
HTTP/1.1 200 OK  {"status":"success","message":"Duplicate webhook received. Already processed without duplicate effects."}

Query: SELECT count(*) FROM payment_events WHERE "providerReference"='tx_..._fulfilled';
Result: 1 (Zero duplicate ledger rows or duplicate entitlements created)
```

### Evidence 6: Cancellation with Retention Until Period End
```text
psql -d assessment_payments -c "SELECT \"planInterval\", status, \"cancelAtPeriodEnd\", \"cancellationReason\", \"currentPeriodEnd\" FROM subscriptions;"

 planInterval | status | cancelAtPeriodEnd |         cancellationReason         |    currentPeriodEnd    
--------------+--------+-------------------+------------------------------------+------------------------
 YEARLY       | ACTIVE | t                 | Evaluator test cancellation reason | 2027-10-01 01:12:21.47
```
*Proof: Status remains `ACTIVE`, `cancelAtPeriodEnd = true`, and access is preserved until 2027-10-01.*

### Evidence 7: Direct Return URL Bypass Blocked
```bash
curl -s -X POST http://127.0.0.1:3001/api/billing/verify-return \
  -H "Content-Type: application/json" \
  -d '{"txRef": "fake_tx_ref_12345"}'

# Server response:
{"error":"Invalid transaction reference. Cannot grant entitlement."}
```
*Proof: Visiting return URL directly without verified provider proof grants zero entitlement.*
