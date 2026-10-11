import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/security/session";
import { prisma } from "@/lib/prisma";
import {
  verifyTransactionWithFlutterwave,
  recordPaymentEvent,
} from "@/lib/payments/flutterwave";
import { PaymentEventType, PlanInterval, SubscriptionStatus } from "@prisma/client";
import { toMinorUnits } from "@/lib/payments/config";

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { txRef, transactionId } = body;

    if (!txRef) {
      return NextResponse.json({ error: "Transaction reference required" }, { status: 400 });
    }

    // 1. Find initiation event
    const initiation = await prisma.paymentEvent.findFirst({
      where: {
        providerReference: txRef,
        userId: session.user.id,
        eventType: PaymentEventType.INITIATION,
      },
    });

    if (!initiation) {
      return NextResponse.json(
        { error: "Invalid transaction reference. Cannot grant entitlement." },
        { status: 404 }
      );
    }

    // 2. Check if already fulfilled
    const existingFulfilment = await prisma.paymentEvent.findFirst({
      where: {
        providerReference: `${txRef}_fulfilled`,
        eventType: PaymentEventType.FULFILMENT,
      },
    });

    if (existingFulfilment) {
      return NextResponse.json({
        verified: true,
        alreadyProcessed: true,
        message: "Payment already verified and subscription is active.",
      });
    }

    // 3. Perform SERVER-SIDE VERIFICATION against Flutterwave
    const verifiedData = await verifyTransactionWithFlutterwave(
      transactionId || txRef,
      initiation.providerReference
    );

    if (!verifiedData || verifiedData.status !== "successful") {
      // Do NOT grant entitlement
      return NextResponse.json({
        verified: false,
        message: "Transaction not yet confirmed by Flutterwave. Awaiting webhook.",
      });
    }

    // 4. Bind the provider's answer to OUR ledger row.
    // A successful transaction is only proof of payment when it is the same
    // reference, for the same amount, in the same currency. Without these
    // checks a single real payment could be replayed to unlock any plan.
    if (verifiedData.txRef !== initiation.providerReference) {
      return NextResponse.json(
        { verified: false, message: "Transaction reference mismatch. Cannot grant entitlement." },
        { status: 409 }
      );
    }

    if (verifiedData.currency !== initiation.currency) {
      return NextResponse.json(
        { verified: false, message: "Transaction currency mismatch. Cannot grant entitlement." },
        { status: 409 }
      );
    }

    const verifiedMinor = toMinorUnits(Number(verifiedData.amount));
    if (!Number.isInteger(initiation.amountMinor) || verifiedMinor !== initiation.amountMinor) {
      return NextResponse.json(
        {
          verified: false,
          message: `Transaction amount mismatch (expected ${initiation.amountMinor} minor units, received ${verifiedMinor}). Cannot grant entitlement.`,
        },
        { status: 409 }
      );
    }

    // 5. Grant entitlement atomically
    const meta = (initiation.metadata as Record<string, unknown>) || {};
    const planInterval = (meta.planInterval as PlanInterval) || PlanInterval.MONTHLY;
    const now = new Date();
    const periodDays = planInterval === PlanInterval.YEARLY ? 365 : 30;
    const currentPeriodEnd = new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000);

    await prisma.$transaction(async (tx) => {
      await recordPaymentEvent(
        {
          userId: session.user.id,
          providerReference: `${txRef}_verified`,
          eventType: PaymentEventType.VERIFICATION,
          amountMinor: initiation.amountMinor,
          currency: initiation.currency,
          status: "verified",
          skipIfExists: true,
          metadata: { transactionId: verifiedData.id, flwRef: verifiedData.flwRef },
        },
        tx
      );

      await recordPaymentEvent(
        {
          userId: session.user.id,
          providerReference: `${txRef}_fulfilled`,
          eventType: PaymentEventType.FULFILMENT,
          amountMinor: initiation.amountMinor,
          currency: initiation.currency,
          status: "fulfilled",
          skipIfExists: true,
          metadata: { planInterval, periodEnd: currentPeriodEnd.toISOString() },
        },
        tx
      );

      await tx.subscription.upsert({
        where: { userId: session.user.id },
        create: {
          userId: session.user.id,
          planInterval,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd,
          cancelAtPeriodEnd: false,
          cancellationReason: null,
          providerSubscriptionReference: initiation.providerReference,
        },
        update: {
          planInterval,
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: now,
          currentPeriodEnd,
          cancelAtPeriodEnd: false,
          cancellationReason: null,
          providerSubscriptionReference: initiation.providerReference,
        },
      });
    });

    return NextResponse.json({
      verified: true,
      message: "Payment verified successfully by server. Entitlement granted.",
      planInterval,
    });
  } catch (error) {
    console.error("Return verification error:", error);
    return NextResponse.json({ error: "Verification processing failed" }, { status: 500 });
  }
}
