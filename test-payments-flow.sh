#!/usr/bin/env bash
# ==============================================================================
# Assessment 2 — Payment and Subscription Verification & Adversarial Suite
# Provider: Flutterwave Test Mode
# ==============================================================================

BASE="${BASE:-http://127.0.0.1:3001}"
DB="${DB:-assessment_payments}"
SRC_DIR="${SRC_DIR:-$(cd "$(dirname "$0")" && pwd)/src}"
SECRET_HASH="flutterwave-dev-webhook-secret-hash-assessment"
JAR=$(mktemp /tmp/payment_jar.XXXXXX)

PASS=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

body_of() { curl -s "$@"; }
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# ------------------------------------------------------------------------------
head_ "1. Preflight & Environment Check"
# ------------------------------------------------------------------------------
if [ "$(code_of "$BASE/plans")" = "200" ]; then
  ok "Server responding at $BASE"
else
  bad "Server not responding at $BASE"; exit 1
fi

if psql -d "$DB" -c "SELECT 1" >/dev/null 2>&1; then
  ok "PostgreSQL database '$DB' connected"
else
  bad "Cannot connect to database '$DB'"; exit 1
fi

# Reset test rate limit buckets and seed test user
psql -d "$DB" -c "DELETE FROM rate_limit_buckets; DELETE FROM processed_webhooks;" >/dev/null 2>&1

TEST_EMAIL="evaluator_$(date +%s)@example.com"
LOGIN_RESP=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/demo-login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$TEST_EMAIL\", \"name\": \"Payment Evaluator\"}")

if echo "$LOGIN_RESP" | grep -q "Signed in"; then
  ok "Authenticated test user session created"
else
  bad "Failed to establish test session"; exit 1
fi

# ------------------------------------------------------------------------------
head_ "2. Baseline State & Money Minor Units"
# ------------------------------------------------------------------------------
STATUS_JSON=$(curl -s -b "$JAR" "$BASE/api/billing/status")
PLAN=$(echo "$STATUS_JSON" | grep -o '"planInterval":"[A-Z]*"' | head -1 | cut -d'"' -f4)

if [ "$PLAN" = "FREE" ]; then
  ok "Initial subscription baseline is FREE"
else
  bad "Expected FREE, got $PLAN"
fi

# ------------------------------------------------------------------------------
head_ "3. Checkout Initiation (Monthly) & Minor Unit Storage"
# ------------------------------------------------------------------------------
CHECKOUT_RESP=$(curl -s -b "$JAR" -X POST "$BASE/api/billing/checkout" \
  -H "Content-Type: application/json" \
  -d '{"planInterval": "MONTHLY"}')

TX_REF=$(echo "$CHECKOUT_RESP" | grep -o '"txRef":"[^"]*"' | cut -d'"' -f4)
AMOUNT_MIN=$(echo "$CHECKOUT_RESP" | grep -o '"amountMinor":[0-9]*' | cut -d':' -f2)

if [ -n "$TX_REF" ] && [ "$AMOUNT_MIN" = "500000" ]; then
  ok "Monthly checkout initiated with whole minor units (500000 kobo / 5000 NGN)"
else
  bad "Monthly checkout initiation failed: $CHECKOUT_RESP"; exit 1
fi

# Verify INITIATION row in database
INIT_COUNT=$(psql -d "$DB" -tAc "SELECT count(*) FROM payment_events WHERE \"providerReference\"='$TX_REF' AND \"eventType\"='INITIATION';")
if [ "$INIT_COUNT" = "1" ]; then
  ok "INITIATION event logged in append-only payment_events table"
else
  bad "Missing INITIATION row in database"
fi

# ------------------------------------------------------------------------------
head_ "4. Checkout Initiation Rate Limiting"
# ------------------------------------------------------------------------------
TRIP_CODE=""
for i in 1 2 3 4 5; do
  TRIP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$BASE/api/billing/checkout" \
    -H "Content-Type: application/json" \
    -d '{"planInterval": "YEARLY"}')
