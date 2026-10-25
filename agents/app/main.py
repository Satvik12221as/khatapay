"""KhataPay agent service. Run:  python -m uvicorn app.main:app --port 8001  (from the agents folder)"""
import hmac
import logging
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException

from .brains import Brain, GeminiBrain, ResilientBrain, ScriptedBrain
from .config import Settings
from .haggle_graph import build_haggle_graph, run_haggle
from .judge_graph import build_judge_graph, run_judge
from .models import Evidence, HaggleRequest, HaggleResponse, JudgeResponse

log = logging.getLogger("agents")


def make_brain(settings: Settings) -> Brain:
    scripted = ScriptedBrain()
    if not settings.gemini_api_key:
        log.warning("No GEMINI_API_KEY: running the offline rule-based agents")
        return scripted
    return ResilientBrain(GeminiBrain(settings.gemini_api_key, settings.gemini_model), scripted,
                          on_error=lambda e: log.warning("Gemini failed, using offline agent: %s", e))


def create_app(brain: Optional[Brain] = None, settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or Settings.from_env()
    brain = brain or make_brain(settings)
    haggle_graph = build_haggle_graph(brain)
    judge_graph = build_judge_graph(brain)
    app = FastAPI(title="KhataPay agents")

    def guard(x_agents_key: Optional[str] = Header(default=None)) -> None:
        if settings.agents_api_key and not hmac.compare_digest(x_agents_key or "", settings.agents_api_key):
            raise HTTPException(status_code=401, detail="Bad agents key")

    @app.get("/health")
    async def health() -> dict:
        return {"ok": True, "llm": "gemini" if settings.gemini_api_key else "scripted", "framework": "langgraph"}

    @app.post("/haggle", response_model=HaggleResponse, dependencies=[Depends(guard)])
    async def haggle(req: HaggleRequest) -> HaggleResponse:
        return await run_haggle(haggle_graph, req)

    @app.post("/judge", response_model=JudgeResponse, dependencies=[Depends(guard)])
    async def judge(ev: Evidence) -> JudgeResponse:
        return await run_judge(judge_graph, ev)

    return app


app = create_app()