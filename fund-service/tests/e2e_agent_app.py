"""Offline E2E entry point: real service/worker/database, scripted models only.

TEST_DATABASE_URL must refer to the disposable database created by the launcher.
There is no HTTP switch or production environment setting for this test provider.
"""

import os
from pathlib import Path

from agent_helpers import scripted_models
from pydantic_ai import models

from fund_service.agent.policy import AgentPolicy, AgentSettings
from fund_service.agent.runtime import AgentWorkflow
from fund_service.app import create_app
from fund_service.config import Settings

models.ALLOW_MODEL_REQUESTS = False
original = AgentWorkflow.execute


async def offline_execute(self, snapshot, root, run_id, stage):
    self.models = scripted_models(snapshot, root)
    return await original(self, snapshot, root, run_id, stage)


AgentWorkflow.execute = offline_execute


def app():
    settings = Settings(
        database_url=os.environ["TEST_DATABASE_URL"],
        service_token=os.environ["FUND_SERVICE_TOKEN"],
        source_dir=Path(os.environ["SOURCE_DIR"]),
        seed_agent_demo=True,
        agent=AgentSettings(AgentPolicy(mode="assist")),
    )
    return create_app(settings)
