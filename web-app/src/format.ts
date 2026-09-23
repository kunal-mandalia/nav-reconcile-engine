import { Decimal } from "decimal.js";
import type { Fact } from "@nav/contracts";

export function amount(
  value: string | null | undefined,
  signed = false,
): string {
  if (value === null || value === undefined) return "—";
  const decimal = new Decimal(value);
  const [whole, fraction] = decimal.abs().toFixed(2).split(".");
  return `${decimal.isNegative() ? "−" : signed && !decimal.isZero() ? "+" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
export const date = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
export const time = (value: string) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
export function location(fact: Fact): string {
  const locator = fact.locator;
  if (locator.kind === "csv_record")
    return `File record ${locator.record_index} · ${locator.column_name}`;
  if (locator.kind === "csv")
    return `Record ${locator.record_number} · ${locator.column_name}`;
  if (locator.kind === "spreadsheet")
    return `${locator.sheet} · ${locator.range}`;
  return `Page ${locator.page_number}`;
}
