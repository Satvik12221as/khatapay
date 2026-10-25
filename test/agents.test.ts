import { describe, it, expect } from "vitest";
import { AgentsClient } from "../src/agents/client";
import { LocalNegotiator, RemoteNegotiator, checkOutcome, makeNegotiator, type NegotiateInput } from "../src/agents/negotiator";
import { LocalPanel, RemotePanel, checkVerdict, makePanel } from "../src/agents/panel";
import { capFor } from "../src/haggle/haggle";
import type { Evidence } from "../src/judge/judges";
import { buildApp } from "../src/server";
import { MockPayPal } from "../src/paypal/client";
import type { Key } from "../src/keypad/keypad";

const input: NegotiateInput = { merchantName: "Shop", totalCents: 9000, policy: { maxDiscountPct: 10, minTotalCents: 100 }, loyalty: { visits: 14, memberSince: "March", onTimeRate: 1 } };
const turn = (side: "customer" | "shop", d: number, accept = false) => ({ side, accept, discountCents: d, message: "hello", source: "gemini" as const });
const goodOutcome = { turns: [turn("customer", 900), turn("shop", 450), turn("customer", 680), turn("shop", 680, true)], finalDiscountCents: 680, agreed: true, trace: [{ node: "customer", ms: 1, detail: "x" }] };
const ev: Evidence = { totalCents: 9000, lines: [], tapeVerified: true, deliveryMarked: true, hoursSinceDelivery: 1, claimReason: "not_received", customerNote: "", shopStance: "no_response", shopNote: "" };
const vote = (judge: string, verdict: "release" | "refund") => ({ judge, verdict, reason: "because", source: "gemini" as const });
const goodVotes = [vote("Consumer advocate", "refund"), vote("Small-shop advocate", "release"), vote("Neutral auditor", "refund")];

