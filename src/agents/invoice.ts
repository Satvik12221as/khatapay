import { z } from "zod";

const LineItemSchema = z.object({
  description: z.string().max(200),
  quantity: z.number().int().min(1).max(1000),
  unitPriceCents: z.number().int().min(0),
  totalCents: z.number().int().min(0),
  taxCents: z.number().int().min(0).default(0),
  sku: z.string().max(50).optional(),
});

const TraceStepSchema = z.object({
  node: z.string(),
  ms: z.number(),
  detail: z.string(),
});

const InvoiceOut = z.object({
  paymentId: z.string(),
  invoiceNumber: z.string().max(50),
  invoiceDate: z.string().max(20),
  dueDate: z.string().max(20).optional(),
  html: z.string(),
  pdfBase64: z.string().optional(),
  lineItems: z.array(LineItemSchema).min(1).max(50),
  subtotalCents: z.number().int().min(0),
  taxCents: z.number().int().min(0),
  totalCents: z.number().int().min(0),
  currency: z.string().max(3),
  source: z.enum(["gemini", "scripted"]),
  trace: z.array(TraceStepSchema).max(50),
});

export interface LineItemDTO {
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  taxCents: number;
  sku?: string;
}

export interface InvoiceResult {
  paymentId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string;
  html: string;
  pdfBase64?: string;
  lineItems: LineItemDTO[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  source: "gemini" | "scripted";
  trace: { node: string; ms: number; detail: string }[];
}

export interface InvoiceInput {
  paymentId: string;
  merchant: {
    id: string;
    name: string;
    address?: string;
    phone?: string;
    email?: string;
    gstNumber?: string;
  };
  customer?: {
    name: string;
    email?: string;
    address?: string;
    phone?: string;
  };
  lineItems: LineItemDTO[];
  currency?: string;
  taxRate?: number;
  dueDate?: string;
  notes?: string;
  includePaymentLink?: boolean;
}

/** Offline rule-based invoice generator. Mirrors Python ScriptedInvoiceBrain. */
export class LocalInvoiceClient {
  async run(input: InvoiceInput): Promise<InvoiceResult> {
    const merchant = input.merchant;
    const customer = input.customer;
    const items = input.lineItems;
    const taxRate = input.taxRate ?? 0.0;
    const currency = input.currency ?? "USD";

    // Calculate totals
    const subtotal = items.reduce((a, item) => a + item.totalCents, 0);
    const taxCents = Math.round(subtotal * taxRate);
    const total = subtotal + taxCents;

    // Generate invoice number
    const date = new Date();
    const invoiceNumber = `INV-${date.toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const invoiceDate = date.toISOString().slice(0, 10);
    const dueDate = input.dueDate ?? new Date(date.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Format money
    const fmt = (cents: number) => {
      const s = (cents / 100).toFixed(2);
      return s.endsWith(".00") ? s.slice(0, -3) : s;
    };

    // Build HTML
    const linesHtml = items.map((item, i) => `
      <tr>
        <td style="padding: 8px; border: 1px solid #ddd;">${i + 1}</td>
        <td style="padding: 8px; border: 1px solid #ddd;">${item.description}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">${item.quantity}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${fmt(item.unitPriceCents)}</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">${fmt(item.totalCents)}</td>
      </tr>`).join("");

    const customerHtml = customer?.name ? `
      <div style="margin-bottom: 20px;">
        <h3 style="margin: 0 0 8px;">Bill To:</h3>
        <p style="margin: 0;">${customer.name}</p>
        ${customer.email ? `<p style="margin: 4px 0;">${customer.email}</p>` : ""}
        ${customer.address ? `<p style="margin: 4px 0;">${customer.address}</p>` : ""}
      </div>` : "";

    const merchantHtml = `
      <div style="margin-bottom: 20px;">
        <h2 style="margin: 0; color: #2c3e50;">${merchant.name}</h2>
        ${merchant.address ? `<p style="margin: 4px 0;">${merchant.address}</p>` : ""}
        ${merchant.phone ? `<p style="margin: 4px 0;">Phone: ${merchant.phone}</p>` : ""}
        ${merchant.email ? `<p style="margin: 4px 0;">Email: ${merchant.email}</p>` : ""}
        ${merchant.gstNumber ? `<p style="margin: 4px 0;">GST: ${merchant.gstNumber}</p>` : ""}
      </div>`;

    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Invoice ${invoiceNumber}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; background: #f5f5f5; }
        .invoice { max-width: 800px; margin: 0 auto; background: white; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { display: flex; justify-content: space-between; margin-bottom: 30px; border-bottom: 2px solid #2c3e50; padding-bottom: 20px; }
        .invoice-title { font-size: 28px; font-weight: 700; color: #2c3e50; margin: 0; }
        .invoice-meta { text-align: right; }
        .meta-row { margin: 4px 0; font-size: 14px; color: #666; }
        .meta-row strong { color: #333; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th { background: #2c3e50; color: white; padding: 12px 8px; text-align: left; }
        td { padding: 8px; border: 1px solid #ddd; }
        tr:nth-child(even) td { background: #f9f9f9; }
        .totals { margin-top: 20px; text-align: right; }
        .total-row { display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid #eee; }
        .total-row.final { font-size: 18px; font-weight: 700; color: #2c3e50; border-top: 2px solid #2c3e50; margin-top: 8px; }
        .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #999; font-size: 12px; }
    </style>
</head>
<body>
    <div class="invoice">
        <div class="header">
            <div>
                <h1 class="invoice-title">INVOICE</h1>
            </div>
            <div class="invoice-meta">
                <div class="meta-row">Invoice #: <strong>${invoiceNumber}</strong></div>
                <div class="meta-row">Date: <strong>${invoiceDate}</strong></div>
                <div class="meta-row">Due: <strong>${dueDate}</strong></div>
            </div>
        </div>

        ${merchantHtml}
        ${customerHtml}

        <table>
            <thead>
                <tr>
                    <th style="width: 5%;">#</th>
                    <th style="width: 45%;">Description</th>
                    <th style="width: 10%;">Qty</th>
                    <th style="width: 20%;">Unit Price</th>
                    <th style="width: 20%;">Total</th>
                </tr>
            </thead>
            <tbody>
                ${linesHtml}
            </tbody>
        </table>

        <div class="totals">
            <div class="total-row"><span>Subtotal:</span><span>${fmt(subtotal)}</span></div>
            ${taxRate > 0 ? `<div class="total-row"><span>Tax (${Math.round(taxRate * 100)}%):</span><span>${fmt(taxCents)}</span></div>` : ""}
            <div class="total-row final"><span>Total:</span><span>${fmt(total)}</span></div>
        </div>

        <div class="footer">
            Generated by KhataPay • Thank you for your business!
        </div>
    </div>
</body>
</html>`;

    return {
      paymentId: input.paymentId,
      invoiceNumber,
      invoiceDate,
      dueDate,
      html,
      lineItems: items,
      subtotalCents: subtotal,
      taxCents,
      totalCents: total,
      currency,
      source: "scripted",
      trace: [{ node: "local", ms: 0, detail: "offline invoice generation" }],
    };
  }
}

/** The Node referee: validates what the Python service returns. Never trusted. */
export function checkInvoiceResult(raw: InvoiceResult, input: InvoiceInput): InvoiceResult {
  if (!raw.paymentId || raw.paymentId !== input.paymentId) {
    throw new Error("Invalid payment ID in response");
  }
  if (!raw.invoiceNumber || !raw.invoiceDate || !raw.html) {
    throw new Error("Missing required invoice fields");
  }
  if (!Array.isArray(raw.lineItems) || raw.lineItems.length === 0) {
    throw new Error("Line items must be a non-empty array");
  }
  if (!["gemini", "scripted"].includes(raw.source)) {
    throw new Error("Invalid source");
  }
  // Verify totals match
  const expectedSubtotal = input.lineItems.reduce((a, item) => a + item.totalCents, 0);
  const expectedTax = Math.round(expectedSubtotal * (input.taxRate ?? 0));
  const expectedTotal = expectedSubtotal + expectedTax;
  if (Math.abs(raw.subtotalCents - expectedSubtotal) > 1) {
    throw new Error(`Subtotal mismatch: expected ${expectedSubtotal}, got ${raw.subtotalCents}`);
  }
  if (Math.abs(raw.taxCents - expectedTax) > 1) {
    throw new Error(`Tax mismatch: expected ${expectedTax}, got ${raw.taxCents}`);
  }
  if (Math.abs(raw.totalCents - expectedTotal) > 1) {
    throw new Error(`Total mismatch: expected ${expectedTotal}, got ${raw.totalCents}`);
  }
  return raw;
}

/** Calls the Python agent service. Falls back to local on any failure. */
export class RemoteInvoiceClient {
  constructor(
    private baseUrl: string,
    private apiKey = "",
    private fallback: LocalInvoiceClient,
    private onError: (e: unknown) => void = () => {},
    private fetchImpl: typeof fetch = fetch,
    private timeoutMs = 60_000,
  ) {}

