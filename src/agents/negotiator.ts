import { capFor, negotiate, type Outcome, type Policy } from "../haggle/haggle";
import { ScriptedBrain, type Brain } from "../haggle/brains";
import { AgentsClient } from "./client";

export interface NegotiateInput {
  merchantName: string;
  totalCents: number;
  policy: Policy;
  loyalty: { visits: number; memberSince: string; onTimeRate: number };
}
export interface Negotiator { run(i: NegotiateInput): Promise<Outcome> }

/** Offline rule-based negotiation (no AI). */
export class LocalNegotiator implements Negotiator {
  constructor(private brain: Brain = new ScriptedBrain()) {}
  run(i: NegotiateInput) { return negotiate({ brain: this.brain, ...i }); }
}

/** The Node referee. Re-checks everything the Python service says, because the service is never trusted. */
export function checkOutcome(out: Outcome, i: NegotiateInput): Outcome {
  const cap = capFor(i.totalCents, i.policy);
  const customerMax = Math.max(Math.floor(i.totalCents * 0.3), cap);
  const t = out.turns;
  if (t.length < 2 || t.length > 4) throw new Error("Unexpected number of turns");
  t.forEach((x, idx) => {
    if (x.side !== (idx % 2 === 0 ? "customer" : "shop")) throw new Error("Turns out of order");
    if (!Number.isInteger(x.discountCents) || x.discountCents < 0 || x.discountCents > (x.side === "customer" ? customerMax : cap)) throw new Error("Turn amount outside the allowed range");
  });
  if (!Number.isInteger(out.finalDiscountCents) || out.finalDiscountCents < 0 || out.finalDiscountCents > cap) throw new Error("Final discount above the shop's limit");
  if (out.finalDiscountCents !== t[t.length - 1].discountCents) throw new Error("Final discount does not match the last turn");
  if (i.totalCents - out.finalDiscountCents < i.policy.minTotalCents) throw new Error("Bill would fall below the minimum");
  return { turns: t, finalDiscountCents: out.finalDiscountCents, agreed: out.agreed };
}

/** Asks the Python LangGraph agents; on any failure or rule break, uses the offline agents instead. */
export class RemoteNegotiator implements Negotiator {
  constructor(private client: AgentsClient, private fallback: Negotiator, private onError: (e: unknown) => void = () => {}) {}
  async run(i: NegotiateInput): Promise<Outcome> {
    try {
      const raw = await this.client.haggle({ merchantName: i.merchantName, totalCents: i.totalCents, maxDiscountPct: i.policy.maxDiscountPct, minTotalCents: i.policy.minTotalCents, loyalty: i.loyalty });
      return checkOutcome(raw, i);
    } catch (e) {
      this.onError(e);
      return this.fallback.run(i);
    }
  }
}

export function makeNegotiator(env: Record<string, string | undefined> = process.env, onError?: (e: unknown) => void, fetchImpl?: typeof fetch): Negotiator {
  const local = new LocalNegotiator();
  return env.AGENTS_URL ? new RemoteNegotiator(new AgentsClient(env.AGENTS_URL, env.AGENTS_API_KEY, fetchImpl), local, onError) : local;
}