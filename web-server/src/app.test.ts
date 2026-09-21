import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { FundListSchema, RunSchema, type CompletedRun } from "@nav/contracts";
import { createApp } from "./app.js";
import { MockFundService } from "./service.js";
import { uuid } from "./fixtures.js";

const operations = "Bearer demo-operations";
const reviewer = "Bearer demo-reviewer";
describe("four-operation mock API", () => {
  let clock: number;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    clock = Date.parse("2026-09-20T12:00:00Z");
    app = createApp({
      now: () => clock,
      service: new MockFundService({ now: () => clock }),
    });
  });
  it("identifies the selected adapter even on errors and ignores a forged source header", async () => {
    const response = await request(app)
      .get("/api/v1/funds")
      .set("Authorization", operations)
      .set("X-Data-Source", "fund-service");
    expect(response.headers["x-data-source"]).toBe("mock");
    const denied = await request(app).get("/api/v1/funds");
    expect(denied.status).toBe(401);
    expect(denied.headers["x-data-source"]).toBe("mock");
  });
  const funds = async (app: ReturnType<typeof createApp>) =>
    FundListSchema.parse(
      (
        await request(app)
          .get("/api/v1/funds")
          .set("Authorization", operations)
          .expect(200)
      ).body,
    ).funds;
  const start = (fund = 1, key = "intent-one") =>
    request(app)
      .post(`/api/v1/funds/${uuid(fund)}/runs`)
      .set("Authorization", operations)
      .set("Idempotency-Key", key)
      .send({ reconciliation_period_id: uuid(fund + 100) });

  it("enforces the Express boundary before dispatch and rejects malformed service responses", async () => {
    const service = new MockFundService({ now: () => clock });
    const dispatch = vi.spyOn(service, "start");
    app = createApp({ service });
    await request(app)
      .post(`/api/v1/funds/${uuid(2)}/runs`)
      .set("Authorization", reviewer)
      .set("Idempotency-Key", "readonly-key")
      .send({ reconciliation_period_id: uuid(102) })
      .expect(403);
    expect(dispatch).not.toHaveBeenCalled();
    vi.spyOn(service, "list").mockReturnValue(
      {} as ReturnType<MockFundService["list"]>,
    );
    const response = await request(app)
      .get("/api/v1/funds")
      .set("Authorization", operations)
      .expect(502);
    expect(response.body.error.code).toBe("INVALID_SERVICE_RESPONSE");
    expect(response.body.error.request_id).toBe(
      response.headers["x-request-id"],
    );
  });

  it("authenticates and scopes list, run, source and mutation access", async () => {
    for (const token of ["", "Bearer missing", "Bearer constructor"])
      await request(app)
        .get("/api/v1/funds")
        .set("Authorization", token)
        .expect(401);
    const all = await funds(app);
    const response = await request(app)
      .get("/api/v1/funds")
      .set("Authorization", reviewer)
      .expect(200);
    expect(
      response.body.funds.map((f: { fund_id: string }) => f.fund_id),
    ).toEqual([uuid(2), uuid(4)]);
    expect(
      response.body.funds.every((f: { can_rerun: boolean }) => !f.can_rerun),
    ).toBe(true);
    const run = (
      await request(app)
        .get(`/api/v1/runs/${all[0].latest_run_id}`)
        .set("Authorization", operations)
    ).body;
    await request(app)
      .get(run.poll_url)
      .set("Authorization", reviewer)
      .expect(403);
    await request(app)
      .get(run.sources[0].content_url)
      .set("Authorization", reviewer)
      .expect(403);
    await request(app)
      .post(`/api/v1/funds/${uuid(2)}/runs`)
      .set("Authorization", reviewer)
      .set("Idempotency-Key", "readonly-key")
      .send({ reconciliation_period_id: uuid(102) })
      .expect(403);
  });

  it("separates financial outcomes, missing evidence and technical failure", async () => {
    const list = await funds(app);
    expect(list.map((f) => f.display_status)).toEqual([
      "mismatch",
      "matched",
      "insufficient_evidence",
      "matched",
      "not_run",
      "run_failed",
    ]);
    expect(list[0].difference).toBe("250000.000000");
    expect(list[2].difference).toBeNull();
    const missing = RunSchema.parse(
      (
        await request(app)
          .get(`/api/v1/runs/${list[2].latest_run_id}`)
          .set("Authorization", operations)
          .expect(200)
      ).body,
    );
    if (missing.state !== "completed") throw new Error("Expected completed");
    expect(missing.summary.calculated_nav).toBeNull();
    expect(missing.facts.some((f) => f.field === "net_income")).toBe(false);
    expect(missing.checks[1].status).toBe("not_evaluated");
    const failed = RunSchema.parse(
      (
        await request(app)
          .get(`/api/v1/runs/${list[5].latest_run_id}`)
          .set("Authorization", operations)
          .expect(200)
      ).body,
    );
    expect(failed.state).toBe("failed");
    expect(failed.outcome).toBeNull();
    expect(failed).not.toHaveProperty("summary");
  });

  it("progresses asynchronously, preserves prior decisions, and replays idempotent requests", async () => {
    const original = (await funds(app))[0];
    const originalRun = (
      await request(app)
        .get(`/api/v1/runs/${original.latest_run_id}`)
        .set("Authorization", operations)
    ).body;
    const first = await start().expect(202);
    expect(first.headers.location).toBe(first.body.poll_url);
    expect(first.body.state).toBe("queued");
    expect((await start().expect(202)).body.run_id).toBe(first.body.run_id);
    const conflict = await start(1, "new-intent").expect(409);
    expect(conflict.body.error.details.run_id).toBe(first.body.run_id);
    expect((await start(2).expect(409)).body.error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    clock += 2100;
    const running = (
      await request(app)
        .get(first.body.poll_url)
        .set("Authorization", operations)
        .expect(200)
    ).body;
    expect(running).toMatchObject({
      state: "running",
      stage: "normalising",
      outcome: null,
    });
    expect(running).not.toHaveProperty("summary");
    const activeSummary = (await funds(app))[0];
    expect(activeSummary).toMatchObject({
      latest_run_id: first.body.run_id,
      last_completed_run_id: original.latest_run_id,
      reported_nav: original.reported_nav,
      can_rerun: false,
    });
    clock += 3000;
    const terminal = (
      await request(app)
        .get(first.body.poll_url)
        .set("Authorization", operations)
        .expect(200)
    ).body;
    expect(terminal).toMatchObject({
      state: "completed",
      outcome: "mismatch",
      summary: originalRun.summary,
    });
    expect((await start().expect(200)).body).toEqual(terminal);
    expect(
      (
        await request(app)
          .get(originalRun.poll_url)
          .set("Authorization", operations)
      ).body,
    ).toEqual(originalRun);
    expect((await start(1, "intent-two").expect(202)).body.run_id).not.toBe(
      first.body.run_id,
    );
  });

  it("resolves every citation to the exact immutable source record and protects membership", async () => {
    const list = await funds(app);
    const run = RunSchema.parse(
      (
        await request(app)
          .get(`/api/v1/runs/${list[0].latest_run_id}`)
          .set("Authorization", operations)
      ).body,
    ) as CompletedRun;
    for (const fact of run.facts) {
      const source = run.sources.find(
        (s) => s.document_id === fact.document_id,
      )!;
      const response = await request(app)
        .get(source.content_url)
        .set("Authorization", operations)
        .expect(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.headers["content-disposition"]).toContain("attachment");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      if (fact.locator.kind !== "csv") throw new Error("Expected CSV fixture");
      const record = response.text.split("\r\n")[fact.locator.record_number];
      expect(record).toContain(`"${fact.field}","${fact.raw_text}"`);
      expect(fact.locator.column_name).toBe(
        response.text.split("\r\n")[0].split(",")[
          fact.locator.column_index - 1
        ],
      );
    }
    for (const commentary of run.commentary) {
      expect(
        commentary.fact_ids.every((id) =>
          run.facts.some((f) => f.fact_id === id),
        ),
      ).toBe(true);
      expect(
        commentary.check_ids.every((id) =>
          run.checks.some((c) => c.check_id === id),
        ),
      ).toBe(true);
    }
    await request(app)
      .get(`/api/v1/runs/${run.run_id}/sources/${uuid(1010)}`)
      .set("Authorization", operations)
      .expect(404);
  });

  it("validates command boundaries and returns traceable errors", async () => {
    const bad = await request(app)
      .post(`/api/v1/funds/${uuid(1)}/runs`)
      .set("Authorization", operations)
      .set("Idempotency-Key", "invalid-body")
      .send({ reconciliation_period_id: uuid(101), outcome: "matched" })
      .expect(422);
    expect(bad.body.error.request_id).toBe(bad.headers["x-request-id"]);
    await request(app)
      .post(`/api/v1/funds/${uuid(1)}/runs`)
      .set("Authorization", operations)
      .send({ reconciliation_period_id: uuid(101) })
      .expect(400);
    await request(app)
      .get("/api/v1/funds?period_start=2026-01-01")
      .set("Authorization", operations)
      .expect(422);
    await request(app)
      .get("/api/v1/funds?period_start=2026-02-30&period_end=2026-06-30")
      .set("Authorization", operations)
      .expect(422);
    await request(app)
      .get("/api/v1/runs/bad-id")
      .set("Authorization", operations)
      .expect(422);
    expect(
      (
        await request(app)
          .get("/api/v1/funds?period_start=2026-01-01&period_end=2026-03-31")
          .set("Authorization", operations)
          .expect(200)
      ).body.funds,
    ).toEqual([]);
    await request(app)
      .get("/api/v1/packs")
      .set("Authorization", operations)
      .expect(404);
  });

  it("keeps rate budgets independent and honours the reset time", async () => {
    app = createApp({
      now: () => clock,
      service: new MockFundService({ now: () => clock }),
      runLimit: 1,
      readLimit: 2,
    });
    await start().expect(202);
    const blocked = await start().expect(429);
    expect(blocked.headers["retry-after"]).toBe("60");
    await funds(app);
    await funds(app);
    await request(app)
      .get("/api/v1/funds")
      .set("Authorization", operations)
      .expect(429);
    await request(app)
      .get("/api/v1/funds")
      .set("Authorization", reviewer)
      .expect(200);
    clock += 60001;
    await start().expect(200);
    await funds(app);
  });
});
