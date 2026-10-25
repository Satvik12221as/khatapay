import type { PayPal } from "../paypal/client";
import type { AuditEvent, ClaimReason, Payment, PaymentStore, ShopStance } from "./store";
import { IllegalTransition, next, type Action } from "./states";
import { tapeHash } from "./tape";
import type { Evidence } from "../judge/judges";
import type { Panel } from "../agents/panel";

/** All money movement goes through here. Every step is validated, idempotent and logged. */
export class PaymentEngine {
  constructor(private store: PaymentStore, private pp: PayPal, private panel: Panel, private payoutEmail?: string) {}

  get(id: string): Payment {
    const p = this.store.get(id);
    if (!p) throw Object.assign(new Error("Unknown payment"), { statusCode: 404 });
    return p;
  }

  private ev(p: Payment | null, action: string, to: Payment["state"], actor: string, detail?: string, ref?: string): AuditEvent {
    return { at: new Date().toISOString(), event: action.toUpperCase(), from: p ? p.state : null, to, actor, ...(detail ? { detail } : {}), ...(ref ? { ref } : {}) };
  }

  /** Re-reads the payment so two quick clicks can never apply the same step twice. */
  private move(id: string, action: Action, actor: string, patch: Partial<Payment> = {}, detail?: string, ref?: string): Payment {
    const cur = this.get(id);
    const to = next(cur.state, action);
    return this.store.update(id, { ...patch, state: to, events: [...cur.events, this.ev(cur, action, to, actor, detail, ref)] });
  }

  create(p: Omit<Payment, "events" | "state">): Payment {
    return this.store.add({ ...p, state: "CREATED", events: [this.ev(null, "create", "CREATED", "customer", `${p.lines.length} line(s), tape ${p.tapeHash.slice(0, 8)}`)] });
  }

  async capture(id: string): Promise<Payment> {
    const p = this.get(id);
    if (p.state !== "CREATED") return p;
    try {
      const cap = await this.pp.captureOrder(p.orderId, `khatapay-${id}-capture`);
      if (cap.status === "COMPLETED") return this.move(id, "capture", "customer", { captureId: cap.captureId }, "Funds held", cap.captureId);
      return this.move(id, "fail", "system", { error: `Capture status ${cap.status}` });
    } catch (e: any) {
      return this.move(id, "fail", "system", { error: e.message });
    }
  }

  cancel(id: string): Payment {
    const p = this.get(id);
    return p.state === "CREATED" ? this.move(id, "cancel", "customer") : p;
  }

  deliver(id: string): Payment {
    return this.move(id, "deliver", "shop", { deliveredAt: new Date().toISOString() }, "Shop marked delivered");
  }

  private async payShop(p: Payment) {
    if (!this.payoutEmail) throw new Error("SHOP_PAYOUT_EMAIL is not set");
    return this.pp.payout({ email: this.payoutEmail, amountCents: p.amountCents, currency: p.currency, note: `KhataPay ${p.id.slice(0, 8)}`, batchId: `khatapay-${p.id}-payout` });
  }
  private async refundCustomer(p: Payment) {
    if (!p.captureId) throw new Error("Nothing to refund");
    return this.pp.refund(p.captureId, `khatapay-${p.id}-refund`, p.amountCents, p.currency);
  }

  /** Customer confirms receipt: the shop is paid. */
  async confirm(id: string): Promise<Payment> {
    const p = this.get(id);
    next(p.state, "confirm");                       // validate before touching PayPal
    const po = await this.payShop(p);
    return this.move(id, "confirm", "customer", { payoutId: po.batchId }, `Payout ${po.status}`, po.batchId);
  }

  /** Customer asks for the money back before delivery. */
  async refund(id: string): Promise<Payment> {
    const p = this.get(id);
    next(p.state, "refund");
    const r = await this.refundCustomer(p);
    return this.move(id, "refund", "customer", { refundId: r.refundId }, `Refund ${r.status}`, r.refundId);
  }

  dispute(id: string, reason: ClaimReason, note: string): Payment {
    return this.move(id, "dispute", "customer", { dispute: { reason, note: note.slice(0, 200), openedAt: new Date().toISOString() } }, `Claim: ${reason}`);
  }

  respond(id: string, stance: ShopStance, note: string): Payment {
    const p = this.get(id);
    if (p.state !== "DISPUTED" || !p.dispute || p.dispute.verdict) throw new IllegalTransition(p.state, "dispute");
    return this.store.update(id, {
      dispute: { ...p.dispute, shopStance: stance, shopNote: note.slice(0, 200) },
      events: [...p.events, this.ev(p, "shop_responded", p.state, "shop", stance)],
    });
  }

  /** Three judges read the signed tape and vote. Plain code then executes the verdict through PayPal */
  async judge(id: string): Promise<Payment> {
    const p = this.get(id);
    next(p.state, "release");                       // must be DISPUTED
    const d = p.dispute!;
    const tapeVerified = tapeHash({ merchantId: p.merchantId, currency: p.currency, lines: p.lines, totalCents: p.amountCents }) === p.tapeHash;
    const evidence: Evidence = {
      totalCents: p.amountCents, lines: p.lines, tapeVerified,
      deliveryMarked: !!p.deliveredAt,
      hoursSinceDelivery: p.deliveredAt ? Math.round((Date.now() - Date.parse(p.deliveredAt)) / 3_600_000) : null,
      claimReason: d.reason, customerNote: d.note,
      shopStance: d.shopStance ?? "no_response", shopNote: d.shopNote ?? "",
    };
    const verdict = tapeVerified
      ? await this.panel.run(evidence)
      : { votes: [], outcome: "refund" as const, note: "Tape fingerprint mismatch: refunded without a vote." };
    this.store.update(id, { dispute: { ...d, verdict } });
    const detail = `Verdict: ${verdict.outcome}`;
    if (verdict.outcome === "release") {
      const po = await this.payShop(p);
      return this.move(id, "release", "judges", { payoutId: po.batchId }, `${detail}. Payout ${po.status}`, po.batchId);
    }
    const r = await this.refundCustomer(p);
    return this.move(id, "refund", "judges", { refundId: r.refundId }, `${detail}. Refund ${r.status}`, r.refundId);
  }
}