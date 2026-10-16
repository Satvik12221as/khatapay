/**
 * Proves your PayPal sandbox credentials work, using a real KhataPay tape.
 * Run:  npm run spike     (needs PAYPAL_CLIENT_ID + PAYPAL_SECRET in .env)
 */
import { createInterface } from "node:readline/promises";
import { replay } from "../src/payments/replay";
import { tapeHash } from "../src/payments/tape";
import { SandboxPayPal } from "../src/paypal/client";
import type { Key } from "../src/keypad/keypad";

const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
const secret = process.env.PAYPAL_SECRET ?? "";
if (!clientId || !secret) {
  console.error("Missing PAYPAL_CLIENT_ID / PAYPAL_SECRET. Put them in .env first.");
  process.exit(1);
}

const pp = new SandboxPayPal(clientId, secret);
// Tape: 30 + 40 + 20 - 5   (shows items AND a discount line)
const keys = "30+40+20-5".split("") as Key[];
const view = replay(keys);
console.log("Tape:", view.lines.map((l) => `${l.expr}=${l.cents / 100}`).join("  "), " Total:", view.totalFormatted);

const id = `spike-${Date.now()}`;
const hash = tapeHash({ merchantId: "spike", currency: "USD", lines: view.lines, totalCents: view.totalCents! });

console.log("\n1) Creating order...");
const order = await pp.createOrder({
  paymentId: id, merchantName: "Spike Shop", currency: "USD", totalCents: view.totalCents!, lines: view.lines, tapeHash: hash,
  requestId: `${id}-order`, returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel",
});
console.log("   Order ID:", order.id, "status:", order.status);
console.log("\n2) Open this link in your browser. Log in with your SANDBOX PERSONAL (buyer) account and click Pay:\n\n  ", order.approvalUrl);

const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("\nAfter approving you will land on example.com. Then press ENTER here... ");
rl.close();

console.log("\n3) Capturing payment...");
const cap = await pp.captureOrder(order.id, `${id}-capture`);
console.log("   ", cap);
console.log(cap.status === "COMPLETED" ? "\nSUCCESS: your sandbox works end to end." : "\nNot completed. Send me this output.");