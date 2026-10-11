import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyWebhookSignature,
  recordPaymentEvent,
} from "@/lib/payments/flutterwave";
import { PaymentEventType, PlanInterval, SubscriptionStatus } from "@prisma/client";
import { toMinorUnits } from "@/lib/payments/config";

export async function POST(req: NextRequest) {
  try {
    // 1. Signature Verification
    const signature = req.headers.get("verif-hash");
    if (!verifyWebhookSignature(signature)) {
      return NextResponse.json(
        { error: "Unauthorized: Invalid or missing webhook signature." },
        { status: 401 }
      );
    }

    const payload = await req.json().catch(() => null);
    if (!payload || !payload.data) {
      return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
    }

    const event = payload;
    const data = event.data;
    const eventId = String(data.id || data.tx_ref || `evt_${Date.now()}`);
    const txRef = String(data.tx_ref || "");

    // 2. Atomically claim the event (idempotency gate).
    // A check-then-write would let two concurrent deliveries both pass the check,
    // so the unique index on eventId does the claiming in a single statement.
    const claim = await prisma.processedWebhook.createMany({
      data: [
        {
          eventId,
          eventType: event.event || "charge.completed",
          payloadSummary: { txRef, status: data.status, note: "claimed" },
        },
      ],
      skipDuplicates: true,
    });

    if (claim.count === 0) {
      return NextResponse.json(
        {
          status: "success",
          message: "Duplicate webhook received. Already processed without duplicate effects.",
          eventId,
        },
        { status: 200 }
      );
    }

    // 3. Find associated payment initiation
    const initiationEvent = await prisma.paymentEvent.findFirst({
      where: {
        providerReference: txRef,
        eventType: PaymentEventType.INITIATION,
      },
      include: { user: true },
    });

    if (!initiationEvent) {
      // Record unmatched webhook for security auditing
      await prisma.processedWebhook.update({
        where: { eventId },
        data: {
          payloadSummary: { txRef, status: data.status, note: "No matching initiation" },
        },
      });
      return NextResponse.json({ status: "ignored", message: "No matching initiation event found" });
    }

    const userId = initiationEvent.userId;
    const meta = (initiationEvent.metadata as Record<string, unknown>) || {};
    const planInterval = (meta.planInterval as PlanInterval) || PlanInterval.MONTHLY;

    // 4. Bind the webhook to our ledger: same amount, same currency.
    // The signature proves the payload is from Flutterwave, not that the customer
    // paid the full amount for this transaction.
    const receivedMinor = toMinorUnits(Number(data.amount));
    const amountMatches = Number.isFinite(receivedMinor) && receivedMinor === initiationEvent.amountMinor;
    const currencyMatches = String(data.currency || initiationEvent.currency).toUpperCase() ===
      initiationEvent.currency.toUpperCase();

    if (!amountMatches || !currencyMatches) {
      await prisma.$transaction(async (tx) => {
        await recordPaymentEvent(
          {
            userId,
            providerReference: `${txRef}_fail_${eventId}`,
            eventType: PaymentEventType.FAILURE,
            amountMinor: initiationEvent.amountMinor,
            currency: initiationEvent.currency,
            status: "rejected",
            skipIfExists: true,
            metadata: {
              reason: "Amount or currency did not match the initiated charge",
              receivedAmountMinor: receivedMinor,
              receivedCurrency: data.currency ?? null,
            },
          },
          tx
        );
      });

      return NextResponse.json({
        status: "recorded_failure",
        message: "Amount or currency mismatch. Entitlement withheld.",
      });
    }

    // 5. Server-Side Verification of Status
    if (data.status !== "successful") {
      await prisma.$transaction(async (tx) => {
        await recordPaymentEvent(
          {
            userId,
            providerReference: `${txRef}_fail_${eventId}`,
            eventType: PaymentEventType.FAILURE,
            amountMinor: initiationEvent.amountMinor,
            currency: initiationEvent.currency,
            status: "failed",
            skipIfExists: true,
            metadata: { reason: data.processor_response || "Payment unsuccessful", eventId },
          },
          tx
        );
      });

      return NextResponse.json({ status: "recorded_failure" });
    }

    // 6. Grant Entitlement & Record Stages Atomically
    const now = new Date();
    const periodDays = planInterval === PlanInterval.YEARLY ? 365 : 30;
    const currentPeriodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      // Refresh the claim with the resolved outcome
      await tx.processedWebhook.update({
        where: { eventId },
        data: {
          payloadSummary: {
            txRef,
            amount: data.amount,
            currency: data.currency,
            userId,
          },
        },
      });

      // Record VERIFICATION stage
      await recordPaymentEvent(
        {
          userId,
          providerReference: `${txRef}_verified`,
          eventType: PaymentEventType.VERIFICATION,
          amountMinor: initiationEvent.amountMinor,
          currency: initiationEvent.currency,
          status: "verified",
          skipIfExists: true,
          metadata: { flwRef: data.flw_ref, eventId },
        },
        tx
      );

      // Record FULFILMENT stage
      await recordPaymentEvent(
        {
          userId,
          providerReference: `${txRef}_fulfilled`,
          eventType: PaymentEventType.FULFILMENT,
          amountMinor: initiationEvent.amountMinor,
          currency: initiationEvent.currency,
          status: "fulfilled",
          skipIfExists: true,
          metadata: {
            grantedPlan: planInterval,
            periodStart: now.toISOString(),
            periodEnd: currentPeriodEnd.toISOString(),
          },
        },
        tx
      );

      // Update or create Subscription
      await tx.subscription.upsert({
        where: { userId },
        create: {
          userId,
          planInterval,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd,
          cancelAtPeriodEnd: false,
          cancellationReason: null,
          providerSubscriptionReference: txRef,
        },
        update: {
          planInterval,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd,
          cancelAtPeriodEnd: false,
          cancellationReason: null,
          providerSubscriptionReference: txRef,
        },
      });
    });

    return NextResponse.json({
      status: "success",
      message: "Payment successfully verified and subscription fulfilled.",
      planInterval,
    });
  } catch (error) {
    console.error("Webhook processing error:", error);
    return NextResponse.json(
      { error: "Internal error processing webhook." },
      { status: 500 }
    );
  }
}
