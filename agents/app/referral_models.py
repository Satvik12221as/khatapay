"""Contract for the Referral Concierge. JSON uses camelCase, Python uses snake_case."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Candidate(Camel):
    shop_id: str = Field(max_length=40)
    name: str = Field(max_length=80)
    category: str = Field(max_length=40)
    area: str = Field(max_length=60)
    score: int = Field(ge=0, le=100)
    tier: str = Field(max_length=20)
    completed: int = Field(ge=0)
    disputes_lost: int = Field(ge=0)
    repeat_customers: int = Field(ge=0)
    customer_orders: int = Field(ge=0)


class RecommendRequest(Camel):
    referrer_name: str = Field(max_length=60)
    needs: str = Field(default="", max_length=200)  # UNTRUSTED text typed by the referrer
    welcome_cents: int = Field(ge=0, le=100_000)
    reward_cents: int = Field(ge=0, le=100_000)
    min_trust: int = Field(ge=0, le=100)
    candidates: list[Candidate] = Field(min_length=1, max_length=10)


class Ranked(Camel):
    shop_id: str
    fit: int


class TraceStep(Camel):
    node: str
    ms: float
    detail: str


class RecommendResponse(Camel):
    shop_id: str
    message: str
    ranked: list[Ranked]
    source: Literal["gemini", "scripted"]
    revisions: int
    fact_checked: bool
    trace: list[TraceStep]