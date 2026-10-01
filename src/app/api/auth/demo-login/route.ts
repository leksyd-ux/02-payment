import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/security/session";
import { hashPassword } from "@/lib/security/hash";
import { PlanInterval, SubscriptionStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = body.email || "demo.evaluator@example.com";
    const name = body.name || "Demo Evaluator";

    const defaultPasswordHash = await hashPassword("AssessmentPassword123!");

    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email,
        name,
        passwordHash: defaultPasswordHash,
        emailVerifiedAt: new Date(),
        subscriptions: {
          create: {
            planInterval: PlanInterval.FREE,
            status: SubscriptionStatus.ACTIVE,
          },
        },
      },
      update: {},
      include: {
        subscriptions: true,
      },
    });

    await createSession(user.id);

    return NextResponse.json({
      success: true,
      message: `Signed in as ${user.name}`,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        subscription: user.subscriptions[0],
      },
    });
  } catch (error) {
    console.error("Demo login error:", error);
    return NextResponse.json({ error: "Failed to establish demo session." }, { status: 500 });
  }
}
