/** Server-Sent Events connection manager for real-time agent events. */
interface SSEClient {
  merchantId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  connectedAt: number;
}

const clients = new Map<string, SSEClient[]>();
const encoder = new TextEncoder();

function formatSSE(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function heartbeat(): Uint8Array {
  return encoder.encode(`: heartbeat\n\n`);
}

/** Broadcast an event to all clients watching a merchant. */
export function broadcastEvent(merchantId: string, event: unknown): void {
  const merchantClients = clients.get(merchantId);
  if (!merchantClients) return;

  const payload = formatSSE(event);
  for (const client of merchantClients) {
    try {
      client.controller.enqueue(payload);
    } catch {
      // Client disconnected, will be cleaned up
    }
  }
}

/** Register a new SSE connection for a merchant. */
export function registerSSEClient(merchantId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
  if (!clients.has(merchantId)) {
    clients.set(merchantId, []);
  }
  clients.get(merchantId)!.push({
    merchantId,
    controller,
    connectedAt: Date.now()
  });
}

/** Unregister an SSE client. */
export function unregisterSSEClient(merchantId: string, controller: ReadableStreamDefaultController<Uint8Array>): void {
  const merchantClients = clients.get(merchantId);
  if (!merchantClients) return;

  const idx = merchantClients.findIndex(c => c.controller === controller);
  if (idx >= 0) merchantClients.splice(idx, 1);

  if (merchantClients.length === 0) {
    clients.delete(merchantId);
  }
}

/** Get connected client count for a merchant. */
export function getClientCount(merchantId: string): number {
  return clients.get(merchantId)?.length ?? 0;
}

/** Heartbeat interval to keep connections alive. */
const HEARTBEAT_INTERVAL = 30_000;
setInterval(() => {
  for (const [merchantId, merchantClients] of clients) {
    const hb = heartbeat();
    for (const client of merchantClients) {
      try {
        client.controller.enqueue(hb);
      } catch {
        unregisterSSEClient(merchantId, client.controller);
      }
    }
  }
}, HEARTBEAT_INTERVAL);

/** Event type constants for consistency. */
export const EventTypes = {
  // PayPal events
  PAYMENT_CAPTURE_COMPLETED: "PAYMENT.CAPTURE.COMPLETED",
  PAYOUT_COMPLETED: "PAYOUT.COMPLETED",
  REFUND_COMPLETED: "REFUND.COMPLETED",
  DISPUTE_CREATED: "DISPUTE.CREATED",

  // Agent events
  AGENT_INSIGHTS_GENERATED: "AGENT.INSIGHTS_GENERATED",
  AGENT_INVOICE_GENERATED: "AGENT.INVOICE_GENERATED",
  AGENT_REFERRAL_PAID: "AGENT.REFERRAL_PAID",
  AGENT_HAGGLE_COMPLETED: "AGENT.HAGGLE_COMPLETED",
  AGENT_PRICE_CHECK_COMPLETED: "AGENT.PRICE_CHECK_COMPLETED",

  // Judge events
  JUDGE_VERDICT: "JUDGE.VERDICT",

  // Payment state changes
  PAYMENT_STATE_CHANGED: "PAYMENT.STATE_CHANGED",
} as const;

export type EventType = typeof EventTypes[keyof typeof EventTypes];