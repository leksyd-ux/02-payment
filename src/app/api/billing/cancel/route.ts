import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/security/session";
import { prisma } from "@/lib/prisma";
import { PaymentEventType, SubscriptionStatus } from "@prisma/client";
import { recordPaymentEvent } from "@/lib/payments/flutterwave";
import { z } from "zod";

const cancelSchema = z.object({
  confirmed: z.literal(true, {
    message: "Cancellation confirmation is required.",
  }),
  reason: z.string().max(500).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const sub = session.user.subscription;
    if (!sub || sub.status !== SubscriptionStatus.ACTIVE) {
      return NextResponse.json(
        { error: "No active paid subscription found to cancel." },
        { status: 400 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const parseResult = cancelSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Validation failed.", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { reason } = parseResult.data;
    const now = new Date();

    // Mark subscription for cancellation at period end.
    // Preserves full active access until currentPeriodEnd!
    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        cancelAtPeriodEnd: true,
        cancellationReason: reason || "User requested cancellation",
        canceledAt: now,
      },
    });

    // Record lifecycle event in the append-only ledger
    await recordPaymentEvent({
      userId: session.user.id,
      subscriptionId: sub.id,
      providerReference: `cancel_${session.user.id}_${Date.now()}`,
      eventType: PaymentEventType.CANCELLATION_REQUESTED,
      amountMinor: 0,
      status: "cancellation_scheduled",
      metadata: {
        plan: sub.planInterval,
        reason: reason || "User requested cancellation",
        requestedAt: now.toISOString(),
        accessRetainedUntil: updated.currentPeriodEnd.toISOString(),
      },
    });

    return NextResponse.json({
      success: true,
      message: `Cancellation confirmed. You retain full access until ${new Date(
        updated.currentPeriodEnd
      ).toLocaleDateString()}.`,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: updated.currentPeriodEnd,
      cancellationReason: updated.cancellationReason,
    });
  } catch (error) {
    console.error("Cancel subscription error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred during cancellation." },
      { status: 500 }
    );
  }
}
