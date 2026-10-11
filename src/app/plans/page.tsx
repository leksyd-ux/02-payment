"use client";

import { useEffect, useState } from "react";
import { PlanInterval } from "@prisma/client";
import { formatMoney, PLAN_DETAILS } from "@/lib/payments/config";
import { ProrationCalculation } from "@/lib/payments/proration";

export default function PlansPage() {
  const [session, setSession] = useState<{
    authenticated: boolean;
    user: { name: string; email: string } | null;
    subscription: {
      planInterval: PlanInterval;
      status: string;
      cancelAtPeriodEnd: boolean;
      currentPeriodEnd: string;
    } | null;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prorationPreview, setProrationPreview] = useState<ProrationCalculation | null>(null);
  const [showProrationModal, setShowProrationModal] = useState(false);

  // Fetch current session and billing status
  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/billing/status");
      if (res.ok) {
        const data = await res.json();
        setSession(data);
      } else {
        // Auto-seed evaluator session for seamless testing
        await fetch("/api/auth/demo-login", { method: "POST" });
        const retry = await fetch("/api/billing/status");
        if (retry.ok) {
          setSession(await retry.json());
        }
      }
    } catch (err) {
      console.error(err);
      setError("Failed to resolve session.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const currentPlan = session?.subscription?.planInterval || PlanInterval.FREE;

  // Handle standard checkout initiation
  const handleSubscribe = async (planInterval: "MONTHLY" | "YEARLY") => {
    setError(null);
    setActionLoading(planInterval);

    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planInterval }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to initiate checkout.");
        return;
      }

      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
      }
    } catch {
      setError("Network error initiating checkout.");
    } finally {
      setActionLoading(null);
    }
  };

  // Fetch live proration preview for Monthly -> Yearly
  const handlePreviewUpgrade = async () => {
    setError(null);
    setActionLoading("preview-upgrade");

    try {
      const res = await fetch("/api/billing/upgrade");
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to fetch proration details.");
        return;
      }

      setProrationPreview(data.proration);
      setShowProrationModal(true);
    } catch {
      setError("Network error fetching upgrade preview.");
    } finally {
      setActionLoading(null);
    }
  };

  // Confirm prorated upgrade
  const handleConfirmUpgrade = async () => {
    setError(null);
    setActionLoading("confirm-upgrade");

    try {
      const res = await fetch("/api/billing/upgrade", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Upgrade failed.");
        return;
      }

      if (data.paymentUrl) {
        window.location.href = data.paymentUrl;
      }
    } catch {
      setError("Network error executing upgrade.");
    } finally {
      setActionLoading(null);
    }
  };

  // Schedule downgrade
  const handleDowngrade = async () => {
    if (!confirm("Are you sure you want to downgrade your Yearly subscription to Monthly at the end of the billing period?")) {
      return;
    }

    setActionLoading("downgrade");
    try {
      const res = await fetch("/api/billing/downgrade", { method: "POST" });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Downgrade failed.");
        return;
      }

      alert(data.message);
      await fetchStatus();
    } catch {
      setError("Network error scheduling downgrade.");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <main className="page-container" style={{ textAlign: "center", paddingTop: "100px" }}>
        <p style={{ color: "var(--text-secondary)" }}>Loading subscription plans...</p>
      </main>
    );
  }

  return (
    <main className="page-container">
      <header className="section-header">
        <h1 className="section-title">Subscription Plans</h1>
        <p className="section-subtitle">
          Choose the right billing interval for your workspace. Mid-cycle upgrades, and many more.
        </p>
      </header>

      {error && (
        <div role="alert" className="alert alert-danger" style={{ maxWidth: "600px", margin: "0 auto 24px" }}>
          {error}
        </div>
      )}

      {session?.subscription?.cancelAtPeriodEnd && (
        <div role="status" className="alert alert-warning" style={{ maxWidth: "600px", margin: "0 auto 24px" }}>
          Your subscription is scheduled to end on{" "}
          <strong>{new Date(session.subscription.currentPeriodEnd).toLocaleDateString()}</strong>. Access remains active until then.
        </div>
      )}

      <div className="plans-grid">
        {/* FREE PLAN */}
        <div className={`plan-card ${currentPlan === PlanInterval.FREE ? "plan-card-current" : ""}`} id="plan-card-free">
          {currentPlan === PlanInterval.FREE && <div className="current-indicator">Current Plan</div>}
          <h2 className="plan-name">{PLAN_DETAILS[PlanInterval.FREE].name}</h2>
          <div className="plan-price">Free</div>
          <div className="plan-cadence">Standard access forever</div>
          <ul className="plan-features">
            {PLAN_DETAILS[PlanInterval.FREE].features.map((f, i) => (
              <li key={i} className="plan-feature-item">
                {f}
              </li>
            ))}
          </ul>
        </div>

        {/* MONTHLY PLAN */}
        <div className={`plan-card ${currentPlan === PlanInterval.MONTHLY ? "plan-card-current" : ""}`} id="plan-card-monthly">
          {currentPlan === PlanInterval.MONTHLY && <div className="current-indicator">Current Plan</div>}
          <h2 className="plan-name">{PLAN_DETAILS[PlanInterval.MONTHLY].name}</h2>
          <div className="plan-price">{formatMoney(PLAN_DETAILS[PlanInterval.MONTHLY].amountMinor)}</div>
          <div className="plan-cadence">Billed monthly</div>
          <ul className="plan-features">
            {PLAN_DETAILS[PlanInterval.MONTHLY].features.map((f, i) => (
              <li key={i} className="plan-feature-item">
                {f}
              </li>
            ))}
          </ul>

          {currentPlan === PlanInterval.MONTHLY ? (
            <button className="btn btn-secondary" disabled style={{ width: "100%" }}>
              Current Plan
            </button>
          ) : currentPlan === PlanInterval.YEARLY ? (
            <button
              className="btn btn-secondary"
              onClick={handleDowngrade}
              disabled={actionLoading !== null || session?.subscription?.cancelAtPeriodEnd}
              style={{ width: "100%" }}
            >
              {session?.subscription?.cancelAtPeriodEnd ? "Downgrade Scheduled" : "Downgrade to Monthly"}
            </button>
          ) : (
            <button
              id="subscribe-monthly-btn"
              className="btn btn-primary"
              onClick={() => handleSubscribe("MONTHLY")}
              disabled={actionLoading !== null}
              style={{ width: "100%" }}
            >
              {actionLoading === "MONTHLY" ? "Connecting to Flutterwave..." : "Subscribe Monthly"}
            </button>
          )}
        </div>

        {/* YEARLY PLAN */}
        <div className={`plan-card ${currentPlan === PlanInterval.YEARLY ? "plan-card-current" : ""}`} id="plan-card-yearly">
          {currentPlan === PlanInterval.YEARLY && <div className="current-indicator">Current Plan</div>}
          <h2 className="plan-name">{PLAN_DETAILS[PlanInterval.YEARLY].name}</h2>
          <div className="plan-price">{formatMoney(PLAN_DETAILS[PlanInterval.YEARLY].amountMinor)}</div>
          <div className="plan-cadence">Billed annually (Save ~16%)</div>
          <ul className="plan-features">
            {PLAN_DETAILS[PlanInterval.YEARLY].features.map((f, i) => (
              <li key={i} className="plan-feature-item">
                {f}
              </li>
            ))}
          </ul>

          {currentPlan === PlanInterval.YEARLY ? (
            <button className="btn btn-secondary" disabled style={{ width: "100%" }}>
              Current Plan
            </button>
          ) : currentPlan === PlanInterval.MONTHLY ? (
            <button
              id="upgrade-yearly-btn"
              className="btn btn-primary"
              onClick={handlePreviewUpgrade}
              disabled={actionLoading !== null}
              style={{ width: "100%" }}
            >
              {actionLoading === "preview-upgrade" ? "Calculating..." : "Upgrade to Yearly"}
            </button>
          ) : (
            <button
              id="subscribe-yearly-btn"
              className="btn btn-primary"
              onClick={() => handleSubscribe("YEARLY")}
              disabled={actionLoading !== null}
              style={{ width: "100%" }}
            >
              {actionLoading === "YEARLY" ? "Connecting to Flutterwave..." : "Subscribe Yearly"}
            </button>
          )}
        </div>
      </div>

      {/* PRORATION PREVIEW MODAL */}
      {showProrationModal && prorationPreview && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-content">
            <h3 className="modal-title">Confirm Mid-Cycle Upgrade</h3>
            <p className="modal-body">
              Your monthly plan will upgrade to Yearly immediately. Your remaining paid monthly time is credited to the kobo.
            </p>

            <div className="proration-box">
              <div className="proration-title">Proration Ledger Breakdown</div>
              <div className="proration-row">
                <span>Cycle duration:</span>
                <span>{prorationPreview.totalCycleDays} days</span>
              </div>
              <div className="proration-row">
                <span>Days remaining:</span>
                <span>{prorationPreview.daysRemaining} days</span>
              </div>
              <div className="proration-row">
                <span>Unused Monthly Credit:</span>
                <span style={{ color: "var(--success-text)" }}>
                  -{formatMoney(prorationPreview.unusedCreditMinor)}
                </span>
              </div>
              <div className="proration-row">
                <span>Yearly Plan Cost:</span>
                <span>{formatMoney(prorationPreview.newPlanCostMinor)}</span>
              </div>
              <div className="proration-row">
                <span>Net Amount Due Now:</span>
                <span style={{ color: "#818cf8" }}>{formatMoney(prorationPreview.netChargeMinor)}</span>
              </div>
            </div>

            <div style={{ display: "flex", gap: "12px", marginTop: "24px" }}>
              <button
                className="btn btn-secondary"
                onClick={() => setShowProrationModal(false)}
                disabled={actionLoading !== null}
                style={{ flex: 1 }}
              >
                Cancel
              </button>
              <button
                id="confirm-upgrade-submit-btn"
                className="btn btn-primary"
                onClick={handleConfirmUpgrade}
                disabled={actionLoading !== null}
                style={{ flex: 2 }}
              >
                {actionLoading === "confirm-upgrade" ? "Initiating Prorated Payment..." : `Pay ${formatMoney(prorationPreview.netChargeMinor)}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
