/**
 * Zapier Webhook Integration
 * Sends real-time agent events to Zapier for Shopify/Slack/Email/GSheets integrations.
 */

import { EventTypes } from "../events/sse";

interface ZapierWebhookEvent {
  event: string;
  timestamp: string;
  merchantId?: string;
  paymentId?: string;
  amountCents?: number;
  amountDollars?: number;
  currency?: string;
  batchId?: string;
  invoiceNumber?: string;
  referralId?: string;
  discountCents?: number;
  discountDollars?: number;
  details?: Record<string, unknown>;
}

type ZapierConfig = {
  url: string;
  events: string[]; // Which events to forward
  secret?: string;  // Optional HMAC signature
};

let zapierConfig: ZapierConfig | null = null;
let zapierQueue: ZapierWebhookEvent[] = [];
const BATCH_INTERVAL = 5000; // Batch webhooks every 5 seconds
const MAX_RETRIES = 3;

function loadConfig(env: Record<string, string | undefined>): ZapierConfig | null {
  const url = env.ZAPIER_WEBHOOK_URL;
  if (!url) return null;

  const events = env.ZAPIER_EVENTS?.split(",").map(e => e.trim()).filter(Boolean) ?? [
    EventTypes.PAYMENT_CAPTURE_COMPLETED,
    EventTypes.PAYOUT_COMPLETED,
    EventTypes.REFUND_COMPLETED,
    EventTypes.DISPUTE_CREATED,
    EventTypes.JUDGE_VERDICT,
    EventTypes.AGENT_INSIGHTS_GENERATED,
    EventTypes.AGENT_INVOICE_GENERATED,
    EventTypes.AGENT_REFERRAL_PAID,
    EventTypes.AGENT_HAGGLE_COMPLETED,
  ];

  return {
    url,
    events,
    secret: env.ZAPIER_WEBHOOK_SECRET,
  };
}

function signPayload(payload: string, secret: string): string {
  const crypto = require("crypto");
  return "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function sendToZapier(event: ZapierWebhookEvent): Promise<boolean> {
  if (!zapierConfig) return false;
  if (!zapierConfig.events.includes(event.event)) return false;

  const payload = JSON.stringify(event);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "KhataPay-Zapier/1.0",
  };

  if (zapierConfig.secret) {
    headers["X-KhataPay-Signature"] = signPayload(payload, zapierConfig.secret);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(zapierConfig.url, {
        method: "POST",
        headers,
        body: payload,
        signal: AbortSignal.timeout(10000),
      });

      if (res.ok || res.status === 400) {
        // 400 might be Zapier validation error - don't retry
        return res.ok;
      }

      if (attempt === MAX_RETRIES) {
        console.error(`Zapier webhook failed after ${MAX_RETRIES} attempts:`, res.status, await res.text());
        return false;
      }

      // Exponential backoff
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    } catch (e) {
      if (attempt === MAX_RETRIES) {
        console.error(`Zapier webhook error after ${MAX_RETRIES} attempts:`, e);
        return false;
      }
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }

  return false;
}

// Queue processor
let processorRunning = false;
async function processQueue() {
  if (processorRunning || zapierQueue.length === 0) return;
  processorRunning = true;

  while (zapierQueue.length > 0) {
    const event = zapierQueue.shift()!;
    await sendToZapier(event);
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 100));
  }

  processorRunning = false;
}

export function initZapier(env: Record<string, string | undefined>) {
  zapierConfig = loadConfig(env);
  if (zapierConfig) {
    console.log(`Zapier webhook configured: ${zapierConfig.url} (${zapierConfig.events.length} events)`);
  } else {
    console.log("Zapier webhook not configured (set ZAPIER_WEBHOOK_URL)");
  }
}

export function emitZapierEvent(event: Omit<ZapierWebhookEvent, "timestamp">) {
  if (!zapierConfig) return;
  if (!zapierConfig.events.includes(event.event)) return;

  zapierQueue.push({
    ...event,
    timestamp: new Date().toISOString(),
  });

  if (!processorRunning) {
    setTimeout(processQueue, 0);
  }
}

