import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "web-server/src/**/*.test.ts",
      "web-app/src/**/*.test.ts",
      "packages/**/*.test.ts",
    ],
  },
});
