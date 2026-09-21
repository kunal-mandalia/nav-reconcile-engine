import { describe, expect, it } from "vitest";
import { backendMode } from "./config.js";

describe("backend selection", () => {
  it.each(["mock", "fund-service"])(
    "selects %s from the environment",
    (mode) => {
      expect(backendMode([], { CLIENT_API_BACKEND: mode })).toBe(mode);
    },
  );
  it("keeps explicit development flags authoritative", () => {
    expect(
      backendMode(["--mock"], { CLIENT_API_BACKEND: "fund-service" }),
    ).toBe("mock");
    expect(backendMode(["--service"], { CLIENT_API_BACKEND: "mock" })).toBe(
      "fund-service",
    );
  });
  it("rejects missing, invalid or contradictory settings", () => {
    expect(() => backendMode([], {})).toThrow("CLIENT_API_BACKEND");
    expect(() => backendMode([], { CLIENT_API_BACKEND: "typo" })).toThrow(
      "CLIENT_API_BACKEND",
    );
    expect(() => backendMode(["--mock", "--service"], {})).toThrow("only one");
  });
  it("keeps the demo identity production guard", () => {
    expect(() =>
      backendMode([], {
        CLIENT_API_BACKEND: "fund-service",
        NODE_ENV: "production",
      }),
    ).toThrow("local-only");
  });
});
