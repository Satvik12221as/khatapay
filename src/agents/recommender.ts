import { z } from "zod";

export interface Candidate {
  shopId: string; name: string; category: string; area: string; score: number; tier: string;
  completed: number; disputesLost: number; repeatCustomers: number; customerOrders: number;
}
export interface RecommendInput { referrerName: string; needs: string; welcomeCents: number; rewardCents: number; minTrust: number; candidates: Candidate[] }
export interface Recommendation { shopId: string; message: string; source: "gemini" | "scripted" }
export interface Recommender { run(i: RecommendInput): Promise<Recommendation> }

const dollars = (c: number) => (c / 100).toFixed(2).replace(/\.00$/, "");

/** A message built only from facts, so it is always true. */
export function templateMessage(referrerName: string, c: Candidate, welcomeCents: number): string {
  return `${referrerName} shops at ${c.name} and recommends it. It has a trust score of ${c.score}, with ${c.completed} completed orders and ${c.disputesLost} lost disputes. New customers get $${dollars(welcomeCents)} off their first order.`;
}

const KEYWORDS: Record<string, string[]> = {
  organic: ["organic", "natural", "chemical", "vegetable", "fresh", "healthy"],
  sweets: ["sweet", "dessert", "mithai", "festival", "diwali", "gift", "snack"],
  groceries: ["grocery", "groceries", "provision", "rice", "dal", "monthly", "staple", "oil"],
  bakery: ["bread", "cake", "bakery", "bun"],
  dairy: ["milk", "curd", "paneer", "ghee", "dairy"],
  household: ["soap", "clean", "detergent", "household"],
};

/** Offline recommender (no AI): a clear need picks among the trusted shops, then trust decides. */
export class LocalRecommender implements Recommender {
  async run(i: RecommendInput): Promise<Recommendation> {
    const low = i.needs.toLowerCase();
    const tags = new Set(Object.entries(KEYWORDS).filter(([, w]) => w.some((x) => low.includes(x))).map(([t]) => t));
    const fit = (c: Candidate) => Math.min(100, c.score + (tags.has(c.category) ? 25 : 0) + Math.min(10, c.customerOrders));
    const ok = i.candidates.filter((c) => c.score >= i.minTrust).sort((a, b) => Number(tags.has(b.category)) - Number(tags.has(a.category)) || fit(b) - fit(a) || a.name.localeCompare(b.name));
    if (!ok.length) throw Object.assign(new Error("No shop meets the minimum trust score."), { statusCode: 422 });
    return { shopId: ok[0].shopId, message: templateMessage(i.referrerName, ok[0], i.welcomeCents), source: "scripted" };
  }
}

const NUM = /\d+(?:\.\d+)?/g;
const BAD = /https?:\/\/|www\.|@|\.com\b/i;

/** The Node referee: the service is never trusted. The pick must be a shop WE sent and WE consider trusted, and the text may only state our facts. */
export function checkRecommendation(raw: Recommendation, i: RecommendInput): Recommendation {
  const c = i.candidates.find((x) => x.shopId === raw.shopId);
  if (!c) throw new Error("The service picked a shop that was not offered");
  if (c.score < i.minTrust) throw new Error("The service picked a shop below the trust minimum");
  const m = raw.message.trim();
  if (!m || m.length > 400) throw new Error("Bad message length");
  if (BAD.test(m)) throw new Error("The message contains a link or email");
  const allowed = new Set([String(c.score), String(c.completed), String(c.disputesLost), String(c.repeatCustomers),
    (i.welcomeCents / 100).toFixed(2), String(i.welcomeCents / 100), ...(c.name.match(NUM) ?? []), ...(i.referrerName.match(NUM) ?? [])]);
  const extra = (m.match(NUM) ?? []).filter((n) => !allowed.has(n));
  if (extra.length) throw new Error(`The message states numbers that are not facts: ${extra.join(", ")}`);
  return { shopId: raw.shopId, message: m, source: raw.source };
}

const Out = z.object({ shopId: z.string().max(40), message: z.string().min(1).max(400), source: z.enum(["gemini", "scripted"]) });

export class RemoteRecommender implements Recommender {
  constructor(private baseUrl: string, private apiKey: string, private fallback: Recommender, private onError: (e: unknown) => void = () => {},
    private fetchImpl: typeof fetch = fetch, private timeoutMs = 60_000) {}
  async run(i: RecommendInput): Promise<Recommendation> {
    try {
      const res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + "/recommend", {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { "x-agents-key": this.apiKey } : {}) },
        body: JSON.stringify(i),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`Agent service /recommend returned ${res.status}`);
      return checkRecommendation(Out.parse(await res.json()), i);
    } catch (e) {
      this.onError(e);
      return this.fallback.run(i);
    }
  }
}

export function makeRecommender(env: Record<string, string | undefined> = process.env, onError?: (e: unknown) => void, fetchImpl?: typeof fetch): Recommender {
  const local = new LocalRecommender();
  return env.AGENTS_URL ? new RemoteRecommender(env.AGENTS_URL, env.AGENTS_API_KEY ?? "", local, onError, fetchImpl) : local;
}