import { describe, it, expect } from "vitest";
import { buildApp } from "../src/server";
import { MockPayPal } from "../src/paypal/client";
import type { Key } from "../src/keypad/keypad";

const K = (s: string) => s.replace(/\*/g, "×").replace(/\//g, "÷").split("") as Key[];
const make = () => { const pp = new MockPayPal(); const b = buildApp({ NODE_ENV: "test", PAYPAL_MODE: "mock", PUBLIC_URL: "http://t" }, pp); return { ...b, pp }; };
const pay = (app: any, body: any) => app.inject({ method: "POST", url: "/api/pay", payload: body });
const backTo = (app: any, approvalUrl: string) => { const u = new URL(approvalUrl); return app.inject({ method: "GET", url: u.pathname + u.search }); };

describe("payment API (mock PayPal)", () => {
  it("full flow: keys -> order -> return -> captured -> PAID", async () => {
    const { app, pp } = make();
    const r = await pay(app, { merchantId: "shop1", keys: K("30+40+20") });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.totalCents).toBe(9000);
    const back = await backTo(app, j.approvalUrl);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`/?paid=${j.paymentId}`);
    const p = (await app.inject({ url: `/api/payments/${j.paymentId}` })).json();
    expect(p.state).toBe("PAID");
    expect(p.captureId).toMatch(/^MOCK-CAP/);
    expect(p.lines.map((l: any) => l.cents)).toEqual([3000, 4000, 2000]);
    expect(pp.calls.filter((c) => c.op === "captureOrder")).toHaveLength(1);
  });
  it("returning twice captures only once", async () => {
    const { app, pp } = make();
    const j = (await pay(app, { merchantId: "shop1", keys: K("50") })).json();
    await backTo(app, j.approvalUrl); await backTo(app, j.approvalUrl);
    expect(pp.calls.filter((c) => c.op === "captureOrder")).toHaveLength(1);
  });
  it("rejects a return with the wrong order token", async () => {
    const { app } = make();
    const j = (await pay(app, { merchantId: "shop1", keys: K("50") })).json();
    const r = await app.inject({ url: `/pay/return?payment=${j.paymentId}&token=WRONG` });
    expect(r.statusCode).toBe(400);
  });
  it("the server computes the total itself and ignores any total the client sends", async () => {
    const { app } = make();
    const j = (await pay(app, { merchantId: "shop1", keys: K("10"), totalCents: 1, amount: 1 })).json();
    expect(j.totalCents).toBe(1000);
  });
  it("rejects incomplete, zero and invalid input", async () => {
    const { app } = make();
    expect((await pay(app, { merchantId: "shop1", keys: K("30+") })).statusCode).toBe(422);
    expect((await pay(app, { merchantId: "shop1", keys: K("10-10") })).statusCode).toBe(422);
    expect((await pay(app, { merchantId: "shop1", keys: [] })).statusCode).toBe(422);
    expect((await pay(app, { merchantId: "shop1", keys: ["x"] })).statusCode).toBe(400);
    expect((await pay(app, { merchantId: "nope", keys: K("5") })).statusCode).toBe(404);
  });
  it("enforces the per-payment cap and the fat-finger confirmation", async () => {
    const { app } = make();
    expect((await pay(app, { merchantId: "shop1", keys: K("1500") })).statusCode).toBe(403);
    const ff = await pay(app, { merchantId: "shop1", keys: K("700") });
    expect(ff.statusCode).toBe(409); expect(ff.json().error).toBe("FAT_FINGER");
    expect((await pay(app, { merchantId: "shop1", keys: K("700"), confirmedLarge: true })).statusCode).toBe(200);
  });
  it("cancel marks the payment CANCELLED", async () => {
    const { app } = make();
    const j = (await pay(app, { merchantId: "shop1", keys: K("50") })).json();
    await app.inject({ url: `/pay/cancel?payment=${j.paymentId}` });
    expect((await app.inject({ url: `/api/payments/${j.paymentId}` })).json().state).toBe("CANCELLED");
  });
});


