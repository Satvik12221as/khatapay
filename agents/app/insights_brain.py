"""The brain for the Merchant Performance Insights Agent."""
import logging
from typing import Literal, Optional, Protocol

from pydantic import BaseModel, Field

log = logging.getLogger("agents.insights")

Source = Literal["gemini", "scripted"]


class InsightData(BaseModel):
    """A single data point for the LLM."""
    id: str
    title: str
    description: str
    priority: Literal["high", "medium", "low"]
    actionable: bool
    recommendedAction: Optional[str] = None


class InsightsResult(BaseModel):
    """Result from the brain."""
    insights: list[InsightData]
    summary: str
    confidence: Literal["high", "medium", "low"]
    source: Source = "scripted"


class InsightsBrain(Protocol):
    """Protocol for insights generation brains."""
    async def generate(self, merchantName: str, stats: dict, periodDays: int) -> InsightsResult:
        ...


class ScriptedInsightsBrain:
    """Offline rule-based insights generator."""
    source: Source = "scripted"

    async def generate(self, merchantName: str, stats: dict, periodDays: int) -> InsightsResult:
        insights: list[InsightData] = []
        confidence = "high"

        # Revenue insights
        total = stats.get("total_revenue_cents", 0)
        avg = stats.get("avg_order_cents", 0)
        if total > 100_000:  # > $1000
            insights.append(InsightData(
                id="revenue_trend",
                title="Strong Revenue Performance",
                description=f"You've processed ${total/100:.2f} in payments over {periodDays} days with an average order of ${avg/100:.2f}.",
                priority="low",
                actionable=False
            ))

        # Success rate
        successRate = stats.get("success_rate", 0)
        if successRate < 0.7:
            insights.append(InsightData(
                id="low_success",
                title="High Dispute Rate",
                description=f"Only {successRate*100:.0f}% of payments completed successfully. {100*(1-successRate):.0f}% had disputes or issues.",
                priority="high",
                actionable=True,
                recommendedAction="Review dispute reasons and improve customer communication during checkout."
            ))
            confidence = "high"
        elif successRate > 0.9:
            insights.append(InsightData(
                id="good_success",
                title="Excellent Customer Satisfaction",
                description=f"Your {successRate*100:.0f}% success rate shows great customer relationships. Well done!",
                priority="low",
                actionable=False
            ))

        # Dispute analysis
        disputesLost = stats.get("disputes_lost", 0)
        disputesOpened = stats.get("disputes_opened", 0)
        if disputesOpened > 0:
            lostRate = disputesLost / disputesOpened if disputesOpened > 0 else 0
            if lostRate > 0.5:
                insights.append(InsightData(
                    id="dispute_pattern",
                    title="Common Dispute Reasons",
                    description=f"You've lost {disputesLost} of {disputesOpened} disputes ({lostRate*100:.0f}% loss rate).",
                    priority="high",
                    actionable=True,
                    recommendedAction="Review dispute notes to identify patterns - maybe shipping times or product descriptions need improvement."
                ))

        # Trust score impact
        disputesLostCount = stats.get("disputes_lost", 0)
        if disputesLostCount > 3:
            insights.append(InsightData(
                id="trust_impact",
                title="Trust Score at Risk",
                description=f"Multiple lost disputes ({disputesLostCount}) are impacting your trust score, affecting customer confidence.",
                priority="high",
                actionable=True,
                recommendedAction="Consider offering pre-shipment tracking updates and clear return policies to reduce disputes."
            ))

        # Repeat customers
        repeatRate = stats.get("repeat_customer_rate", 0)
        if repeatRate < 0.2:
            insights.append(InsightData(
                id="low_repeat",
                title="Build Repeat Customer Relationships",
                description=f"Only {repeatRate*100:.0f}% of customers return. Loyal customers are more forgiving of minor issues.",
                priority="medium",
                actionable=True,
                recommendedAction="Add a loyalty program or follow-up thank-you messages after delivery."
            ))
        elif repeatRate > 0.5:
            insights.append(InsightData(
                id="loyal_customers",
                title="Loyal Customer Base",
                description=f"{repeatRate*100:.0f}% of customers have returned. Focus on delighting them further!",
                priority="low",
                actionable=False
            ))

        # Response time
        avgResponse = stats.get("avg_response_time_hours", 0)
        if avgResponse > 24:
            insights.append(InsightData(
                id="response_time",
                title="Customer Response Time Matters",
                description=f"Average {avgResponse:.0f} hour response time. Quick responses reduce disputes.",
                priority="medium",
                actionable=True,
                recommendedAction="Set up order status updates to reduce 'where is my order?' inquiries."
            ))

        # Summary
        summary = f"{merchantName}: {successRate*100:.0f}% success rate, ${total/100:.2f} revenue, {disputesLost} lost disputes."
        if insights:
            summary = f"{merchantName}: " + "; ".join(i.description for i in insights[:2])

        return InsightsResult(insights=insights, summary=summary, confidence=confidence)


