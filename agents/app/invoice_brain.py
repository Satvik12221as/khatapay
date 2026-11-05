"""The brain for the Invoice Generator Agent."""
import logging
from typing import Literal, Optional, Protocol

from pydantic import BaseModel, Field

log = logging.getLogger("agents.invoice")

Source = Literal["gemini", "scripted"]


class InvoiceBrain(Protocol):
    """Protocol for invoice generation brains."""
    async def generate(self, merchant: dict, customer: dict, items: list[dict], tax_rate: float) -> dict:
        ...


class ScriptedInvoiceBrain:
    """Offline rule-based invoice generator."""
    source: Source = "scripted"

    async def generate(self, merchant: dict, customer: dict, items: list[dict], tax_rate: float) -> dict:
        import uuid
        from datetime import datetime, timedelta

        # Calculate totals
        subtotal = sum(item.get("totalCents", 0) for item in items)
        tax_cents = round(subtotal * tax_rate)
        total = subtotal + tax_cents

        # Generate invoice number
        invoice_number = f"INV-{datetime.now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"
        invoice_date = datetime.now().strftime('%Y-%m-%d')
        due_date = (datetime.now() + timedelta(days=7)).strftime('%Y-%m-%d')

        # Build HTML
        html = self._build_html(
            invoice_number, invoice_date, due_date,
            merchant, customer, items,
            subtotal, tax_cents, total, tax_rate
        )

        return {
            "invoice_number": invoice_number,
            "invoice_date": invoice_date,
            "due_date": due_date,
            "html": html,
            "line_items": items,
            "subtotal_cents": subtotal,
            "tax_cents": tax_cents,
            "total_cents": total,
            "source": "scripted"
        }

    def _build_html(self, invoice_number: str, invoice_date: str, due_date: str,
                    merchant: dict, customer: dict, items: list[dict],
                    subtotal: int, tax_cents: int, total: int, tax_rate: float) -> str:
        def fmt(cents: int) -> str:
            return f"${cents/100:.2f}"

        lines_html = ""
        for i, item in enumerate(items, 1):
            lines_html += f"""
            <tr>
                <td style="padding: 8px; border: 1px solid #ddd;">{i}</td>
                <td style="padding: 8px; border: 1px solid #ddd;">{item.get('description', '')}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: center;">{item.get('quantity', 1)}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">{fmt(item.get('unitPriceCents', 0))}</td>
                <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">{fmt(item.get('totalCents', 0))}</td>
            </tr>"""

        customer_html = ""
        if customer and customer.get("name"):
            customer_html = f"""
            <div style="margin-bottom: 20px;">
                <h3 style="margin: 0 0 8px;">Bill To:</h3>
                <p style="margin: 0;">{customer.get('name', '')}</p>
                {'<p style="margin: 4px 0;">' + customer.get('email', '') + '</p>' if customer.get('email') else ''}
                {'<p style="margin: 4px 0;">' + customer.get('address', '') + '</p>' if customer.get('address') else ''}
            </div>"""

        merchant_html = f"""
        <div style="margin-bottom: 20px;">
            <h2 style="margin: 0; color: #2c3e50;">{merchant.get('name', 'Merchant')}</h2>
            {'<p style="margin: 4px 0;">' + merchant.get('address', '') + '</p>' if merchant.get('address') else ''}
            {'<p style="margin: 4px 0;">Phone: ' + merchant.get('phone', '') + '</p>' if merchant.get('phone') else ''}
            {'<p style="margin: 4px 0;">Email: ' + merchant.get('email', '') + '</p>' if merchant.get('email') else ''}
            {'<p style="margin: 4px 0;">GST: ' + merchant.get('gstNumber', '') + '</p>' if merchant.get('gstNumber') else ''}
        </div>"""

        return f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Invoice {invoice_number}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 40px; background: #f5f5f5; }}
        .invoice {{ max-width: 800px; margin: 0 auto; background: white; padding: 40px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }}
        .header {{ display: flex; justify-content: space-between; margin-bottom: 30px; border-bottom: 2px solid #2c3e50; padding-bottom: 20px; }}
        .invoice-title {{ font-size: 28px; font-weight: 700; color: #2c3e50; margin: 0; }}
        .invoice-meta {{ text-align: right; }}
        .meta-row {{ margin: 4px 0; font-size: 14px; color: #666; }}
        .meta-row strong {{ color: #333; }}
        table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
        th {{ background: #2c3e50; color: white; padding: 12px 8px; text-align: left; }}
        td {{ padding: 8px; border: 1px solid #ddd; }}
        tr:nth-child(even) td {{ background: #f9f9f9; }}
        .totals {{ margin-top: 20px; text-align: right; }}
        .total-row {{ display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid #eee; }}
        .total-row.final {{ font-size: 18px; font-weight: 700; color: #2c3e50; border-top: 2px solid #2c3e50; margin-top: 8px; }}
        .notes {{ margin-top: 30px; padding: 15px; background: #f8f9fa; border-radius: 4px; }}
        .footer {{ margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #999; font-size: 12px; }}
    </style>
</head>
<body>
    <div class="invoice">
        <div class="header">
            <div>
                <h1 class="invoice-title">INVOICE</h1>
            </div>
            <div class="invoice-meta">
                <div class="meta-row">Invoice #: <strong>{invoice_number}</strong></div>
                <div class="meta-row">Date: <strong>{invoice_date}</strong></div>
                <div class="meta-row">Due: <strong>{due_date}</strong></div>
            </div>
        </div>

        {merchant_html}
        {customer_html}

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
                {lines_html}
            </tbody>
        </table>

        <div class="totals">
            <div class="total-row"><span>Subtotal:</span><span>{fmt(subtotal)}</span></div>
            {f'<div class="total-row"><span>Tax ({int(tax_rate*100)}%):</span><span>{fmt(tax_cents)}</span></div>' if tax_rate > 0 else ''}
            <div class="total-row final"><span>Total:</span><span>{fmt(total)}</span></div>
        </div>

        <div class="footer">
            Generated by KhataPay • Thank you for your business!
        </div>
    </div>
</body>
</html>"""


class LLMInvoiceReply(BaseModel):
    """Structured output from LLM for invoice generation."""
    invoice_number: str
    invoice_date: str
    due_date: str
    html: str
    subtotal_cents: int
    tax_cents: int
    total_cents: int
    notes: str = ""


class GeminiInvoiceBrain:
    """LLM-powered invoice generator."""
    source: Source = "gemini"

    def __init__(self, api_key: str, model: str = "gemini-2.5-flash", chain_factory=None, timeout_s: float = 30.0):
        if not api_key:
            raise ValueError("GEMINI_API_KEY missing")
        self._timeout = timeout_s
        if chain_factory is not None:
            self._factory = chain_factory
        else:
            from langchain_google_genai import ChatGoogleGenerativeAI
            llm = ChatGoogleGenerativeAI(
                model=model,
                google_api_key=api_key,
                temperature=0.2,
                timeout=20,
                max_retries=0
            )
            self._factory = lambda schema: llm.with_structured_output(schema)

    async def generate(self, merchant: dict, customer: dict, items: list[dict], tax_rate: float) -> dict:
        import asyncio

        system = """You are a professional invoice generator for small businesses.
        Generate a clean, professional HTML invoice based on the provided data.

        Rules:
        1. Output valid, well-formatted HTML that renders correctly
        2. Include all standard invoice fields: number, date, due date, line items, totals
        3. Use only the data provided - do not invent merchant/customer info
        4. Apply tax rate correctly to calculate totals
        5. Keep the design professional and printable
        6. Return JSON matching the schema exactly"""

        data = {
            "merchant": merchant,
            "customer": customer,
            "items": items,
            "tax_rate": tax_rate,
            "currency": "USD"
        }

        chain = self._factory(LLMInvoiceReply)
        reply: LLMInvoiceReply = await asyncio.wait_for(
            chain.ainvoke([("system", system), ("human", str(data))]),
            self._timeout
        )

        return {
            "invoice_number": reply.invoice_number,
            "invoice_date": reply.invoice_date,
            "due_date": reply.due_date,
            "html": reply.html,
            "line_items": items,
            "subtotal_cents": reply.subtotal_cents,
            "tax_cents": reply.tax_cents,
            "total_cents": reply.total_cents,
            "source": "gemini"
        }


class ResilientInvoiceBrain:
    """Uses primary brain; falls back on any failure."""

    def __init__(self, primary: InvoiceBrain, fallback: InvoiceBrain, on_error=lambda e: None):
        self.primary, self.fallback, self.on_error = primary, fallback, on_error

    async def generate(self, merchant: dict, customer: dict, items: list[dict], tax_rate: float) -> dict:
        try:
            return await self.primary.generate(merchant, customer, items, tax_rate)
        except Exception as e:
            log.warning("Invoice brain failed, using fallback: %s", e)
            self.on_error(e)
            return await self.fallback.generate(merchant, customer, items, tax_rate)