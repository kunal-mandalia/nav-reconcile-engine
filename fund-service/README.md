# Fund service — planned

This directory is reserved for the Python/FastAPI reconciliation service. The current TypeScript demo uses `MockFundService` in [`web-server/src/service.ts`](../web-server/src/service.ts).

The next implementation should expose four private operations matching the [public contracts](../docs/plans/api-contracts.md), with service authentication and trusted actor/fund scope supplied by Express. Python owns real extraction, Decimal arithmetic, source membership checks and Postgres transactions. No browser should call this service directly.

Use Postgres `NUMERIC(38,6)` for canonical money, JSONB for versioned metadata, and immutable source files. Validate scale/precision before persistence. Run admission and idempotency must become durable, and results must publish atomically. See the [state and data design](../docs/plans/state-and-data.md).
