"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function ReturnContent() {
  const searchParams = useSearchParams();
  const txRef = searchParams.get("tx_ref") || "";
  const statusParam = searchParams.get("status") || "";
  const transactionId = searchParams.get("transaction_id") || "";

  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState("Verifying payment with server...");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!txRef) {
      setError("No transaction reference was provided in the return URL.");
      setLoading(false);
      return;
    }

    if (statusParam === "cancelled" || statusParam === "failed") {
      setError("The checkout transaction was cancelled or declined by the payment provider.");
      setLoading(false);
      return;
    }

    // Enforce server-side verification: Do NOT trust frontend URL alone
    const verifyWithServer = async () => {
      try {
        const res = await fetch("/api/billing/verify-return", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txRef, transactionId }),
        });

        const data = await res.json();
        if (res.ok && data.verified) {
          setVerified(true);
          setMessage(data.message || "Payment verified! Your subscription is now active.");
        } else {
          setMessage(data.message || "Awaiting asynchronous provider webhook confirmation.");
        }
      } catch {
        setError("Network error while communicating with verification server.");
      } finally {
        setLoading(false);
      }
    };

    verifyWithServer();
  }, [txRef, statusParam, transactionId]);

  return (
    <main className="page-container" style={{ maxWidth: "540px", textAlign: "center" }}>
      <div className="billing-card" style={{ marginTop: "40px" }}>
        {loading ? (
          <div>
            <h2 className="section-title" style={{ fontSize: "1.5rem" }}>
              Verifying Transaction
            </h2>
            <p style={{ color: "var(--text-secondary)", margin: "16px 0" }}>
              Communicating server-to-server with Flutterwave...
            </p>
          </div>
        ) : error ? (
          <div>
            <div role="alert" className="alert alert-danger">
              {error}
            </div>
            <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", marginBottom: "20px" }}>
              Reference: <code>{txRef || "None"}</code>
            </p>
            <Link href="/plans" className="btn btn-secondary">
              Return to Plans
            </Link>
          </div>
        ) : verified ? (
          <div>
            <div role="status" className="alert alert-success">
              {message}
            </div>
            <h2 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "12px" }}>
              Welcome to Your New Tier!
            </h2>
            <p style={{ color: "var(--text-secondary)", marginBottom: "24px", fontSize: "0.9375rem" }}>
              Your entitlement has been granted server-side and recorded in the append-only ledger.
            </p>
            <Link href="/billing" className="btn btn-primary" style={{ width: "100%" }}>
              View Billing & Ledger
            </Link>
          </div>
        ) : (
          <div>
            <div role="status" className="alert alert-warning">
              {message}
            </div>
            <p style={{ color: "var(--text-secondary)", marginBottom: "20px" }}>
              We are waiting for the Flutterwave webhook signature to confirm your charge.
            </p>
            <Link href="/billing" className="btn btn-secondary">
              Go to Billing
            </Link>
          </div>
        )}
      </div>
    </main>
  );
}

export default function CheckoutReturnPage() {
  return (
    <Suspense fallback={<div className="page-container" style={{ textAlign: "center", paddingTop: "80px" }}>Loading...</div>}>
      <ReturnContent />
    </Suspense>
  );
}