class LLMInsightsBody(BaseModel):
    merchant_name: str
    stats: dict
    period_days: int
    total_revenue: float
    avg_order: float
    success_rate: float
    disputes_lost: int
    disputes_total: int
    repeat_rate: float


class LLMInsightsReply(BaseModel):
    insights: list[dict]
    summary: str
    confidence: Literal["high", "medium", "low"]


class GeminiInsightsBrain:
    """LLM-powered insights generator."""
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
                temperature=0.3,
                timeout=20,
                max_retries=0
            )
            self._factory = lambda schema: llm.with_structured_output(schema)

    async def generate(self, merchantName: str, stats: dict, periodDays: int) -> InsightsResult:
        import asyncio
        system = """You are a small-business performance analyst and merchant advisor.
        Analyze the provided merchant statistics and write concrete, actionable insights for a local shop owner.

        Rules:
        1. Write in supportive, professional tone - you're helping, not judging
        2. Each insight needs an ID, title, description, priority (high/medium/low), and whether it's actionable
        3. Actionable items MUST have a "recommendedAction"
        4. Do NOT invent numbers - use only what's in stats
        5. Confidence is "high" for clear patterns, "medium" for borderline cases

        Focus on: dispute reduction, trust score improvement, customer retention, revenue optimization.
        Return JSON matching the schema."""

        body = LLMInsightsBody(
            merchant_name=merchantName,
            stats=stats,
            period_days=periodDays,
            total_revenue=stats.get("total_revenue_cents", 0) / 100,
            avg_order=stats.get("avg_order_cents", 0) / 100,
            success_rate=stats.get("success_rate", 0),
            disputes_lost=stats.get("disputes_lost", 0),
            disputes_total=stats.get("disputes_opened", 0),
            repeat_rate=stats.get("repeat_customer_rate", 0)
        )

        chain = self._factory(LLMInsightsReply)
        reply: LLMInsightsReply = await asyncio.wait_for(
            chain.ainvoke([("system", system), ("human", body.model_dump_json())]),
            self._timeout
        )

        insights = [InsightData(**i) for i in reply.insights]
        return InsightsResult(insights=insights, summary=reply.summary, confidence=reply.confidence)


class ResilientInsightsBrain:
    """Uses primary brain; falls back on any failure."""

    def __init__(self, primary: InsightsBrain, fallback: InsightsBrain, on_error=lambda e: None):
        self.primary, self.fallback, self.on_error = primary, fallback, on_error

    async def generate(self, merchantName: str, stats: dict, periodDays: int) -> InsightsResult:
        try:
            return await self.primary.generate(merchantName, stats, periodDays)
        except Exception as e:
            log.warning("Insights brain failed, using fallback: %s", e)
            self.on_error(e)
            return await self.fallback.generate(merchantName, stats, periodDays)