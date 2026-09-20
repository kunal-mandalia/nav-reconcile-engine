import { describe, expect, it } from "vitest";
import { money, rollForward } from "./money.js";
import { createFixtures, finishRun, queuedRun, uuid } from "./fixtures.js";

describe("exact monetary decisions", () => {
  it("keeps sub-unit differences above JavaScript safe integer range", () => {
    expect(
      rollForward("9007199254740993.000001", "0.000001", "0", "-0.000001"),
    ).toBe("9007199254740993.000001");
    expect(money("99999999999999999999999999999999.999999")).toBe(
      "99999999999999999999999999999999.999999",
    );
    expect(money("-0")).toBe("0.000000");
  });
  it.each([
    "0.0000001",
    "100000000000000000000000000000000",
    "NaN",
    "Infinity",
  ])("rejects precision loss: %s", (value) =>
    expect(() => money(value)).toThrow(),
  );
  it.each([
    ["128699999.99", "matched"],
    ["128700000.01", "matched"],
    ["128699999.989999", "mismatch"],
    ["128700000.010001", "mismatch"],
  ])(
    "applies tolerance to the unrounded difference: %s",
    (reported, outcome) => {
      const fixture = createFixtures()[0];
      fixture.reported = money(reported);
      const run = finishRun(
        fixture,
        queuedRun(fixture, uuid(500), "2026-09-20T12:00:00Z"),
        "2026-09-20T12:00:05Z",
      );
      expect(run.outcome).toBe(outcome);
    },
  );
});
