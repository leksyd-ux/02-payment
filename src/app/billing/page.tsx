"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PlanInterval, PaymentEventType } from "@prisma/client";
import { formatMoney } from "@/lib/payments/config";

interface BillingData {
  authenticated: boolean;
  user: { id: string; name: string; email: string };
  subscription: {
    id: string;
    planInterval: PlanInterval;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    cancellationReason: string | null;
  } | null;
  paymentEvents: Array<{
    id: string;
    providerReference: string;
    eventType: PaymentEventType;
    amountMinor: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
}

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBilling = async () => {
    try {
      const res = await fetch("/api/billing/status");
      if (res.ok) {
        setData(await res.json());
      } else {
        await fetch("/api/auth/demo-login", { method: "POST" });
        const retry = await fetch("/api/billing/status");
        if (retry.ok) {
          setData(await retry.json());
        }
      }
    } catch (err) {
      console.error(err);
      setError("Failed to load billing details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBilling();
  }, []);

  const handleCancelSubscription = async () => {
    setCanceling(true);
    setError(null);

    try {
      const res = await fetch("/api/billing/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          reason: cancelReason,
        }),
      });

      const resData = await res.json();
      if (!res.ok) {
        setError(resData.error || "Cancellation failed.");
        return;
      }

      setShowCancelModal(false);
      await fetchBilling();
    } catch {
      setError("Network error canceling subscription.");
    } finally {
      setCanceling(false);
    }
  };

  if (loading) {
    return (
      <main className="page-container" style={{ textAlign: "center", paddingTop: "80px" }}>
        <p style={{ color: "var(--text-secondary)" }}>Loading billing records...</p>
      </main>
    );
  }

  const sub = data?.subscription;
  const isPaid = sub && sub.planInterval !== PlanInterval.FREE;

  return (
    <main className="page-container">
      <header className="section-header" style={{ textAlign: "left" }}>
        <h1 className="section-title">Billing & Subscription</h1>
        <p className="section-subtitle">
          Manage your subscription plan, view renewal dates, and audit the append-only payment log.
        </p>
      </header>

      {error && (
        <div role="alert" className="alert alert-danger">
          {error}
        </div>
      )}

      {/* SUBSCRIPTION SUMMARY CARD */}
      <div className="billing-card" id="subscription-summary-card">
        <div className="billing-card-header">
          <div>
            <h2 style={{ fontSize: "1.25rem", fontWeight: 700 }}>Current Subscription</h2>
            <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
              Active entitlement details
            </p>
          </div>
          <Link href="/plans" className="btn btn-secondary">
            Change Plan
          </Link>
        </div>

        <div className="billing-grid">
          <div>
            <div className="billing-metric-label">Current Plan</div>
            <div className="billing-metric-value" id="current-plan-value">
              {sub ? sub.planInterval : "FREE"}
            </div>
          </div>

          <div>
            <div className="billing-metric-label">Status</div>
            <div className="billing-metric-value" id="current-status-value">
              {sub?.cancelAtPeriodEnd ? (
                <span style={{ color: "var(--warning-text)" }}>Canceling</span>
              ) : (
                <span style={{ color: "var(--success-text)" }}>{sub?.status || "ACTIVE"}</span>
              )}
            </div>
          </div>

          <div>
            <div className="billing-metric-label">
              {sub?.cancelAtPeriodEnd ? "Access Ends On" : "Renewal / Period End"}
            </div>
            <div className="billing-metric-value" id="period-end-value">
              {sub?.currentPeriodEnd
                ? new Date(sub.currentPeriodEnd).toLocaleDateString()
                : "N/A"}
            </div>
          </div>
        </div>

        {sub?.cancelAtPeriodEnd && (
          <div className="alert alert-warning" style={{ marginTop: "16px", marginBottom: "16px" }}>
            <strong>Cancellation Scheduled:</strong> Your subscription is set to end at the conclusion of your billing cycle. You maintain full access until{" "}
            <strong>{new Date(sub.currentPeriodEnd).toLocaleDateString()}</strong>.
            {sub.cancellationReason && (
              <div style={{ marginTop: "6px", fontSize: "0.8125rem", opacity: 0.9 }}>
                Reason recorded: <em>&ldquo;{sub.cancellationReason}&rdquo;</em>
              </div>
            )}
          </div>
        )}

        {isPaid && !sub?.cancelAtPeriodEnd && (
          <div style={{ marginTop: "24px", paddingTop: "20px", borderTop: "1px solid var(--border-color)" }}>
            <button
              id="open-cancel-modal-btn"
              className="btn btn-danger"
              onClick={() => setShowCancelModal(true)}
            >
              Cancel Subscription
            </button>
          </div>
        )}
      </div>

      {/* APPEND-ONLY PAYMENT LEDGER */}
      <div className="billing-card" id="payment-ledger-card">
        <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: "8px" }}>
          Append-Only Payment & Event Log
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem", marginBottom: "16px" }}>
          Every lifecycle event (Initiation, Verification, Fulfilment, Failure) is recorded immutably with minor unit whole amounts.
        </p>

        {data?.paymentEvents && data.paymentEvents.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="events-table" id="payment-events-table">
              <thead>
                <tr>
                  <th>Event Type</th>
                  <th>Reference</th>
                  <th>Amount (Minor Units)</th>
                  <th>Status</th>
                  <th>Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {data.paymentEvents.map((evt) => (
                  <tr key={evt.id}>
                    <td>
                      <span
                        style={{
                          fontWeight: 700,
                          color:
                            evt.eventType === PaymentEventType.FULFILMENT
                              ? "var(--success-text)"
                              : evt.eventType === PaymentEventType.FAILURE
                              ? "var(--danger-text)"
                              : evt.eventType === PaymentEventType.VERIFICATION
                              ? "#818cf8"
                              : "var(--text-secondary)",
                        }}
                      >
                        {evt.eventType}
                      </span>
                    </td>
                    <td>
                      <code>{evt.providerReference}</code>
                    </td>
                    <td>
                      {formatMoney(evt.amountMinor, evt.currency)}{" "}
                      <span style={{ color: "var(--text-muted)", fontSize: "0.75rem" }}>
                        ({evt.amountMinor} {evt.currency.toUpperCase()})
                      </span>
                    </td>
                    <td>{evt.status}</td>
                    <td>{new Date(evt.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ color: "var(--text-muted)", fontSize: "0.875rem" }}>
            No payment events recorded yet.
          </p>
        )}
      </div>

      {/* CANCELLATION MODAL */}
      {showCancelModal && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-content">
            <h3 className="modal-title">Confirm Cancellation</h3>
            <p className="modal-body">
              Are you sure you want to cancel your paid plan? You will retain complete access to all paid features until{" "}
              <strong>{sub ? new Date(sub.currentPeriodEnd).toLocaleDateString() : "period end"}</strong>.
            </p>

            <div style={{ marginBottom: "20px" }}>
              <label htmlFor="cancel-reason-input" style={{ fontSize: "0.8125rem", color: "var(--text-secondary)", fontWeight: 600 }}>
                Reason for cancellation (optional):
              </label>
              <textarea
                id="cancel-reason-input"
                className="modal-textarea"
                placeholder="Let us know why you are canceling..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
              />
            </div>

            <div style={{ display: "flex", gap: "12px" }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowCancelModal(false)}
                disabled={canceling}
                style={{ flex: 1 }}
              >
                Keep Subscription
              </button>
              <button
                id="confirm-cancel-btn"
                className="btn btn-danger"
                onClick={handleCancelSubscription}
                disabled={canceling}
                style={{ flex: 1 }}
              >
                {canceling ? "Processing..." : "Confirm Cancellation"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
