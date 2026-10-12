import type { Metadata } from "next";
import "./globals.css";
import { getCurrentSession } from "@/lib/security/session";
import Navbar from "@/components/Navbar";

export const metadata: Metadata = {
  title: "Tessera · Payments & Subscriptions (Slice 2)",
  description:
    "Production-minded subscription system featuring test-mode Flutterwave integration, mid-cycle proration, scheduled downgrades, and append-only payment event logging.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getCurrentSession();

  return (
    <html lang="en">
      <body>
        <Navbar user={session ? session.user : null} />

        {children}
      </body>
    </html>
  );
}
