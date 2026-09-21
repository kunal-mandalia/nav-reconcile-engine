import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

const path = new URL("../.env", import.meta.url);
if (!existsSync(path)) {
  const password = randomBytes(24).toString("hex");
  const token = randomBytes(32).toString("hex");
  writeFileSync(
    path,
    `CLIENT_API_BACKEND=fund-service\nPOSTGRES_PASSWORD=${password}\nFUND_SERVICE_TOKEN=${token}\nDATABASE_URL=postgresql://nav:${password}@127.0.0.1:5433/nav_demo\nFUND_SERVICE_URL=http://127.0.0.1:8000\n`,
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Created local .env with generated database and service credentials.",
  );
} else {
  if (
    !/^\s*(?:export\s+)?CLIENT_API_BACKEND\s*=/m.test(
      readFileSync(path, "utf8"),
    )
  ) {
    appendFileSync(path, "\nCLIENT_API_BACKEND=fund-service\n");
    console.log("Added CLIENT_API_BACKEND=fund-service to existing .env.");
  }
  console.log(
    "Using existing .env; credentials and database state are preserved.",
  );
}
