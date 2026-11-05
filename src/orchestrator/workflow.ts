/**
 * Workflow Orchestrator — runs the full payment lifecycle through all agents.
 *
 * Pipeline:
 *   paymentId → [insights + pricecheck] → capture → invoice → referral → notify
 *
 * Triggered by:
 *   1. Manual: POST /api/payments/:id/auto-complete
 *   2. Event-driven: PaymentEngine emits PAYMENT.STATE_CHANGED
 *   3. Cron: scheduler runs on intervals
 */

import type { Payment } from "../payments/store";
import type { PaymentEngine } from "../payments/engine";
import type { ReferralService } from "../referrals/service";
import type { InsightsResult } from "../agents/insights";
import type { InvoiceResult } from "../agents/invoice";
import type { PriceCheckResult } from "../agents/pricecheck";
import type { Merchant } from "../merchants";
import { MERCHANTS } from "../merchants";
import { trustScore, statsFor } from "../trust/trust";
import { broadcastEvent, EventTypes } from "../events/sse";

export interface WorkflowStep {
  step: string;
  status: "started" | "completed" | "failed" | "skipped";
  durationMs: number;
  detail?: string;
  result?: unknown;
}

export interface WorkflowResult {
  paymentId: string;
  status: "COMPLETED" | "BLOCKED" | "PARTIAL" | "FAILED";
  steps: WorkflowStep[];
  insights?: InsightsResult;
  invoice?: InvoiceResult;
  error?: string;
}

export interface OrchestratorDeps {
  engine: PaymentEngine;
  referrals: ReferralService;
  insightsClient: { run(input: any): Promise<InsightsResult> };
  invoiceClient: { run(input: any): Promise<InvoiceResult> };
  priceCheck: (req: any, typicalCents: number | null) => PriceCheckResult;
  merchants: Merchant[];
  store: { list(): Payment[]; get(id: string): Payment | undefined; linkOf(paymentId: string): { customerId: string } | undefined };
}

const step = (name: string, status: WorkflowStep["status"], durationMs: number, detail?: string, result?: unknown): WorkflowStep => ({ step: name, status, durationMs, detail, result });

async function timed<T>(name: string, fn: () => Promise<T>): Promise<{ result: T; duration: number }> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, duration: Date.now() - t0 };
  } catch (e) {
    return { result: undefined as unknown as T, duration: Date.now() - t0 };
  }
}

export class WorkflowOrchestrator {
  constructor(private deps: OrchestratorDeps) {}

  /** Run the full payment lifecycle. */
  async runPaymentLifecycle(paymentId: string): Promise<WorkflowResult> {
    const steps: WorkflowStep[] = [];
    const payment = this.deps.engine.get(paymentId);
    const merchant = this.deps.merchants.find(m => m.id === payment.merchantId);
    if (!merchant) return { paymentId, status: "FAILED", steps, error: "Unknown merchant" };

    // Step 1: Insights + Price Check (parallel)
    const allPayments = this.deps.store.list();
    const stats = statsFor(merchant.id, allPayments, p => this.deps.store.linkOf(p)?.customerId, merchant.history);
    const trust = trustScore(stats);

    const [insightsResult, priceResult] = await Promise.all([
      timed("insights", () => this.deps.insightsClient.run({
        merchantId: merchant.id,
        merchantName: merchant.name,
        periodDays: 30,
        totalPayments: stats.completed,
        totalRevenueCents: stats.completed * merchant.typicalCents,
        avgOrderCents: merchant.typicalCents,
        successRate: stats.completed > 0 ? 1 : 0,
        disputesOpened: stats.disputesLost,
        disputesLost: stats.disputesLost,
        repeatCustomerRate: stats.repeatCustomers > 0 ? 0.5 : 0,
        avgResponseTimeHours: 12,
      })),
      timed("pricecheck", () => {
        const typicalCents = merchant.typicalCents;
        return Promise.resolve(this.deps.priceCheck(
          { merchantId: merchant.id, lines: payment.lines },
          typicalCents
        ));
      }),
    ]);

    steps.push(step("insights", insightsResult.result ? "completed" : "failed", insightsResult.duration, `Generated ${insightsResult.result?.insights?.length ?? 0} insights`, insightsResult.result));
    steps.push(step("pricecheck", priceResult.result ? "completed" : "failed", priceResult.duration, `Verdict: ${priceResult.result?.totalVerdict}`, priceResult.result));

    // Step 2: Capture (if not already captured)
    if (payment.state === "CREATED") {
      const cap = await timed("capture", () => this.deps.engine.capture(paymentId));
      steps.push(step("capture", cap.result ? "completed" : "failed", cap.duration, `State: ${cap.result?.state}`));
    } else {
      steps.push(step("capture", "skipped", 0, `Already ${payment.state}`));
    }

    // Step 3: Generate Invoice
    const inv = await timed("invoice", () => this.deps.invoiceClient.run({
      paymentId,
      merchant: { id: merchant.id, name: merchant.name },
      lineItems: payment.lines.map(l => ({ description: l.expr, quantity: 1, unitPriceCents: l.cents, totalCents: l.cents })),
      taxRate: 0.18,
    }));
    steps.push(step("invoice", inv.result ? "completed" : "failed", inv.duration, `Invoice: ${inv.result?.invoiceNumber}`, inv.result));

    // Step 4: Referral Settlement (fire-and-forget)
    const ref = await timed("referral", () => this.deps.referrals.sync(paymentId).then(() => ({ ok: true as const })).catch(e => ({ ok: false as const, error: e.message })));
    const referralOk = ref.result.ok === true;
    steps.push(step("referral", referralOk ? "completed" : "failed", ref.duration, referralOk ? "Settled" : (ref.result.ok === false ? ref.result.error : "No referral")));

    // Step 5: Broadcast events
    broadcastEvent(merchant.id, {
      type: EventTypes.AGENT_INSIGHTS_GENERATED,
      merchantId: merchant.id,
      count: insightsResult.result?.insights?.length ?? 0,
      timestamp: new Date().toISOString(),
    });
    if (inv.result) {
      broadcastEvent(merchant.id, {
        type: EventTypes.AGENT_INVOICE_GENERATED,
        paymentId,
        invoiceNumber: inv.result.invoiceNumber,
        timestamp: new Date().toISOString(),
      });
    }

    const hasFailure = steps.some(s => s.status === "failed");
    return {
      paymentId,
      status: hasFailure ? "PARTIAL" : "COMPLETED",
      steps,
      insights: insightsResult.result,
      invoice: inv.result,
    };
  }
}

/** Build an orchestrator from the app's existing dependencies. */
export function makeOrchestrator(deps: OrchestratorDeps): WorkflowOrchestrator {
  return new WorkflowOrchestrator(deps);
}