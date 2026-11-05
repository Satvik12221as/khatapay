import { z } from "zod";

const InsightSchema = z.object({
  id: z.string().max(50),
  title: z.string().max(120),
  description: z.string().max(500),
  priority: z.enum(["high", "medium", "low"]),
  actionable: z.boolean(),
  metric: z.string().max(50).optional(),
  currentValue: z.number().min(0).optional(),
  recommendedAction: z.string().max(200).optional(),
});

const TraceStepSchema = z.object({
  node: z.string(),
  ms: z.number(),
  detail: z.string(),
});

const InsightsOut = z.object({
  merchantId: z.string(),
  merchantName: z.string().max(80),
  periodDays: z.number().int().min(1),
  insights: z.array(InsightSchema).min(0).max(20),
  summary: z.string().max(300),
  source: z.enum(["gemini", "scripted"]),
  confidence: z.enum(["high", "medium", "low"]),
  trace: z.array(TraceStepSchema).max(50),
});

export interface InsightDTO {
  id: string;
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  actionable: boolean;
  metric?: string;
  currentValue?: number;
  recommendedAction?: string;
}

export interface InsightsResult {
  merchantId: string;
  merchantName: string;
  periodDays: number;
  insights: InsightDTO[];
  summary: string;
  source: "gemini" | "scripted";
  confidence: "high" | "medium" | "low";
  trace: { node: string; ms: number; detail: string }[];
}

export interface InsightsInput {
  merchantId: string;
  merchantName: string;
  periodDays: number;
  totalPayments: number;
  totalRevenueCents: number;
  avgOrderCents: number;
  successRate: number;
  disputesOpened: number;
  disputesLost: number;
  repeatCustomerRate: number;
  avgResponseTimeHours: number;
}

/** Offline rule-based insights (no AI). Mirrors the Python ScriptedInsightsBrain. */
export class LocalInsightsClient {
  async run(input: InsightsInput): Promise<InsightsResult> {
    const stats = {
      total_revenue_cents: input.totalRevenueCents,
      avg_order_cents: input.avgOrderCents,
      success_rate: input.successRate,
      disputes_lost: input.disputesLost,
      disputes_opened: input.disputesOpened,
      repeat_customer_rate: input.repeatCustomerRate,
      total_payments: input.totalPayments,
      avg_response_time_hours: input.avgResponseTimeHours,
    };
    const periodDays = input.periodDays;
    const merchantName = input.merchantName;

    const insights: InsightDTO[] = [];
    let confidence: "high" | "medium" | "low" = "high";

    // Revenue insights
    if (input.totalRevenueCents > 100_000) {
      insights.push({
        id: "revenue_trend",
        title: "Strong Revenue Performance",
        description: `You've processed $${(input.totalRevenueCents/100).toFixed(2)} in payments over ${periodDays} days with an average order of $${(input.avgOrderCents/100).toFixed(2)}.`,
        priority: "low",
        actionable: false,
      });
    }

    // Success rate
    if (input.successRate < 0.7) {
      insights.push({
        id: "low_success",
        title: "High Dispute Rate",
        description: `Only ${(input.successRate*100).toFixed(0)}% of payments completed successfully. ${(100*(1-input.successRate)).toFixed(0)}% had disputes or issues.`,
        priority: "high",
        actionable: true,
        recommendedAction: "Review dispute reasons and improve customer communication during checkout.",
      });
      confidence = "high";
    } else if (input.successRate > 0.9) {
      insights.push({
        id: "good_success",
        title: "Excellent Customer Satisfaction",
        description: `Your ${(input.successRate*100).toFixed(0)}% success rate shows great customer relationships. Well done!`,
        priority: "low",
        actionable: false,
      });
    }

    // Dispute analysis
    if (input.disputesOpened > 0) {
      const lostRate = input.disputesOpened > 0 ? input.disputesLost / input.disputesOpened : 0;
      if (lostRate > 0.5) {
        insights.push({
          id: "dispute_pattern",
          title: "Common Dispute Reasons",
          description: `You've lost ${input.disputesLost} of ${input.disputesOpened} disputes (${(lostRate*100).toFixed(0)}% loss rate).`,
          priority: "high",
          actionable: true,
          recommendedAction: "Review dispute notes to identify patterns - maybe shipping times or product descriptions need improvement.",
        });
      }
    }

    // Trust score impact
    if (input.disputesLost > 3) {
      insights.push({
        id: "trust_impact",
        title: "Trust Score at Risk",
        description: `Multiple lost disputes (${input.disputesLost}) are impacting your trust score, affecting customer confidence.`,
        priority: "high",
        actionable: true,
        recommendedAction: "Consider offering pre-shipment tracking updates and clear return policies to reduce disputes.",
      });
    }

    // Repeat customers
    if (input.repeatCustomerRate < 0.2) {
      insights.push({
        id: "low_repeat",
        title: "Build Repeat Customer Relationships",
        description: `Only ${(input.repeatCustomerRate*100).toFixed(0)}% of customers return. Loyal customers are more forgiving of minor issues.`,
        priority: "medium",
        actionable: true,
        recommendedAction: "Add a loyalty program or follow-up thank-you messages after delivery.",
      });
    } else if (input.repeatCustomerRate > 0.5) {
      insights.push({
        id: "loyal_customers",
        title: "Loyal Customer Base",
        description: `${(input.repeatCustomerRate*100).toFixed(0)}% of customers have returned. Focus on delighting them further!`,
        priority: "low",
        actionable: false,
      });
    }

    // Response time
    if (input.avgResponseTimeHours > 24) {
      insights.push({
        id: "response_time",
        title: "Customer Response Time Matters",
        description: `Average ${input.avgResponseTimeHours.toFixed(0)} hour response time. Quick responses reduce disputes.`,
        priority: "medium",
        actionable: true,
        recommendedAction: "Set up order status updates to reduce 'where is my order?' inquiries.",
      });
    }

    // Summary
    let summary = `${merchantName}: ${(input.successRate*100).toFixed(0)}% success rate, $${(input.totalRevenueCents/100).toFixed(2)} revenue, ${input.disputesLost} lost disputes.`;
    if (insights.length > 0) {
      summary = `${merchantName}: ` + insights.slice(0, 2).map(i => i.description).join("; ");
    }

    return {
      merchantId: input.merchantId,
      merchantName,
      periodDays,
      insights,
      summary,
      source: "scripted",
      confidence,
      trace: [{ node: "local", ms: 0, detail: "offline analysis" }],
    };
  }
}

