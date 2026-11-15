# Vanilla example

A complete study page without a framework, in about 150 lines ([`src/main.ts`](src/main.ts)):
consent generated from the configured sensors, then a reading task with areas of interest, then
finish (downloads the zip) or withdraw. Reloading the page mid-task resumes the same session.

```sh
pnpm install
pnpm --filter @mmstudykit/core --filter @mmstudykit/sensors build
pnpm --filter @mmstudykit/example-vanilla dev
# open the printed URL with ?pid=P001
```

Then load the downloaded zip in Python:

```python
from mmstudykit import load_session
s = load_session("session_….zip")
s.streams["keyboard.keystrokes"]
```

`test/e2e.test.ts` drives this page in Chromium: consent, reading, clicking, typing (including
into a password field), a reload, then finish. It checks the downloaded bundle against the schema
and checks that none of the typed text is in it.
