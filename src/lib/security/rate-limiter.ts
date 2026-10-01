import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Database-backed atomic rate limiter using PostgreSQL single-statement upsert.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000);

  const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    INSERT INTO rate_limit_buckets ("id", "key", "count", "expiresAt", "createdAt", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${key}, 1, ${expiresAt}, ${now}, ${now})
    ON CONFLICT ("key") DO UPDATE
      SET "count" = CASE
            WHEN rate_limit_buckets."expiresAt" <= ${now} THEN 1
            ELSE rate_limit_buckets."count" + 1
          END,
          "expiresAt" = CASE
            WHEN rate_limit_buckets."expiresAt" <= ${now} THEN ${expiresAt}
            ELSE rate_limit_buckets."expiresAt"
          END,
          "updatedAt" = ${now}
    WHERE rate_limit_buckets."expiresAt" <= ${now}
       OR rate_limit_buckets."count" < ${maxRequests}
    RETURNING "count"
  `);

  if (rows.length > 0) {
    return {
      success: true,
      remaining: Math.max(0, maxRequests - rows[0].count),
      retryAfterSeconds: 0,
    };
  }

  const current = await prisma.rateLimitBucket.findUnique({ where: { key } });
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil(((current?.expiresAt ?? expiresAt).getTime() - now.getTime()) / 1000)
  );

  return {
    success: false,
    remaining: 0,
    retryAfterSeconds,
  };
}
