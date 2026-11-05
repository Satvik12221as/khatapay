import { z } from "zod";

const MerchantMatchSchema = z.object({
  shopId: z.string().max(50),
  name: z.string().max(80),
  category: z.string().max(40),
  area: z.string().max(60),
  trustScore: z.number().int().min(0).max(100),
  trustTier: z.string().max(20),
  typicalTotalDollars: z.number().min(0),
  distanceKm: z.number().min(0).optional(),
  fitScore: z.number().int().min(0).max(100),
  reason: z.string().max(200),
});

const TraceStepSchema = z.object({
  node: z.string(),
  ms: z.number(),
  detail: z.string(),
});

const MerchantFindOut = z.object({
  matches: z.array(MerchantMatchSchema).min(0).max(20),
  source: z.enum(["gemini", "scripted"]),
  trace: z.array(TraceStepSchema).max(50),
});

export interface MerchantMatchDTO {
  shopId: string;
  name: string;
  category: string;
  area: string;
  trustScore: number;
  trustTier: string;
  typicalTotalDollars: number;
  distanceKm?: number;
  fitScore: number;
  reason: string;
}

export interface MerchantFindResult {
  matches: MerchantMatchDTO[];
  source: "gemini" | "scripted";
  trace: { node: string; ms: number; detail: string }[];
}

export interface MerchantFindInput {
  needs: string;
  category?: string;
  area?: string;
  maxPriceDollars?: number;
  minTrustScore?: number;
  maxResults?: number;
  candidates: {
    shopId: string;
    name: string;
    category: string;
    area: string;
    score: number;
    tier: string;
    typicalCents: number;
    customerOrders: number;
  }[];
}

/** Offline rule-based merchant finder. Mirrors Python ScriptedMerchantBrain. */
export class LocalMerchantClient {
  private readonly KEYWORDS: Record<string, string[]> = {
    organic: ["organic", "natural", "chemical-free", "fresh", "healthy", "vegetable", "produce"],
    sweets: ["sweet", "dessert", "mithai", "festival", "diwali", "gift", "snack", "laddu", "cake"],
    groceries: ["grocery", "groceries", "provision", "rice", "dal", "monthly", "staple", "oil", "flour"],
    bakery: ["bread", "cake", "bakery", "bun", "pastry", "croissant"],
    dairy: ["milk", "curd", "paneer", "ghee", "dairy", "butter", "cheese", "yogurt"],
    household: ["soap", "clean", "detergent", "household", "cleaning", "tissue", "paper"],
  };

  async run(input: MerchantFindInput): Promise<MerchantFindResult> {
    const needs = input.needs.toLowerCase();
    const maxResults = input.maxResults ?? 5;
    const minTrust = input.minTrustScore ?? 0;
    const area = input.area;
    const maxPrice = input.maxPriceDollars;

    // Extract tags from needs
    const tags = new Set<string>();
    for (const [tag, words] of Object.entries(this.KEYWORDS)) {
      if (words.some(w => needs.includes(w))) {
        tags.add(tag);
      }
    }

    // Filter candidates
    let filtered = input.candidates.filter(c => c.score >= minTrust);

    if (area) {
      filtered = filtered.filter(c => c.area.toLowerCase() === area.toLowerCase());
    }

    if (maxPrice !== undefined) {
      filtered = filtered.filter(c => c.typicalCents / 100 <= maxPrice);
    }

    // Score matches
    const scored = filtered.map(c => {
      let fit = c.score;

      if (tags.has(c.category)) {
        fit += 30;
      }

      const typical = c.typicalCents / 100;
      if (maxPrice !== undefined && typical <= maxPrice) {
        fit += 10;
      }

      if (area && c.area.toLowerCase() === area.toLowerCase()) {
        fit += 15;
      }

      fit = Math.min(100, fit);

      const reasonParts: string[] = [];
      if (tags.has(c.category)) {
        reasonParts.push(`matches your ${c.category} preference`);
      }
      if (area) {
        reasonParts.push(`in ${area}`);
      }
      if (maxPrice !== undefined && typical <= maxPrice) {
        reasonParts.push(`fits your budget ($${typical.toFixed(2)} typical)`);
      }

      const reason = reasonParts.length > 0
        ? reasonParts.join("; ")
        : `Trusted ${c.category} shop with ${c.score} trust score`;

      return {
        shopId: c.shopId,
        name: c.name,
        category: c.category,
        area: c.area,
        trustScore: c.score,
        trustTier: c.tier,
        typicalTotalDollars: typical,
        fitScore: fit,
        reason,
      };
    });

    scored.sort((a, b) => b.fitScore - a.fitScore);
    const matches = scored.slice(0, maxResults);

    return {
      matches,
      source: "scripted",
      trace: [{ node: "local", ms: 0, detail: "offline merchant matching" }],
    };
  }
}

