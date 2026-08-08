## What & why

<!-- One or two sentences: the behavior change and the reason for it. Link the
issue if there is one. -->

## Checklist

- [ ] `npm test` passes (all 13 suites)
- [ ] New behavior ships with a test (regression coverage for bug fixes)
- [ ] Docs updated where affected (README / DEPLOY / CHANGELOG / `docs/`)
- [ ] Backward compatibility preserved — `fundgraph` alias, `FUNDGRAPH_*` env
      vars, and existing `./data` directories still work; older databases
      still open (migration added if the shape changed)
- [ ] Scores stay deterministic; no LLM in the relationship-scoring path
- [ ] Privacy/auth boundaries intact (touched a read path? the leak probe
      still passes)

## Notes

<!-- Anything reviewers should know: tradeoffs, follow-ups, out-of-scope bits. -->
