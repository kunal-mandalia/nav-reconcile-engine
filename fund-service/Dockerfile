FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.11.7 /uv /usr/local/bin/uv
WORKDIR /app/fund-service
COPY fund-service/pyproject.toml fund-service/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY packages/contracts/wire.schema.json /app/packages/contracts/wire.schema.json
COPY fund-service/fund_service ./fund_service
COPY fund-service/migrations ./migrations
COPY fund-service/fixtures ./fixtures
ENV PATH="/app/fund-service/.venv/bin:$PATH" PYTHONUNBUFFERED=1
CMD ["uvicorn", "fund_service.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
