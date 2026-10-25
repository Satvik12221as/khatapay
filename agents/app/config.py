import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


@dataclass(frozen=True)
class Settings:
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    agents_api_key: str = ""

    @staticmethod
    def from_env() -> "Settings":
        load_dotenv(Path(__file__).resolve().parent.parent / ".env")
        return Settings(
            gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
            gemini_model=os.getenv("GEMINI_MODEL", "").strip() or "gemini-2.5-flash",
            agents_api_key=os.getenv("AGENTS_API_KEY", "").strip(),
        )