"""Conservative demo-layout gates: source bytes and arithmetic outrank model answers.

The LLM locates/maps values; these adapters validate those selections against the
known demo layouts. Unsupported context is Needs input, never inferred metadata.
"""

from collections import Counter, defaultdict
from datetime import date
from decimal import InvalidOperation
from uuid import uuid4

from ..reconcile import FIELDS, HEADER, ROLES, normalise
from .schemas import Extraction, VisualReading

LABELS = {
    "opening_nav": "Opening partners' capital",
    "capital_calls": "Capital funded during the quarter",
    "distributions": "Cash returned to partners",
    "net_income": "Net result for the period",
    "reported_nav": "Closing partners' capital",
}


def _csv(candidate, content, snapshot, doc):
    rows = [r["cells"] for r in content["records"]]
    if candidate.record is None or candidate.column is None or candidate.page or candidate.word:
        raise ValueError("CSV requires record and column only")
    row = rows[candidate.record - 1]
    if row[candidate.column - 1] != candidate.raw_text:
        raise ValueError("Raw amount does not match source cell")
    scope = snapshot["inputs"]
    if rows[0] == HEADER:
        if (
            candidate.column != 7
            or len(row) != 7
            or row[0] != snapshot["fund"]["name"]
            or row[1:4] != [scope["period_start"], scope["period_end"], scope["currency"]]
            or row[4] != candidate.scale
            or row[5] != candidate.field
            or candidate.field not in ROLES.get(doc["role"], set())
        ):
            raise ValueError("Fixed CSV scope/field mismatch")
        return {
            "kind": "csv",
            "record_number": candidate.record - 1,
            "column_name": "value",
            "column_index": 7,
        }
    # Known administrator layout only. Extending layout support is explicit.
    metadata_rows = [
        r for r in rows if r and r[0] in {"Reporting scope", "Period", "Currency / scale"}
    ]
    if Counter(r[0] for r in metadata_rows) != {
        "Reporting scope": 1,
        "Period": 1,
        "Currency / scale": 1,
    }:
        raise ValueError("Missing or duplicate reporting metadata")
    metadata = {r[0]: r[1:] for r in metadata_rows}
    if (
        rows[0] != [snapshot["fund"]["name"].upper()]
        or metadata.get("Reporting scope", [])[:1] != ["Whole fund"]
        or metadata.get("Period") != [scope["period_start"], scope["period_end"]]
        or metadata.get("Currency / scale")
        != [scope["currency"], "All monetary amounts below in thousands"]
        or candidate.scale != "1000"
        or candidate.column != 2
        or row[0] != LABELS[candidate.field]
    ):
        raise ValueError("Administrator CSV scope/field mismatch")
    # Inspect the complete current block, not just the row selected by the model.
    # An omitted competing amount or repeated current table cannot establish agreement.
    headers = [i for i, r in enumerate(rows) if r[:2] == ["Line item", "Current quarter"]]
    if len(headers) != 1:
        raise ValueError("Missing or ambiguous current-period table")
    start = headers[0] + 1
    end = next(
        (
            i
            for i in range(start, len(rows))
            if not rows[i] or rows[i][0] in {"Line item", "Account"}
        ),
        len(rows),
    )
    counts = Counter(r[0] for r in rows[start:end])
    if any(counts[label] != 1 for label in LABELS.values()):
        raise ValueError("Missing or duplicate figures in current-period table")
    if not start <= candidate.record - 1 < end:
        raise ValueError("Not the current whole-fund table")
    return {
        "kind": "csv_record",
        "version": 1,
        "record_index": candidate.record,
        "column_index": candidate.column,
        "column_name": "Current quarter",
    }


def _pdf(candidate, content, snapshot):
    if candidate.page is None or candidate.word is None or candidate.record or candidate.column:
        raise ValueError("PDF requires page and word only")
    page = content["pages"][candidate.page - 1]
    word = page["words"][candidate.word - 1]
    if word["text"] != candidate.raw_text:
        raise ValueError("Raw amount does not match PDF word")
    text = page["text"]
    scope = snapshot["inputs"]
    start, end = date.fromisoformat(scope["period_start"]), date.fromisoformat(scope["period_end"])
    period = f"{start.day} {start:%B} - {end.day} {end:%B %Y}"
    if (
        snapshot["fund"]["name"] not in text
        or f"Whole fund | {period}" not in text
        or f"Currency: {scope['currency']} | All table figures in thousands" not in text
        or candidate.scale != "1000"
    ):
        raise ValueError("PDF context is not a supported whole-fund schedule")
    words = page["words"]
    row_label = " ".join(
        w["text"]
        for w in words
        if abs(w["bbox"][1] - word["bbox"][1]) < 2 and w["bbox"][2] < word["bbox"][0]
    )
    if row_label != LABELS[candidate.field]:
        raise ValueError("PDF row label mismatch")
    quarter = f"Q{(end.month - 1) // 3 + 1}"
    header = next(w for w in words if w["text"] == quarter and w["bbox"][1] < word["bbox"][1])
    next_header = next(
        w
        for w in words
        if w["text"].startswith("Q")
        and w["bbox"][0] > header["bbox"][2]
        and abs(w["bbox"][1] - header["bbox"][1]) < 2
    )
    if not header["bbox"][0] <= word["bbox"][0] < word["bbox"][2] < next_header["bbox"][0]:
        raise ValueError("PDF value is not in the current-period column")
    return {
        "kind": "pdf",
        "page_number": candidate.page,
        "bbox": word["bbox"],
        "coordinate_system": "top_left_points",
    }


