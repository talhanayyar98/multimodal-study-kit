# mmstudykit (Python)

Load session bundles exported by [multimodal-study-kit](../../README.md) into pandas.

> **Pre-alpha.** M0 ships the package skeleton and format-conformance tests. `load_session` lands in M1; `align` and `epochs` in M4. See [`PLAN.md`](../../PLAN.md).

```python
from mmstudykit import load_session            # M1
s = load_session("session_abc123/")            # or .zip
s.streams["face.headpose"]                     # DataFrame, t = session ms
s.align(["face.blendshapes", "pointer.move"], rate_hz=30)   # M4
s.epochs(marker="stimulus_onset", window=(-500, 3000))      # M4
```

## Development

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest
```
