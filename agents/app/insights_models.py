"""The contract for merchant insights agent. JSON uses camelCase, Python uses snake_case."""
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Insight(Camel):
    """A single insight about a merchant's performance."""
    id: str = Field(max_length=50)
    title: str = Field(max_length=120)
    description: str = Field(max_length=500)
    priority: Literal["high", "medium", "low"]
    actionable: bool
    metric: Optional[str] = Field(default=None, max_length=50)
    currentValue: Optional[float] = Field(default=None, ge=0)
    recommendedAction: Optional[str] = Field(default=None, max_length=200)


class PeriodParams(Camel):
    """Time period for analysis."""
    days: int = Field(ge=1, le=365)
    includeRecent: bool = True


class InsightsRequest(Camel):
    """Request for merchant insights."""
    merchantId: str = Field(max_length=50)
    period: PeriodParams
    includeDisputeAnalysis: bool = True
    includeRevenueForecast: bool = False


class InsightsResponse(Camel):
    """Response with merchant performance insights."""
    merchantId: str
    merchantName: str = Field(max_length=80)
    periodDays: int
    insights: list[Insight]
    summary: str = Field(max_length=300)
    source: Literal["gemini", "scripted"]
    confidence: Literal["high", "medium", "low"]
    trace: list[dict]  # TraceStep equivalent


class MerchantStats(Camel):
    """Core merchant statistics for analysis."""
    totalPayments: int
    totalRevenueCents: int
    avgOrderCents: int
    successRate: float  # 0-1
    disputesOpened: int
    disputesLost: int
    chargebackRate: float  # 0-1
    repeatCustomerRate: float  # 0-1
    avgResponseTimeHours: float
    typicalOrderCents: int
    disputeReasons: dict[str, int]  # reason -> count