"""Naive whole-file readers. No search, index, crop, or ranged tools are registered."""

import csv
import io
import json
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium
from pdfminer.pdfparser import PDFSyntaxError

from .. import sources
from ..errors import SourceFailure

MAX_BYTES = 2_000_000
MAX_TEXT = 40_000
MAX_PAGES = 6
MAX_RECORDS = 500
MAX_IMAGE_BYTES = 8_000_000


class WholeFileReader:
    def __init__(self, snapshot: dict, root: Path):
        self.snapshot, self.root = snapshot, root
        self.documents = {d["document_id"]: d for d in snapshot["documents"]}
        self.cache = {}
        self.read_ids = set()

    def read_file(self, document_id: str):
        """Return a complete bounded file, with stable source coordinates and PDF images."""
        if document_id not in self.documents:
            raise SourceFailure("SOURCE_ACCESS_DENIED", "The document is outside this run's pack.")
        if document_id in self.cache:
            self.read_ids.add(document_id)
            return self.cache[document_id]
        doc = self.documents[document_id]
        if doc["byte_size"] > MAX_BYTES:
            raise SourceFailure(
                "WHOLE_FILE_LIMIT",
                "File exceeds the whole-file reader limit. Ranged reads are not implemented.",
            )
        data = sources.read(self.root, doc)
        images = []
        try:
            if doc["media_type"] == "text/csv":
                records = list(
                    csv.reader(io.StringIO(data.decode("utf-8-sig"), newline=""), strict=True)
                )
                if len(records) > MAX_RECORDS:
                    raise SourceFailure(
                        "WHOLE_FILE_LIMIT",
                        "Too many CSV records; ranged reads are not implemented.",
                    )
                content = {
                    "kind": "csv",
                    "records": [{"record": i, "cells": row} for i, row in enumerate(records, 1)],
                }
            elif doc["media_type"] == "application/pdf":
                pages = []
                with pdfplumber.open(io.BytesIO(data)) as pdf:
                    if len(pdf.pages) > MAX_PAGES:
                        raise SourceFailure(
                            "WHOLE_FILE_LIMIT",
                            "Too many PDF pages; ranged reads are not implemented.",
                        )
                    for i, page in enumerate(pdf.pages, 1):
                        if page.width > 1200 or page.height > 1200 or page.rotation:
                            raise SourceFailure(
                                "UNSUPPORTED_LAYOUT",
                                "This reader supports small, unrotated PDF pages only.",
                            )
                        words = [
                            {
                                "word": n,
                                "text": w["text"],
                                "bbox": [round(w[k], 3) for k in ("x0", "top", "x1", "bottom")],
                            }
                            for n, w in enumerate(page.extract_words(), 1)
                        ]
                        pages.append(
                            {
                                "page": i,
                                "width": page.width,
                                "height": page.height,
                                "text": page.extract_text() or "",
                                "words": words,
                            }
                        )
                if not any(p["text"] for p in pages):
                    raise SourceFailure(
                        "SEARCHABLE_PDF_REQUIRED",
                        "Image-only PDF verification is outside this demo policy.",
                    )
                content = {"kind": "pdf", "pages": pages}
                # Check text volume before allocating rendered pages.
                self._check_text(content)
                with pdfium.PdfDocument(data) as pdf:
                    for page in pdf:
                        try:
                            bitmap = page.render(scale=1.5)
                            try:
                                out = io.BytesIO()
                                bitmap.to_pil().save(out, format="PNG")
                                images.append(out.getvalue())
                            finally:
                                bitmap.close()
                        finally:
                            page.close()
            else:
                raise SourceFailure(
                    "UNSUPPORTED_LAYOUT", "Only CSV and searchable PDF files are supported."
                )
        except (UnicodeError, csv.Error, PDFSyntaxError, pdfium.PdfiumError, ValueError) as error:
            raise SourceFailure(
                "SOURCE_DECODE_FAILED", "A source file could not be decoded."
            ) from error
        self._check_text(content)
        if sum(len(i) for i in images) > MAX_IMAGE_BYTES:
            raise SourceFailure("WHOLE_FILE_LIMIT", "Rendered file exceeds the image budget.")
        # Aggregate pack bounds prevent many individually small files overflowing context.
        size = len(json.dumps(content))
        if sum(c["characters"] for c in self.cache.values()) + size > MAX_TEXT:
            raise SourceFailure(
                "WHOLE_FILE_LIMIT",
                "Pack exceeds the whole-file context budget; ranged reads are not implemented.",
            )
        if sum(len(c["images"]) for c in self.cache.values()) + len(images) > MAX_PAGES:
            raise SourceFailure("WHOLE_FILE_LIMIT", "Pack exceeds the whole-file page budget.")
        result = {"content": content, "images": images, "characters": size}
        self.cache[document_id] = result
        self.read_ids.add(document_id)
        return result

    @staticmethod
    def _check_text(content):
        if len(json.dumps(content)) > MAX_TEXT:
            raise SourceFailure(
                "WHOLE_FILE_LIMIT",
                "File exceeds the whole-file text budget; ranged reads are not implemented.",
            )


class RangedReaderPlaceholder:
    """Future index → section → ranged read implementation; intentionally NOT an agent tool."""

    def read_range(self, *args, **kwargs):
        raise NotImplementedError(
            "Interview extension: index documents, then read cited record/page ranges."
        )
