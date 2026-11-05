"""Price-check brain: rule-based fallback (ScriptedPriceBrain) or Gemini LLM (GeminiPriceBrain)."""
import csv
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional, Protocol

from pydantic import BaseModel, Field

Source = Literal["gemini", "scripted"]

log = logging.getLogger("agents.pricecheck")


@dataclass
class PriceCtx:
    merchant_name: str
    total_cents: int
    typical_cents: Optional[int]
    category: str
    area: str
    lines: list[dict]
    pricebook: list[dict]


@dataclass
class LineResult:
    expr: str
    cents: int
    verdict: Literal["ok", "suspicious", "overcharge"]
    expected_cents: Optional[int]
    note: str


@dataclass
class PriceAuditResult:
    lines: list[LineResult]
    total_verdict: Literal["ok", "flagged"]
    total_expected_cents: Optional[int]
    note: str
    source: Source


def load_pricebook() -> list[dict]:
    path = Path(__file__).resolve().parent.parent.parent / "data" / "pricebook.csv"
    if not path.exists():
        return []
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


class PriceBrain(Protocol):
    async def audit(self, c: PriceCtx) -> PriceAuditResult: ...


class ScriptedPriceBrain:
    source: Source = "scripted"

    async def audit(self, c: PriceCtx) -> PriceAuditResult:
        pb = [row for row in c.pricebook if row["category"].lower() == c.category.lower()]
        avg_item = int(sum(int(r["price_cents"]) for r in pb) / max(1, len(pb))) if pb else 1000

        line_results = []
        total_expected = 0
        has_flag = False

        for l in c.lines:
            cents = l["cents"]
            expected = avg_item
            if cents > 10000:
                line_results.append(LineResult(expr=l["expr"], cents=cents, verdict="overcharge", expected_cents=expected, note="Amount is unusually high for a single line item."))
                has_flag = True
            elif c.typical_cents and cents > c.typical_cents * 0.8:
                line_results.append(LineResult(expr=l["expr"], cents=cents, verdict="suspicious", expected_cents=expected, note="This line accounts for the majority of typical spend."))
                has_flag = True
            else:
                line_results.append(LineResult(expr=l["expr"], cents=cents, verdict="ok", expected_cents=expected, note="Within expected range."))
            total_expected += expected

        total_verdict = "flagged" if has_flag or (c.typical_cents and c.total_cents > c.typical_cents * 3) else "ok"
        note = "Audited against local pricebook and typical spend."
        return PriceAuditResult(lines=line_results, total_verdict=total_verdict, total_expected_cents=total_expected, note=note, source="scripted")


class LLMLineResult(BaseModel):
    expr: str
    cents: int
    verdict: Literal["ok", "suspicious", "overcharge"]
    expected_cents: Optional[int] = Field(default=None, ge=0)
    note: str = Field(min_length=1, max_length=160)


class LLMAuditReply(BaseModel):
    lines: list[LLMLineResult]
    total_verdict: Literal["ok", "flagged"]
    total_expected_cents: Optional[int] = Field(default=None, ge=0)
    note: str = Field(min_length=1, max_length=240)


class GeminiPriceBrain:
    source: Source = "gemini"

    def __init__(self, api_key: str, model: str = "gemini-2.5-flash", chain_factory: Any = None, timeout_s: float = 25.0):
        if not api_key:
            raise ValueError("GEMINI_API_KEY missing")
        self._timeout = timeout_s
        if chain_factory is not None:
            self._factory = chain_factory
        else:
            from langchain_google_genai import ChatGoogleGenerativeAI
            llm = ChatGoogleGenerativeAI(model=model, google_api_key=api_key, temperature=0.2, timeout=20, max_retries=0)
            self._factory = lambda schema: llm.with_structured_output(schema)

    async def audit(self, c: PriceCtx) -> PriceAuditResult:
        system = (
            "You are a rigorous financial auditor and price-check agent for small-shop retail bills. "
            "Compare the provided bill items and total against the reference pricebook and typical customer spend. "
            "Mark items as 'ok', 'suspicious', or 'overcharge' with expected prices and clear, objective reasons. "
            "Return JSON matching the requested schema."
        )
        data = {
            "merchant": c.merchant_name,
            "category": c.category,
            "area": c.area,
            "totalDollars": c.total_cents / 100,
            "typicalDollars": c.typical_cents / 100 if c.typical_cents else None,
            "lines": [{"expr": l["expr"], "dollars": l["cents"] / 100} for l in c.lines],
            "referenceItems": [{"item": r["item"], "priceDollars": int(r["price_cents"])/100} for r in c.pricebook[:15]]
        }
        chain = self._factory(LLMAuditReply)
        import asyncio
        res: LLMAuditReply = await asyncio.wait_for(chain.ainvoke([("system", system), ("human", json.dumps(data))]), self._timeout)

        lr = [LineResult(expr=x.expr, cents=x.cents, verdict=x.verdict, expected_cents=x.expected_cents, note=x.note) for x in res.lines]
        return PriceAuditResult(lines=lr, total_verdict=res.total_verdict, total_expected_cents=res.total_expected_cents, note=res.note, source="gemini")


class ResilientPriceBrain:
    def __init__(self, primary: PriceBrain, fallback: PriceBrain, on_error: Any = lambda e: None):
        self.primary, self.fallback, self.on_error = primary, fallback, on_error

    async def audit(self, c: PriceCtx) -> PriceAuditResult:
        try:
            return await self.primary.audit(c)
        except Exception as e:
            self.on_error(e)
            return await self.fallback.audit(c)
