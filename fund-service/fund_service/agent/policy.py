import os
from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class AgentPolicy:
    mode: str = "off"
    model: str = "openai:gpt-4.1-mini"
    max_requests: int = 12
    max_tool_calls: int = 24
    timeout_seconds: int = 90
    request_timeout_seconds: int = 20
    toolset: str = "whole-file-v1"
    workflow_version: str = "fund-agent-v1"

    def __post_init__(self):
        if self.mode not in {"off", "assist"}:
            raise ValueError("AGENT_MODE must be off or assist")
        if not self.model.startswith("openai:") or len(self.model) <= 7:
            raise ValueError("AGENT_MODEL must be openai:<model-name>")
        for name, ceiling in [
            ("max_requests", 12),
            ("max_tool_calls", 24),
            ("timeout_seconds", 180),
            ("request_timeout_seconds", 60),
        ]:
            if not 1 <= getattr(self, name) <= ceiling:
                raise ValueError(f"Agent {name} must be between 1 and {ceiling}")

    def snapshot(self):
        return asdict(self)


@dataclass(frozen=True)
class AgentSettings:
    policy: AgentPolicy = field(default_factory=AgentPolicy)
    api_key: str = field(default="", repr=False)

    @classmethod
    def from_env(cls):
        policy = AgentPolicy(
            mode=os.getenv("AGENT_MODE", "off"),
            model=os.getenv("AGENT_MODEL", "openai:gpt-4.1-mini"),
            max_requests=int(os.getenv("AGENT_MAX_REQUESTS", "12")),
            max_tool_calls=int(os.getenv("AGENT_MAX_TOOL_CALLS", "24")),
            timeout_seconds=int(os.getenv("AGENT_TIMEOUT_SECONDS", "90")),
            request_timeout_seconds=int(os.getenv("AGENT_REQUEST_TIMEOUT_SECONDS", "20")),
        )
        key = os.getenv("OPENAI_API_KEY", "").strip()
        if policy.mode == "assist" and not key:
            raise ValueError("AGENT_MODE=assist requires OPENAI_API_KEY in the fund service")
        return cls(policy, key)
