import { randomUUID } from "node:crypto";
import {
  RunSchema,
  type CompletedRun,
  type Currency,
  type Fact,
  type FactField,
  type Run,
} from "@nav/contracts";
import { Exact, money, rollForward, TOLERANCE } from "./money.js";

export const PERIOD = { start: "2026-04-01", end: "2026-06-30" };
export const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export interface Fixture {
  fund: {
    fund_id: string;
    name: string;
    administrator: string;
    strategy: string;
  };
  periodId: string;
  packId: string;
  packVersion: number;
  currency: Currency;
  opening: string;
  calls: string;
  distributions: string;
  income: string | null;
  reported: string;
  failure: boolean;
  initialRun: boolean;
  documents: FixtureDocument[];
}
export interface FixtureDocument {
  id: string;
  filename: string;
  bytes: Buffer;
  rows: { field: FactField; raw: string; amount: string }[];
}
type Seed = [
  string,
  string,
  string,
  Currency,
  string,
  string,
  string,
  string | null,
  string,
  boolean?,
  boolean?,
];
const seeds: Seed[] = [
  [
    "Atlas Growth Fund IV",
    "Citco",
    "Private equity",
    "USD",
    "120000000",
    "12000000",
    "4000000",
    "700000",
    "128450000",
  ],
  [
    "Meridian Infrastructure II",
    "SS&C",
    "Infrastructure",
    "EUR",
    "80000000",
    "5000000",
    "1000000",
    "2720000",
    "86720000",
  ],
  [
    "Oakbridge Private Credit",
    "Aztec",
    "Private credit",
    "GBP",
    "60000000",
    "5000000",
    "1000000",
    null,
    "64200000",
  ],
  [
    "Cove Real Estate Partners",
    "Citco",
    "Real estate",
    "USD",
    "200000000",
    "16000000",
    "6000000",
    "4180000",
    "214180000",
  ],
  [
    "Northline Ventures III",
    "SS&C",
    "Venture capital",
    "USD",
    "40000000",
    "4000000",
    "500000",
    "-735000",
    "42850000",
    false,
    false,
  ],
  [
    "Summit Secondaries I",
    "Gen II",
    "Secondaries",
    "EUR",
    "70000000",
    "2000000",
    "1000000",
    "300000",
    "71300000",
    true,
  ],
];
const csvCell = (value: string) => `"${value.replaceAll('"', '""')}"`;
export function createFixtures(): Fixture[] {
  return seeds.map(
    (
      [
        name,
        administrator,
        strategy,
        currency,
        opening,
        calls,
        distributions,
        income,
        reported,
        failure = false,
        initialRun = true,
      ],
      index,
    ) => {
      const seed: Fixture = {
        fund: { fund_id: uuid(index + 1), name, administrator, strategy },
        periodId: uuid(index + 101),
        packId: uuid(index + 201),
        packVersion: index === 0 ? 2 : 1,
        currency,
        opening: money(opening),
        calls: money(calls),
        distributions: money(distributions),
        income: income === null ? null : money(income),
        reported: money(reported),
        failure,
        initialRun,
        documents: [],
      };
      const groups: [string, [FactField, string | null][]][] = [
        ["opening_capital.csv", [["opening_nav", seed.opening]]],
        [
          "capital_activity.csv",
          [
            ["capital_calls", seed.calls],
            ["distributions", seed.distributions],
          ],
        ],
        [
          "capital_statement.csv",
          [
            ["net_income", seed.income],
            ["reported_nav", seed.reported],
          ],
        ],
      ];
      seed.documents = groups.map(([filename, values], docIndex) => {
        const rows = values.flatMap(([field, value]) => {
          if (value === null) return [];
          const decimal = new Exact(value);
          const raw =
            field === "distributions" || decimal.isNegative()
              ? `(${decimal.abs().toFixed(2)})`
              : decimal.toFixed(2);
          return [{ field, raw, amount: value }];
        });
        const lines = [
          "fund,period_start,period_end,currency,scale,field,value",
          ...rows.map((row) =>
            [name, PERIOD.start, PERIOD.end, currency, "1", row.field, row.raw]
              .map(csvCell)
              .join(","),
          ),
        ];
        return {
          id: uuid(1000 + index * 10 + docIndex),
          filename,
          rows,
          bytes: Buffer.from(lines.join("\r\n") + "\r\n"),
        };
      });
      return seed;
    },
  );
}
export function queuedRun(
  seed: Fixture,
  runId: string,
  createdAt: string,
): Run {
  return RunSchema.parse({
    schema_version: 1,
    run_id: runId,
    reconciliation_period_id: seed.periodId,
    pack_id: seed.packId,
    fund: seed.fund,
    created_at: createdAt,
    stage_updated_at: createdAt,
    inputs: {
      pack_id: seed.packId,
      pack_version: seed.packVersion,
      period_start: PERIOD.start,
      period_end: PERIOD.end,
      entity_scope: "fund",
      currency: seed.currency,
      ruleset_version: "capital-roll-forward-v1",
      absolute_tolerance: TOLERANCE,
    },
    state: "queued",
    stage: "waiting",
    outcome: null,
    poll_url: `/api/v1/runs/${runId}`,
  });
}
export function finishRun(seed: Fixture, run: Run, completedAt: string): Run {
  if (seed.failure)
    return RunSchema.parse({
      ...run,
      state: "failed",
      stage: "extracting",
      completed_at: completedAt,
      stage_updated_at: completedAt,
      outcome: null,
      error: {
        code: "MOCK_EXTRACTION_FAILED",
        message:
          "The simulated extraction worker stopped before a decision could be made. Retry to demonstrate the same failure on unchanged inputs.",
      },
    });
  const facts: Fact[] = seed.documents.flatMap((doc) =>
    doc.rows.map((row, index) => ({
      fact_id: randomUUID(),
      field: row.field,
      amount: row.amount,
      raw_text: row.raw,
      currency: seed.currency,
      scale: "1" as const,
      document_id: doc.id,
      locator: {
        kind: "csv" as const,
        record_number: index + 1,
        column_name: "value",
        column_index: 7,
      },
      normalisation_steps:
        row.field === "distributions"
          ? [
              {
                operation: "parse_accounting_number",
                output: money(new Exact(row.amount).negated()),
              },
              {
                operation: "distribution_outflow_to_magnitude",
                output: row.amount,
              },
            ]
          : [{ operation: "parse_decimal", output: row.amount }],
    })),
  );
  const calculated =
    seed.income === null
      ? null
      : rollForward(seed.opening, seed.calls, seed.distributions, seed.income);
  const difference =
    calculated === null
      ? null
      : money(new Exact(calculated).minus(seed.reported));
  const outcome =
    difference === null
      ? "insufficient_evidence"
      : new Exact(difference).abs().lte(TOLERANCE)
        ? "matched"
        : "mismatch";
  const checkId = randomUUID();
  const factIds = facts.map((f) => f.fact_id);
  const direction =
    difference && new Exact(difference).isNegative() ? "below" : "above";
  const finding =
    outcome === "insufficient_evidence"
      ? "The capital statement has no net income value. Closing NAV is available, but the roll-forward cannot be calculated. Missing income is not treated as zero."
      : outcome === "matched"
        ? `Calculated and reported closing NAV agree within the ${seed.currency} 0.01 tolerance. The capital roll-forward and input alignment checks pass.`
        : `Calculated NAV is ${seed.currency} ${new Exact(difference!).abs().toFixed(2)} ${direction} reported NAV, exceeding the ${seed.currency} 0.01 tolerance. The supplied documents do not explain the variance.`;
  const result: CompletedRun = {
    ...run,
    state: "completed",
    stage: "finished",
    outcome,
    stage_updated_at: completedAt,
    completed_at: completedAt,
    summary: {
      reported_nav: seed.reported,
      calculated_nav: calculated,
      difference,
    },
    facts,
    sources: seed.documents.map((doc) => ({
      document_id: doc.id,
      filename: doc.filename,
      media_type: "text/csv",
      content_url: `/api/v1/runs/${run.run_id}/sources/${doc.id}`,
    })),
    checks: [
      {
        check_id: randomUUID(),
        type: "input_alignment",
        required: true,
        status: "pass",
        reason_code: null,
        input_fact_ids: factIds,
      },
      {
        check_id: checkId,
        type: "capital_roll_forward",
        required: true,
        status:
          outcome === "insufficient_evidence"
            ? "not_evaluated"
            : outcome === "matched"
              ? "pass"
              : "fail",
        reason_code:
          outcome === "insufficient_evidence"
            ? "MISSING_NET_INCOME"
            : outcome === "mismatch"
              ? "NAV_OUTSIDE_TOLERANCE"
              : null,
        expected_amount: calculated,
        reported_amount: seed.reported,
        difference_amount: difference,
        tolerance_amount: TOLERANCE,
        currency: seed.currency,
        input_fact_ids: factIds,
      },
    ],
    commentary: [
      {
        kind: "finding",
        text: finding,
        check_ids: [checkId],
        fact_ids: factIds,
      },
      {
        kind: "next_action",
        text:
          outcome === "matched"
            ? "Review the cited source evidence. A mathematical match is separate from human approval."
            : outcome === "insufficient_evidence"
              ? "Request a capital statement containing net income for this reporting period."
              : "Ask the administrator to explain the variance or provide corrected figures.",
        check_ids: [checkId],
        fact_ids: [],
      },
    ],
  };
  return RunSchema.parse(result);
}
