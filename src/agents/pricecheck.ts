import { z } from "zod";

const LineCheck = z.object({
  expr: z.string().max(100),
  cents: z.number().int().min(0),
  verdict: z.enum(["ok", "suspicious", "overcharge"]),
  expectedCents: z.number().int().min(0).optional(),
  note: z.string().min(1).max(160),
});

const PriceCheckOut = z.object({
  lines: z.array(LineCheck).min(1).max(100),
  totalVerdict: z.enum(["ok", "flagged"]),
  totalExpectedCents: z.number().int().min(0).optional(),
  note: z.string().min(1).max(240),
  source: z.enum(["gemini", "scripted"]),
});

export interface LineCheckDTO {
  expr: string;
  cents: number;
  verdict: "ok" | "suspicious" | "overcharge";
  expectedCents?: number;
  note: string;
}

export interface PriceCheckResult {
  lines: LineCheckDTO[];
  totalVerdict: "ok" | "flagged";
  totalExpectedCents?: number;
  note: string;
  source: "gemini" | "scripted";
}

export class PriceCheckClient {
  constructor(
    private baseUrl: string,
    private apiKey = "",
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 60_000,
  ) {}

  private async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    const res = await this.fetchImpl(
      this.baseUrl.replace(/\/$/, "") + path,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.apiKey ? { "x-agents-key": this.apiKey } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!res.ok) throw new Error(`Price-check service ${path} returned ${res.status}`);
    return schema.parse(await res.json());
  }

  async check(bill: { merchantId: string; totalCents: number; typicalCents?: number; lines: { expr: string; cents: number }[] }, category: string, area: string) {
    return this.post("/pricecheck", {
      merchantName: this.merchantName(bill.merchantId),
      totalCents: bill.totalCents,
      typicalCents: bill.typicalCents ?? null,
      category,
      area,
      lines: bill.lines,
    }, PriceCheckOut);
  }

  private merchantName(id: string): string {
    return (
      {
        shop1: "Lakshmi Provision Store",
        shop2: "Green Leaf Organics",
        shop3: "Annapurna Sweets",
      } as Record<string, string>
    )[id] ?? "Shop";
  }
}