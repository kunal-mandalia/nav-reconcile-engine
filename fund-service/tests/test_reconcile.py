from decimal import Decimal

import pytest

from fund_service.reconcile import decide, extract, money, normalise
from fund_service.sources import digest, store


def snapshot(tmp_path, rows, *, header=None):
    data = (
        (header or "fund,period_start,period_end,currency,scale,field,value") + "\n" + rows
    ).encode()
    key = store(tmp_path, data)
    return {
        "fund": {"name": "Demo"},
        "inputs": {
            "period_start": "2026-04-01",
            "period_end": "2026-06-30",
            "currency": "USD",
            "absolute_tolerance": "0.010000",
        },
        "documents": [
            {
                "document_id": "test-doc",
                "role": "statement",
                "filename": "statement.csv",
                "media_type": "text/csv",
                "storage_key": key,
                "sha256": digest(data),
                "byte_size": len(data),
            }
        ],
    }


def test_exact_numbers_brackets_scales_and_precision():
    assert (
        money(Decimal("99999999999999999999999999999999.999999"))
        == "99999999999999999999999999999999.999999"
    )
    assert (
        normalise("9,007,199,254,740,993.000001", "opening_nav", "1")[0]
        == "9007199254740993.000001"
    )
    assert normalise("(4,000)", "distributions", "1000")[0] == "4000000.000000"
    assert normalise("(735,000)", "net_income", "1")[0] == "-735000.000000"
    assert normalise("0", "net_income", "1")[0] == "0.000000"


@pytest.mark.parametrize(
    "value",
    ["NaN", "Infinity", "1e3", "12,34", "0.0000001", "(-2)", "100000000000000000000000000000000"],
)
def test_reject_unsupported_amounts(value):
    with pytest.raises((ValueError, ArithmeticError)):
        normalise(value, "net_income", "1")


def test_bracketed_amount_does_not_round_before_precision_validation():
    # The nonzero tail is beyond the calculation context's 50 digits but within
    # the supported input length. It must not silently become exactly -1.
    raw = "(1." + "0" * 60 + "1)"
    with pytest.raises(ValueError, match="six decimal places"):
        normalise(raw, "net_income", "1")


@pytest.mark.parametrize(
    "reported,expected",
    [
        ("99.990000", "matched"),
        ("100.010000", "matched"),
        ("99.989999", "mismatch"),
        ("100.010001", "mismatch"),
    ],
)
def test_tolerance_uses_unrounded_difference(reported, expected):
    facts = [
        {"fact_id": str(i), "field": field, "amount": amount}
        for i, (field, amount) in enumerate(
            [
                ("opening_nav", "100.000000"),
                ("capital_calls", "0.000000"),
                ("distributions", "0.000000"),
                ("net_income", "0.000000"),
                ("reported_nav", reported),
            ]
        )
    ]
    result = decide(
        {"inputs": {"currency": "USD", "absolute_tolerance": "0.010000"}, "documents": []},
        "run",
        facts,
        [],
    )
    assert result["outcome"] == expected


def test_missing_currency_layout_and_conflicting_sources_need_input(tmp_path):
    snap = snapshot(tmp_path, "Demo,2026-04-01,2026-06-30,EUR,1,net_income,0\n")
    facts, issues = extract(snap, tmp_path)
    assert facts == [] and issues == ["INPUT_SCOPE_MISMATCH"]
    snap = snapshot(tmp_path, "Demo,2026-04-01,2026-06-30,USD,1,net_income,0\n" * 2)
    facts, issues = extract(snap, tmp_path)
    assert facts == [] and issues == ["CONFLICTING_SOURCES"]
    snap = snapshot(tmp_path, "data\n", header="unknown,columns")
    facts, issues = extract(snap, tmp_path)
    result = decide(snap, "run", facts, issues)
    assert result["outcome"] == "insufficient_evidence"
    assert result["summary"]["calculated_nav"] is None
    assert result["checks"][0]["reason_code"] == "UNSUPPORTED_LAYOUT"


def test_locator_is_csv_record_not_physical_line(tmp_path):
    snap = snapshot(
        tmp_path,
        'Demo,2026-04-01,2026-06-30,USD,1,net_income,"\n0"\nDemo,2026-04-01,2026-06-30,USD,1,reported_nav,1\n',
    )
    facts, issues = extract(snap, tmp_path)
    assert issues == []
    assert [f["locator"]["record_number"] for f in facts] == [1, 2]
    assert facts[0]["raw_text"] == "\n0"
