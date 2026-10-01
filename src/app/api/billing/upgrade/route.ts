import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/security/session";
import { calculateMidCycleProration } from "@/lib/payments/proration";
import { createFlutterwavePaymentLink } from "@/lib/payments/flutterwave";
import { PlanInterval, SubscriptionStatus } from "@prisma/client";

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const sub = session.user.subscription;
  if (!sub || sub.status !== SubscriptionStatus.ACTIVE || sub.planInterval !== PlanInterval.MONTHLY) {
    return NextResponse.json(
      { error: "Prorated upgrade is only applicable for active Monthly subscriptions." },
      { status: 400 }
    );
  }

  const proration = calculateMidCycleProration(sub, PlanInterval.YEARLY);

  return NextResponse.json({
    success: true,
    proration,
  });
}

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const sub = session.user.subscription;
    if (!sub || sub.status !== SubscriptionStatus.ACTIVE || sub.planInterval !== PlanInterval.MONTHLY) {
      return NextResponse.json(
        { error: "Prorated upgrade is only applicable for active Monthly subscriptions." },
        { status: 400 }
      );
    }

    // 1. Calculate to-the-day proration
    const proration = calculateMidCycleProration(sub, PlanInterval.YEARLY);

    // 2. Initiate payment for net prorated charge
    const checkout = await createFlutterwavePaymentLink({
      userId: session.user.id,
      userEmail: session.user.email,
      userName: session.user.name,
      amountMinor: proration.netChargeMinor,
      planInterval: PlanInterval.YEARLY,
      isUpgrade: true,
      metadata: {
        unusedCreditMinor: proration.unusedCreditMinor,
        daysRemaining: proration.daysRemaining,
        totalCycleDays: proration.totalCycleDays,
      },
    });

    return NextResponse.json({
      success: true,
      paymentUrl: checkout.paymentUrl,
      txRef: checkout.txRef,
      proration,
    });
  } catch (error) {
    console.error("Upgrade initiation error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred processing the upgrade." },
      { status: 500 }
    );
  }
}
