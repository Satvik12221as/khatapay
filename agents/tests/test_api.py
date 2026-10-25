import pytest
from fastapi.testclient import TestClient

from app.brains import ScriptedBrain
from app.config import Settings
from app.main import create_app

HAGGLE = {"merchantName": "Shop", "totalCents": 9000, "maxDiscountPct": 10, "minTotalCents": 100,
          "loyalty": {"visits": 14, "memberSince": "March", "onTimeRate": 1}}
EVIDENCE = {"totalCents": 9000, "lines": [{"expr": "30", "cents": 3000}], "tapeVerified": True, "deliveryMarked": True,
            "hoursSinceDelivery": 2, "claimReason": "not_received", "customerNote": "", "shopStance": "no_response", "shopNote": ""}


def client(**kw):
    return TestClient(create_app(brain=ScriptedBrain(), settings=Settings(**kw)))


def test_health_reports_framework_and_mode():
    j = client().get("/health").json()
    assert j == {"ok": True, "llm": "scripted", "framework": "langgraph"}


def test_haggle_contract_uses_camel_case():
    j = client().post("/haggle", json=HAGGLE).json()
    assert j["finalDiscountCents"] == 680 and j["agreed"] is True
    assert set(j["turns"][0]) >= {"side", "accept", "discountCents", "message", "source"}
    assert j["trace"][0]["node"] == "customer"


def test_judge_contract():
    j = client().post("/judge", json=EVIDENCE).json()
    assert j["outcome"] == "refund" and [v["judge"] for v in j["votes"]][0] == "Consumer advocate"
    assert all(set(v) == {"judge", "verdict", "reason", "source"} for v in j["votes"])


@pytest.mark.parametrize("path,bad", [("/haggle", {**HAGGLE, "totalCents": 5}), ("/haggle", {**HAGGLE, "maxDiscountPct": 99}),
                                      ("/judge", {**EVIDENCE, "claimReason": "bogus"}), ("/judge", {**EVIDENCE, "customerNote": "x" * 500})])
def test_bad_input_is_rejected(path, bad):
    assert client().post(path, json=bad).status_code == 422


def test_shared_secret_is_enforced_when_configured():
    c = client(agents_api_key="s3cret")
    assert c.post("/haggle", json=HAGGLE).status_code == 401
    assert c.post("/haggle", json=HAGGLE, headers={"x-agents-key": "wrong"}).status_code == 401
    assert c.post("/haggle", json=HAGGLE, headers={"x-agents-key": "s3cret"}).status_code == 200
    assert c.get("/health").status_code == 200