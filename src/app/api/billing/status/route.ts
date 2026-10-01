import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/security/session";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ authenticated: false, error: "Unauthorized." }, { status: 401 });
  }

  const paymentEvents = await prisma.paymentEvent.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return NextResponse.json({
    authenticated: true,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
    },
    subscription: session.user.subscription,
    paymentEvents,
  });
}
