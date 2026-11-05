"""KhataPay agent service. Run:  python -m uvicorn app.main:app --port 8001  (from the agents folder)"""
import hmac
import logging
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException

from .brains import Brain, GeminiBrain, ResilientBrain, ScriptedBrain
from .pricecheck_brain import PriceBrain
from .config import Settings
from .haggle_graph import build_haggle_graph, run_haggle
from .judge_graph import build_judge_graph, run_judge
from .models import Evidence, HaggleRequest, HaggleResponse, JudgeResponse
from .pricecheck_brain import ScriptedPriceBrain, GeminiPriceBrain, ResilientPriceBrain
from .pricecheck_graph import build_pricecheck_graph, run_pricecheck
from .pricecheck_models import PriceCheckRequest, PriceCheckResponse
from .insights_brain import InsightsBrain, ScriptedInsightsBrain, GeminiInsightsBrain, ResilientInsightsBrain
from .insights_graph import build_insights_graph, run_insights
from .insights_models import InsightsRequest, InsightsResponse
from .invoice_brain import InvoiceBrain, ScriptedInvoiceBrain, GeminiInvoiceBrain, ResilientInvoiceBrain
from .invoice_graph import build_invoice_graph, run_invoice
from .invoice_models import InvoiceRequest, InvoiceResponse
from .merchant_brain import MerchantBrain, ScriptedMerchantBrain, GeminiMerchantBrain, ResilientMerchantBrain
from .merchant_graph import build_merchant_graph, run_merchant
from .merchant_models import MerchantFindRequest, MerchantFindResponse
from .referral_api import build_router, make_referral_brain
from .mesh import get_mesh, register_mesh_handlers, build_mesh_router, Topics

log = logging.getLogger("agents")


def make_brain(settings: Settings) -> Brain:
    scripted = ScriptedBrain()
    if not settings.gemini_api_key:
        log.warning("No GEMINI_API_KEY: running the offline rule-based agents")
        return scripted
    return ResilientBrain(GeminiBrain(settings.gemini_api_key, settings.gemini_model), scripted,
                          on_error=lambda e: log.warning("Gemini failed, using offline agent: %s", e))


def make_price_brain(settings: Settings) -> "PriceBrain":
    scripted = ScriptedPriceBrain()
    if not settings.gemini_api_key:
        return scripted
    return ResilientPriceBrain(GeminiPriceBrain(settings.gemini_api_key, settings.gemini_model), scripted,
                               on_error=lambda e: log.warning("Gemini price-check failed, using scripted: %s", e))


def create_app(brain: Optional[Brain] = None, settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    brain = brain or make_brain(settings)
    price_brain = make_price_brain(settings)
    haggle_graph = build_haggle_graph(brain)
    judge_graph = build_judge_graph(brain)
    pricecheck_graph = build_pricecheck_graph(price_brain)
    app = FastAPI(title="KhataPay agents")

    def guard(x_agents_key: Optional[str] = Header(default=None)) -> None:
        if settings.agents_api_key and not hmac.compare_digest(x_agents_key or "", settings.agents_api_key):
            raise HTTPException(status_code=401, detail="Bad agents key")

    app.include_router(build_router(make_referral_brain(settings), guard))
    app.include_router(build_mesh_router(get_mesh()))

    # Register mesh handlers (subscribes to topics)
    register_mesh_handlers(get_mesh())

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "llm": "gemini" if settings.gemini_api_key else "scripted", "framework": "langgraph"}

    @app.post("/haggle", response_model=HaggleResponse, dependencies=[Depends(guard)])
    async def haggle(req: HaggleRequest) -> HaggleResponse:
        return await run_haggle(haggle_graph, req)

    @app.post("/judge", response_model=JudgeResponse, dependencies=[Depends(guard)])
    async def judge(ev: Evidence) -> JudgeResponse:
        return await run_judge(judge_graph, ev)

    @app.post("/pricecheck", response_model=PriceCheckResponse, dependencies=[Depends(guard)])
    async def pricecheck(req: PriceCheckRequest) -> PriceCheckResponse:
        return await run_pricecheck(pricecheck_graph, req)

    @app.post("/insights", response_model=InsightsResponse, dependencies=[Depends(guard)])
    async def insights(req: InsightsRequest) -> InsightsResponse:
        # Build insights brain with same resilience pattern
        scripted = ScriptedInsightsBrain()
        if not settings.gemini_api_key:
            insights_brain = scripted
        else:
            insights_brain = ResilientInsightsBrain(
                GeminiInsightsBrain(settings.gemini_api_key, settings.gemini_model),
                scripted,
                on_error=lambda e: log.warning("Gemini insights failed, using offline: %s", e)
            )
        insights_graph = build_insights_graph(insights_brain)
        return await run_insights(insights_graph, req)

    @app.post("/invoice", response_model=InvoiceResponse, dependencies=[Depends(guard)])
    async def invoice(req: InvoiceRequest) -> InvoiceResponse:
        # Build invoice brain with same resilience pattern
        scripted = ScriptedInvoiceBrain()
        if not settings.gemini_api_key:
            invoice_brain = scripted
        else:
            invoice_brain = ResilientInvoiceBrain(
                GeminiInvoiceBrain(settings.gemini_api_key, settings.gemini_model),
                scripted,
                on_error=lambda e: log.warning("Gemini invoice failed, using offline: %s", e)
            )
        invoice_graph = build_invoice_graph(invoice_brain)
        return await run_invoice(invoice_graph, req)

    @app.post("/merchant/find", response_model=MerchantFindResponse, dependencies=[Depends(guard)])
    async def merchant_find(req: MerchantFindRequest) -> MerchantFindResponse:
        # Build merchant brain with same resilience pattern
        scripted = ScriptedMerchantBrain()
        if not settings.gemini_api_key:
            merchant_brain = scripted
        else:
            merchant_brain = ResilientMerchantBrain(
                GeminiMerchantBrain(settings.gemini_api_key, settings.gemini_model),
                scripted,
                on_error=lambda e: log.warning("Gemini merchant finder failed, using offline: %s", e)
            )
        merchant_graph = build_merchant_graph(merchant_brain)
        return await run_merchant(merchant_graph, req)

    return app


app = create_app()