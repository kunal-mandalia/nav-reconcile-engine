import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { z } from "zod";
import { FundListSchema, StartRunSchema, RunSchema } from "@nav/contracts";
import { ApiError } from "./errors.js";
import { PERIOD } from "./fixtures.js";
import {
  DEMO_PRINCIPALS,
  MockFundService,
  type FundService,
  type Principal,
} from "./service.js";

interface AppOptions {
  service?: FundService;
  now?: () => number;
  readLimit?: number;
  runLimit?: number;
}
export function createApp(options: AppOptions = {}) {
  const app = express();
  const service: FundService = options.service ?? new MockFundService();
  const now = options.now ?? Date.now;
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({
      "X-Request-ID": res.locals.requestId,
      "X-Data-Source": service.dataSource,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  });
  app.use("/api/v1", (req, res, next) => {
    const token = (req.header("Authorization") ?? "").replace(/^Bearer /, "");
    const principal = Object.hasOwn(DEMO_PRINCIPALS, token)
      ? DEMO_PRINCIPALS[token]
      : undefined;
    if (!req.header("Authorization")?.startsWith("Bearer ") || !principal)
      return next(
        new ApiError(
          401,
          "UNAUTHENTICATED",
          "Choose a valid demo identity to continue.",
        ),
      );
    res.locals.principal = { ...principal, requestId: res.locals.requestId };
    next();
  });
  app.use(express.json({ limit: "8kb" }));
  const windows = new Map<string, { start: number; count: number }>();
  const limit =
    (bucket: "read" | "run"): RequestHandler =>
    (_req, res, next) => {
      const principal = res.locals.principal as Principal;
      const key = `${principal.id}:${bucket}`;
      const max =
        bucket === "run" ? (options.runLimit ?? 6) : (options.readLimit ?? 180);
      let window = windows.get(key);
      if (!window || now() - window.start >= 60000) {
        window = { start: now(), count: 0 };
        windows.set(key, window);
      }
      if (window.count >= max) {
        res.set(
          "Retry-After",
          String(Math.max(1, Math.ceil((60000 - now() + window.start) / 1000))),
        );
        return next(
          new ApiError(
            429,
            "RATE_LIMITED",
            bucket === "run"
              ? "Too many reconciliation requests. Please wait before trying again."
              : "Too many read requests. Please wait before refreshing.",
          ),
        );
      }
      window.count++;
      next();
    };
  const id = (value: unknown) => z.uuid().parse(value);
  const response = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ApiError(
        502,
        "INVALID_SERVICE_RESPONSE",
        "The fund service response did not match the contract.",
      );
    return parsed.data;
  };
  app.get("/api/v1/funds", limit("read"), async (req, res) => {
    const query = z
      .strictObject({
        period_start: z.iso.date().optional(),
        period_end: z.iso.date().optional(),
      })
      .parse(req.query);
    if (
      !!query.period_start !== !!query.period_end ||
      (query.period_start &&
        query.period_end &&
        query.period_start > query.period_end)
    ) {
      throw new ApiError(
        422,
        "INVALID_PERIOD",
        "Supply both reporting dates in chronological order.",
      );
    }
    res.json(
      response(
        FundListSchema,
        await service.list(res.locals.principal, {
          start: query.period_start ?? PERIOD.start,
          end: query.period_end ?? PERIOD.end,
        }),
      ),
    );
  });
  app.post("/api/v1/funds/:fundId/runs", limit("run"), async (req, res) => {
    const fundId = id(req.params.fundId);
    const principal = res.locals.principal as Principal;
    // Action scope is a client-API responsibility, even with a remote adapter.
    if (!principal.canRun || !principal.allowedFundIds.includes(fundId))
      throw new ApiError(
        403,
        "ACTION_DENIED",
        "Your demo identity cannot start reconciliation for this fund.",
      );
    const body = StartRunSchema.parse(req.body);
    const key = z
      .string()
      .min(8)
      .max(128)
      .regex(/^[\w-]+$/)
      .safeParse(req.header("Idempotency-Key"));
    if (!key.success)
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "Supply an Idempotency-Key of 8–128 letters, numbers, underscores or hyphens.",
      );
    const run = response(
      RunSchema,
      await service.start(
        principal,
        fundId,
        body.reconciliation_period_id,
        key.data,
      ),
    );
    res
      .location(run.poll_url)
      .status(run.state === "queued" || run.state === "running" ? 202 : 200)
      .json(run);
  });
  app.get("/api/v1/runs/:runId", limit("read"), async (req, res) =>
    res.json(
      response(
        RunSchema,
        await service.get(res.locals.principal, id(req.params.runId)),
      ),
    ),
  );
  app.get(
    "/api/v1/runs/:runId/sources/:documentId",
    limit("read"),
    async (req, res) => {
      const source = await service.source(
        res.locals.principal,
        id(req.params.runId),
        id(req.params.documentId),
      );
      res
        .set("Content-Type", source.mediaType ?? "text/csv; charset=utf-8")
        .attachment(source.filename)
        .send(source.bytes);
    },
  );
  app.use((_req, _res, next) =>
    next(new ApiError(404, "RESOURCE_NOT_FOUND", "Endpoint not found.")),
  );
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    let safe: ApiError;
    if (error instanceof ApiError) safe = error;
    else if (error instanceof z.ZodError)
      safe = new ApiError(
        422,
        "INVALID_REQUEST",
        "The request does not match the API contract.",
      );
    else if (error instanceof SyntaxError)
      safe = new ApiError(
        400,
        "INVALID_REQUEST",
        "Request body must be valid JSON.",
      );
    else if (
      typeof error === "object" &&
      error !== null &&
      "type" in error &&
      error.type === "entity.too.large"
    )
      safe = new ApiError(
        413,
        "REQUEST_TOO_LARGE",
        "Request body exceeds the limit.",
      );
    else {
      safe = new ApiError(
        500,
        "INTERNAL_ERROR",
        "An unexpected server error occurred.",
      );
      console.error("Request failed", res.locals.requestId, error);
    }
    res.status(safe.status).json({
      schema_version: 1,
      error: {
        code: safe.code,
        message: safe.message,
        request_id: res.locals.requestId,
        ...(safe.details ? { details: safe.details } : {}),
      },
    });
  };
  app.use(errors);
  return app;
}
