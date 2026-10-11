import { PlanInterval } from "@prisma/client";

export const CURRENCY = process.env.CURRENCY || "NGN";

/**
 * Provider simulation is opt-in and development-only.
 *
 * It must never be reachable in production, and it must be enabled explicitly:
 * inferring "this is a test environment" from the shape of a secret key string
 * silently disables real verification and turns the fallback into a bypass.
 */
export function isSimulationEnabled(): boolean {
  return process.env.PAYMENTS_SIMULATE === "true" && process.env.NODE_ENV !== "production";
}

/**
 * Resolves the application origin the caller is actually using.
 *
 * Checkout redirects must return to the SAME host the session cookie was issued
 * for. A fixed NEXT_PUBLIC_APP_URL silently breaks that when the app is opened on
 * another host (e.g. 127.0.0.1 vs localhost): the browser lands on a different
 * origin, drops the session cookie, and verification fails with 401 mid-payment.
 * The request's own Host header is authoritative; the env var is the fallback.
 */
export function resolveAppOrigin(req: {
  headers: Headers;
  nextUrl?: { origin: string };
}): string {
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") || "http";
    return `${proto}://${host}`;
  }
  return req.nextUrl?.origin || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

/**
 * Converts a provider amount (major units, e.g. 5000.00 NGN) into whole minor
 * units (e.g. 500000 kobo). Single conversion point, mirrored by formatMoney.
 */
export function toMinorUnits(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

export const PLAN_PRICING_MINOR: Record<PlanInterval, number> = {
  [PlanInterval.FREE]: 0,
  [PlanInterval.MONTHLY]: parseInt(process.env.PLAN_MONTHLY_MINOR || "500000", 10), // 5,000.00 NGN (kobo)
  [PlanInterval.YEARLY]: parseInt(process.env.PLAN_YEARLY_MINOR || "5000000", 10),  // 50,000.00 NGN (kobo)
};

export const PLAN_DETAILS = {
  [PlanInterval.FREE]: {
    name: "Free Plan",
    interval: "free",
    amountMinor: 0,
    features: ["Core access", "Community support"],
  },
  [PlanInterval.MONTHLY]: {
    name: "Pro Monthly",
    interval: "monthly",
    amountMinor: PLAN_PRICING_MINOR[PlanInterval.MONTHLY],
    features: ["Full platform entitlement", "Priority support", "Monthly billing cycle"],
  },
  [PlanInterval.YEARLY]: {
    name: "Pro Yearly",
    interval: "yearly",
    amountMinor: PLAN_PRICING_MINOR[PlanInterval.YEARLY],
    features: [
      "Full platform entitlement",
      "Priority support",
      "Yearly billing (Save ~16%)",
      "Mid-cycle upgrades prorated to the day",
    ],
  },
};

/**
 * Format minor unit whole number into localized currency string.
 * Example: 500000 kobo (NGN) -> "₦5,000.00"
 */
export function formatMoney(amountMinor: number, currency: string = CURRENCY): string {
  const major = amountMinor / 100;
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(major);
}
