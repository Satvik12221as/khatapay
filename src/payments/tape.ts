import { createHash } from "node:crypto";
import type { Line } from "../keypad/keypad";

/**
 * Signed tape: a SHA-256 fingerprint of everything that defines the bill.
 * Change one line, the amount, the shop or the currency and the hash changes.
 */
export function tapeHash(a: { merchantId: string; currency: string; lines: readonly Line[]; totalCents: number }): string {
  const canonical = JSON.stringify({ v: 1, m: a.merchantId, cur: a.currency, l: a.lines.map((l) => [l.expr, l.cents]), t: a.totalCents });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Splits the tape into what PayPal's order format wants:
 * positive lines become items, negative lines (discounts) are summed into one discount.
 * Invariant: itemTotal - discount === total.
 */
export function orderBreakdown(lines: readonly Line[]) {
  const items = lines.filter((l) => l.cents > 0);
  const itemTotalCents = items.reduce((a, l) => a + l.cents, 0);
  const discountCents = lines.filter((l) => l.cents < 0).reduce((a, l) => a - l.cents, 0);
  return { items, itemTotalCents, discountCents };
}