import { randomUUID } from "node:crypto";
import { FundListSchema, RunSchema, ErrorEnvelopeSchema } from "@nav/contracts";
import type { z } from "zod";
import { ApiError } from "./errors.js";
import type { FundService, Principal } from "./service.js";

export class RemoteFundService implements FundService {
  readonly dataSource = "fund-service" as const;
  private url: string;
  constructor(
    private options: {
      url: string;
      token: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(options.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      options.token.length < 32
    )
      throw new Error(
        "A valid FUND_SERVICE_URL and a 32+ character FUND_SERVICE_TOKEN are required.",
      );
    this.url = url.origin;
  }

  private async request<T>(
    principal: Principal,
    path: string,
    read: (response: Response) => Promise<T>,
    init: RequestInit = {},
  ): Promise<T> {
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.url}/internal/v1${path}`,
        {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
          headers: {
            ...init.headers,
            Authorization: `Bearer ${this.options.token}`,
            "X-Actor-ID": principal.id,
            "X-Allowed-Fund-IDs": JSON.stringify(principal.allowedFundIds),
            "X-Can-Run": String(principal.canRun),
            "X-Request-ID": principal.requestId ?? randomUUID(),
          },
        },
      );
      if (!response.ok) {
        const error = ErrorEnvelopeSchema.safeParse(
          await response.json().catch(() => null),
        );
        if (response.status === 401)
          throw new ApiError(
            502,
            "SERVICE_AUTH_FAILED",
            "The client API could not authenticate with the fund service.",
          );
        if (error.success)
          throw new ApiError(
            response.status,
            error.data.error.code,
            error.data.error.message,
            error.data.error.details,
          );
        throw new ApiError(
          502,
          "INVALID_SERVICE_RESPONSE",
          "The fund service returned an unexpected response.",
        );
      }
      return await read(response);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
      )
        throw new ApiError(
          504,
          "SERVICE_TIMEOUT",
          "The fund service timed out. Retry a run request with the same idempotency key.",
        );
      if (error instanceof SyntaxError)
        throw new ApiError(
          502,
          "INVALID_SERVICE_RESPONSE",
          "The fund service returned invalid JSON.",
        );
      throw new ApiError(
        503,
        "SERVICE_UNAVAILABLE",
        "The fund service is unavailable. Please retry shortly.",
      );
    }
  }

  private json<T>(
    principal: Principal,
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
  ) {
    return this.request(
      principal,
      path,
      async (response) => {
        const parsed = schema.safeParse(await response.json());
        if (!parsed.success)
          throw new ApiError(
            502,
            "INVALID_SERVICE_RESPONSE",
            "The fund service response did not match the contract.",
          );
        return parsed.data;
      },
      init,
    );
  }
  list(principal: Principal, period: { start: string; end: string }) {
    return this.json(
      principal,
      `/funds?${new URLSearchParams({ period_start: period.start, period_end: period.end })}`,
      FundListSchema,
    );
  }
  start(principal: Principal, fundId: string, periodId: string, key: string) {
    return this.json(
      principal,
      `/funds/${encodeURIComponent(fundId)}/runs`,
      RunSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ reconciliation_period_id: periodId }),
      },
    );
  }
  get(principal: Principal, runId: string) {
    return this.json(
      principal,
      `/runs/${encodeURIComponent(runId)}`,
      RunSchema,
    );
  }
  source(principal: Principal, runId: string, documentId: string) {
    return this.request(
      principal,
      `/runs/${encodeURIComponent(runId)}/sources/${encodeURIComponent(documentId)}`,
      async (response) => ({
        filename:
          response.headers
            .get("content-disposition")
            ?.match(/filename="([^"\r\n]+)"/)?.[1] ?? `${documentId}.csv`,
        mediaType:
          response.headers.get("content-type") ?? "application/octet-stream",
        bytes: Buffer.from(await response.arrayBuffer()),
      }),
    );
  }
}
