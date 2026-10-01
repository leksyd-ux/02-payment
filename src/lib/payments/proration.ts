import { PlanInterval, Subscription } from "@prisma/client";
import { PLAN_PRICING_MINOR } from "./config";

export interface ProrationCalculation {
  totalCycleDays: number;
  daysElapsed: number;
  daysRemaining: number;
  currentPlanAmountMinor: number;
  dailyRateMinor: number;
  unusedCreditMinor: number;
  newPlanCostMinor: number;
  netChargeMinor: number;
  effectiveDate: Date;
  newPeriodStart: Date;
  newPeriodEnd: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calculates exact to-the-day proration for mid-cycle plan changes (Monthly -> Yearly).
 * All monetary amounts are computed strictly in whole minor units.
 */
export function calculateMidCycleProration(
  subscription: Subscription,
  targetInterval: PlanInterval = PlanInterval.YEARLY,
  asOfDate: Date = new Date()
): ProrationCalculation {
  const periodStart = new Date(subscription.currentPeriodStart).getTime();
  const periodEnd = new Date(subscription.currentPeriodEnd).getTime();
  const now = asOfDate.getTime();

  // Total cycle span in whole calendar days (minimum 1 to prevent division by zero)
  const totalCycleDays = Math.max(1, Math.round((periodEnd - periodStart) / MS_PER_DAY));

  // Compute elapsed vs remaining days within the paid cycle
  const daysElapsed = Math.max(0, Math.min(totalCycleDays, Math.floor((now - periodStart) / MS_PER_DAY)));
  const daysRemaining = Math.max(0, totalCycleDays - daysElapsed);

  const currentPlanAmountMinor = PLAN_PRICING_MINOR[subscription.planInterval];
  const newPlanCostMinor = PLAN_PRICING_MINOR[targetInterval];

  // Daily rate in minor units
  const dailyRateMinor = Math.floor(currentPlanAmountMinor / totalCycleDays);

  // Unused credit earned from remaining paid days
  const unusedCreditMinor = Math.min(currentPlanAmountMinor, daysRemaining * dailyRateMinor);

  // Net prorated charge = New Plan Cost - Unused Credit (floor at 0)
  const netChargeMinor = Math.max(0, newPlanCostMinor - unusedCreditMinor);

  // New period starts immediately upon upgrade and lasts 365 days (1 full year)
  const newPeriodStart = asOfDate;
  const newPeriodEnd = new Date(newPeriodStart.getTime() + 365 * MS_PER_DAY);

  return {
    totalCycleDays,
    daysElapsed,
    daysRemaining,
    currentPlanAmountMinor,
    dailyRateMinor,
    unusedCreditMinor,
    newPlanCostMinor,
    netChargeMinor,
    effectiveDate: asOfDate,
    newPeriodStart,
    newPeriodEnd,
  };
}
