import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

SCHEMAS = json.loads(
    (Path(__file__).resolve().parents[2] / "packages/contracts/wire.schema.json").read_text()
)
VALIDATORS = {
    name: Draft202012Validator(schema, format_checker=FormatChecker())
    for name, schema in SCHEMAS.items()
}


def validate(name: str, payload: dict) -> dict:
    """Use the generated TypeScript wire contract, rather than duplicate DTO definitions."""
    VALIDATORS[name].validate(payload)
    return payload
