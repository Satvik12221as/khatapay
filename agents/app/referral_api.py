import logging
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException

from .config import Settings
from .referral_brain import GeminiReferralBrain, ReferralBrain, ResilientReferralBrain, ScriptedReferralBrain
from .referral_graph import NoEligibleShop, build_referral_graph, run_recommend
from .referral_models import RecommendRequest, RecommendResponse

log = logging.getLogger("agents.referral")


def make_referral_brain(settings: Settings) -> ReferralBrain:
    scripted = ScriptedReferralBrain()
    if not settings.gemini_api_key:
        return scripted
    return ResilientReferralBrain(GeminiReferralBrain(settings.gemini_api_key, settings.gemini_model), scripted,
                                  on_error=lambda e: log.warning("Gemini failed, using offline referral agent: %s", e))


def build_router(brain: ReferralBrain, guard: Callable) -> APIRouter:
    graph = build_referral_graph(brain)
    router = APIRouter()

    @router.post("/recommend", response_model=RecommendResponse, dependencies=[Depends(guard)])
    async def recommend(req: RecommendRequest) -> RecommendResponse:
        try:
            return await run_recommend(graph, req)
        except NoEligibleShop:
            raise HTTPException(status_code=422, detail="No shop meets the minimum trust score")

    return router