done

if [ "$TRIP_CODE" = "429" ]; then
  ok "Checkout initiation rate limit tripped with HTTP 429 Too Many Requests"
else
  bad "Expected 429 on rate limit trip, got $TRIP_CODE"
fi

# Reset buckets for remaining flow
psql -d "$DB" -c "DELETE FROM rate_limit_buckets;" >/dev/null 2>&1

# ------------------------------------------------------------------------------
head_ "5. Webhook Signature Verification"
# ------------------------------------------------------------------------------
# Test 5.1: Missing / Invalid Signature
INVALID_SIG_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/webhooks/flutterwave" \
  -H "Content-Type: application/json" \
  -H "verif-hash: wrong-signature" \
  -d "{\"data\": {\"tx_ref\": \"$TX_REF\", \"status\": \"successful\"}}")

if [ "$INVALID_SIG_CODE" = "401" ]; then
  ok "Webhook rejected invalid signature with 401 Unauthorized"
else
  bad "Expected 401 on invalid signature, got $INVALID_SIG_CODE"
fi

# Test 5.2: Valid Signature
WEBHOOK_PAYLOAD="{\"event\": \"charge.completed\", \"data\": {\"id\": 9876543, \"tx_ref\": \"$TX_REF\", \"flw_ref\": \"FLW_MOCK_12345\", \"amount\": 5000, \"currency\": \"NGN\", \"status\": \"successful\"}}"

VALID_WEBHOOK_RESP=$(curl -s -X POST "$BASE/api/webhooks/flutterwave" \
  -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "$WEBHOOK_PAYLOAD")

if echo "$VALID_WEBHOOK_RESP" | grep -q '"status":"success"'; then
  ok "Valid signed webhook processed successfully"
else
  bad "Webhook processing failed: $VALID_WEBHOOK_RESP"
fi

# ------------------------------------------------------------------------------
head_ "6. Webhook Idempotency (Duplicate Request Proof)"
# ------------------------------------------------------------------------------
DUPLICATE_RESP=$(curl -s -X POST "$BASE/api/webhooks/flutterwave" \
  -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "$WEBHOOK_PAYLOAD")

if echo "$DUPLICATE_RESP" | grep -q "Duplicate webhook received"; then
  ok "Duplicate webhook identified and handled idempotently"
else
  bad "Expected duplicate webhook notice, got: $DUPLICATE_RESP"
fi

# Check that duplicate webhook did not create duplicate fulfilment events
FULFILL_COUNT=$(psql -d "$DB" -tAc "SELECT count(*) FROM payment_events WHERE \"providerReference\"='${TX_REF}_fulfilled';")
if [ "$FULFILL_COUNT" = "1" ]; then
  ok "Zero duplicate fulfilment entries in payment ledger (count = 1)"
else
  bad "Duplicate events detected in payment_events table (count = $FULFILL_COUNT)"
fi

# ------------------------------------------------------------------------------
head_ "7. Verification & Entitlement Check"
# ------------------------------------------------------------------------------
SUB_PLAN=$(psql -d "$DB" -tAc "SELECT \"planInterval\" FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$TEST_EMAIL';")
SUB_STATUS=$(psql -d "$DB" -tAc "SELECT status FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$TEST_EMAIL';")

if [ "$SUB_PLAN" = "MONTHLY" ] && [ "$SUB_STATUS" = "ACTIVE" ]; then
  ok "Entitlement granted: Subscription status ACTIVE on MONTHLY plan"
else
  bad "Subscription update failed: plan=$SUB_PLAN status=$SUB_STATUS"
fi

