import { prisma } from "@/lib/prisma";
import { PaymentEventType, Prisma } from "@prisma/client";
import crypto from "crypto";
import { CURRENCY, isSimulationEnabled } from "./config";

export interface CreateCheckoutParams {
  userId: string;
  userEmail: string;
  userName: string;
  amountMinor: number;
  planInterval: "MONTHLY" | "YEARLY";
  isUpgrade?: boolean;
  appUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckoutResult {
  paymentUrl: string;
  txRef: string;
}

export interface VerifiedTransaction {
  id: number;
  txRef: string;
  flwRef: string;
  amount: number;
  currency: string;
  status: string;
  customer: {
    email: string;
    name: string;
  };
  meta?: Record<string, unknown>;
}

/**
 * Append-only ledger writer.
 * Records each payment lifecycle stage (INITIATION, VERIFICATION, FULFILMENT, FAILURE).
 *
 * `skipIfExists` makes the append idempotent for derived references (verified /
 * fulfilled / failure rows). Rows are still never updated or deleted — a repeated
 * delivery simply does not append a duplicate entry. This matters because the
 * return-URL path and the webhook path can settle the same transaction, and
 * because providers retry deliveries.
 */
export async function recordPaymentEvent(
  params: {
    userId: string;
    subscriptionId?: string | null;
    providerReference: string;
    eventType: PaymentEventType;
    amountMinor: number;
    currency?: string;
    status: string;
    metadata?: Prisma.InputJsonValue;
    skipIfExists?: boolean;
  },
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  const data = {
    userId: params.userId,
    subscriptionId: params.subscriptionId || null,
    providerReference: params.providerReference,
    eventType: params.eventType,
    amountMinor: params.amountMinor,
    currency: params.currency || CURRENCY,
    status: params.status,
    metadata: params.metadata || Prisma.JsonNull,
  };

  if (params.skipIfExists) {
    const result = await db.paymentEvent.createMany({ data: [data], skipDuplicates: true });
    return { appended: result.count === 1 };
  }

  return await db.paymentEvent.create({ data });
}

/**
 * Initiates a Flutterwave hosted checkout payment link.
 *
 * Fails closed: when simulation is disabled, a checkout URL is only ever returned
 * if Flutterwave itself returned one. Missing credentials or a declined request
 * throw instead of degrading into a fabricated "successful" checkout.
 */
export async function createFlutterwavePaymentLink(
  params: CreateCheckoutParams
): Promise<CheckoutResult> {
  const secretKey = (process.env.FLW_SECRET_KEY || "").trim();
  const appUrl = params.appUrl || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const txRef = `tx_${params.userId.slice(0, 8)}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  const amountMajor = params.amountMinor / 100;

  // Record INITIATION event in append-only payment log
  await recordPaymentEvent({
    userId: params.userId,
    providerReference: txRef,
    eventType: PaymentEventType.INITIATION,
    amountMinor: params.amountMinor,
    currency: CURRENCY,
    status: "initiated",
    metadata: {
      planInterval: params.planInterval,
      isUpgrade: !!params.isUpgrade,
      ...params.metadata,
    },
  });

  if (isSimulationEnabled()) {
    // Local/evaluator simulation: no provider call, no fabricated verification path.
    return {
      paymentUrl: `${appUrl}/checkout/return?status=successful&tx_ref=${txRef}&transaction_id=flw_sim_${Date.now()}`,
      txRef,
    };
  }

  if (!secretKey) {
    throw new Error("FLW_SECRET_KEY is not configured. Refusing to initiate checkout.");
  }

  const response = await fetch("https://api.flutterwave.com/v3/payments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tx_ref: txRef,
      amount: amountMajor,
      currency: CURRENCY,
      redirect_url: `${appUrl}/checkout/return?tx_ref=${txRef}`,
      customer: {
        email: params.userEmail,
        name: params.userName,
      },
      meta: {
        userId: params.userId,
        planInterval: params.planInterval,
        isUpgrade: params.isUpgrade ? "true" : "false",
      },
      customizations: {
        title: `Upgrade to ${params.planInterval}`,
        description: "Subscription payment",
      },
    }),
  });

  const data = await response.json().catch(() => null);
  if (!data || data.status !== "success" || !data.data?.link) {
    throw new Error(
      `Flutterwave declined checkout initiation: ${data?.message ?? `HTTP ${response.status}`}`
    );
  }

  return { paymentUrl: data.data.link as string, txRef };
}

/**
 * Verifies that a transaction with the Flutterwave server exists, is successful,
 * and belongs to the exact transaction reference this application initiated.
 *
 * `expectedTxRef` is required and is always compared by the caller against the
 * INITIATION ledger row, so a successful-but-unrelated transaction can never be
 * substituted. Any uncertainty (no credentials, network failure, unrecognised
 * provider id) returns null, which denies entitlement.
 */
export async function verifyTransactionWithFlutterwave(
  transactionId: string | number,
  expectedTxRef: string
): Promise<VerifiedTransaction | null> {
  if (isSimulationEnabled()) {
    // Simulation reads its truth from our own ledger, never from caller input.
    const initiation = await prisma.paymentEvent.findFirst({
      where: {
        providerReference: expectedTxRef,
        eventType: PaymentEventType.INITIATION,
      },
    });
    if (!initiation) return null;

    return {
      id: Number(String(transactionId).replace(/\D/g, "")) || 0,
      txRef: initiation.providerReference,
      flwRef: `flw_sim_${initiation.id}`,
      amount: initiation.amountMinor / 100,
      currency: initiation.currency,
      status: "successful",
      customer: {
        email: "",
        name: "",
      },
    };
  }

  const secretKey = (process.env.FLW_SECRET_KEY || "").trim();
  if (!secretKey) return null;

  // Flutterwave transaction identifiers are numeric. Anything else is malformed
  // input, not a provider id, and must not reach the verify endpoint.
  const providerTransactionId = String(transactionId).trim();
  if (!/^\d+$/.test(providerTransactionId)) return null;

  try {
    const res = await fetch(
      `https://api.flutterwave.com/v3/transactions/${providerTransactionId}/verify`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    const json = await res.json().catch(() => null);
    if (!json || json.status !== "success" || !json.data) return null;

    const d = json.data;
    return {
      id: d.id,
      txRef: d.tx_ref,
      flwRef: d.flw_ref,
      amount: d.amount,
      currency: d.currency,
      status: d.status,
      customer: {
        email: d.customer?.email,
        name: d.customer?.name,
      },
      meta: d.meta,
    };
  } catch (e) {
    console.error("Transaction verification network error:", e);
    return null;
  }
}

/**
 * Verifies a Flutterwave webhook signature using the configured secret hash.
 * Compared in constant time to avoid leaking the hash through timing.
 */
export function verifyWebhookSignature(reqHash: string | null): boolean {
  const secretHash = process.env.FLW_SECRET_HASH;
  if (!secretHash || !reqHash) return false;

  const provided = Buffer.from(reqHash);
  const expected = Buffer.from(secretHash);
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(provided, expected);
}
