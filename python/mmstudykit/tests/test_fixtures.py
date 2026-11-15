"""Format-conformance tests against the shared fixtures in spec/fixtures.

The same fixtures are validated against the JSON Schema by the TypeScript test suite, so these
tests pin down that a Python reader sees what the manifest promises.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

import mmstudykit

FIXTURES = Path(__file__).resolve().parents[3] / "spec" / "fixtures"
FIXTURE_DIRS = sorted(p.parent for p in FIXTURES.glob("*/manifest.json"))


def load_manifest(bundle: Path) -> dict[str, Any]:
    manifest: dict[str, Any] = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    return manifest


def test_fixtures_exist() -> None:
    assert {p.name for p in FIXTURE_DIRS} >= {"minimal", "withdrawn"}


@pytest.mark.parametrize("bundle", FIXTURE_DIRS, ids=lambda p: p.name)
def test_manifest_is_supported(bundle: Path) -> None:
    manifest = load_manifest(bundle)
    assert manifest["format"] == mmstudykit.FORMAT
    assert mmstudykit.is_supported_schema(manifest["schemaVersion"])


@pytest.mark.parametrize("bundle", FIXTURE_DIRS, ids=lambda p: p.name)
def test_streams_match_manifest(bundle: Path) -> None:
    manifest = load_manifest(bundle)
    for stream in manifest["streams"]:
        path = bundle / stream["file"]
        declared = [c["name"] for c in stream["columns"]]
        if stream["format"] == "csv":
            df = pd.read_csv(path)
        else:
            df = pd.read_json(path, lines=True)
        assert list(df.columns) == declared, stream["name"]
        assert len(df) == stream["stats"]["count"], stream["name"]
        assert df["t"].iloc[0] == pytest.approx(stream["stats"]["firstT"])
        assert df["t"].iloc[-1] == pytest.approx(stream["stats"]["lastT"])
        assert df["t"].is_monotonic_increasing, stream["name"]


def test_withdrawn_bundle_has_no_streams() -> None:
    manifest = load_manifest(FIXTURES / "withdrawn")
    assert manifest["session"]["status"] == "withdrawn"
    assert manifest["streams"] == []
    assert manifest["consent"]["withdrawal"] is not None


@pytest.mark.parametrize(
    ("version", "expected"),
    [("0.1.0", True), ("0.9.3", True), ("1.0.0", False), ("", False), ("x.1.0", False)],
)
def test_is_supported_schema(version: str, expected: bool) -> None:
    assert mmstudykit.is_supported_schema(version) is expected
