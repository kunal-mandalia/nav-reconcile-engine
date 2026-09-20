import {
  FundListSchema,
  RunSchema,
  ErrorEnvelopeSchema,
  type Source,
} from "@nav/contracts";
import type { z } from "zod";

export const IDENTITIES = {
  operations: {
    label: "Alex Chen · Operations",
    token: "demo-operations",
    initials: "AC",
    canRun: true,
  },
  reviewer: {
    label: "Priya Shah · Read only",
    token: "demo-reviewer",
    initials: "PS",
    canRun: false,
  },
} as const;
export type Identity = keyof typeof IDENTITIES;
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public retryAfter = 0,
    public details?: Record<string, string>,
  ) {
    super(message);
  }
}
async function request(
  path: string,
  identity: Identity,
  init: RequestInit = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${IDENTITIES[identity].token}`,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      0,
      "CONNECTION_FAILED",
      "Cannot reach the demo server. Your last loaded result is preserved.",
    );
  }
  if (!response.ok) {
    const parsed = ErrorEnvelopeSchema.safeParse(
      await response.json().catch(() => null),
    );
    const error = parsed.success ? parsed.data.error : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? "REQUEST_FAILED",
      error?.message ?? "The server could not complete this request.",
      error?.request_id,
      Number(response.headers.get("Retry-After") ?? 0),
      error?.details,
    );
  }
  return response;
}
async function json<T>(
  path: string,
  identity: Identity,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await request(path, identity, init);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success)
    throw new ApiError(
      502,
      "INVALID_RESPONSE",
      "The server response did not match the agreed contract.",
      response.headers.get("X-Request-ID") ?? undefined,
    );
  return parsed.data;
}
export const api = {
  funds: (identity: Identity, period: string, signal?: AbortSignal) =>
    json(
      `/api/v1/funds?period_start=${period === "q2" ? "2026-04-01" : "2026-01-01"}&period_end=${period === "q2" ? "2026-06-30" : "2026-03-31"}`,
      identity,
      FundListSchema,
      { signal },
    ),
  run: (identity: Identity, id: string, signal?: AbortSignal) =>
    json(`/api/v1/runs/${encodeURIComponent(id)}`, identity, RunSchema, {
      signal,
    }),
  start: (identity: Identity, fundId: string, periodId: string, key: string) =>
    json(
      `/api/v1/funds/${encodeURIComponent(fundId)}/runs`,
      identity,
      RunSchema,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ reconciliation_period_id: periodId }),
      },
    ),
  download: async (identity: Identity, source: Source) => {
    // Only allow our same-origin source route, never arbitrary URLs from a payload.
    if (!/^\/api\/v1\/runs\/[\w-]+\/sources\/[\w-]+$/.test(source.content_url))
      throw new ApiError(502, "INVALID_SOURCE", "Invalid source link.");
    const response = await request(source.content_url, identity);
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = source.filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
