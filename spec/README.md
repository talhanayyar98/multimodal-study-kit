# Session bundle format

This folder is the **language-neutral contract** between the browser toolkit (which writes bundles) and any reader (the `mmstudykit` Python package, R scripts, your own tools).

| File                   | What it is                                                                   |
| ---------------------- | ---------------------------------------------------------------------------- |
| `manifest.schema.json` | JSON Schema (2020-12) for `manifest.json`, currently **v0.1.0 (draft)**      |
| `fixtures/`            | Example bundles. Both the TypeScript and Python test suites run against them |
| `upload-protocol.md`   | HTTP upload protocol for the upload sink (coming in M3)                      |

## Bundle layout

```
session_<sessionId>/
  manifest.json        self-describing metadata: IDs, consent record, clock, sensors, stream schemas + stats
  streams/
    <sensor>.<stream>.csv     regular numeric series
    <sensor>.<stream>.jsonl   irregular events with nested payloads
```

## Conventions

- Every stream's first column/key is `t`: **milliseconds since session start on one shared monotonic clock**.
- CSV: RFC 4180, UTF-8 (no BOM), LF, header row, snake_case column names, empty field = missing, booleans `0`/`1`.
- JSONL: one JSON object per line; keys are declared in the manifest like CSV columns.
- Manifest keys are camelCase; stream and column names are snake_case.
- `schemaVersion` is semver. Readers accept the same major version and ignore unknown fields. Until 1.0.0, minor versions may break compatibility (the changelog will say so).

The design rationale is in [`PLAN.md` §6](../PLAN.md#6-export-format).
