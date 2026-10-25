import { z } from "zod";
import type { Evidence } from "../judge/judges";

const Turn = z.object({
  side: z.enum(["customer", "shop"]),
  accept: z.boolean(),
  discountCents: z.number().int().min(0),
  message: z.string().min(1).max(300),
  source: z.enum(["gemini", "scripted"]),
  note: z.string().max(200).optional(),
});
const HaggleOut = z.object({ turns: z.array(Turn).min(2).max(4), finalDiscountCents: z.number().int().min(0), agreed: z.boolean() });
const Vote = z.object({ judge: z.string(), verdict: z.enum(["release", "refund"]), reason: z.string().min(1).max(300), source: z.enum(["gemini", "scripted"]) });
const VerdictOut = z.object({ votes: z.array(Vote), note: z.string().max(500).optional() });

export interface HaggleRequest {
  merchantName: string;
  totalCents: number;
  maxDiscountPct: number;
  minTotalCents: number;
  loyalty: { visits: number; memberSince: string; onTimeRate: number };
}

/** Talks to the Python agent service (LangGraph). Never trusted: callers validate what comes back. */
export class AgentsClient {
  constructor(private baseUrl: string, private apiKey = "", private fetchImpl: typeof fetch = fetch, private timeoutMs = 60_000) {}

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.apiKey ? { "x-agents-key": this.apiKey } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Agent service ${path} returned ${res.status}`);
    return schema.parse(await res.json());
  }

  haggle(req: HaggleRequest) { return this.post("/haggle", req, HaggleOut); }
  judge(ev: Evidence) { return this.post("/judge", ev, VerdictOut); }
}