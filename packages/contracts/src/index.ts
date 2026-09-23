import { z } from "zod";

export const MoneySchema = z
  .string()
  .regex(
    /^-?(0|[1-9]\d{0,31})\.\d{6}$/,
    "Expected a decimal string with six fractional digits",
  );
export const CurrencySchema = z.enum(["USD", "EUR", "GBP"]);
export const OutcomeSchema = z.enum([
  "matched",
  "mismatch",
  "insufficient_evidence",
]);
export const DisplayStatusSchema = z.enum([
  "no_pack",
  "processing_pack",
  "awaiting_documents",
  "processing_failed",
  "queued",
  "running",
  "run_failed",
  "matched",
  "mismatch",
  "insufficient_evidence",
  "not_run",
]);
export const StageSchema = z.enum([
  "waiting",
  "extracting",
  "normalising",
  "reconciling",
  "publishing",
  "finished",
]);
export const FundIdentitySchema = z.object({
  fund_id: z.uuid(),
  name: z.string(),
  administrator: z.string(),
  strategy: z.string(),
});
export const PackSchema = z.object({
  pack_id: z.uuid(),
  version: z.number().int().positive(),
  state: z.enum(["received", "indexing", "ready", "needs_input", "failed"]),
});
export const FundSummarySchema = FundIdentitySchema.extend({
  currency: CurrencySchema,
  reconciliation_period_id: z.uuid(),
  pack: PackSchema.nullable(),
  display_status: DisplayStatusSchema,
  reported_nav: MoneySchema.nullable(),
  difference: MoneySchema.nullable(),
  latest_run_id: z.uuid().nullable(),
  last_completed_run_id: z.uuid().nullable(),
  can_rerun: z.boolean(),
  last_run_at: z.iso.datetime().nullable(),
  status_reason: z.string(),
});
export const FundListSchema = z.object({
  processing_mode: z.enum(["deterministic", "agent"]).optional(),
  schema_version: z.literal(1),
  period: z.object({ start: z.iso.date(), end: z.iso.date() }),
  funds: z.array(FundSummarySchema),
});
export const StartRunSchema = z.strictObject({
  reconciliation_period_id: z.uuid(),
});
export const FactFieldSchema = z.enum([
  "opening_nav",
  "capital_calls",
  "distributions",
  "net_income",
  "reported_nav",
]);
export const LocatorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("csv_record"),
    version: z.literal(1),
    record_index: z.number().int().positive(),
    column_index: z.number().int().positive(),
    column_name: z.string(),
  }),
  z.object({
    kind: z.literal("csv"),
    record_number: z.number().int().positive(),
    column_name: z.string(),
    column_index: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("spreadsheet"),
    sheet: z.string(),
    range: z.string(),
  }),
  z.object({
    kind: z.literal("pdf"),
    page_number: z.number().int().positive(),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    coordinate_system: z.literal("top_left_points"),
  }),
]);
export const FactSchema = z.object({
  fact_id: z.uuid(),
  field: FactFieldSchema,
  amount: MoneySchema,
  raw_text: z.string(),
  currency: CurrencySchema,
  scale: z.enum(["1", "1000", "1000000"]),
  document_id: z.uuid(),
  locator: LocatorSchema,
  normalisation_steps: z.array(
    z.object({ operation: z.string(), output: z.string().optional() }),
  ),
});
export const CheckSchema = z.object({
  check_id: z.uuid(),
  type: z.enum(["input_alignment", "capital_roll_forward"]),
  required: z.boolean(),
  status: z.enum(["pass", "fail", "not_evaluated"]),
  reason_code: z.string().nullable(),
  input_fact_ids: z.array(z.uuid()),
  expected_amount: MoneySchema.nullable().optional(),
  reported_amount: MoneySchema.nullable().optional(),
  difference_amount: MoneySchema.nullable().optional(),
  tolerance_amount: MoneySchema.optional(),
  currency: CurrencySchema.optional(),
});
export const SourceSchema = z.object({
  document_id: z.uuid(),
  filename: z.string(),
  content_url: z.string(),
  media_type: z.string(),
});
export const InputsSchema = z.object({
  pack_id: z.uuid(),
  pack_version: z.number().int(),
  period_start: z.iso.date(),
  period_end: z.iso.date(),
  entity_scope: z.literal("fund"),
  currency: CurrencySchema,
  ruleset_version: z.string(),
  absolute_tolerance: MoneySchema,
});
export const SafeErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.string()).optional(),
});
export const ErrorEnvelopeSchema = z.object({
  schema_version: z.literal(1),
  error: SafeErrorSchema.extend({ request_id: z.string() }),
});
export const ProcessingSchema = z.object({
  mode: z.enum(["deterministic", "agent"]),
  model: z.string().nullable(),
  toolset: z.string().nullable(),
  verification: z.enum([
    "not_applicable",
    "pending",
    "source_checked",
    "visual_passed",
    "needs_input",
  ]),
  commentary: z.enum(["template", "agent_supported"]),
  model_requests: z.number().int().nonnegative(),
  tool_calls: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
const RunBase = z.object({
  processing: ProcessingSchema.optional(),
  schema_version: z.literal(1),
  run_id: z.uuid(),
  reconciliation_period_id: z.uuid(),
  pack_id: z.uuid(),
  fund: FundIdentitySchema,
  inputs: InputsSchema,
  created_at: z.iso.datetime(),
  stage_updated_at: z.iso.datetime(),
  poll_url: z.string(),
});
export const RunSchema = z.discriminatedUnion("state", [
  RunBase.extend({
    state: z.literal("queued"),
    stage: z.literal("waiting"),
    outcome: z.null(),
  }),
  RunBase.extend({
    state: z.literal("running"),
    stage: StageSchema,
    outcome: z.null(),
  }),
  RunBase.extend({
    state: z.literal("failed"),
    stage: StageSchema,
    outcome: z.null(),
    completed_at: z.iso.datetime(),
    error: SafeErrorSchema,
  }),
  RunBase.extend({
    state: z.literal("completed"),
    stage: z.literal("finished"),
    outcome: OutcomeSchema,
    completed_at: z.iso.datetime(),
    summary: z.object({
      reported_nav: MoneySchema.nullable(),
      calculated_nav: MoneySchema.nullable(),
      difference: MoneySchema.nullable(),
    }),
    checks: z.array(CheckSchema),
    facts: z.array(FactSchema),
    sources: z.array(SourceSchema),
    commentary: z.array(
      z.object({
        kind: z.enum(["finding", "next_action"]),
        text: z.string(),
        check_ids: z.array(z.uuid()),
        fact_ids: z.array(z.uuid()),
      }),
    ),
  }),
]);
export type Money = z.infer<typeof MoneySchema>;
export type Currency = z.infer<typeof CurrencySchema>;
export type FundSummary = z.infer<typeof FundSummarySchema>;
export type FundList = z.infer<typeof FundListSchema>;
export type Fact = z.infer<typeof FactSchema>;
export type FactField = z.infer<typeof FactFieldSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Run = z.infer<typeof RunSchema>;
export type CompletedRun = Extract<Run, { state: "completed" }>;
export type DisplayStatus = z.infer<typeof DisplayStatusSchema>;
