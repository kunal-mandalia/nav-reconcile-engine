import csv
import io
import re
from collections import Counter
from decimal import Decimal, InvalidOperation, localcontext
from pathlib import Path
from uuid import uuid4

from . import sources
from .errors import SourceFailure

FIELDS = ("opening_nav", "capital_calls", "distributions", "net_income", "reported_nav")
HEADER = ["fund", "period_start", "period_end", "currency", "scale", "field", "value"]
ROLES = {
    "opening": {"opening_nav"},
    "activity": {"capital_calls", "distributions"},
    "statement": {"net_income", "reported_nav"},
}
NUMBER = re.compile(r"[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$")


def money(value: Decimal) -> str:
    """Validate BEFORE NUMERIC coercion; never silently round financial inputs."""
    with localcontext() as context:
        context.prec = 50
        if not value.is_finite() or abs(value) >= Decimal("1e32"):
            raise ValueError("Amount exceeds NUMERIC(38,6)")
        fixed = value.quantize(Decimal("0.000001"))
        if fixed != value:
            raise ValueError("Amount has more than six decimal places")
        return format(abs(fixed) if fixed == 0 else fixed, ".6f")


def normalise(raw: str, field: str, scale: str) -> tuple[str, list]:
    text = raw.strip()
    bracketed = text.startswith("(") and text.endswith(")")
    if bracketed:
        text = text[1:-1]
        if text.startswith(("+", "-")):
            raise ValueError("Ambiguous accounting sign")
    if not NUMBER.fullmatch(text) or len(text) > 80 or scale not in {"1", "1000", "1000000"}:
        raise ValueError("Unsupported amount or scale")
    with localcontext() as context:
        context.prec = 50
        value = Decimal(text.replace(",", ""))
        if bracketed:
            # Unary minus applies the current Decimal context and can round a
            # long fractional tail before money() has a chance to reject it.
            value = value.copy_negate()
        # Validate source precision before any arithmetic can round it.
        parsed = money(value)
        steps = [
            {
                "operation": "parse_accounting_number" if bracketed else "parse_decimal",
                "output": parsed,
            }
        ]
        value *= Decimal(scale)
        steps.append({"operation": f"apply_scale_{scale}", "output": money(value)})
        if field == "distributions":
            # This layout permits positive magnitudes or bracketed outflows only.
            if bracketed:
                value = -value
                steps.append(
                    {"operation": "distribution_outflow_to_magnitude", "output": money(value)}
                )
            elif value < 0:
                raise ValueError("Unmapped negative distribution convention")
        if field in {"capital_calls", "distributions"} and value < 0:
            raise ValueError("Negative movement needs an explicit mapping")
        return money(value), steps


def extract(snapshot: dict, root: Path) -> tuple[list, list]:
    facts, issues = [], []
    scope = snapshot["inputs"]
    for document in snapshot["documents"]:
        data = sources.read(root, document)
        if len(data) > 2_000_000:
            issues.append("UNSUPPORTED_DOCUMENT_SIZE")
            continue
        try:
            text = data.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise SourceFailure(
                "SOURCE_DECODE_FAILED", "A source file is not readable as UTF-8 CSV."
            ) from error
        try:
            reader = csv.DictReader(io.StringIO(text, newline=""), strict=True)
            if reader.fieldnames != HEADER:
                issues.append("UNSUPPORTED_LAYOUT")
                continue
            for record, row in enumerate(reader, start=1):
                if record > 10000:
                    issues.append("UNSUPPORTED_DOCUMENT_SIZE")
                    break
                if None in row or any(value is None for value in row.values()):
                    issues.append("INVALID_RECORD")
                    continue
                if (
                    row["fund"] != snapshot["fund"]["name"]
                    or row["period_start"] != scope["period_start"]
                    or row["period_end"] != scope["period_end"]
                    or row["currency"] != scope["currency"]
                ):
                    issues.append("INPUT_SCOPE_MISMATCH")
                    continue
                field = row["field"]
                if field not in ROLES.get(document["role"], set()):
                    issues.append("UNSUPPORTED_FIELD_MAPPING")
                    continue
                try:
                    amount, steps = normalise(row["value"], field, row["scale"])
                except (ValueError, InvalidOperation):
                    issues.append("INVALID_AMOUNT_OR_SCALE")
                    continue
                facts.append(
                    {
                        "fact_id": str(uuid4()),
                        "field": field,
                        "amount": amount,
                        "raw_text": row["value"],
                        "currency": row["currency"],
                        "scale": row["scale"],
                        "document_id": document["document_id"],
                        "locator": {
                            "kind": "csv",
                            "record_number": record,
                            "column_name": "value",
                            "column_index": 7,
                        },
                        "normalisation_steps": steps,
                    }
                )
        except csv.Error:
            issues.append("UNSUPPORTED_LAYOUT")
    counts = Counter(f["field"] for f in facts)
    if any(n > 1 for n in counts.values()):
        issues.append("CONFLICTING_SOURCES")
        facts = [f for f in facts if counts[f["field"]] == 1]
    return facts, sorted(set(issues))


