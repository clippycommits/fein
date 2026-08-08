---
name: Bug report
about: Something isn't working the way it should
title: ""
labels: bug
assignees: ""
---

**What happened**
A clear, short description of the bug.

**Expected**
What you expected instead.

**Repro**
Steps to reproduce — ideally the exact commands. If it involves ingestion, the
source type helps (`.mbox` / `.ics` / `.csv` / `.jsonl`, a live connector, or
extraction).

```
$ fein ...
```

**Environment**
- fein version (`package.json` / dashboard footer):
- Node version (`node -v`):
- Storage: embedded PGlite (default) or `DATABASE_URL` Postgres:
- OS:

**Logs / output**
Relevant terminal output or server logs. Scrub anything sensitive — do not
paste real relationship data or tokens.

> If this is a security or privacy-leak issue, do **not** file it here — email
> security@fein.vc instead (see SECURITY.md).
