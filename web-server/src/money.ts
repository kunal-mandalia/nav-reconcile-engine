import { Decimal } from "decimal.js";
import { MoneySchema } from "@nav/contracts";

export const Exact = Decimal.clone({ precision: 50 });
export const TOLERANCE = "0.010000";
export function money(input: string | Decimal): string {
  const value = new Exact(input);
  if (
    !value.isFinite() ||
    value.decimalPlaces() > 6 ||
    value.abs().gte("1e32")
  ) {
    throw new Error("Amount is outside NUMERIC(38,6) precision");
  }
  return MoneySchema.parse(value.isZero() ? "0.000000" : value.toFixed(6));
}
export function rollForward(
  opening: string,
  calls: string,
  distributions: string,
  income: string,
) {
  return money(
    new Exact(opening).plus(calls).minus(distributions).plus(income),
  );
}
