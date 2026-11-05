/** PayPal Webhook Types and Simulator for Demo */
import { EventTypes, broadcastEvent } from "../events/sse";
import type { Payment } from "../payments/store";
import type { Referral } from "../referrals/store";

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource_type: string;
  resource: PayPalWebhookResource;
  resource_version: string;
}

export interface PayPalWebhookResource {
  id: string;
  status: string;
  amount?: { value: string; currency_code: string };
  purchase_units?: Array<{ reference_id: string; custom_id: string }>;
  links?: Array<{ rel: string; href: string }>;
  batch_header?: { payout_batch_id: string; batch_status: string };
  batch_id?: string;
  item_id?: string;
  reason?: string;
}

/** Simulated PayPal event types for demo. */
export const SimulatedEvents = {
  CAPTURE_COMPLETED: {
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource_type: "capture",
    resource: {
      id: "capture-sim-123",
      status: "COMPLETED",
      amount: { value: "10.00", currency_code: "USD" },
      purchase_units: [{ reference_id: "payment-123", custom_id: "tape-hash" }],
    },
  },
  PAYOUT_COMPLETED: {
    event_type: "PAYOUT.COMPLETED",
    resource_type: "payout",
    resource: {
      id: "payout-sim-123",
      status: "COMPLETED",
      batch_header: { payout_batch_id: "batch-123", batch_status: "SUCCESS" },
      batch_id: "batch-123",
      item_id: "item-123",
    },
  },
  REFUND_COMPLETED: {
    event_type: "PAYMENT.REFUND.COMPLETED",
    resource_type: "refund",
    resource: {
      id: "refund-sim-123",
      status: "COMPLETED",
      amount: { value: "10.00", currency_code: "USD" },
    },
  },
  DISPUTE_CREATED: {
    event_type: "CUSTOMER.DISPUTE.CREATED",
    resource_type: "dispute",
    resource: {
      id: "dispute-sim-123",
      status: "OPEN",
      reason: "MERCHANDISE_NOT_RECEIVED",
      amount: { value: "10.00", currency_code: "USD" },
    },
  },
};

/** Build a simulated webhook event. */
export function buildSimulatedWebhook(
  eventType: keyof typeof SimulatedEvents,
  overrides: Partial<PayPalWebhookEvent> = {}
): PayPalWebhookEvent {
  const base = SimulatedEvents[eventType];
  return {
    id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    event_type: base.event_type,
    create_time: new Date().toISOString(),
    resource_type: base.resource_type,
    resource: { ...base.resource, ...overrides.resource },
    resource_version: "2.0",
    ...overrides,
  };
}

/** Process a real PayPal webhook (verifies signature in production). */
export async function processPayPalWebhook(
  event: PayPalWebhookEvent,
  engine: { capture: (id: string) => Promise<Payment>; payout: (id: string) => Promise<any> }
): Promise<{ handled: boolean; message: string }> {
  // In production: verify webhook signature with PayPal SDK
  // const verified = await paypalWebhooks.verify(...);

  switch (event.event_type) {
    case "PAYMENT.CAPTURE.COMPLETED": {
      const paymentId = event.resource.purchase_units?.[0]?.reference_id;
      if (paymentId) {
        broadcastEvent("system", {
          type: EventTypes.PAYMENT_CAPTURE_COMPLETED,
          paymentId,
          timestamp: event.create_time,
          captureId: event.resource.id,
        });
        // engine.capture(paymentId); // Would trigger in real flow
      }
      return { handled: true, message: "Capture completed" };
    }
    case "PAYOUT.COMPLETED": {
      const batchId = event.resource.batch_header?.payout_batch_id;
      if (batchId) {
        broadcastEvent("system", {
          type: EventTypes.PAYOUT_COMPLETED,
          batchId,
          timestamp: event.create_time,
        });
      }
      return { handled: true, message: "Payout completed" };
    }
    case "PAYMENT.REFUND.COMPLETED": {
      broadcastEvent("system", {
        type: EventTypes.REFUND_COMPLETED,
        refundId: event.resource.id,
        timestamp: event.create_time,
      });
      return { handled: true, message: "Refund completed" };
    }
    case "CUSTOMER.DISPUTE.CREATED": {
      broadcastEvent("system", {
        type: EventTypes.DISPUTE_CREATED,
        disputeId: event.resource.id,
        timestamp: event.create_time,
      });
      return { handled: true, message: "Dispute created" };
    }
    default:
      return { handled: false, message: `Unhandled event type: ${event.event_type}` };
  }
}

/** Emit agent events for SSE. */
export function emitAgentInsightsGenerated(merchantId: string, count: number): void {
  broadcastEvent(merchantId, {
    type: EventTypes.AGENT_INSIGHTS_GENERATED,
    merchantId,
    count,
    timestamp: new Date().toISOString(),
  });
}

export function emitAgentInvoiceGenerated(paymentId: string, invoiceNumber: string): void {
  broadcastEvent("system", {
    type: EventTypes.AGENT_INVOICE_GENERATED,
    paymentId,
    invoiceNumber,
    timestamp: new Date().toISOString(),
  });
}

export function emitAgentReferralPaid(referralId: string, amountCents: number): void {
  broadcastEvent("system", {
    type: EventTypes.AGENT_REFERRAL_PAID,
    referralId,
    amountCents,
    amountDollars: amountCents / 100,
    timestamp: new Date().toISOString(),
  });
}

export function emitAgentHaggleCompleted(paymentId: string, discountCents: number): void {
  broadcastEvent("system", {
    type: EventTypes.AGENT_HAGGLE_COMPLETED,
    paymentId,
    discountCents,
    discountDollars: discountCents / 100,
    timestamp: new Date().toISOString(),
  });
}

export function emitJudgeVerdict(paymentId: string, outcome: "release" | "refund"): void {
  broadcastEvent("system", {
    type: EventTypes.JUDGE_VERDICT,
    paymentId,
    outcome,
    timestamp: new Date().toISOString(),
  });
}

export function emitPaymentStateChanged(paymentId: string, from: string, to: string): void {
  broadcastEvent("system", {
    type: EventTypes.PAYMENT_STATE_CHANGED,
    paymentId,
    from,
    to,
    timestamp: new Date().toISOString(),
  });
}