# ------------------------------------------------------------------------------
head_ "8. Mid-Cycle Proration Calculation (Monthly -> Yearly Upgrade)"
# ------------------------------------------------------------------------------
PRORATION_PREVIEW=$(curl -s -b "$JAR" "$BASE/api/billing/upgrade")
DAYS_REM=$(echo "$PRORATION_PREVIEW" | grep -o '"daysRemaining":[0-9]*' | cut -d':' -f2)
CREDIT=$(echo "$PRORATION_PREVIEW" | grep -o '"unusedCreditMinor":[0-9]*' | cut -d':' -f2)
NET_CHARGE=$(echo "$PRORATION_PREVIEW" | grep -o '"netChargeMinor":[0-9]*' | cut -d':' -f2)

if [ -n "$DAYS_REM" ] && [ -n "$CREDIT" ] && [ -n "$NET_CHARGE" ]; then
  ok "Proration computed with real numbers: $DAYS_REM days remaining, credit=$CREDIT kobo, net=$NET_CHARGE kobo"
else
  bad "Proration preview failed: $PRORATION_PREVIEW"
fi

# Confirm upgrade and execute webhook for prorated payment
UPGRADE_RESP=$(curl -s -b "$JAR" -X POST "$BASE/api/billing/upgrade")
UPGRADE_TX_REF=$(echo "$UPGRADE_RESP" | grep -o '"txRef":"[^"]*"' | cut -d'"' -f4)

# Provider amounts are in major units. Integer division would silently drop the
# leftover minor units (4500020 -> 45000 instead of 45000.20), so convert exactly.
NET_MAJOR=$(awk "BEGIN{printf \"%.2f\", $NET_CHARGE/100}")
UPGRADE_WEBHOOK="{\"event\": \"charge.completed\", \"data\": {\"id\": 9988776, \"tx_ref\": \"$UPGRADE_TX_REF\", \"flw_ref\": \"FLW_UPGRADE_6789\", \"amount\": $NET_MAJOR, \"currency\": \"NGN\", \"status\": \"successful\"}}"

curl -s -X POST "$BASE/api/webhooks/flutterwave" \
  -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "$UPGRADE_WEBHOOK" >/dev/null

NEW_PLAN=$(psql -d "$DB" -tAc "SELECT \"planInterval\" FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$TEST_EMAIL';")
if [ "$NEW_PLAN" = "YEARLY" ]; then
  ok "Upgrade executed: Subscription plan successfully upgraded to YEARLY"
else
  bad "Upgrade plan check failed, got $NEW_PLAN"
fi

# ------------------------------------------------------------------------------
head_ "9. Scheduled Downgrade"
# ------------------------------------------------------------------------------
DOWN_RESP=$(curl -s -b "$JAR" -X POST "$BASE/api/billing/downgrade")
if echo "$DOWN_RESP" | grep -q "downgrade at the end of your billing cycle"; then
  ok "Downgrade scheduled at period end without immediately revoking access"
else
  bad "Downgrade schedule failed: $DOWN_RESP"
fi

# ------------------------------------------------------------------------------
head_ "10. Cancellation Flow & Retention Until Period End"
# ------------------------------------------------------------------------------
CANCEL_RESP=$(curl -s -b "$JAR" -X POST "$BASE/api/billing/cancel" \
  -H "Content-Type: application/json" \
  -d '{"confirmed": true, "reason": "Evaluator test cancellation reason"}')

CANCEL_FLAG=$(psql -d "$DB" -tAc "SELECT \"cancelAtPeriodEnd\" FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$TEST_EMAIL';")
REASON_SAVED=$(psql -d "$DB" -tAc "SELECT \"cancellationReason\" FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$TEST_EMAIL';")
STILL_ACTIVE=$(psql -d "$DB" -tAc "SELECT status FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$TEST_EMAIL';")

if [ "$CANCEL_FLAG" = "t" ] && [ "$STILL_ACTIVE" = "ACTIVE" ]; then
  ok "Access retained until period end (status=ACTIVE, cancelAtPeriodEnd=true)"
  ok "Cancellation reason recorded: '$REASON_SAVED'"
