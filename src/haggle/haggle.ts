import type { Key } from "../keypad/keypad";
import type { Brain, Ctx, Side, Source } from "./brains";

export interface Turn { side: Side; accept: boolean; discountCents: number; message: string; source: Source; note?: string }
export interface Outcome { turns: Turn[]; finalDiscountCents: number; agreed: boolean }
export interface Policy { maxDiscountPct: number; minTotalCents: number }

const r10 = (c: number) => Math.round(c / 10) * 10;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
const money = (c: number) => "$" + (c / 100).toFixed(2).replace(/\.00$/, "");

/** The shop's hard limit. Plain code, never an AI. */
export function capFor(totalCents: number, p: Policy): number {
  return Math.max(0, Math.min(Math.floor((totalCents * p.maxDiscountPct) / 100), totalCents - p.minTotalCents));
}

/** The referee: agents propose, this decides what is allowed. */
export async function negotiate(a: {
  brain: Brain; merchantName: string; totalCents: number; policy: Policy;
  loyalty: { visits: number; memberSince: string; onTimeRate: number };
}): Promise<Outcome> {
  const cap = capFor(a.totalCents, a.policy);
  const v = a.loyalty.visits;
  const comfort = Math.min(cap, r10(a.totalCents * (v >= 10 ? 0.05 : v >= 3 ? 0.03 : 0.01)));
  const base = { merchantName: a.merchantName, totalCents: a.totalCents, capCents: cap, comfortCents: comfort, loyalty: a.loyalty };
  const customerMax = Math.floor(a.totalCents * 0.3);
  const turns: Turn[] = [];
  const ctx = (o: Pick<Ctx, "side" | "round" | "askCents" | "counterCents">): Ctx => ({ ...base, ...o });

  // Round 1: customer asks.
  const c1 = await a.brain.decide(ctx({ side: "customer", round: 1, askCents: null, counterCents: null }));
  const ask1 = clamp(c1.discountCents, 0, customerMax);
  turns.push({ side: "customer", accept: false, discountCents: ask1, message: c1.message, source: c1.source, ...(ask1 !== c1.discountCents ? { note: "Referee: ask reduced to a sane range." } : {}) });

  // Round 1: shop answers
  const s1 = await a.brain.decide(ctx({ side: "shop", round: 1, askCents: ask1, counterCents: null }));
  const allowed1 = Math.min(ask1, cap);
  const accepted1 = s1.accept && ask1 <= cap;
  const shop1 = accepted1 ? ask1 : clamp(s1.discountCents, 0, allowed1);
  const note1 = s1.discountCents > cap || (s1.accept && ask1 > cap) ? `Referee: the shop's limit is ${a.policy.maxDiscountPct}% (${money(cap)}).` : undefined;
  turns.push({ side: "shop", accept: accepted1, discountCents: shop1, message: s1.message, source: s1.source, ...(note1 ? { note: note1 } : {}) });
  if (accepted1) return { turns, finalDiscountCents: shop1, agreed: true };

  // Round 2: customer accepts the counter or asks again (between counter and last ask)
  const c2 = await a.brain.decide(ctx({ side: "customer", round: 2, askCents: ask1, counterCents: shop1 }));
  if (c2.accept) {
    turns.push({ side: "customer", accept: true, discountCents: shop1, message: c2.message, source: c2.source });
    return { turns, finalDiscountCents: shop1, agreed: true };
  }
  const ask2 = clamp(c2.discountCents, shop1, Math.max(shop1, ask1));
  turns.push({ side: "customer", accept: false, discountCents: ask2, message: c2.message, source: c2.source });

  // Round 2: shop's final answer
  const s2 = await a.brain.decide(ctx({ side: "shop", round: 2, askCents: ask2, counterCents: shop1 }));
  const allowed2 = Math.max(shop1, Math.min(ask2, cap));
  const accepted2 = s2.accept && ask2 <= cap;
  const shop2 = accepted2 ? ask2 : clamp(s2.discountCents, shop1, allowed2);
  const note2 = s2.discountCents > cap || (s2.accept && ask2 > cap) ? `Referee: the shop's limit is ${a.policy.maxDiscountPct}% (${money(cap)}).` : undefined;
  turns.push({ side: "shop", accept: accepted2 || shop2 === ask2, discountCents: shop2, message: s2.message, source: s2.source, ...(note2 ? { note: note2 } : {}) });
  return { turns, finalDiscountCents: shop2, agreed: accepted2 || shop2 === ask2 };
}

/** The agreed discount as keypad key presses, e.g. 750 -> ["-","7",".","5"]. Agents press keys, not amounts. */
export function discountKeys(cents: number): Key[] {
  if (cents <= 0) return [];
  const s = (cents / 100).toFixed(2).replace(/\.?0+$/, "");
  return ["-", ...(s.split("") as Key[])];
}