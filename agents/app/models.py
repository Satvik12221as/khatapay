"""The contract with the Node server. JSON uses camelCase, Python uses snake_case."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


Source = Literal["gemini", "scripted"]


class TraceStep(Camel):
    node: str
    ms: float
    detail: str


# ---- Haggle ----
class Loyalty(Camel):
    visits: int = Field(ge=0, le=100_000)
    member_since: str = Field(max_length=40)
    on_time_rate: float = Field(ge=0, le=1)


class HaggleRequest(Camel):
    merchant_name: str = Field(max_length=80)
    total_cents: int = Field(ge=100, le=100_000_000)
    max_discount_pct: float = Field(ge=0, le=50)
    min_total_cents: int = Field(ge=0, le=100_000_000)
    loyalty: Loyalty


class Turn(Camel):
    side: Literal["customer", "shop"]
    accept: bool
    discount_cents: int
    message: str
    source: Source
    note: Optional[str] = None


class HaggleResponse(Camel):
    turns: list[Turn]
    final_discount_cents: int
    agreed: bool
    trace: list[TraceStep]


# ---- Judges ----
class Line(Camel):
    expr: str = Field(max_length=100)
    cents: int


class Evidence(Camel):
    total_cents: int
    lines: list[Line] = Field(max_length=100)
    tape_verified: bool
    delivery_marked: bool
    hours_since_delivery: Optional[int] = None
    claim_reason: Literal["not_received", "wrong_items", "wrong_amount", "other"]
    customer_note: str = Field(default="", max_length=400)
    shop_stance: Literal["delivered_ok", "agrees_refund", "no_response"]
    shop_note: str = Field(default="", max_length=400)


class Vote(Camel):
    judge: str
    verdict: Literal["release", "refund"]
    reason: str
    source: Source


class JudgeResponse(Camel):
    votes: list[Vote]
    outcome: Literal["release", "refund"]
    note: Optional[str] = None
    trace: list[TraceStep]