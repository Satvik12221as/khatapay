export type Side = "customer" | "shop";
export type Source = "gemini" | "scripted";

/** What an agent decides in one turn (before the referee checks it). */
export interface Decision { accept: boolean; discountCents: number; message: string; source: Source }

/** Everything an agent is allowed to know when it decides. */
export interface Ctx {
  side: Side;
  round: 1 | 2;
  merchantName: string;
  totalCents: number;
  capCents: number;
  comfortCents: number;
  loyalty: { visits: number; memberSince: string; onTimeRate: number };
  askCents: number | null;
  counterCents: number | null;
}

export interface Brain { decide(ctx: Ctx): Promise<Decision> }

const r10 = (c: number) => Math.round(c / 10) * 10;
const money = (c: number) => "$" + (c / 100).toFixed(2).replace(/\.00$/, "");

/**
 * Rule-based agents. No AI. This is the offline safety net: if the Python agent service
 * is down or returns something the referee rejects, the app falls back to these.
 */
export class ScriptedBrain implements Brain {
  async decide(c: Ctx): Promise<Decision> {
    const s = "scripted" as const;
    const ask = c.askCents ?? 0;
    if (c.side === "customer") {
      if (c.round === 1) {
        const pct = c.loyalty.visits >= 10 ? 0.1 : c.loyalty.visits >= 3 ? 0.06 : 0.03;
        const d = r10(c.totalCents * pct);
        return { accept: false, discountCents: d, source: s, message: `I've shopped here ${c.loyalty.visits} times since ${c.loyalty.memberSince} and always pay on time. Could you take ${money(d)} off?` };
      }
      const counter = c.counterCents ?? 0;
      if (counter >= ask * 0.6) return { accept: true, discountCents: counter, source: s, message: `${money(counter)} works for me. Thank you!` };
      const mid = r10((ask + counter) / 2);
      return { accept: false, discountCents: mid, source: s, message: `Could we meet in the middle at ${money(mid)}?` };
    }
    const comfort = c.comfortCents;
    if (c.round === 1) {
      if (ask <= comfort) return { accept: true, discountCents: ask, source: s, message: `Happy to, you're a valued regular. ${money(ask)} off.` };
      if (comfort <= 0) return { accept: false, discountCents: 0, source: s, message: "Sorry, I can't discount this bill." };
      return { accept: false, discountCents: comfort, source: s, message: `I can do ${money(comfort)} off for a regular like you.` };
    }
    const mid = r10(comfort + (c.capCents - comfort) / 2);
    if (ask <= mid) return { accept: true, discountCents: ask, source: s, message: `Fair enough. ${money(ask)} off, deal.` };
    return { accept: false, discountCents: Math.max(comfort, mid), source: s, message: `My best is ${money(Math.max(comfort, mid))} off.` };
  }
}