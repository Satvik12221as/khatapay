"""Invoice Generator Agent as a LangGraph state machine.

Generates professional invoices from payment data.
"""
import operator
import time
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from .invoice_brain import InvoiceBrain
from .invoice_models import InvoiceRequest, InvoiceResponse, LineItem
from .models import TraceStep


class InvState(TypedDict, total=False):
    """State for the invoice agent."""
    request: dict
    merchant: dict
    customer: dict
    items: list[dict]
    tax_rate: float
    invoice_number: str
    invoice_date: str
    due_date: str
    html: str
    pdf_base64: str
    subtotal_cents: int
    tax_cents: int
    total_cents: int
    source: str
    trace: Annotated[list[dict], operator.add]


def _step(node: str, t0: float, detail: str) -> dict:
    """Create a trace step."""
    return {"node": node, "ms": round((time.perf_counter() - t0) * 1000, 1), "detail": detail}


def build_invoice_graph(brain: InvoiceBrain):
    """Build the LangGraph state machine for invoice generation."""

    async def prepare_data(s: InvState) -> dict:
        """Prepare and validate invoice data."""
        t0 = time.perf_counter()
        req = s["request"]

        # Extract merchant, customer, items
        merchant = req.get("merchant", {})
        customer = req.get("customer", {})
        items = req.get("lineItems", [])
        tax_rate = req.get("taxRate", 0.0)

        # Validate items
        validated_items = []
        for item in items:
            total_cents = item.get("quantity", 1) * item.get("unitPriceCents", 0)
            validated_items.append({
                "description": item.get("description", ""),
                "quantity": item.get("quantity", 1),
                "unitPriceCents": item.get("unitPriceCents", 0),
                "totalCents": total_cents,
                "taxCents": round(total_cents * tax_rate),
                "sku": item.get("sku")
            })

        return {
            "merchant": merchant,
            "customer": customer,
            "items": validated_items,
            "tax_rate": tax_rate,
            "trace": [_step("prepare_data", t0, f"prepared {len(validated_items)} line items")]
        }

    async def generate_invoice(s: InvState) -> dict:
        """Generate the invoice using the AI brain."""
        t0 = time.perf_counter()

        result = await brain.generate(
            s["merchant"],
            s["customer"],
            s["items"],
            s["tax_rate"]
        )

        return {
            "invoice_number": result.get("invoice_number", ""),
            "invoice_date": result.get("invoice_date", ""),
            "due_date": result.get("due_date", ""),
            "html": result.get("html", ""),
            "subtotal_cents": result.get("subtotal_cents", 0),
            "tax_cents": result.get("tax_cents", 0),
            "total_cents": result.get("total_cents", 0),
            "source": result.get("source", "scripted"),
            "trace": [_step("generate_invoice", t0, f"generated invoice {result.get('invoice_number', '')}")]
        }

    async def add_pdf(s: InvState) -> dict:
        """Add PDF generation if requested."""
        t0 = time.perf_counter()
        # PDF generation would go here using pdfkit or similar
        # For now, return empty - PDF is optional
        return {
            "pdf_base64": "",
            "trace": [_step("add_pdf", t0, "PDF generation skipped (optional)")]
        }

    g = StateGraph(InvState)
    g.add_node("prepare_data", prepare_data)
    g.add_node("generate_invoice", generate_invoice)
    g.add_node("add_pdf", add_pdf)

    g.add_edge(START, "prepare_data")
    g.add_edge("prepare_data", "generate_invoice")
    g.add_edge("generate_invoice", "add_pdf")
    g.add_edge("add_pdf", END)

    return g.compile()


async def run_invoice(graph, req: InvoiceRequest) -> InvoiceResponse:
    """Run the invoice agent with the given request."""
    state = {
        "request": req.model_dump(),
        "trace": []
    }

    result = await graph.ainvoke(state, config={"recursion_limit": 25})

    # Build line items
    line_items = [LineItem(**item) for item in result.get("items", [])]

    return InvoiceResponse(
        paymentId=req.paymentId,
        invoiceNumber=result["invoice_number"],
        invoiceDate=result["invoice_date"],
        dueDate=result.get("due_date"),
        html=result["html"],
        pdfBase64=result.get("pdf_base64"),
        lineItems=line_items,
        subtotalCents=result["subtotal_cents"],
        taxCents=result["tax_cents"],
        totalCents=result["total_cents"],
        currency=req.currency,
        source=result["source"],
        trace=result["trace"]
    )