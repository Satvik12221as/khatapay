import type { Payment } from "../payments/store";
import type { History } from "../merchants";

export interface TrustStats { completed: number; disputesLost: number; repeatCustomers: number }
export type Tier = "New" | "Growing" | "Established" | "Trusted";
export interface Trust { score: number; tier: Tier; stats: TrustStats; explanation: string }

/**
 * Plain-code trust score, 0 to 100. No AI.
 * A shop starts at 75 (3 good orders and 1 bad assumed). Every completed order raises it,
 * every LOST dispute (the customer won) counts three times as much against it, repeat customers add up to 5.
 */
export function trustScore(s: TrustStats): Trust {
  const base = (100 * (s.completed + 3)) / (s.completed + 3 + 3 * s.disputesLost + 1);
  const score = Math.min(100, Math.round(base) + Math.min(5, s.repeatCustomers));
  const tier: Tier = s.completed < 5 ? "New" : score >= 90 ? "Trusted" : score >= 75 ? "Established" : "Growing";
  const facts = `${s.completed} orders completed, ${s.disputesLost} disputes lost, ${s.repeatCustomers} repeat customers`;
  return { score, tier, stats: s, explanation: facts + (tier === "New" ? ". Not enough history yet." : ".") };
}

/** Live stats from real payments, added on top of the seeded demo history. */
export function statsFor(merchantId: string, payments: readonly Payment[], customerOf: (paymentId: string) => string | undefined, history: History): TrustStats {
  const mine = payments.filter((p) => p.merchantId === merchantId);
  const released = mine.filter((p) => p.state === "RELEASED");
  const lost = mine.filter((p) => p.dispute?.verdict?.outcome === "refund").length;
  const perCustomer = new Map<string, number>();
  for (const p of released) {
    const c = customerOf(p.id);
    if (c) perCustomer.set(c, (perCustomer.get(c) ?? 0) + 1);
  }
  const repeat = [...perCustomer.values()].filter((n) => n >= 2).length;
  return { completed: history.completed + released.length, disputesLost: history.disputesLost + lost, repeatCustomers: history.repeatCustomers + repeat };
}