  async run(input: InvoiceInput): Promise<InvoiceResult> {
    try {
      const res = await this.fetchImpl(
        this.baseUrl.replace(/\/$/, "") + "/invoice",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { "x-agents-key": this.apiKey } : {}),
          },
          body: JSON.stringify({
            paymentId: input.paymentId,
            merchant: input.merchant,
            customer: input.customer,
            lineItems: input.lineItems,
            currency: input.currency ?? "USD",
            taxRate: input.taxRate ?? 0,
            dueDate: input.dueDate,
            notes: input.notes,
            includePaymentLink: input.includePaymentLink ?? false,
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!res.ok) throw new Error(`Invoice service returned ${res.status}`);
      const raw = InvoiceOut.parse(await res.json());
      return checkInvoiceResult(raw, input);
    } catch (e) {
      this.onError(e);
      return this.fallback.run(input);
    }
  }
}

export function makeInvoiceClient(
  env: Record<string, string | undefined> = process.env,
  onError?: (e: unknown) => void,
  fetchImpl?: typeof fetch,
): RemoteInvoiceClient | LocalInvoiceClient {
  const local = new LocalInvoiceClient();
  return env.AGENTS_URL
    ? new RemoteInvoiceClient(env.AGENTS_URL, env.AGENTS_API_KEY ?? "", local, onError, fetchImpl)
    : local;
}