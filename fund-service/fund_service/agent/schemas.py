from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FieldName = Literal["opening_nav", "capital_calls", "distributions", "net_income", "reported_nav"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Candidate(StrictModel):
    """Source reading, not an accepted amount. Indices are one-based."""

    field: FieldName
    document_id: str
    raw_text: str = Field(
        max_length=80,
        pattern=r"^(?:[+-]?[0-9][0-9,.]*|\([0-9][0-9,.]*\))$",
        description="Only the original numeric token, including commas or accounting brackets. Never include the row label, currency or units.",
    )
    scale: Literal["1", "1000", "1000000"]
    # CSV: whole-file logical record + column. PDF: page + word index from read tool.
    record: int | None = Field(default=None, ge=1)
    column: int | None = Field(default=None, ge=1)
    page: int | None = Field(default=None, ge=1)
    word: int | None = Field(default=None, ge=1)


class Extraction(StrictModel):
    candidates: list[Candidate] = Field(max_length=40)
    issues: list[Literal["MISSING_INPUT", "AMBIGUOUS_LAYOUT", "INPUT_SCOPE_MISMATCH"]] = Field(
        default_factory=list, max_length=5
    )


class VisualFact(StrictModel):
    field: FieldName
    document_id: str
    page: int = Field(ge=1)
    raw_text: str = Field(
        max_length=80,
        pattern=r"^(?:[+-]?[0-9][0-9,.]*|\([0-9][0-9,.]*\))$",
        description="Only the original numeric token, including commas or accounting brackets. Never include the row label, currency or units.",
    )
    scale: Literal["1", "1000", "1000000"]


class VisualReading(StrictModel):
    # Blinded verifier must identify the same reporting scope independently.
    fund_name: str
    period_start: date = Field(description="Reporting period start as YYYY-MM-DD")
    period_end: date = Field(description="Reporting period end as YYYY-MM-DD")
    currency: str
    entity_scope: Literal["fund", "investor", "unknown"]
    facts: list[VisualFact] = Field(max_length=30)
    uncertain: bool


class CommentaryPlan(StrictModel):
    """Constrained claims; financial values and final prose are rendered in Python."""

    outcome: Literal["matched", "mismatch", "insufficient_evidence"]
    check_ids: list[str] = Field(max_length=2)
    fact_ids: list[str] = Field(max_length=5)
    next_action: Literal["review", "request_explanation", "resolve_inputs"]