/** Event emitter hooks for key payment/agent events. */
export const ZapierEvents = {
  paymentCaptured: (paymentId: string, amountCents: number, merchantId: string) =>
    emitZapierEvent({
      event: EventTypes.PAYMENT_CAPTURE_COMPLETED,
      paymentId,
      amountCents,
      amountDollars: amountCents / 100,
      merchantId,
      currency: "USD",
      details: { capturedAt: new Date().toISOString() },
    }),

  payoutCompleted: (batchId: string, amountCents: number, merchantId: string) =>
    emitZapierEvent({
      event: EventTypes.PAYOUT_COMPLETED,
      batchId,
      amountCents,
      amountDollars: amountCents / 100,
      merchantId,
      currency: "USD",
      details: { paidAt: new Date().toISOString() },
    }),

  refundIssued: (paymentId: string, amountCents: number, reason: string) =>
    emitZapierEvent({
      event: EventTypes.REFUND_COMPLETED,
      paymentId,
      amountCents,
      amountDollars: amountCents / 100,
      currency: "USD",
      details: { reason, refundedAt: new Date().toISOString() },
    }),

  disputeOpened: (paymentId: string, amountCents: number, reason: string) =>
    emitZapierEvent({
      event: EventTypes.DISPUTE_CREATED,
      paymentId,
      amountCents,
      amountDollars: amountCents / 100,
      currency: "USD",
      details: { reason, disputedAt: new Date().toISOString() },
    }),

  judgeVerdict: (paymentId: string, outcome: "release" | "refund", amountCents: number) =>
    emitZapierEvent({
      event: EventTypes.JUDGE_VERDICT,
      paymentId,
      amountCents,
      amountDollars: amountCents / 100,
      currency: "USD",
      details: { outcome, judgedAt: new Date().toISOString() },
    }),

  insightsGenerated: (merchantId: string, count: number) =>
    emitZapierEvent({
      event: EventTypes.AGENT_INSIGHTS_GENERATED,
      merchantId,
      details: { count, generatedAt: new Date().toISOString() },
    }),

  invoiceGenerated: (paymentId: string, invoiceNumber: string, amountCents: number) =>
    emitZapierEvent({
      event: EventTypes.AGENT_INVOICE_GENERATED,
      paymentId,
      invoiceNumber,
      amountCents,
      amountDollars: amountCents / 100,
      currency: "USD",
      details: { generatedAt: new Date().toISOString() },
    }),

  referralPaid: (referralId: string, amountCents: number, merchantId: string) =>
    emitZapierEvent({
      event: EventTypes.AGENT_REFERRAL_PAID,
      referralId,
      merchantId,
      amountCents,
      amountDollars: amountCents / 100,
      currency: "USD",
      details: { paidAt: new Date().toISOString() },
    }),

  haggleCompleted: (paymentId: string, discountCents: number, agreed: boolean) =>
    emitZapierEvent({
      event: EventTypes.AGENT_HAGGLE_COMPLETED,
      paymentId,
      discountCents,
      discountDollars: discountCents / 100,
      currency: "USD",
      details: { agreed, completedAt: new Date().toISOString() },
    }),
};

/** Fastify route to configure Zapier dynamically. */
export function buildZapierRoutes() {
  const router = {
    "/zapier/test": {
      method: "POST",
      handler: async (req: any) => {
        const { event, data } = req.body;
        if (!event || !data) return { error: "Missing event or data" };
        emitZapierEvent({ event, ...data });
        return { status: "queued", event };
      },
    },
    "/zapier/status": {
      method: "GET",
      handler: async () => ({
        configured: !!zapierConfig,
        events: zapierConfig?.events ?? [],
        queueLength: zapierQueue.length,
      }),
    },
  };
  return router;
}