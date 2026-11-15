"""Read a session bundle (folder or zip) into pandas DataFrames, typed from the manifest."""

from __future__ import annotations

import io
import json
import os
import zipfile
from collections.abc import Iterator, Mapping
from pathlib import Path, PurePosixPath
from typing import Any

import pandas as pd

from ._version import FORMAT, SUPPORTED_SCHEMA_MAJOR, is_supported_schema

__all__ = ["BundleError", "Session", "UnsupportedSchemaError", "load_session"]

Manifest = dict[str, Any]
StreamInfo = dict[str, Any]


class BundleError(ValueError):
    """The path is not a readable session bundle, or a file disagrees with the manifest."""


class UnsupportedSchemaError(BundleError):
    """The manifest's major ``schemaVersion`` is not one this reader understands."""


class _Source:
    """Read files of one bundle, from a folder or a zip, by bundle-relative POSIX path."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._zip: zipfile.ZipFile | None = None
        self._prefix = ""
        self._root: Path | None = None
        if path.is_dir():
            self._root = self._find_dir_root(path)
        elif zipfile.is_zipfile(path):
            self._zip = zipfile.ZipFile(path)
            self._prefix = self._find_zip_prefix(self._zip)
        else:
            raise BundleError(f"{path} is neither a session folder nor a zip file")

    @staticmethod
    def _find_dir_root(path: Path) -> Path:
        if (path / "manifest.json").is_file():
            return path
        candidates = [p for p in path.iterdir() if (p / "manifest.json").is_file()]
        if len(candidates) == 1:
            return candidates[0]
        raise BundleError(f"no manifest.json in {path} (or in exactly one subfolder)")

    @staticmethod
    def _find_zip_prefix(zf: zipfile.ZipFile) -> str:
        manifests = [n for n in zf.namelist() if PurePosixPath(n).name == "manifest.json"]
        if "manifest.json" in manifests:
            return ""
        top_level = [n for n in manifests if len(PurePosixPath(n).parts) == 2]
        if len(top_level) == 1:
            return top_level[0][: -len("manifest.json")]
        raise BundleError("zip must contain one manifest.json at its root or in one top-level folder")

    def read(self, relpath: str) -> bytes:
        parts = PurePosixPath(relpath).parts
        if not parts or ".." in parts or PurePosixPath(relpath).is_absolute():
            raise BundleError(f"unsafe path in manifest: {relpath!r}")
        if self._zip is not None:
            try:
                return self._zip.read(self._prefix + relpath)
            except KeyError:
                raise BundleError(f"missing file in bundle: {relpath}") from None
        assert self._root is not None
        target = self._root.joinpath(*parts)
        if not target.is_file():
            raise BundleError(f"missing file in bundle: {relpath}")
        return target.read_bytes()

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()


def _dtype_for(column: Mapping[str, Any]) -> Any:
    kind = column["type"]
    if kind == "number":
        return "float64"
    if kind == "integer":
        return "Int64"
    if kind == "boolean":
        return "boolean"
    if kind == "string":
        return "string"
    if kind == "enum":
        return pd.CategoricalDtype(categories=list(column["enumValues"]))
    return "object"


def _read_csv(data: bytes, info: StreamInfo) -> pd.DataFrame:
    columns = info["columns"]
    names = [c["name"] for c in columns]
    # Empty field = missing (and only that): don't let pandas turn "NA" or "null" into NaN.
    df = pd.read_csv(
        io.BytesIO(data),
        dtype={c["name"]: _dtype_for(c) for c in columns if c["type"] not in ("boolean",)},
        keep_default_na=False,
        na_values=[""],
        encoding="utf-8",
    )
    if list(df.columns) != names:
        raise BundleError(f"{info['file']}: header {list(df.columns)} does not match manifest {names}")
    for c in columns:
        if c["type"] == "boolean":
            # 0/1 → nullable boolean (read as Int64 first so empty fields stay missing).
            df[c["name"]] = df[c["name"]].astype("Int64").astype("boolean")
    return df


def _read_jsonl(data: bytes, info: StreamInfo) -> pd.DataFrame:
    columns = info["columns"]
    names = [c["name"] for c in columns]
    records = [json.loads(line) for line in data.decode("utf-8").splitlines() if line.strip()]
    df = pd.DataFrame.from_records(records, columns=names) if records else pd.DataFrame(columns=names)
    for c in columns:
        dtype = _dtype_for(c)
        if dtype == "object":
            continue
        if dtype == "boolean":
            df[c["name"]] = df[c["name"]].astype("boolean")
        elif dtype == "float64":
            df[c["name"]] = pd.to_numeric(df[c["name"]], errors="raise").astype("float64")
        else:
            df[c["name"]] = df[c["name"]].astype(dtype)
    return df


class Streams(Mapping[str, pd.DataFrame]):
    """Stream name → DataFrame. Each stream is read on first access, then cached."""

    def __init__(self, source: _Source, infos: list[StreamInfo]) -> None:
        self._source = source
        self._infos = {s["name"]: s for s in infos}
        self._cache: dict[str, pd.DataFrame] = {}

    def __getitem__(self, name: str) -> pd.DataFrame:
        if name not in self._cache:
            info = self._infos.get(name)
            if info is None:
                raise KeyError(f"{name!r} is not in this bundle (have: {', '.join(self._infos)})")
            data = self._source.read(info["file"])
            reader = _read_csv if info["format"] == "csv" else _read_jsonl
            self._cache[name] = reader(data, info)
        return self._cache[name]

    def __iter__(self) -> Iterator[str]:
        return iter(self._infos)

    def __len__(self) -> int:
        return len(self._infos)

    def __repr__(self) -> str:
        return f"Streams({list(self._infos)})"


class Session:
    """One exported session: its manifest and its streams.

    Every stream's ``t`` column is milliseconds since session start on the session clock, so
    streams can be joined on ``t`` directly.
    """

    def __init__(self, source: _Source, manifest: Manifest) -> None:
        self._source = source
        self.manifest: Manifest = manifest
        self.streams = Streams(source, list(manifest.get("streams", [])))

    @property
    def path(self) -> Path:
        return self._source.path

    @property
    def id(self) -> str:
        return str(self.manifest["session"]["id"])

    @property
    def participant_id(self) -> str:
        return str(self.manifest["session"]["participantId"])

    @property
    def status(self) -> str:
        """``completed``, ``incomplete`` or ``withdrawn`` (withdrawn bundles have no streams)."""
        return str(self.manifest["session"]["status"])

    @property
    def markers(self) -> pd.DataFrame:
        """Task markers (``task.markers``); empty if there are none."""
        return self._stream_or_empty("task.markers", ["t", "name", "source", "data"])

    @property
    def events(self) -> pd.DataFrame:
        """Session lifecycle events (``session.events``); empty if there are none."""
        return self._stream_or_empty("session.events", ["t", "type", "data"])

    def stream_info(self, name: str) -> StreamInfo:
        """The manifest entry of a stream: columns with units and descriptions, stats, …"""
        for info in self.manifest.get("streams", []):
            if info["name"] == name:
                return dict(info)
        raise KeyError(name)

    def close(self) -> None:
        self._source.close()

    def __enter__(self) -> Session:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _stream_or_empty(self, name: str, columns: list[str]) -> pd.DataFrame:
        if name in self.streams:
            return self.streams[name]
        return pd.DataFrame(columns=columns)

    def __repr__(self) -> str:
        return f"Session(id={self.id!r}, participant_id={self.participant_id!r}, status={self.status!r}, streams={len(self.streams)})"


def load_session(path: str | os.PathLike[str]) -> Session:
    """Open a session bundle: a ``session_<id>/`` folder, or a ``session_<id>.zip``.

    The manifest is read and checked immediately; streams are read on first access.

    Raises:
        BundleError: not a bundle, or files disagree with the manifest.
        UnsupportedSchemaError: the manifest's major schema version isn't supported.
    """
    source = _Source(Path(path))
    try:
        manifest = json.loads(source.read("manifest.json").decode("utf-8"))
    except json.JSONDecodeError as e:
        source.close()
        raise BundleError(f"manifest.json is not valid JSON: {e}") from None
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        source.close()
        raise BundleError(f"not a {FORMAT} manifest")
    version = str(manifest.get("schemaVersion", ""))
    if not is_supported_schema(version):
        source.close()
        raise UnsupportedSchemaError(
            f"schemaVersion {version!r} is not supported (this reader supports {SUPPORTED_SCHEMA_MAJOR}.x)"
        )
    return Session(source, manifest)
