/**
 * Reset Test User (RTU)
 * ---------------------
 * Deletes a user by email from the database.
 * Cascade rules in the schema automatically wipe:
 *   - sessions
 *   - subscriptions
 *   - payment_events
 *
 * Usage:
 *   npm run rtu -- test@example.com
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email) {
    console.error("❌  No email provided.");
    console.error("    Usage: npm run rtu -- your@email.com");
    process.exit(1);
  }

  // Basic email sanity check
  if (!email.includes("@")) {
    console.error(`❌  "${email}" doesn't look like a valid email address.`);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    console.log(`ℹ️   No user found with email: ${email}`);
    console.log("    Nothing to delete — you're already at a clean slate.");
    process.exit(0);
  }

  console.log(`\n🔍  Found user:`);
  console.log(`    ID    : ${user.id}`);
  console.log(`    Email : ${user.email}`);
  console.log(`    Name  : ${user.name}`);
  console.log(`    Created: ${user.createdAt.toISOString()}\n`);

  // Cascade deletes sessions, subscriptions, payment_events automatically
  await prisma.user.delete({ where: { email } });

  console.log("✅  User deleted. Cascaded:");
  console.log("    - sessions");
  console.log("    - subscriptions");
  console.log("    - payment_events");
  console.log("\n🧹  Clean slate. You can now register fresh and retry the payment flow.");
  console.log("    Don't forget to clear your browser session cookie too!\n");
}

main()
  .catch((e) => {
    console.error("❌  Script error:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
