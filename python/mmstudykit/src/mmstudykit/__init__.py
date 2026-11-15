"""Load multimodal-study-kit session bundles into pandas DataFrames.

Pre-alpha: this release only defines the format constants. ``load_session`` lands in M1.
"""

from __future__ import annotations

__all__ = ["FORMAT", "SUPPORTED_SCHEMA_MAJOR", "__version__", "is_supported_schema"]

__version__ = "0.0.0"

#: Value of ``manifest["format"]`` for every session bundle.
FORMAT = "mmstudykit.session"

#: Manifest major schema version this reader understands. Readers accept any manifest with the
#: same major version and ignore unknown fields (see spec/README.md).
SUPPORTED_SCHEMA_MAJOR = 0


def is_supported_schema(schema_version: str) -> bool:
    """Return True if a manifest with this ``schemaVersion`` can be read by this package."""
    major, _, _ = schema_version.partition(".")
    return major.isdigit() and int(major) == SUPPORTED_SCHEMA_MAJOR
