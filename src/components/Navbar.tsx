"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PlanInterval } from "@prisma/client";

interface NavbarProps {
  user: {
    name: string;
    email: string;
    subscription: {
      planInterval: PlanInterval;
      status: string;
      cancelAtPeriodEnd: boolean;
    } | null;
  } | null;
}

export default function Navbar({ user }: NavbarProps) {
  const pathname = usePathname();
  const plan = user?.subscription?.planInterval || PlanInterval.FREE;

  const planClass =
    plan === PlanInterval.YEARLY
      ? "plan-pill plan-pill-yearly"
      : plan === PlanInterval.MONTHLY
      ? "plan-pill plan-pill-monthly"
      : "plan-pill plan-pill-free";

  return (
    <header className="app-header">
      <div className="brand-title">
        <span>Payment & Subscription</span>
        <span className="brand-badge">Slice 2</span>
      </div>

      <nav className="nav-links">
        <Link href="/plans" className={`nav-link ${pathname === "/plans" ? "active" : ""}`}>
          Plans
        </Link>
        <Link href="/billing" className={`nav-link ${pathname === "/billing" ? "active" : ""}`}>
          Billing & Invoices
        </Link>
      </nav>

      <div className="user-badge">
        <span className={planClass}>
          {plan} {user?.subscription?.cancelAtPeriodEnd ? "(Canceling)" : ""}
        </span>
        <span style={{ color: "var(--text-secondary)", fontSize: "0.8125rem" }}>
          {user ? user.name : "Guest"}
        </span>
      </div>
    </header>
  );
}
