import { writeFileSync } from "node:fs";
import { z } from "zod";
import { FundListSchema, RunSchema, StartRunSchema } from "./src/index.js";

const schemas = Object.fromEntries(
  Object.entries({
    FundList: FundListSchema,
    Run: RunSchema,
    StartRun: StartRunSchema,
  }).map(([name, schema]) => [name, z.toJSONSchema(schema)]),
);
writeFileSync(
  new URL("./wire.schema.json", import.meta.url),
  JSON.stringify(schemas, null, 2) + "\n",
);
