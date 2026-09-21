import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { FundListSchema, RunSchema, StartRunSchema } from "./index.js";

it("keeps the Python JSON Schema contract in sync with TypeScript", () => {
  const generated = JSON.parse(
    readFileSync(new URL("../wire.schema.json", import.meta.url), "utf8"),
  );
  expect(generated).toEqual(
    Object.fromEntries(
      Object.entries({
        FundList: FundListSchema,
        Run: RunSchema,
        StartRun: StartRunSchema,
      }).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
    ),
  );
});
