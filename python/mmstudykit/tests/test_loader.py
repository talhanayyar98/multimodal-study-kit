"""load_session against the shared fixtures and hand-made edge cases."""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import pandas as pd
import pytest

from mmstudykit import BundleError, UnsupportedSchemaError, load_session

FIXTURES = Path(__file__).resolve().parents[3] / "spec" / "fixtures"


def zip_folder(folder: Path, dest: Path, *, prefix: str) -> Path:
    with zipfile.ZipFile(dest, "w") as zf:
        for f in sorted(folder.rglob("*")):
            if f.is_file():
                zf.write(f, prefix + f.relative_to(folder).as_posix())
    return dest


def test_folder_bundle_types_columns_from_the_manifest() -> None:
    s = load_session(FIXTURES / "minimal")
    assert s.id == "s-0001"
    assert s.participant_id == "P001"
    assert s.status == "completed"
    assert list(s.streams) == ["pointer.move", "task.markers"]

    move = s.streams["pointer.move"]
    assert list(move.columns) == ["t", "x", "y", "pointer_type", "pointer_id", "buttons", "coalesced"]
    assert move["t"].dtype == "float64"
    assert str(move["pointer_id"].dtype) == "Int64"
    assert str(move["coalesced"].dtype) == "boolean"
    assert isinstance(move["pointer_type"].dtype, pd.CategoricalDtype)
    assert list(move["pointer_type"].cat.categories) == ["mouse", "pen", "touch"]
    assert move["coalesced"].tolist() == [False, True, True, False, False, True]
    assert move["t"].iloc[-1] == pytest.approx(1082.5)

    markers = s.markers
    assert markers["name"].tolist() == ["stimulus_onset", "response"]
    assert markers["data"].iloc[1] == {"itemId": 3, "choice": "B"}
    assert s.streams["pointer.move"] is move  # cached


@pytest.mark.parametrize("prefix", ["", "session_s-0001/"])
def test_zip_bundle_with_or_without_top_level_folder(tmp_path: Path, prefix: str) -> None:
    path = zip_folder(FIXTURES / "minimal", tmp_path / "bundle.zip", prefix=prefix)
    with load_session(path) as s:
        assert len(s.streams["pointer.move"]) == 6
        assert s.stream_info("pointer.move")["stats"]["count"] == 6


def test_parent_folder_with_one_session(tmp_path: Path) -> None:
    shutil.copytree(FIXTURES / "minimal", tmp_path / "session_s-0001")
    assert load_session(tmp_path).id == "s-0001"


def test_withdrawn_bundle_has_no_streams() -> None:
    s = load_session(FIXTURES / "withdrawn")
    assert s.status == "withdrawn"
    assert len(s.streams) == 0
    assert s.markers.empty
    assert list(s.markers.columns) == ["t", "name", "source", "data"]


def test_missing_values_strings_and_empty_files(tmp_path: Path) -> None:
    bundle = tmp_path / "b"
    shutil.copytree(FIXTURES / "minimal", bundle)
    manifest = json.loads((bundle / "manifest.json").read_text())
    manifest["streams"][0]["columns"].append(
        {"name": "label", "type": "string", "unit": None, "description": "x"}
    )
    manifest["streams"][0]["stats"]["count"] = 2
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    (bundle / "streams" / "pointer.move.csv").write_text(
        "t,x,y,pointer_type,pointer_id,buttons,coalesced,label\n"
        '1.000,,2.0,,,,,NA\n'
        '2.000,1.5,,touch,3,0,1,"a,""b"""\n'
    )
    (bundle / "streams" / "task.markers.jsonl").write_text("")
    s = load_session(bundle)
    move = s.streams["pointer.move"]
    assert pd.isna(move["x"].iloc[0]) and move["x"].iloc[1] == 1.5
    assert pd.isna(move["pointer_type"].iloc[0])
    assert pd.isna(move["coalesced"].iloc[0]) and bool(move["coalesced"].iloc[1]) is True
    # "NA" is a string, not missing: only empty fields are missing.
    assert move["label"].tolist() == ["NA", 'a,"b"']
    assert s.markers.empty and list(s.markers.columns) == ["t", "name", "source", "data"]


def test_rejects_header_mismatch(tmp_path: Path) -> None:
    bundle = tmp_path / "b"
    shutil.copytree(FIXTURES / "minimal", bundle)
    (bundle / "streams" / "pointer.move.csv").write_text("t,y,x\n1,2,3\n")
    with pytest.raises(BundleError, match="does not match manifest"):
        _ = load_session(bundle).streams["pointer.move"]


def test_rejects_unsupported_major_version(tmp_path: Path) -> None:
    bundle = tmp_path / "b"
    shutil.copytree(FIXTURES / "minimal", bundle)
    manifest = json.loads((bundle / "manifest.json").read_text())
    manifest["schemaVersion"] = "1.0.0"
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(UnsupportedSchemaError):
        load_session(bundle)


def test_rejects_unsafe_paths(tmp_path: Path) -> None:
    bundle = tmp_path / "b"
    shutil.copytree(FIXTURES / "minimal", bundle)
    manifest = json.loads((bundle / "manifest.json").read_text())
    manifest["streams"][0]["file"] = "../../etc/passwd"
    (bundle / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(BundleError, match="unsafe path"):
        _ = load_session(bundle).streams["pointer.move"]


def test_rejects_non_bundles(tmp_path: Path) -> None:
    (tmp_path / "x.txt").write_text("hi")
    with pytest.raises(BundleError):
        load_session(tmp_path / "x.txt")
    with pytest.raises(BundleError):
        load_session(tmp_path)


def test_unknown_stream_name_lists_what_exists() -> None:
    with pytest.raises(KeyError, match="pointer.move"):
        _ = load_session(FIXTURES / "minimal").streams["face.headpose"]
