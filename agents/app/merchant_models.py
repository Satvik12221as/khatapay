"""The contract for the Merchant Concierge Agent. JSON uses camelCase, Python uses snake_case."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class MerchantMatch(Camel):
    """A merchant that matches the customer's needs."""
    shopId: str = Field(max_length=50)
    name: str = Field(max_length=80)
    category: str = Field(max_length=40)
    area: str = Field(max_length=60)
    trustScore: int = Field(ge=0, le=100)
    trustTier: str = Field(max_length=20)
    typicalTotalDollars: float = Field(ge=0)
    distanceKm: Optional[float] = Field(default=None, ge=0)
    fitScore: int = Field(ge=0, le=100)
    reason: str = Field(max_length=200)


class MerchantFindRequest(Camel):
    """Request to find shops matching customer needs."""
    needs: str = Field(max_length=200)  # UNTRUSTED: what the customer is looking for
    category: Optional[str] = Field(default=None, max_length=40)
    area: Optional[str] = Field(default=None, max_length=60)
    maxPriceDollars: Optional[float] = Field(default=None, ge=0)
    minTrustScore: int = Field(default=0, ge=0, le=100)
    maxResults: int = Field(default=5, ge=1, le=20)
    candidates: list[dict] = Field(default_factory=list)


class MerchantFindResponse(Camel):
    """Response with matched merchants."""
    matches: list[MerchantMatch]
    source: Literal["gemini", "scripted"]
    trace: list[dict]  # TraceStep equivalent