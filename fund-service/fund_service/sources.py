import hashlib
import os
from pathlib import Path
from uuid import uuid4

from .errors import SourceFailure


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def store(root: Path, data: bytes) -> str:
    """Content-addressed, write-once storage. DB manifests never hold caller paths."""
    root.mkdir(parents=True, exist_ok=True)
    key = digest(data)
    target = root / key
    if target.exists():
        if digest(target.read_bytes()) != key:
            raise SourceFailure(
                "SOURCE_INTEGRITY_FAILED", "Stored source does not match its manifest."
            )
        return key
    temporary = root / f".{uuid4()}.tmp"
    try:
        with temporary.open("xb") as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        temporary.chmod(0o444)
        # Link rather than overwrite; another importer may have stored identical bytes.
        try:
            os.link(temporary, target)
        except FileExistsError:
            if digest(target.read_bytes()) != key:
                raise SourceFailure(
                    "SOURCE_INTEGRITY_FAILED", "Stored source failed integrity validation."
                )
    finally:
        temporary.unlink(missing_ok=True)
    return key


def read(root: Path, document: dict) -> bytes:
    key = document["storage_key"]
    if len(key) != 64 or any(c not in "0123456789abcdef" for c in key):
        raise SourceFailure(
            "SOURCE_INTEGRITY_FAILED", "Source manifest contains an invalid storage key."
        )
    try:
        data = (root / key).read_bytes()
    except OSError as error:
        raise SourceFailure(
            "SOURCE_UNAVAILABLE", "An original source file is unavailable."
        ) from error
    if len(data) != document["byte_size"] or digest(data) != document["sha256"]:
        raise SourceFailure(
            "SOURCE_INTEGRITY_FAILED", "Original source bytes no longer match the frozen manifest."
        )
    return data