def validate_extraction(extraction: Extraction, reader):
    issues = list(extraction.issues)
    candidates = []
    counts = Counter((c.document_id, c.field) for c in extraction.candidates)
    for candidate in extraction.candidates:
        try:
            if candidate.document_id not in reader.read_ids:
                raise ValueError("Agent did not read cited file")
            if counts[candidate.document_id, candidate.field] != 1:
                raise ValueError("Duplicate field within source")
            content = reader.cache[candidate.document_id]["content"]
            locator = (
                _csv(candidate, content, reader.snapshot, reader.documents[candidate.document_id])
                if content["kind"] == "csv"
                else _pdf(candidate, content, reader.snapshot)
            )
            amount, steps = normalise(candidate.raw_text, candidate.field, candidate.scale)
            candidates.append(
                {
                    "fact_id": str(uuid4()),
                    "field": candidate.field,
                    "amount": amount,
                    "raw_text": candidate.raw_text,
                    "scale": candidate.scale,
                    "currency": reader.snapshot["inputs"]["currency"],
                    "document_id": candidate.document_id,
                    "locator": locator,
                    "normalisation_steps": steps,
                }
            )
        except (ValueError, KeyError, IndexError, StopIteration, InvalidOperation):
            issues.append("INVALID_SOURCE_CITATION")
    # Every file must be inspected; a model cannot quietly omit an inconvenient source.
    if reader.read_ids != set(reader.documents):
        issues.append("UNREAD_SOURCE")
    for doc_id in reader.read_ids:
        content = reader.cache[doc_id]["content"]
        if (
            content["kind"] == "csv"
            and content["records"]
            and content["records"][0]["cells"] == HEADER
        ):
            # Deterministically check every fixed-format source, including omitted rows.
            from ..reconcile import extract

            snapshot = {**reader.snapshot, "documents": [reader.documents[doc_id]]}
            expected, source_issues = extract(snapshot, reader.root)
            issues.extend(source_issues)
            if {(f["field"], f["amount"]) for f in expected} != {
                (f["field"], f["amount"]) for f in candidates if f["document_id"] == doc_id
            }:
                issues.append("EXTRACTION_DISAGREEMENT")
        elif {f["field"] for f in candidates if f["document_id"] == doc_id} != set(FIELDS):
            issues.append("MISSING_INPUT")
    by_field = defaultdict(list)
    for fact in candidates:
        by_field[fact["field"]].append(fact)
    accepted = []
    for field in FIELDS:
        values = by_field[field]
        if not values:
            continue
        if len({v["amount"] for v in values}) != 1:
            issues.append("CONFLICTING_SOURCES")
        else:
            # Prefer CSV cell provenance; all corroborating readings remain in the audit.
            accepted.append(min(values, key=lambda f: f["locator"]["kind"] == "pdf"))
    return accepted, sorted(set(issues)), candidates


def verify_visual(reading: VisualReading, candidates: list, snapshot: dict):
    scope = snapshot["inputs"]
    if (
        reading.uncertain
        or reading.fund_name != snapshot["fund"]["name"]
        or str(reading.period_start) != scope["period_start"]
        or str(reading.period_end) != scope["period_end"]
        or reading.currency != scope["currency"]
        or reading.entity_scope != "fund"
    ):
        return ["EXTRACTION_DISAGREEMENT"]
    expected = {
        (c["document_id"], c["field"]): c for c in candidates if c["locator"]["kind"] == "pdf"
    }
    actual = {}
    try:
        for value in reading.facts:
            key = (value.document_id, value.field)
            if key in actual or key not in expected:
                return ["EXTRACTION_DISAGREEMENT"]
            fact = expected[key]
            if value.page != fact["locator"]["page_number"] or value.scale != fact["scale"]:
                return ["EXTRACTION_DISAGREEMENT"]
            actual[key] = normalise(value.raw_text, value.field, value.scale)[0]
    except (ValueError, InvalidOperation):
        return ["EXTRACTION_DISAGREEMENT"]
    return (
        []
        if actual == {k: c["amount"] for k, c in expected.items()} and expected
        else ["EXTRACTION_DISAGREEMENT"]
    )
