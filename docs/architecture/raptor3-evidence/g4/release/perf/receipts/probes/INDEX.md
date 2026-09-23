# Probe index — which file is which attempt

Every attempt is kept. None was relabelled or deleted.

| Version | Probe | Runner | Samples / summary | Status |
| --- | --- | --- | --- | --- |
| v1 | `seam-probe-v1.mjs` | (the v1 form of `seam-run.mjs`) | `seam-samples-v1-ordering-confound.json`, `seam-summary-v1-ordering-confound.json` | superseded — both seams in one process, ordering confound (`README-v1.md`) |
| v2 | `seam-probe.mjs` | `seam-run.mjs` | `seam-samples-v2.json`, `seam-summary-v2.json` | superseded — one seam per process, own bare fixture; did not reproduce the series |
| v3 | `seam-probe-v3.mjs` | `seam-run-v3.mjs` | `seam-samples-v3.json`, `seam-summary-v3.json` | superseded — the series' own setup; still did not reproduce it |
| v4 | `seam-probe-v4.mjs` | `seam-run-v4.mjs` | `seam-samples-v4.json`, `seam-summary-v4.json` | superseded — per-stage-kind loop; closer, still not it |
| **v5** | `seam-probe-v5.mjs` | `seam-run-v5.mjs` | `seam-samples-v5.json`, `seam-summary-v5.json` | **the one the note reads** for the three read cells — the worker's method exactly |
| **v6** | `seam-probe-v6.mjs` | `seam-run-v6.mjs` | `seam-samples-v6.json`, `seam-summary-v6.json` | **the repair round** (review F2): v5's method with `bulk-update-returning-100` added to `OPERATIONS`, the statement-arm loop kind taken from the catalog instead of hardcoded sync (this cell declares `prepare` async), and the side order alternated per pair. v6 is a copy of v5, not an edit of it, so v5's receipts keep their provenance |

Other receipts here:

| File | What it is |
| --- | --- |
| `gc-sensitivity.txt` | the v4 → v5 finding, measured: the forced collection after warmup, three runs per side |
| `statement-count-probe.mjs`, `count__<workload>__<side>.json/.err` | statements per PUBLIC operation, counted at `driver.execute` |
| `flat-scalar-update-probe.mjs`, `fsu-publish-*.json`, `fsu-full-summary.json` | what each engine publishes for `flat-scalar-update`, and the end-to-end evidence the un-adapted frozen harness does not retain (note §4.2) |

`count__flat-scalar-update__cand.json` is empty and its `.err` holds the
refusal: that is the receipt of §4.2, not a failed run to retry.
