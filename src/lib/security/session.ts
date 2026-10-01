import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { generateRandomToken, hashToken } from "./hash";
import { Subscription, PlanInterval, SubscriptionStatus } from "@prisma/client";

export const SESSION_COOKIE_NAME = "auth_session";
export const SESSION_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export interface SessionUserWithSubscription {
  id: string;
  name: string;
  email: string;
  subscription: Subscription | null;
}

export interface ActiveSession {
  sessionId: string;
  user: SessionUserWithSubscription;
  expiresAt: Date;
}

export async function createSession(userId: string): Promise<string> {
  const rawToken = generateRandomToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_EXPIRY_SECONDS * 1000);

  await prisma.session.create({
    data: {
      userId,
      sessionTokenHash: tokenHash,
      expiresAt,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_EXPIRY_SECONDS,
  });

  return rawToken;
}

export async function getCurrentSession(): Promise<ActiveSession | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const now = new Date();

  const session = await prisma.session.findUnique({
    where: { sessionTokenHash: tokenHash },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          subscriptions: {
            take: 1,
            orderBy: { updatedAt: "desc" },
          },
        },
      },
    },
  });

  if (!session || session.expiresAt <= now) {
    if (session) {
      await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    }
    return null;
  }

  // Ensure user has at least a FREE baseline subscription record
  let sub = session.user.subscriptions[0] || null;
  if (!sub) {
    sub = await prisma.subscription.create({
      data: {
        userId: session.user.id,
        planInterval: PlanInterval.FREE,
        status: SubscriptionStatus.ACTIVE,
      },
    });
  }

  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      subscription: sub,
    },
    expiresAt: session.expiresAt,
  };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    await prisma.session.deleteMany({ where: { sessionTokenHash: tokenHash } }).catch(() => {});
  }

  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
