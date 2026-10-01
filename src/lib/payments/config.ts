import { PlanInterval } from "@prisma/client";

export const CURRENCY = process.env.CURRENCY || "NGN";

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
    features: ["Full platform entitlement", "Priority support", "Yearly billing (Save ~16%)"],
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
    minimumFractionDigits: 2,
  }).format(major);
}
