import { describe, it, expect } from "vitest";
import { statsFor, trustScore } from "../src/trust/trust";
import { MERCHANTS } from "../src/merchants";
import type { Payment } from "../src/payments/store";

const pay = (id: string, merchantId: string, state: Payment["state"], dispute?: Payment["dispute"]): Payment => ({
  id, merchantId, merchantName: "x", amountCents: 2000, currency: "USD", lines: [], tapeHash: "h", state, orderId: "o", createdAt: id, events: [], ...(dispute ? { dispute } : {}),
});
const lost: Payment["dispute"] = { reason: "not_received", note: "", openedAt: "", verdict: { votes: [], outcome: "refund" } };

describe("trustScore", () => {
  it("gives the demo shops distinct, explainable scores", () => {
    const [a, b, c] = MERCHANTS.map((m) => trustScore(m.history));
    expect([a.score, a.tier]).toEqual([97, "Trusted"]);
    expect([b.score, b.tier]).toEqual([62, "Growing"]);
    expect([c.score, c.tier]).toEqual([75, "New"]);
    expect(a.explanation).toBe("42 orders completed, 1 disputes lost, 9 repeat customers.");
    expect(c.explanation).toContain("Not enough history yet");
  });
  it("rises with completed orders and falls with lost disputes", () => {
    const s = (completed: number, disputesLost: number, repeatCustomers = 0) => trustScore({ completed, disputesLost, repeatCustomers }).score;
    expect(s(10, 0)).toBeGreaterThan(s(5, 0));
    expect(s(10, 2)).toBeLessThan(s(10, 0));
    expect(s(10, 1)).toBeLessThan(s(10, 0));
    expect(s(0, 0, 4)).toBe(79);
    expect(s(1000, 0, 50)).toBe(100);
  });
  it("one lost dispute hurts a new shop far more than an established one", () => {
    const drop = (c: number) => trustScore({ completed: c, disputesLost: 0, repeatCustomers: 0 }).score - trustScore({ completed: c, disputesLost: 1, repeatCustomers: 0 }).score;
    expect(drop(5)).toBeGreaterThan(drop(100));
  });
});

describe("statsFor (real payments on top of the seeded history)", () => {
  const owner: Record<string, string> = { p1: "A", p2: "A", p3: "B", p4: "B", p6: "C" };
  const payments = [pay("p1", "shop1", "RELEASED"), pay("p2", "shop1", "RELEASED"), pay("p3", "shop1", "RELEASED"), pay("p4", "shop1", "HELD"),
    pay("p5", "shop1", "REFUNDED", lost), pay("p6", "shop2", "RELEASED")];
  it("counts completed orders, lost disputes and repeat customers for the right shop", () => {
    const s = statsFor("shop1", payments, (id) => owner[id], { completed: 10, disputesLost: 1, repeatCustomers: 2 });
    expect(s).toEqual({ completed: 13, disputesLost: 2, repeatCustomers: 3 });
    expect(statsFor("shop2", payments, (id) => owner[id], { completed: 0, disputesLost: 0, repeatCustomers: 0 })).toEqual({ completed: 1, disputesLost: 0, repeatCustomers: 0 });
  });
  it("a payment nobody claimed still counts as completed, but not as a repeat customer", () => {
    expect(statsFor("shop1", payments, () => undefined, { completed: 0, disputesLost: 0, repeatCustomers: 0 }).repeatCustomers).toBe(0);
  });
});