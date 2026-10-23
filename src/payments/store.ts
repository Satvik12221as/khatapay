import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Line } from "../keypad/keypad";

export type PaymentState = "CREATED" | "HELD" | "FULFILLED" | "DISPUTED" | "RELEASED" | "REFUNDED" | "FAILED" | "CANCELLED";
export type ClaimReason = "not_received" | "wrong_items" | "wrong_amount" | "other";
export type ShopStance = "delivered_ok" | "agrees_refund";

export interface AuditEvent { at: string; event: string; from: PaymentState | null; to: PaymentState; actor: string; detail?: string; ref?: string }
export interface Vote { judge: string; verdict: "release" | "refund"; reason: string; source: "gemini" | "scripted" }
export interface PanelVerdict { votes: Vote[]; outcome: "release" | "refund"; note?: string }
export interface Dispute { reason: ClaimReason; note: string; openedAt: string; shopStance?: ShopStance; shopNote?: string; verdict?: PanelVerdict }

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
  payoutId?: string;
  refundId?: string;
  error?: string;
  createdAt: string;
  deliveredAt?: string;
  dispute?: Dispute;
  events: AuditEvent[];
}

/** Keeps payments in memory and (optionally) in a JSON file so a restart does not lose them. */
export class PaymentStore {
  private m = new Map<string, Payment>();
  constructor(private file?: string) {
    if (file && existsSync(file)) {
      try { for (const p of JSON.parse(readFileSync(file, "utf8")) as Payment[]) this.m.set(p.id, p); } catch { /* ignore a corrupt file */ }
    }
  }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.m.values()]));
  }
  add(p: Payment) { this.m.set(p.id, p); this.save(); return p; }
  get(id: string) { return this.m.get(id); }
  list() { return [...this.m.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  update(id: string, patch: Partial<Payment>) {
    const p = this.m.get(id);
    if (!p) throw new Error("Payment not found");
    Object.assign(p, patch);
    this.save();
    return p;
  }
}