else
  bad "Cancellation retention failed: flag=$CANCEL_FLAG, status=$STILL_ACTIVE"
fi

# ------------------------------------------------------------------------------
head_ "11. Direct Return URL Bypass Test"
# ------------------------------------------------------------------------------
# Visiting the return page without a valid transaction reference must not grant entitlement
BYPASS_RESP=$(curl -s -b "$JAR" -X POST "$BASE/api/billing/verify-return" \
  -H "Content-Type: application/json" \
  -d '{"txRef": "fake_tx_ref_12345"}')

if echo "$BYPASS_RESP" | grep -q "Invalid transaction reference"; then
  ok "Visiting return URL directly without server-verified proof rejected (entitlement blocked)"
else
  bad "Security bypass flaw detected: $BYPASS_RESP"
fi

# ------------------------------------------------------------------------------
head_ "12. Verification Binding & Ledger Idempotency Adversaries"
# ------------------------------------------------------------------------------
# Entitlement may only be granted when the provider's answer is bound to OUR
# ledger row: same transaction reference, same amount, same currency.

# 12.1 Signed webhook claiming success with a fraction of the amount charged.
UNDERPAID_TX="tx_underpaid_$(date +%s)"
UNDERPAID_USER="underpaid_$(date +%s)@example.com"
curl -s -c "$JAR" -X POST "$BASE/api/auth/demo-login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$UNDERPAID_USER\", \"name\": \"Underpaid\"}" -o /dev/null
UNDERPAID_ID=$(psql -d "$DB" -tAc "SELECT u.id FROM users u WHERE u.email='$UNDERPAID_USER';")

# Give this user a real INITIATION row for a yearly charge, then report 1/100th of it.
psql -d "$DB" -tAc "INSERT INTO payment_events (id,\"userId\",\"providerReference\",\"eventType\",\"amountMinor\",currency,status,metadata,\"createdAt\") SELECT gen_random_uuid(), '$UNDERPAID_ID', '$UNDERPAID_TX','INITIATION',5000000,'NGN','initiated','{\"planInterval\":\"YEARLY\"}'::jsonb,now();" >/dev/null

UNDERPAID_RESP=$(curl -s -X POST "$BASE/api/webhooks/flutterwave" \
  -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "{\"event\": \"charge.completed\", \"data\": {\"id\": 700001, \"tx_ref\": \"$UNDERPAID_TX\", \"amount\": 500, \"currency\": \"NGN\", \"status\": \"successful\"}}")

# The INITIATION above is 5000000 minor (50000.00 NGN); the webhook reports only 500.00 NGN.
UNDERPAID_DB=$(psql -d "$DB" -tAc "SELECT count(*) FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$UNDERPAID_USER' AND s.\"planInterval\" <> 'FREE';")

if echo "$UNDERPAID_RESP" | grep -q "mismatch" && [ "$UNDERPAID_DB" = "0" ]; then
  ok "Underpaid signed webhook rejected and entitlement withheld"
else
  bad "Underpaid webhook granted entitlement: $UNDERPAID_RESP (paid subs=$UNDERPAID_DB)"
fi

# 12.2 Wrong currency, correct numeric amount.
CURRENCY_RESP=$(curl -s -X POST "$BASE/api/webhooks/flutterwave" \
  -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "{\"event\": \"charge.completed\", \"data\": {\"id\": 700002, \"tx_ref\": \"$UNDERPAID_TX\", \"amount\": 50000, \"currency\": \"USD\", \"status\": \"successful\"}}")
CURRENCY_DB=$(psql -d "$DB" -tAc "SELECT count(*) FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$UNDERPAID_USER' AND s.\"planInterval\" <> 'FREE';")

if echo "$CURRENCY_RESP" | grep -q "mismatch" && [ "$CURRENCY_DB" = "0" ]; then
  ok "Currency-mismatch webhook rejected and entitlement withheld"
else
  bad "Currency mismatch granted entitlement: $CURRENCY_RESP (paid subs=$CURRENCY_DB)"
