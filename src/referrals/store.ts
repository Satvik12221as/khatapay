import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Customer { id: string; name: string; paypalEmail?: string; referralCode: string; createdAt: string }
export type ReferralState = "PENDING" | "REWARDED" | "VOID";
export interface Referral {
  id: string; referrerId: string; refereeId: string; merchantId: string; paymentId: string;
  welcomeCents: number; state: ReferralState; rewardCents?: number; payoutId?: string; reason?: string;
  createdAt: string; settledAt?: string;
}
export interface Link { paymentId: string; customerId: string; merchantId: string }
interface Snapshot { customers: Customer[]; links: Link[]; referrals: Referral[]; pitches: Record<string, string> }

/** Customers, which payment belongs to whom, referrals and the saved pitches. Optionally kept in a JSON file. */
export class ReferralStore {
  private customers = new Map<string, Customer>();
  private links = new Map<string, Link>();
  private referrals = new Map<string, Referral>();
  private pitches = new Map<string, string>();

  constructor(private file?: string) {
    if (file && existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
        s.customers.forEach((c) => this.customers.set(c.id, c));
        s.links.forEach((l) => this.links.set(l.paymentId, l));
        s.referrals.forEach((r) => this.referrals.set(r.id, r));
        Object.entries(s.pitches).forEach(([k, v]) => this.pitches.set(k, v));
      } catch { /* ignore a corrupt file */ }
    }
  }
  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const s: Snapshot = { customers: [...this.customers.values()], links: [...this.links.values()], referrals: [...this.referrals.values()], pitches: Object.fromEntries(this.pitches) };
    writeFileSync(this.file, JSON.stringify(s));
  }

  private newCode(name: string): string {
    const letters = (name.replace(/[^A-Za-z]/g, "").slice(0, 4) || "FRND").toUpperCase().padEnd(4, "X");
    for (;;) {
      const code = `${letters}-${randomBytes(2).toString("hex").toUpperCase()}`;
      if (![...this.customers.values()].some((c) => c.referralCode === code)) return code;
    }
  }

  createCustomer(name: string, paypalEmail?: string): Customer {
    const c: Customer = { id: randomUUID(), name, ...(paypalEmail ? { paypalEmail } : {}), referralCode: this.newCode(name), createdAt: new Date().toISOString() };
    this.customers.set(c.id, c);
    this.save();
    return c;
  }
  customer(id: string) { return this.customers.get(id); }
  findByCode(code: string) { return [...this.customers.values()].find((c) => c.referralCode === code); }
  updateCustomer(id: string, patch: { name?: string; paypalEmail?: string }): Customer {
    const c = this.customers.get(id);
    if (!c) throw new Error("Unknown customer");
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.paypalEmail !== undefined) c.paypalEmail = patch.paypalEmail;
    this.save();
    return c;
  }

  link(paymentId: string, customerId: string, merchantId: string) { this.links.set(paymentId, { paymentId, customerId, merchantId }); this.save(); }
  linkOf(paymentId: string) { return this.links.get(paymentId); }
  paymentsOf(customerId: string) { return [...this.links.values()].filter((l) => l.customerId === customerId); }

  addReferral(r: Omit<Referral, "id" | "state" | "createdAt">): Referral {
    const ref: Referral = { ...r, id: randomUUID(), state: "PENDING", createdAt: new Date().toISOString() };
    this.referrals.set(ref.id, ref);
    this.save();
    return ref;
  }
  updateReferral(id: string, patch: Partial<Referral>) { const r = this.referrals.get(id)!; Object.assign(r, patch); this.save(); return r; }
  allReferrals() { return [...this.referrals.values()]; }
  referralByPayment(paymentId: string) { return this.allReferrals().find((r) => r.paymentId === paymentId && r.state !== "VOID"); }
  pendingForPayment(paymentId: string) { return this.allReferrals().find((r) => r.paymentId === paymentId && r.state === "PENDING"); }

  setPitch(referrerId: string, merchantId: string, message: string) { this.pitches.set(`${referrerId}:${merchantId}`, message); this.save(); }
  pitch(referrerId: string, merchantId: string) { return this.pitches.get(`${referrerId}:${merchantId}`); }
}