def decide(snapshot: dict, run_id: str, facts: list, issues: list) -> dict:
    values = {f["field"]: Decimal(f["amount"]) for f in facts}
    scope = snapshot["inputs"]
    missing = [field for field in FIELDS if field not in values]
    calculated = difference = None
    if not issues and not missing:
        with localcontext() as context:
            context.prec = 50
            try:
                calculated = money(
                    values["opening_nav"]
                    + values["capital_calls"]
                    - values["distributions"]
                    + values["net_income"]
                )
                difference = money(Decimal(calculated) - values["reported_nav"])
            except (ValueError, InvalidOperation):
                issues = [*issues, "CALCULATION_OUT_OF_RANGE"]
                calculated = difference = None
    outcome = (
        "insufficient_evidence"
        if issues or missing
        else "matched"
        if Decimal(difference).copy_abs() <= Decimal(scope["absolute_tolerance"])
        else "mismatch"
    )
    reason = (
        issues[0]
        if issues
        else f"MISSING_{missing[0].upper()}"
        if missing
        else "NAV_OUTSIDE_TOLERANCE"
        if outcome == "mismatch"
        else None
    )
    check_id, alignment_id = str(uuid4()), str(uuid4())
    fact_ids = [f["fact_id"] for f in facts]
    reported = money(values["reported_nav"]) if "reported_nav" in values else None
    if outcome == "insufficient_evidence":
        finding = (
            "The supplied pack cannot support a complete reconciliation. "
            + (f"Input issues: {', '.join(issues).lower().replace('_', ' ')}. " if issues else "")
            + (
                f"Missing or unresolved: {', '.join(missing).replace('_', ' ')}. "
                if missing
                else ""
            )
            + "Missing or unreliable amounts are not treated as zero."
        )
        action = "Request a corrected pack using the supported layout and all required values."
    elif outcome == "matched":
        finding = f"Calculated and reported NAV agree within {scope['currency']} {Decimal(scope['absolute_tolerance']):.2f}. The capital roll-forward and input alignment checks pass."
        action = "Review the cited source evidence. A mathematical match is separate from human approval."
    else:
        finding = f"Calculated NAV is {scope['currency']} {Decimal(difference).copy_abs():,.2f} {'below' if Decimal(difference) < 0 else 'above'} reported NAV, exceeding the {scope['currency']} {Decimal(scope['absolute_tolerance']):.2f} tolerance. The supplied documents do not explain the variance."
        action = "Ask the administrator to explain the variance or provide corrected figures."
    return {
        "outcome": outcome,
        "summary": {
            "reported_nav": reported,
            "calculated_nav": calculated,
            "difference": difference,
        },
        "facts": facts,
        "sources": [
            {
                "document_id": d["document_id"],
                "filename": d["filename"],
                "media_type": d["media_type"],
                "content_url": f"/api/v1/runs/{run_id}/sources/{d['document_id']}",
            }
            for d in snapshot["documents"]
        ],
        "checks": [
            {
                "check_id": alignment_id,
                "type": "input_alignment",
                "required": True,
                "status": "not_evaluated" if issues else "pass",
                "reason_code": issues[0] if issues else None,
                "input_fact_ids": fact_ids,
            },
            {
                "check_id": check_id,
                "type": "capital_roll_forward",
                "required": True,
                "status": "not_evaluated"
                if outcome == "insufficient_evidence"
                else "pass"
                if outcome == "matched"
                else "fail",
                "reason_code": reason,
                "expected_amount": calculated,
                "reported_amount": reported,
                "difference_amount": difference,
                "tolerance_amount": scope["absolute_tolerance"],
                "currency": scope["currency"],
                "input_fact_ids": fact_ids,
            },
        ],
        "commentary": [
            {
                "kind": "finding",
                "text": finding,
                "check_ids": [alignment_id, check_id],
                "fact_ids": fact_ids,
            },
            {"kind": "next_action", "text": action, "check_ids": [check_id], "fact_ids": []},
        ],
    }
