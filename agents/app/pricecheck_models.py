"""The contract for the price-check agent. JSON uses camelCase, Python uses snake_case."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .models import Camel, Source, TraceStep


class PriceCheckRequest(Camel):
    """The bill to audit plus the context the agent is allowed to trust."""
    merchant_name: str = Field(max_length=80)
    total_cents: int = Field(ge=100, le=100_000_000)
    typical_cents: Optional[int] = Field(default=None, ge=0, le=100_000_000)
    category: str = Field(max_length=40)
    area: str = Field(max_length=40)
    lines: list[dict] = Field(min_length=1, max_length=100)


class LineCheck(Camel):
    expr: str = Field(max_length=100)
    cents: int = Field(ge=0)
    verdict: Literal["ok", "suspicious", "overcharge"]
    expected_cents: Optional[int] = Field(default=None, ge=0)
    note: str = Field(min_length=1, max_length=160)


class PriceCheckResponse(Camel):
    lines: list[LineCheck]
    total_verdict: Literal["ok", "flagged"]
    total_expected_cents: Optional[int] = Field(default=None, ge=0)
    note: str = Field(min_length=1, max_length=240)
    source: Source
    trace: list[TraceStep]