fi

# 12.3 A correct-amount settlement for that same transaction still succeeds,
#      proving the binding check rejects mismatches rather than everything.
BOUND_RESP=$(curl -s -X POST "$BASE/api/webhooks/flutterwave" \
  -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "{\"event\": \"charge.completed\", \"data\": {\"id\": 700003, \"tx_ref\": \"$UNDERPAID_TX\", \"amount\": 50000, \"currency\": \"NGN\", \"status\": \"successful\"}}")
BOUND_DB=$(psql -d "$DB" -tAc "SELECT count(*) FROM subscriptions s JOIN users u ON u.id=s.\"userId\" WHERE u.email='$UNDERPAID_USER' AND s.\"planInterval\"='YEARLY';")

if echo "$BOUND_RESP" | grep -q '"status":"success"' && [ "$BOUND_DB" = "1" ]; then
  ok "Correctly bound settlement still grants entitlement (no over-blocking)"
else
  bad "Correctly bound settlement was rejected: $BOUND_RESP (yearly subs=$BOUND_DB)"
fi

# 12.4 Repeated distinct failure events for one transaction must not 500.
FAIL_TX="tx_failrepeat_$(date +%s)"
FAIL_CODE_A=$(code_of -X POST "$BASE/api/webhooks/flutterwave" -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "{\"event\": \"charge.failed\", \"data\": {\"id\": 700010, \"tx_ref\": \"$FAIL_TX\", \"status\": \"failed\"}}")
FAIL_CODE_B=$(code_of -X POST "$BASE/api/webhooks/flutterwave" -H "Content-Type: application/json" \
  -H "verif-hash: $SECRET_HASH" \
  -d "{\"event\": \"charge.failed\", \"data\": {\"id\": 700011, \"tx_ref\": \"$FAIL_TX\", \"status\": \"failed\"}}")

if [ "$FAIL_CODE_A" = "200" ] && [ "$FAIL_CODE_B" = "200" ]; then
  ok "Repeated distinct failure events handled idempotently (no unique-constraint 500)"
else
  bad "Repeated failure events returned $FAIL_CODE_A then $FAIL_CODE_B"
fi

# 12.5 The verification branch must never be selectable from request input.
if grep -rEq 'startsWith\("flw_sim|startsWith\("test_' "$SRC_DIR/lib" 2>/dev/null; then
  bad "Verification path is still selectable from caller-controlled input"
else
  ok "Verification branch is not reachable from caller-controlled input"
fi

# 12.6 Provider simulation must be explicitly gated and never active in production.
if grep -q 'PAYMENTS_SIMULATE === "true" && process.env.NODE_ENV !== "production"' "$SRC_DIR/lib/payments/config.ts"; then
  ok "Provider simulation is opt-in and hard-disabled when NODE_ENV=production"
else
  bad "Provider simulation gate missing or not production-guarded"
fi

# 12.7 Checkout redirects must resolve the caller's own origin. A hardcoded
#      NEXT_PUBLIC_APP_URL sends 127.0.0.1 visitors to localhost, where the
#      session cookie does not apply and verification fails with 401 mid-payment.
if grep -q 'resolveAppOrigin' "$SRC_DIR/api/billing/checkout/route.ts" 2>/dev/null || \
   grep -q 'resolveAppOrigin' "$SRC_DIR/app/api/billing/checkout/route.ts" 2>/dev/null; then
  ok "Checkout resolves the request origin instead of a fixed APP_URL"
else
  bad "Checkout still uses a fixed NEXT_PUBLIC_APP_URL for redirects"
fi

echo -e "\n================================================================="
echo "  SUMMARY: $PASS passed, $FAIL failed"
echo "================================================================="

if [ "$FAIL" -eq 0 ]; then
  echo "All payment and subscription verification checks passed successfully!"
  exit 0
else
  echo "Some checks failed."
  exit 1
fi
