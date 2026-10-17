import { z } from "zod";

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
  capCents: number;      // shop's hard limit (the shop agent is told; the referee enforces it)
  comfortCents: number;  // what the shop likes to give a customer like this
  loyalty: { visits: number; memberSince: string; onTimeRate: number };
  askCents: number | null;      // customer's latest ask
  counterCents: number | null;  // shop's latest counter
}

export interface Brain { decide(ctx: Ctx): Promise<Decision> }

const r10 = (c: number) => Math.round(c / 10) * 10;
const money = (c: number) => "$" + (c / 100).toFixed(2).replace(/\.00$/, "");

/** Rule-based agents. Used offline and as the safety net if Gemini fails. */
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
    // shop
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

const Reply = z.object({ accept: z.boolean(), discount: z.number().min(0).max(1_000_000), message: z.string().min(1).max(300) });

/** Gemini-powered agents. The model only returns JSON; the referee checks every number. */
export class GeminiBrain implements Brain {
  constructor(private apiKey: string, private model = "gemini-2.5-flash", private fetchImpl: typeof fetch = fetch) {
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
  }

  private prompts(c: Ctx) {
    const shape = 'Reply with ONLY this JSON: {"accept": boolean, "discount": number, "message": string}. "discount" is in dollars (e.g. 7.5). "message" is one short friendly sentence (max 25 words).';
    const facts = { shop: c.merchantName, billTotalDollars: c.totalCents / 100, customerVisits: c.loyalty.visits, customerSince: c.loyalty.memberSince, customerOnTimeRate: c.loyalty.onTimeRate, customerLastAskDollars: c.askCents === null ? null : c.askCents / 100, shopLastCounterDollars: c.counterCents === null ? null : c.counterCents / 100, round: c.round };
    if (c.side === "customer") {
      const rule = c.round === 1
        ? "This is round 1: set accept=false and ask for a discount of at most 15% of the bill."
        : "This is round 2: either accept the shop's counter (accept=true, discount = the counter) or ask for a new amount between the shop's counter and your last ask (accept=false).";
      return { system: `You are a customer's shopping agent negotiating at a small shop. Get a fair discount, politely. Use only the facts given; never invent facts. ${rule} ${shape}`, user: JSON.stringify(facts) };
    }
    const rule = c.round === 1
      ? "Accept the ask (accept=true, discount = the ask) only if it is at or below your preferred discount. Otherwise counter (accept=false) with a discount no higher than the ask."
      : "This is the final round. Accept the ask if you can afford it, otherwise give your best final counter, never lower than your previous counter.";
    return { system: `You are the shop owner's agent. Protect the shop's margin but reward loyal regulars. Your preferred discount for this customer is $${c.comfortCents / 100}. Your absolute maximum is $${c.capCents / 100}: never go above it. ${rule} ${shape}`, user: JSON.stringify(facts) };
  }

  async decide(c: Ctx): Promise<Decision> {
    const { system, user } = this.prompts(c);
    const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.5 },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${j?.error?.message ?? "request failed"}`);
    const text: string = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    const parsed = Reply.parse(JSON.parse(text.replace(/^```(?:json)?|```$/g, "").trim()));
    return { accept: parsed.accept, discountCents: Math.round(parsed.discount * 100), message: parsed.message, source: "gemini" };
  }
}

/** Tries the primary brain; on ANY failure (network, quota, bad JSON) uses the fallback so the demo never breaks. */
export class ResilientBrain implements Brain {
  constructor(private primary: Brain, private fallback: Brain, private onError: (e: unknown) => void = () => {}) {}
  async decide(c: Ctx): Promise<Decision> {
    try { return await this.primary.decide(c); }
    catch (e) { this.onError(e); return this.fallback.decide(c); }
  }
}

export function makeBrain(env: Record<string, string | undefined> = process.env, onError?: (e: unknown) => void): Brain {
  const scripted = new ScriptedBrain();
  return env.GEMINI_API_KEY ? new ResilientBrain(new GeminiBrain(env.GEMINI_API_KEY, env.GEMINI_MODEL || undefined), scripted, onError) : scripted;
}