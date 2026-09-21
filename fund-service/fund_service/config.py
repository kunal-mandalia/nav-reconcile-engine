import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    database_url: str = field(repr=False)
    service_token: str = field(repr=False)
    source_dir: Path
    queue_capacity: int = 8
    seed_demo: bool = True

    @classmethod
    def from_env(cls):
        token = os.environ.get("FUND_SERVICE_TOKEN", "")
        if len(token) < 32:
            raise RuntimeError("FUND_SERVICE_TOKEN must contain at least 32 characters")
        capacity = int(os.environ.get("FUND_QUEUE_CAPACITY", "8"))
        if capacity < 1:
            raise RuntimeError("FUND_QUEUE_CAPACITY must be positive")
        return cls(
            database_url=os.environ["DATABASE_URL"],
            service_token=token,
            source_dir=Path(os.environ.get("SOURCE_DIR", ROOT / "data")),
            queue_capacity=capacity,
            seed_demo=os.environ.get("SEED_DEMO", "true") == "true",
        )
