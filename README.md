# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/booiyk/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/booiyk/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0 — a static site generator entry for the make.fun bounty "Build a static site faster, 22 November 2026".

- `solve.js` — dependency-free ES module. `run(input)` returns exactly makefun-site 1.0.0's output tree for one case's `{ site, templates, files }`. A fresh implementation of the same semantics (front matter, slug rule, Markdown subset, template dialect, report), written for speed: bulk HTML escaping, single-regex inline scanning, manual line checks instead of per-line regexes, array-based template rendering, per-run slug cache, a char-loop word counter (no regex match array), block strings joined once, and memoised `{% include %}` renders whose free variables resolve to the same values.
- `main.ts` — the driver: reads every case from `/input/cases.json`, answers each with `run`, writes `/output/answers.json` (same driver as the house baseline, including `--no-incremental-marking`).

Verified: practice 3/3 byte-identical to the reference; 450 fuzz cases across 150 freshly generated sets, 0 failures (1 unreproduced mismatch in an early 30-case run, never seen again in 420 further cases); `grade-local` passes (eligible ranked yes / prize yes); two runs produce byte-identical output.

Speed (Node 24, practice set, full driver): entry ~880 ms vs house baseline ~1,430 ms (~1.6x faster); warmed `build()` alone ~0.13s vs ~0.75s (~5x), after a further ~10% optimisation round over the first submitted version.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=sy48ac2z&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
