"""Load multimodal-study-kit session bundles into pandas DataFrames.

>>> from mmstudykit import load_session
>>> s = load_session("session_abc123.zip")       # doctest: +SKIP
>>> s.streams["pointer.move"]                    # doctest: +SKIP

Pre-alpha. ``align`` and ``epochs`` arrive in M4.
"""

from __future__ import annotations

from ._loader import BundleError, Session, Streams, UnsupportedSchemaError, load_session
from ._version import FORMAT, SUPPORTED_SCHEMA_MAJOR, __version__, is_supported_schema

__all__ = [
    "FORMAT",
    "SUPPORTED_SCHEMA_MAJOR",
    "BundleError",
    "Session",
    "Streams",
    "UnsupportedSchemaError",
    "__version__",
    "is_supported_schema",
    "load_session",
]
