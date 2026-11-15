# mmstudykit (Python)

Load session bundles exported by [multimodal-study-kit](../../README.md) into pandas.

> **Pre-alpha.** `load_session` works (M1). `align` and `epochs` arrive in M4. See [`PLAN.md`](../../PLAN.md).

```python
from mmstudykit import load_session

s = load_session("session_abc123.zip")       # or the unzipped session_abc123/ folder
s.status                                     # 'completed', 'incomplete' or 'withdrawn'
list(s.streams)                              # ['session.events', 'task.markers', 'pointer.move', …]
s.streams["pointer.move"]                    # DataFrame; t = ms since session start, shared by all streams
s.markers                                    # task.markers: t, name, source, data
s.stream_info("pointer.move")["columns"]     # units and descriptions, straight from the manifest
s.manifest["consent"]["decisions"]           # the full manifest is a dict
```

Column types come from the manifest: `number` → `float64`, `integer` → `Int64`, `boolean` →
`boolean`, `enum` → `category` (with the declared categories), `string` → `string`, and nested
`object` values (JSONL streams only) stay Python dicts. Missing values are `NA`. In CSV files only an empty
field counts as missing, so a string such as `"NA"` stays a string.

Streams load on first access and are cached. A zip is read in place, without extracting it.

## Development

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
mypy && pytest
```

`tests/test_roundtrip.py` reads bundles written by the TypeScript exporter. Run it through
`pnpm roundtrip` from the repository root.
