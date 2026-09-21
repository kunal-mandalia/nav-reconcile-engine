import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { RemoteFundService } from "./remote-service.js";
import { DEMO_PRINCIPALS, MockFundService } from "./service.js";
import { PERIOD, uuid } from "./fixtures.js";

afterEach(() => vi.restoreAllMocks());
const principal = {
  ...DEMO_PRINCIPALS["demo-operations"],
  requestId: "upstream-request",
};
const options = {
  url: "http://127.0.0.1:8000",
  token: "test-service-credential-at-least-32-characters",
};

describe("private FastAPI adapter", () => {
  it("forwards only server-derived actor scope, service credentials and trace identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(new MockFundService().list(principal, PERIOD)),
      );
    const app = createApp({
      service: new RemoteFundService({ ...options, fetch: fetcher }),
    });
    const result = await request(app)
      .get("/api/v1/funds")
      .set("Authorization", "Bearer demo-operations")
      .set("X-Actor-ID", "forged-user")
      .set("X-Allowed-Fund-IDs", "[]")
      .set("X-Request-ID", "forged-trace");
    expect(result.status).toBe(200);
    expect(result.headers["x-data-source"]).toBe("fund-service");
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain("/internal/v1/funds?period_start=2026-04-01");
    expect(init?.headers).toMatchObject({
      Authorization: `Bearer ${options.token}`,
      "X-Actor-ID": "alex-chen",
      "X-Allowed-Fund-IDs": JSON.stringify(principal.allowedFundIds),
      "X-Request-ID": result.headers["x-request-id"],
    });
    expect(JSON.stringify(result.body)).not.toContain(options.token);
  });

  it("preserves run intent and safe domain errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          schema_version: 1,
          error: {
            code: "RUN_ALREADY_ACTIVE",
            message: "Already running",
            request_id: "trace",
            details: { run_id: uuid(500) },
          },
        },
        { status: 409 },
      ),
    );
    const service = new RemoteFundService({ ...options, fetch: fetcher });
    await expect(
      service.start(principal, uuid(1), uuid(101), "same-intent"),
    ).rejects.toMatchObject({
      status: 409,
      code: "RUN_ALREADY_ACTIVE",
      details: { run_id: uuid(500) },
    });
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      "Idempotency-Key": "same-intent",
    });
    expect(JSON.parse(fetcher.mock.calls[0][1]?.body as string)).toEqual({
      reconciliation_period_id: uuid(101),
    });
  });

  it("maps unavailable, timeout, invalid response and service-auth failures", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = new RemoteFundService({ ...options, fetch: fetcher });
    fetcher.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(service.get(principal, uuid(1))).rejects.toMatchObject({
      status: 503,
    });
    fetcher.mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError"),
    );
    await expect(service.get(principal, uuid(1))).rejects.toMatchObject({
      status: 504,
    });
    fetcher.mockResolvedValueOnce(Response.json({ invalid: true }));
    await expect(service.get(principal, uuid(1))).rejects.toMatchObject({
      status: 502,
    });
    fetcher.mockResolvedValueOnce(new Response("denied", { status: 401 }));
    await expect(service.get(principal, uuid(1))).rejects.toMatchObject({
      status: 502,
      code: "SERVICE_AUTH_FAILED",
    });
  });

  it("returns original bytes with source metadata", async () => {
    const bytes = Buffer.from('field,value\r\nreported_nav,"123.00"\r\n');
    const service = new RemoteFundService({
      ...options,
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(bytes, {
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="statement.csv"',
          },
        }),
      ),
    });
    expect(await service.source(principal, uuid(500), uuid(1000))).toEqual({
      filename: "statement.csv",
      mediaType: "text/csv; charset=utf-8",
      bytes,
    });
  });
});
