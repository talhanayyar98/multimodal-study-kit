# Session bundle format

This folder is the **language-neutral contract** between the browser toolkit (which writes bundles) and any reader (the `mmstudykit` Python package, R scripts, your own tools).

| File                   | What it is                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| `manifest.schema.json` | JSON Schema (2020-12) for `manifest.json`, currently **v0.1.0 (draft)**      |
| `fixtures/`            | Example bundles. Both the TypeScript and Python test suites run against them |
| `upload-protocol.md`   | HTTP upload protocol for the upload sink (coming in M3)                      |

## Bundle layout

```
session_<sessionId>/              the zip (session_<sessionId>.zip) contains this folder
  manifest.json        self-describing metadata: IDs, consent record, clock, sensors, stream schemas + stats
  streams/
    session.events.jsonl      always present: start, segments, pauses, discontinuities, sensor errors, end
    task.markers.jsonl        always present: mark() / markOnNextFrame() markers
    <sensor>.<stream>.csv     regular numeric series and flat events
    <sensor>.<stream>.jsonl   irregular events with nested payloads
```

Every stream listed in `manifest.streams` has a file, even if it has no rows (CSV: header only;
JSONL: empty). A withdrawn session's bundle is the manifest alone, with `streams: []`.

## Conventions

- Every stream's first column/key is `t`: **milliseconds since session start on one shared monotonic clock**. Rows in every file are in non-decreasing `t` order.
- CSV: RFC 4180, UTF-8 (no BOM), LF line endings (fields may contain quoted CR/LF), header row, snake_case column names, booleans `0`/`1`.
  - An **empty field means missing**. An empty string can't be distinguished from missing in CSV (pandas and R read both the same way), so writers write empty strings as missing. Only an empty field is missing: `NA` or `null` are ordinary strings.
  - Numbers with a declared `precision` are written with exactly that many decimals. Others use the shortest form that round-trips, which can include an exponent (`1e-7`).
- JSONL: one JSON object per line, with every declared key present (`null` = missing). Numbers with a declared `precision` are rounded to it.
- Manifest keys are camelCase; stream and column names are snake_case.
- `stats.intervalMs` (sample streams only) summarizes the intervals between consecutive `t`: `sd` is the sample standard deviation (n − 1), and `p50`/`p95` use linear interpolation (numpy's default).
- Zip entries all carry the timestamp 1980-01-01 00:00. Zip timestamps are local time, so real ones would reveal the participant's timezone, which the manifest deliberately omits.
- `schemaVersion` is semver. Readers accept the same major version and ignore unknown fields. Until 1.0.0, minor versions may break compatibility (the changelog will say so).

The design rationale is in [`PLAN.md` §6](../PLAN.md#6-export-format).
