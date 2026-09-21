import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { dataSource } from "./data-source";
import { MockFundService, DEMO_PRINCIPALS } from "../../web-server/src/service";
import { PERIOD } from "../../web-server/src/fixtures";

const body = new MockFundService().list(
  DEMO_PRINCIPALS["demo-operations"],
  PERIOD,
);
const response = (source?: string, status = 200, payload: unknown = body) =>
  Response.json(payload, {
    status,
    headers: source ? { "X-Data-Source": source } : {},
  });
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  dataSource.reset();
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetcher.mockReset();
});

describe("API-confirmed data source", () => {
  it.each(["mock", "fund-service"])(
    "confirms %s after validating the response",
    async (source) => {
      expect(dataSource.getSnapshot().status).toBe("checking");
      fetcher.mockResolvedValue(response(source));
      await api.funds("operations", "q2");
      expect(dataSource.getSnapshot()).toEqual({ source, status: "connected" });
    },
  );
  it.each([undefined, "unknown"])(
    "does not guess an absent or unknown source: %s",
    async (source) => {
      fetcher
        .mockResolvedValueOnce(response("fund-service"))
        .mockResolvedValueOnce(response(source));
      await api.funds("operations", "q2");
      await api.funds("operations", "q2");
      expect(dataSource.getSnapshot()).toEqual({
        source: null,
        status: "unverified",
      });
    },
  );
  it("keeps the last source on outage and recovers on a valid response", async () => {
    fetcher
      .mockResolvedValueOnce(response("fund-service"))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(response("mock"));
    await api.funds("operations", "q2");
    await expect(api.funds("operations", "q2")).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
    expect(dataSource.getSnapshot()).toEqual({
      source: "fund-service",
      status: "disconnected",
    });
    await api.funds("operations", "q2");
    expect(dataSource.getSnapshot()).toEqual({
      source: "mock",
      status: "connected",
    });
  });
  it.each([502, 503, 504])(
    "does not treat a %s header as successful connectivity",
    async (status) => {
      fetcher.mockResolvedValue(response("fund-service", status, {}));
      await expect(api.funds("operations", "q2")).rejects.toMatchObject({
        status,
      });
      expect(dataSource.getSnapshot()).toEqual({
        source: null,
        status: "disconnected",
      });
    },
  );
  it("rejects malformed data before confirming a source", async () => {
    fetcher.mockResolvedValue(response("fund-service", 200, {}));
    await expect(api.funds("operations", "q2")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(dataSource.getSnapshot().status).toBe("disconnected");
  });
  it.each([401, 403, 409, 429])(
    "does not report an outage or confirmation for %s",
    async (status) => {
      fetcher.mockResolvedValue(response("fund-service", status, {}));
      await expect(api.funds("operations", "q2")).rejects.toMatchObject({
        status,
      });
      expect(dataSource.getSnapshot().status).toBe("checking");
    },
  );
  it("ignores cancelled requests", async () => {
    fetcher.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    await expect(api.funds("operations", "q2")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(dataSource.getSnapshot().status).toBe("checking");
  });
  it("ignores cancellation while reading the response body", async () => {
    const pending = response("fund-service");
    vi.spyOn(pending, "json").mockRejectedValue(
      new DOMException("Cancelled", "AbortError"),
    );
    fetcher.mockResolvedValue(pending);
    await expect(api.funds("operations", "q2")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(dataSource.getSnapshot().status).toBe("checking");
  });
  it("ignores old responses after a newer failure or identity reset", () => {
    const first = dataSource.begin();
    dataSource.fail(dataSource.begin());
    dataSource.confirm(first, "mock");
    expect(dataSource.getSnapshot().status).toBe("disconnected");
    const previousIdentity = dataSource.begin();
    dataSource.reset();
    dataSource.confirm(previousIdentity, "mock");
    expect(dataSource.getSnapshot().status).toBe("checking");
  });
});
