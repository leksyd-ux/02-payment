import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/security/session";
import { checkRateLimit } from "@/lib/security/rate-limiter";
import { createFlutterwavePaymentLink } from "@/lib/payments/flutterwave";
import { PLAN_PRICING_MINOR } from "@/lib/payments/config";
import { PlanInterval, SubscriptionStatus } from "@prisma/client";
import { z } from "zod";

const checkoutSchema = z.object({
  planInterval: z.enum(["MONTHLY", "YEARLY"]),
});

export async function POST(req: NextRequest) {
  try {
    const session = await getCurrentSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized. Please sign in." }, { status: 401 });
    }

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "127.0.0.1";

    // 1. Rate Limiting on checkout initiation (5 per 10 minutes)
    const rateLimit = await checkRateLimit(`checkout:${session.user.id}:${ip}`, 5, 600);
    if (!rateLimit.success) {
      return NextResponse.json(
        {
          error: "Too many checkout requests. Please wait before attempting again.",
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        {
          status: 429,
          headers: { "Retry-After": rateLimit.retryAfterSeconds.toString() },
        }
      );
    }

    const body = await req.json().catch(() => ({}));
    const parseResult = checkoutSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Invalid plan selection.", details: parseResult.error.flatten() },
        { status: 400 }
      );
    }

    const { planInterval } = parseResult.data;
    const currentSub = session.user.subscription;

    // Handle existing active plan check
    if (
      currentSub &&
      currentSub.status === SubscriptionStatus.ACTIVE &&
      currentSub.planInterval === planInterval &&
      !currentSub.cancelAtPeriodEnd
    ) {
      return NextResponse.json(
        { error: `You are already actively subscribed to the ${planInterval} plan.` },
        { status: 400 }
      );
    }

    const amountMinor = PLAN_PRICING_MINOR[planInterval];

    // Initiate Flutterwave checkout
    const checkout = await createFlutterwavePaymentLink({
      userId: session.user.id,
      userEmail: session.user.email,
      userName: session.user.name,
      amountMinor,
      planInterval,
      isUpgrade: false,
    });

    return NextResponse.json({
      success: true,
      paymentUrl: checkout.paymentUrl,
      txRef: checkout.txRef,
      amountMinor,
    });
  } catch (error) {
    console.error("Checkout initiation error:", error);
    return NextResponse.json(
      { error: "An unexpected error occurred initiating checkout." },
      { status: 500 }
    );
  }
}
