import { expect, it } from "vitest";
import { amount } from "./format";

it("formats large decimal strings without converting through Number", () => {
  expect(amount("9007199254740993.010000")).toBe("9,007,199,254,740,993.01");
  expect(amount("-85000.000000", true)).toBe("−85,000.00");
  expect(amount("0.000000", true)).toBe("0.00");
  expect(amount(null)).toBe("—");
});
