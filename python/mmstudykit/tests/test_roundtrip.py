"""Cross-language round trip: bundles written by the TypeScript exporter, read here.

The TypeScript side (`pnpm roundtrip`, also a CI job) writes zips plus an `expected.json` with the
exact rows it emitted into $MMSK_ROUNDTRIP_DIR. These tests check that pandas sees exactly those
values, with the types the manifest declares. Without the variable they're skipped, unless
MMSK_REQUIRE_ROUNDTRIP=1 (set in CI), in which case a missing directory fails.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from mmstudykit import load_session

ROUNDTRIP_DIR = os.environ.get("MMSK_ROUNDTRIP_DIR")
REQUIRED = os.environ.get("MMSK_REQUIRE_ROUNDTRIP") == "1"

if not ROUNDTRIP_DIR and not REQUIRED:
    pytest.skip("set MMSK_ROUNDTRIP_DIR (pnpm roundtrip does) to run", allow_module_level=True)


def bundles() -> list[Path]:
    assert ROUNDTRIP_DIR, "MMSK_ROUNDTRIP_DIR is required (MMSK_REQUIRE_ROUNDTRIP=1)"
    found = sorted(Path(ROUNDTRIP_DIR).glob("*.zip"))
    assert found, f"no bundles in {ROUNDTRIP_DIR}"
    return found


def normalize(value: Any) -> Any:
    """Make a pandas cell comparable with the JSON value the exporter wrote."""
    if value is None or value is pd.NA or (isinstance(value, float) and math.isnan(value)):
        return None
    if hasattr(value, "item"):  # numpy scalars
        return value.item()
    return value


@pytest.mark.parametrize("path", bundles(), ids=lambda p: p.name)
def test_bundle_loads_with_manifest_types(path: Path) -> None:
    s = load_session(path)
    assert s.status in {"completed", "withdrawn", "incomplete"}
    for name in s.streams:
        info = s.stream_info(name)
        df = s.streams[name]
        assert list(df.columns) == [c["name"] for c in info["columns"]], name
        assert len(df) == info["stats"]["count"], name
        assert df["t"].dtype == "float64", name
        assert df["t"].is_monotonic_increasing, name
        if len(df):
            assert df["t"].iloc[0] == pytest.approx(info["stats"]["firstT"]), name
            assert df["t"].iloc[-1] == pytest.approx(info["stats"]["lastT"]), name
        for col in info["columns"]:
            dtype = str(df[col["name"]].dtype)
            expected = {"number": "float64", "integer": "Int64", "boolean": "boolean", "string": "string", "enum": "category", "object": "object"}[col["type"]]
            assert dtype == expected or (expected == "string" and dtype.startswith("string")), (name, col["name"], dtype)


@pytest.mark.parametrize("path", [p for p in bundles() if p.with_suffix(".expected.json").exists()], ids=lambda p: p.name)
def test_values_match_what_typescript_emitted(path: Path) -> None:
    expected: dict[str, list[dict[str, Any]]] = json.loads(path.with_suffix(".expected.json").read_text("utf-8"))
    s = load_session(path)
    assert set(expected) <= set(s.streams)
    for name, rows in expected.items():
        info = s.stream_info(name)
        precision = {c["name"]: c.get("precision") for c in info["columns"]}
        df = s.streams[name]
        assert len(df) == len(rows), name
        for i, row in enumerate(rows):
            for key, want in row.items():
                got = normalize(df[key].iloc[i])
                # CSV has no empty-string/missing distinction: an empty string reads back as missing.
                if info["format"] == "csv" and want == "":
                    want = None
                if isinstance(want, float) and got is not None:
                    places = precision.get(key)
                    tol = 0.5 * 10 ** -places + 1e-9 if places is not None else 1e-9
                    assert abs(got - want) <= tol, (name, i, key, got, want)
                else:
                    assert got == want, (name, i, key, got, want)