/** The Node referee: validates what the Python service returns. Never trusted. */
export function checkMerchantResult(raw: MerchantFindResult, input: MerchantFindInput): MerchantFindResult {
  if (!Array.isArray(raw.matches)) {
    throw new Error("Matches must be an array");
  }
  for (const m of raw.matches) {
    if (!m.shopId || !m.name || !m.category || !m.area) {
      throw new Error("Invalid match structure");
    }
    if (m.trustScore < 0 || m.trustScore > 100) {
      throw new Error("Invalid trust score");
    }
    if (m.fitScore < 0 || m.fitScore > 100) {
      throw new Error("Invalid fit score");
    }
    // Verify the match is from our candidates
    const candidate = input.candidates.find(c => c.shopId === m.shopId);
    if (!candidate) {
      throw new Error(`Match ${m.shopId} was not in the provided candidates`);
    }
    if (candidate.score < (input.minTrustScore ?? 0)) {
      throw new Error(`Match ${m.shopId} is below the minimum trust score`);
    }
  }
  if (!["gemini", "scripted"].includes(raw.source)) {
    throw new Error("Invalid source");
  }
  return raw;
}

/** Calls the Python agent service. Falls back to local on any failure. */
export class RemoteMerchantClient {
  constructor(
    private baseUrl: string,
    private apiKey = "",
    private fallback: LocalMerchantClient,
    private onError: (e: unknown) => void = () => {},
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 60_000,
  ) {}

  async run(input: MerchantFindInput): Promise<MerchantFindResult> {
    try {
      const res = await this.fetchImpl(
        this.baseUrl.replace(/\/$/, "") + "/merchant/find",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { "x-agents-key": this.apiKey } : {}),
          },
          body: JSON.stringify({
            needs: input.needs,
            category: input.category,
            area: input.area,
            maxPriceDollars: input.maxPriceDollars,
            minTrustScore: input.minTrustScore ?? 0,
            maxResults: input.maxResults ?? 5,
            candidates: input.candidates.map(c => ({
              shop_id: c.shopId,
              name: c.name,
              category: c.category,
              area: c.area,
              score: c.score,
              tier: c.tier,
              typical_total_cents: c.typicalCents,
              customer_orders: c.customerOrders,
            })),
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok) throw new Error(`Merchant find service returned ${res.status}`);
      const raw = MerchantFindOut.parse(await res.json());
      return checkMerchantResult(raw, input);
    } catch (e) {
      this.onError(e);
      return this.fallback.run(input);
    }
  }
}

export function makeMerchantClient(
  env: Record<string, string | undefined> = process.env,
  onError?: (e: unknown) => void,
  fetchImpl?: typeof fetch,
): RemoteMerchantClient | LocalMerchantClient {
  const local = new LocalMerchantClient();
  return env.AGENTS_URL
    ? new RemoteMerchantClient(env.AGENTS_URL, env.AGENTS_API_KEY ?? "", local, onError, fetchImpl)
    : local;
}