/** The Node referee: validates what the Python service returns. Never trusted. */
export function checkInsightsResult(raw: InsightsResult, input: InsightsInput): InsightsResult {
  // Validate structure
  if (!raw.merchantId || raw.merchantId !== input.merchantId) {
    throw new Error("Invalid merchant ID in response");
  }
  if (!Array.isArray(raw.insights)) {
    throw new Error("Insights must be an array");
  }
  for (const i of raw.insights) {
    if (!i.id || !i.title || !i.description || !["high", "medium", "low"].includes(i.priority)) {
      throw new Error("Invalid insight structure");
    }
    if (i.actionable && !i.recommendedAction) {
      throw new Error("Actionable insights must have recommendedAction");
    }
  }
  if (!["gemini", "scripted"].includes(raw.source)) {
    throw new Error("Invalid source");
  }
  if (!["high", "medium", "low"].includes(raw.confidence)) {
    throw new Error("Invalid confidence");
  }
  if (raw.periodDays !== input.periodDays) {
    throw new Error("Period mismatch");
  }
  return raw;
}

/** Calls the Python agent service. Falls back to local on any failure. */
export class RemoteInsightsClient {
  constructor(
    private baseUrl: string,
    private apiKey = "",
    private fallback: LocalInsightsClient,
    private onError: (e: unknown) => void = () => {},
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 60_000,
  ) {}

  async run(input: InsightsInput): Promise<InsightsResult> {
    try {
      const res = await this.fetchImpl(
        this.baseUrl.replace(/\/$/, "") + "/insights",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { "x-agents-key": this.apiKey } : {}),
          },
          body: JSON.stringify({
            merchantId: input.merchantId,
            periodDays: input.periodDays,
            totalRevenueCents: input.totalRevenueCents,
            avgOrderCents: input.avgOrderCents,
            successRate: input.successRate,
            disputesOpened: input.disputesOpened,
            disputesLost: input.disputesLost,
            repeatCustomerRate: input.repeatCustomerRate,
            avgResponseTimeHours: input.avgResponseTimeHours,
            totalPayments: input.totalPayments,
            merchantName: input.merchantName,
            includeDisputeAnalysis: true,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok) throw new Error(`Insights service returned ${res.status}`);
      const raw = InsightsOut.parse(await res.json());
      return checkInsightsResult(raw, input);
    } catch (e) {
      this.onError(e);
      return this.fallback.run(input);
    }
  }
}

export function makeInsightsClient(
  env: Record<string, string | undefined> = process.env,
  onError?: (e: unknown) => void,
  fetchImpl?: typeof fetch,
): RemoteInsightsClient | LocalInsightsClient {
  const local = new LocalInsightsClient();
  return env.AGENTS_URL
    ? new RemoteInsightsClient(env.AGENTS_URL, env.AGENTS_API_KEY ?? "", local, onError, fetchImpl)
    : local;
}