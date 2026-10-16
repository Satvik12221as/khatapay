import type { Line } from "../keypad/keypad";

export type PaymentState = "CREATED" | "PAID" | "FAILED" | "CANCELLED";

export interface Payment {
  id: string;
  merchantId: string;
  merchantName: string;
  amountCents: number;
  currency: string;
  lines: Line[];
  tapeHash: string;
  state: PaymentState;
  orderId: string;
  captureId?: string;
  error?: string;
  createdAt: string;
}

/** In-memory for now. Phase 4 replaces this with a database and the full promise state machine. */
export class PaymentStore {
  private m = new Map<string, Payment>();
  add(p: Payment) { this.m.set(p.id, p); return p; }
  get(id: string) { return this.m.get(id); }
  update(id: string, patch: Partial<Payment>) {
    const p = this.m.get(id);
    if (!p) throw new Error("Payment not found");
    Object.assign(p, patch);
    return p;
  }
}