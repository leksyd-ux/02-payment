import bcrypt from "bcrypt";
import crypto from "crypto";

const BCRYPT_COST = 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export function hashToken(token: string): string {
  const secret = process.env.AUTH_SECRET || "default-payment-auth-secret-salt-32-chars";
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

export function generateRandomToken(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}
