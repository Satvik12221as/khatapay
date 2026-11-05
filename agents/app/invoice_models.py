"""The contract for the Invoice Generator Agent. JSON uses camelCase, Python uses snake_case."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class LineItem(Camel):
    """Single line item on an invoice."""
    description: str = Field(max_length=200)
    quantity: int = Field(ge=1, le=1000)
    unitPriceCents: int = Field(ge=0)
    totalCents: int = Field(ge=0)
    taxCents: int = Field(default=0, ge=0)
    sku: Optional[str] = Field(default=None, max_length=50)


class MerchantInfo(Camel):
    """Merchant details for invoice header."""
    id: str = Field(max_length=50)
    name: str = Field(max_length=80)
    address: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=30)
    email: Optional[str] = Field(default=None, max_length=80)
    gstNumber: Optional[str] = Field(default=None, max_length=20)  # For Indian merchants


class CustomerInfo(Camel):
    """Customer details for invoice."""
    name: str = Field(max_length=80)
    email: Optional[str] = Field(default=None, max_length=80)
    address: Optional[str] = Field(default=None, max_length=200)
    phone: Optional[str] = Field(default=None, max_length=30)


class InvoiceRequest(Camel):
    """Request to generate an invoice."""
    paymentId: str = Field(max_length=100)
    merchant: MerchantInfo
    customer: Optional[CustomerInfo] = None
    lineItems: list[LineItem] = Field(min_length=1, max_length=50)
    currency: str = Field(default="USD", max_length=3)
    taxRate: float = Field(default=0.0, ge=0.0, le=1.0)  # e.g., 0.18 for 18% GST
    dueDate: Optional[str] = Field(default=None, max_length=20)  # ISO date
    notes: Optional[str] = Field(default=None, max_length=500)
    includePaymentLink: bool = False


class InvoiceResponse(Camel):
    """Response with generated invoice."""
    paymentId: str
    invoiceNumber: str = Field(max_length=50)
    invoiceDate: str = Field(max_length=20)
    dueDate: Optional[str] = Field(default=None, max_length=20)
    html: str  # Full HTML invoice
    pdfBase64: Optional[str] = None  # Base64 encoded PDF
    lineItems: list[LineItem]
    subtotalCents: int
    taxCents: int
    totalCents: int
    currency: str
    source: Literal["gemini", "scripted"]
    trace: list[dict]  # TraceStep equivalent