/** A stand-in for the Python service. */
const service = (handler: (path: string, body: any, headers: any) => { status?: number; json?: unknown } | Error) => {
  const seen: any[] = [];
  const f = (async (url: string, init: any) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    seen.push({ path, body, headers: init.headers });
    const r = handler(path, body, init.headers);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as any;
  return { f, seen };
};
const remoteNeg = (f: any, errors: unknown[] = []) => new RemoteNegotiator(new AgentsClient("http://agents:8001/", "k3y", f), new LocalNegotiator(), (e) => errors.push(e));
const remotePanel = (f: any, errors: unknown[] = []) => new RemotePanel(new AgentsClient("http://agents:8001", "", f), new LocalPanel(), (e) => errors.push(e));

describe("negotiation via the Python service", () => {
  it("sends the camelCase request with the shared secret and returns the validated outcome", async () => {
    const s = service(() => ({ json: goodOutcome }));
    const out = await remoteNeg(s.f).run(input);
    expect(out.finalDiscountCents).toBe(680);
    expect(out.turns).toHaveLength(4);
    expect(s.seen[0].path).toBe("/haggle");
    expect(s.seen[0].headers["x-agents-key"]).toBe("k3y");
    expect(s.seen[0].body).toEqual({ merchantName: "Shop", totalCents: 9000, maxDiscountPct: 10, minTotalCents: 100, loyalty: input.loyalty });
  });
  it("rejects a service that breaks the shop's limit and uses the offline agents", async () => {
    const errors: unknown[] = [];
    const bad = { ...goodOutcome, turns: [turn("customer", 900), turn("shop", 5000, true)], finalDiscountCents: 5000 };
    const out = await remoteNeg(service(() => ({ json: bad })).f, errors).run(input);
    expect(out.finalDiscountCents).toBeLessThanOrEqual(capFor(9000, input.policy));
    expect(out.turns.every((t) => t.source === "scripted")).toBe(true);
    expect(errors).toHaveLength(1);
  });
  it("falls back on HTTP errors, network failure, malformed JSON, and inconsistent answers", async () => {
    const cases: any[] = [
      () => ({ status: 500 }),
      () => new Error("ECONNREFUSED"),
      () => ({ json: { nonsense: true } }),
      () => ({ json: { ...goodOutcome, finalDiscountCents: 450 } }),                                 // final != last turn
      () => ({ json: { ...goodOutcome, turns: [turn("shop", 450), turn("customer", 450)] } }),       // wrong order
      () => ({ json: { ...goodOutcome, turns: [turn("customer", 900)] } }),                          // too few turns
    ];
    for (const c of cases) {
      const errors: unknown[] = [];
      const out = await remoteNeg(service(c).f, errors).run(input);
      expect(out.turns.every((t) => t.source === "scripted")).toBe(true);
      expect(errors).toHaveLength(1);
    }
  });
  it("checkOutcome enforces the minimum bill", () => {
    const tiny = { ...input, totalCents: 120 };
    expect(() => checkOutcome({ turns: [turn("customer", 30), turn("shop", 30, true)], finalDiscountCents: 30, agreed: true }, tiny)).toThrow();
  });
  it("uses the offline agents when AGENTS_URL is not set", () => {
    expect(makeNegotiator({})).toBeInstanceOf(LocalNegotiator);
    expect(makeNegotiator({ AGENTS_URL: "http://x" })).toBeInstanceOf(RemoteNegotiator);
  });
});

describe("judging via the Python service", () => {
  it("returns the votes and counts the majority itself", async () => {
    const s = service(() => ({ json: { votes: goodVotes, outcome: "release", note: "Judges deliberated." } }));   // service LIES about the outcome
    const v = await remotePanel(s.f).run(ev);
    expect(v.outcome).toBe("refund");
    expect(v.note).toBe("Judges deliberated.");
    expect(s.seen[0].path).toBe("/judge");
    expect(s.seen[0].headers["x-agents-key"]).toBeUndefined();
  });
  it("rejects a verdict without exactly one vote per judge and uses the offline judges", async () => {
    for (const votes of [goodVotes.slice(0, 2), [goodVotes[0], goodVotes[0], goodVotes[2]], [vote("Random judge", "release"), goodVotes[1], goodVotes[2]]]) {
      const errors: unknown[] = [];
      const v = await remotePanel(service(() => ({ json: { votes } })).f, errors).run(ev);
      expect(v.votes.every((x) => x.source === "scripted")).toBe(true);
      expect(errors).toHaveLength(1);
    }
  });
  it("falls back when the service is down", async () => {
    const errors: unknown[] = [];
    const v = await remotePanel(service(() => new Error("down")).f, errors).run(ev);
    expect(v.votes).toHaveLength(3);
    expect(errors).toHaveLength(1);
  });
  it("checkVerdict and the offline switch", () => {
    expect(checkVerdict({ votes: goodVotes }).outcome).toBe("refund");
    expect(makePanel({})).toBeInstanceOf(LocalPanel);
    expect(makePanel({ AGENTS_URL: "http://x" })).toBeInstanceOf(RemotePanel);
  });
});

describe("the whole app with the Python service", () => {
  it("/api/haggle returns the service's negotiation, and the keys replay to the discounted total", async () => {
    const s = service(() => ({ json: goodOutcome }));
    const { app } = buildApp({ NODE_ENV: "test", PAYPAL_MODE: "mock", PUBLIC_URL: "http://t" }, new MockPayPal(), remoteNeg(s.f));
    const keys = "30+40+20".split("") as Key[];
    const j = (await app.inject({ method: "POST", url: "/api/haggle", payload: { merchantId: "shop1", keys } })).json();
    expect(j.finalDiscountCents).toBe(680);
    expect(j.totalAfterCents).toBe(8320);
    expect(j.turns[0].source).toBe("gemini");
  });
  it("a dispute is judged by the service's panel and Node executes the verdict", async () => {
    const pp = new MockPayPal();
    const s = service(() => ({ json: { votes: [vote("Consumer advocate", "release"), vote("Small-shop advocate", "release"), vote("Neutral auditor", "refund")], note: "ok" } }));
    const { app } = buildApp({ NODE_ENV: "test", PAYPAL_MODE: "mock", PUBLIC_URL: "http://t" }, pp, undefined, remotePanel(s.f));
    const post = (url: string, payload: any = {}) => app.inject({ method: "POST", url, payload });
    const pay = (await post("/api/pay", { merchantId: "shop1", keys: "50".split("") })).json();
    const u = new URL(pay.approvalUrl);
    await app.inject({ url: u.pathname + u.search });
    await post(`/api/payments/${pay.paymentId}/deliver`);
    await post(`/api/payments/${pay.paymentId}/dispute`, { reason: "not_received" });
    const done = (await post(`/api/payments/${pay.paymentId}/judge`)).json();
    expect(done.state).toBe("RELEASED");
    expect(done.dispute.verdict.votes).toHaveLength(3);
    expect(s.seen.map((x) => x.path)).toEqual(["/judge"]);
    expect(pp.calls.filter((c) => c.op === "payout")).toHaveLength(1);
  });
});