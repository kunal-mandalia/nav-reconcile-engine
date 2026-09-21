import { randomUUID } from "node:crypto";
import { FundListSchema, type Run, type FundList } from "@nav/contracts";
import { ApiError } from "./errors.js";
import {
  createFixtures,
  finishRun,
  queuedRun,
  PERIOD,
  uuid,
  type Fixture,
} from "./fixtures.js";

export interface Principal {
  id: string;
  allowedFundIds: string[];
  canRun: boolean;
  requestId?: string;
}
export const DEMO_PRINCIPALS: Record<string, Principal> = {
  "demo-operations": {
    id: "alex-chen",
    allowedFundIds: [1, 2, 3, 4, 5, 6].map(uuid),
    canRun: true,
  },
  "demo-reviewer": {
    id: "priya-shah",
    allowedFundIds: [2, 4].map(uuid),
    canRun: false,
  },
};
/** Replace this adapter with the private FastAPI client; routes and DTOs stay the same. */
type Awaitable<T> = T | Promise<T>;
export interface FundService {
  readonly dataSource: "mock" | "fund-service";
  list(principal: Principal, period: typeof PERIOD): Awaitable<FundList>;
  start(
    principal: Principal,
    fundId: string,
    periodId: string,
    key: string,
  ): Awaitable<Run>;
  get(principal: Principal, runId: string): Awaitable<Run>;
  source(
    principal: Principal,
    runId: string,
    documentId: string,
  ): Awaitable<{ filename: string; bytes: Buffer; mediaType?: string }>;
}
interface StoredRun {
  fixture: Fixture;
  run: Run;
  startedAt: number;
}
export class MockFundService implements FundService {
  readonly dataSource = "mock" as const;
  private fixtures = createFixtures();
  private runs = new Map<string, StoredRun>();
  private requests = new Map<string, { fingerprint: string; runId: string }>();
  private now: () => number;
  private stageMs: number;
  constructor(options: { now?: () => number; stageMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.stageMs = options.stageMs ?? 1000;
    for (const [index, fixture] of this.fixtures.entries()) {
      if (!fixture.initialRun) continue;
      const time = this.now() - (index + 1) * 60000;
      const run = finishRun(
        fixture,
        queuedRun(fixture, randomUUID(), new Date(time).toISOString()),
        new Date(time + 5000).toISOString(),
      );
      this.runs.set(run.run_id, { fixture, run, startedAt: time });
    }
  }
  private authorise(principal: Principal, fundId: string) {
    if (!principal.allowedFundIds.includes(fundId))
      throw new ApiError(
        403,
        "FUND_ACCESS_DENIED",
        "Your demo identity does not have access to this fund.",
      );
  }
  private advance() {
    for (const record of this.runs.values()) {
      if (record.run.state !== "queued" && record.run.state !== "running")
        continue;
      const step = Math.floor((this.now() - record.startedAt) / this.stageMs);
      if (step >= 5)
        record.run = finishRun(
          record.fixture,
          record.run,
          new Date(record.startedAt + this.stageMs * 5).toISOString(),
        );
      else if (step > 0)
        record.run = {
          ...record.run,
          state: "running",
          stage: (
            [
              "waiting",
              "extracting",
              "normalising",
              "reconciling",
              "publishing",
            ] as const
          )[step],
          stage_updated_at: new Date(
            record.startedAt + step * this.stageMs,
          ).toISOString(),
        };
    }
  }
  list(principal: Principal, period: typeof PERIOD): FundList {
    this.advance();
    const seeds =
      period.start === PERIOD.start && period.end === PERIOD.end
        ? this.fixtures
        : [];
    return FundListSchema.parse({
      schema_version: 1,
      period,
      funds: seeds
        .filter((f) => principal.allowedFundIds.includes(f.fund.fund_id))
        .map((f) => {
          const records = [...this.runs.values()]
            .filter((r) => r.fixture.fund.fund_id === f.fund.fund_id)
            .reverse();
          const latest = records[0]?.run;
          const completed = records
            .map((r) => r.run)
            .find((r) => r.state === "completed");
          const active =
            latest?.state === "running" || latest?.state === "queued";
          const status = !latest
            ? "not_run"
            : latest.state === "completed"
              ? latest.outcome
              : latest.state === "failed"
                ? "run_failed"
                : latest.state;
          return {
            ...f.fund,
            currency: f.currency,
            reconciliation_period_id: f.periodId,
            pack: { pack_id: f.packId, version: f.packVersion, state: "ready" },
            display_status: status,
            reported_nav: completed?.summary.reported_nav ?? null,
            difference: completed?.summary.difference ?? null,
            latest_run_id: latest?.run_id ?? null,
            last_completed_run_id: completed?.run_id ?? null,
            can_rerun: principal.canRun && !active,
            last_run_at: latest?.created_at ?? null,
            status_reason:
              status === "insufficient_evidence"
                ? "Net income is missing"
                : status === "run_failed"
                  ? "Simulated extraction failure"
                  : status === "mismatch"
                    ? "Outside the 0.01 tolerance"
                    : status === "matched"
                      ? "Capital roll-forward matched"
                      : status === "not_run"
                        ? "Ready for first reconciliation"
                        : "Reconciliation in progress",
          };
        }),
    });
  }
  start(
    principal: Principal,
    fundId: string,
    periodId: string,
    key: string,
  ): Run {
    this.authorise(principal, fundId);
    if (!principal.canRun)
      throw new ApiError(
        403,
        "ACTION_DENIED",
        "This demo identity can view results but cannot start reconciliation.",
      );
    const fixture = this.fixtures.find((f) => f.fund.fund_id === fundId);
    if (!fixture || fixture.periodId !== periodId)
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "The reconciliation period does not belong to this fund.",
      );
    const requestKey = `${principal.id}:start:${key}`;
    const fingerprint = `${fundId}:${periodId}`;
    const previous = this.requests.get(requestKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ApiError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This key was already used for a different request.",
        );
      return this.get(principal, previous.runId);
    }
    this.advance();
    const active = [...this.runs.values()].find(
      (r) =>
        r.fixture.periodId === periodId &&
        ["queued", "running"].includes(r.run.state),
    );
    if (active)
      throw new ApiError(
        409,
        "RUN_ALREADY_ACTIVE",
        "A reconciliation is already running for this fund and period.",
        { run_id: active.run.run_id },
      );
    const time = this.now();
    const run = queuedRun(fixture, randomUUID(), new Date(time).toISOString());
    this.runs.set(run.run_id, { fixture, run, startedAt: time });
    this.requests.set(requestKey, { fingerprint, runId: run.run_id });
    return structuredClone(run);
  }
  get(principal: Principal, runId: string): Run {
    const record = this.runs.get(runId);
    if (!record)
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "Run not found. The mock server may have restarted.",
      );
    this.authorise(principal, record.fixture.fund.fund_id);
    this.advance();
    return structuredClone(record.run);
  }
  source(principal: Principal, runId: string, documentId: string) {
    const run = this.get(principal, runId);
    const record = this.runs.get(runId)!;
    const document = record.fixture.documents.find((d) => d.id === documentId);
    if (
      run.state !== "completed" ||
      !document ||
      !run.sources.some((s) => s.document_id === documentId)
    ) {
      throw new ApiError(
        404,
        "RESOURCE_NOT_FOUND",
        "This document is not cited by this completed run.",
      );
    }
    return { filename: document.filename, bytes: Buffer.from(document.bytes) };
  }
}
