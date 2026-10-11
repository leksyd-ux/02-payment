import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/security/session";
import { prisma } from "@/lib/prisma";
import { PlanInterval, SubscriptionStatus, PaymentEventType } from "@prisma/client";
import { recordPaymentEvent } from "@/lib/payments/flutterwave";

export async function POST() {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const sub = session.user.subscription;
    if (!sub || sub.status !== SubscriptionStatus.ACTIVE || sub.planInterval !== PlanInterval.YEARLY) {
      return NextResponse.json(
        { error: "Downgrade is only applicable for active Yearly subscriptions." },
        { status: 400 }
      );
    }

    // Schedule downgrade at currentPeriodEnd without immediately terminating access
    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        cancelAtPeriodEnd: true,
        cancellationReason: "Scheduled downgrade to Monthly at period end.",
      },
    });

    // Record lifecycle event in the append-only ledger
    await recordPaymentEvent({
      userId: session.user.id,
      subscriptionId: sub.id,
      providerReference: `downgrade_${session.user.id}_${Date.now()}`,
      eventType: PaymentEventType.DOWNGRADE_SCHEDULED,
      amountMinor: 0,
      status: "scheduled",
      metadata: {
        fromPlan: PlanInterval.YEARLY,
        toPlan: PlanInterval.MONTHLY,
        scheduledAt: new Date().toISOString(),
        effectiveAt: updated.currentPeriodEnd.toISOString(),
      },
    });

    return NextResponse.json({
      success: true,
      message: `Your Yearly plan will downgrade at the end of your billing cycle on ${new Date(
        updated.currentPeriodEnd
      ).toLocaleDateString()}. Access is preserved until then.`,
      currentPeriodEnd: updated.currentPeriodEnd,
    });
  } catch (error) {
    console.error("Downgrade error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred scheduling the downgrade." },
      { status: 500 }
    );
  }
}

