import type { NextConfig } from "next";
import os from "os";

/**
 * The dev server only trusts `localhost` and the hostname it was started with.
 * Any other host blocks dev assets and HMR, so the page renders server HTML but
 * never hydrates — which on /plans means it stays on "Loading subscription plans..."
 * forever, with no plan cards, buttons or modals.
 *
 * Rather than hardcoding an IP that DHCP will eventually change, allow every
 * non-internal IPv4 address on this machine, plus anything in ALLOWED_DEV_ORIGINS.
 * This setting only applies to `next dev`.
 */
function collectDevOrigins(): string[] {
  const origins = new Set<string>(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (!address.internal) origins.add(address.address);
    }
  }

  for (const extra of (process.env.ALLOWED_DEV_ORIGINS ?? "").split(",")) {
    const trimmed = extra.trim();
    if (trimmed) origins.add(trimmed);
  }

  return [...origins];
}

const nextConfig: NextConfig = {
  allowedDevOrigins: collectDevOrigins(),
};

export default nextConfig;