# Final local release index — final local closure

Assembled 2026-09-21T12:16:18.786Z by `scripts/closure-final-index.mjs` from `docs/architecture/raptor3-evidence/g4/release/closure-final/gate`.
Raw logs are copied verbatim under `logs/`; nothing here is recomputed or
reconstructed.

## 1. Source identity

- commit: `b5fde8c1eec56992eaadd898c72e462a191151e5`
- head: b5fde8c1eec56992eaadd898c72e462a191151e5 2026-09-21T13:55:17+02:00 fix(raptor3): the third arm whose probe let go — a nested to-one upsert demands its target's keys
- calibration source identity: `cb7f60efd02ac772b1670d8100048beacba2bd1466d2e03b4c009fc380f3e874`
- scope: src/, benchmarks/, scripts/, package.json, pnpm-lock.yaml, tsconfig.json, tsdown.config.ts, biome.jsonc — the existing calibration owner
- working tree at assembly: 

```
M CONTEXT.md
 M docs/architecture/raptor3-evidence/g4/final-report.md
 M docs/architecture/raptor3-evidence/g4/release/closure/fc00/inventory.md
 M docs/architecture/raptor3-final-closure-handoff.md
 M docs/architecture/raptor3-implementation-plan.md
 M features-docs/recursive-query.md
 M memory.md
?? docs/architecture/raptor3-evidence/baseline.json
?? docs/architecture/raptor3-evidence/calibration-protocol.json.gz
?? docs/architecture/raptor3-evidence/calibration-transport-diagnostic.json.gz
?? docs/architecture/raptor3-evidence/calibration-v1-scalar-find-unique-cold-prepare-1.json.gz
?? docs/architecture/raptor3-evidence/calibration-v1-scalar-find-unique-prepare-1.json.gz
?? docs/architecture/raptor3-evidence/calibration-v1-scalar-find-unique-prepare-2.json.gz
?? docs/architecture/raptor3-evidence/calibration-v1-scalar-full-1.json.gz
?? docs/architecture/raptor3-evidence/g0-contract-evidence-checkpoint.tar.gz
?? docs/architecture/raptor3-evidence/g0-contract-evidence.tar.gz
?? docs/architecture/raptor3-evidence/g0.json
?? docs/architecture/raptor3-evidence/g1-closure-cost.json
?? docs/architecture/raptor3-evidence/g1-closure-evidence.tar.gz
?? docs/architecture/raptor3-evidence/g1-closure-index.json
?? docs/architecture/raptor3-evidence/g1-comparison-evidence.tar.gz
?? docs/architecture/raptor3-evidence/g1-comparison-index.json
?? docs/architecture/raptor3-evidence/g1-cost.json
?? docs/architecture/raptor3-evidence/g1-expanded-cost.json
?? docs/architecture/raptor3-evidence/g1-expanded-evidence.tar.gz
?? docs/architecture/raptor3-evidence/g1-expanded-index.json
?? docs/architecture/raptor3-evidence/g2-closure-evidence.tar.gz
?? docs/architecture/raptor3-evidence/g2-closure-index.json
?? docs/architecture/raptor3-evidence/g2-closure-runs.log
?? docs/architecture/raptor3-evidence/g2-cost.json
?? docs/architecture/raptor3-evidence/g25-closure-evidence.tar.gz
?? docs/architecture/raptor3-evidence/g25-closure-index.json
?? docs/architecture/raptor3-evidence/g25-closure-runs.log
?? docs/architecture/raptor3-evidence/g25-compression-cost.json
?? docs/architecture/raptor3-evidence/g25-compression-index.json
?? docs/architecture/raptor3-evidence/g25-compression-runs.log
?? docs/architecture/raptor3-evidence/g25-cost.json
?? docs/architecture/raptor3-evidence/g27-baseline-cost.json
?? docs/architecture/raptor3-evidence/g27-closure-evidence.sha256
?? docs/architecture/raptor3-evidence/g27-closure-evidence.tar.gz
?? docs/architecture/raptor3-evidence/g27-closure-index.json
?? docs/architecture/raptor3-evidence/g27-closure-runs.log
?? docs/architecture/raptor3-evidence/g27-cost.json
?? docs/architecture/raptor3-evidence/g27-unit2-red.json
?? docs/architecture/raptor3-evidence/g3-prep-01/final-snapshot.json
?? docs/architecture/raptor3-evidence/g3-prep-01/g3-prep-01-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-01/g3-prep-01-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-01/g3-prep-01-replay-overlay.json.gz
?? docs/architecture/raptor3-evidence/g3-prep-01/initial-snapshot.json
?? docs/architecture/raptor3-evidence/g3-prep-01/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-02-final/g3-prep-02-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-02-final/g3-prep-02-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-02-final/g3-prep-02-index.json
?? docs/architecture/raptor3-evidence/g3-prep-02-final/g3-prep-02-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-02-final/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-02/g3-prep-02-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-02/g3-prep-02-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-02/g3-prep-02-index.json
?? docs/architecture/raptor3-evidence/g3-prep-02/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-03-review-repair/g3-prep-03-repair-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-03-review-repair/g3-prep-03-repair-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-03-review-repair/g3-prep-03-repair-index.json
?? docs/architecture/raptor3-evidence/g3-prep-03-review-repair/g3-prep-03-repair-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-03-review-repair/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-03/g3-prep-03-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-03/g3-prep-03-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-03/g3-prep-03-index.json
?? docs/architecture/raptor3-evidence/g3-prep-03/g3-prep-03-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-03/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair-02/g3-prep-04-repair-02-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair-02/g3-prep-04-repair-02-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair-02/g3-prep-04-repair-02-index.json
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair-02/g3-prep-04-repair-02-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair-02/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair/g3-prep-04-repair-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair/g3-prep-04-repair-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair/g3-prep-04-repair-index.json
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair/g3-prep-04-repair-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-04-review-repair/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-04/g3-prep-04-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-04/g3-prep-04-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-04/g3-prep-04-index.json
?? docs/architecture/raptor3-evidence/g3-prep-04/g3-prep-04-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-04/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-05-review-repair/g3-prep-05-repair-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-05-review-repair/g3-prep-05-repair-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-05-review-repair/g3-prep-05-repair-index.json
?? docs/architecture/raptor3-evidence/g3-prep-05-review-repair/g3-prep-05-repair-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-05-review-repair/g3-prep-05-repair-recursive-metrics.json
?? docs/architecture/raptor3-evidence/g3-prep-05-review-repair/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-05/g3-prep-05-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-05/g3-prep-05-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-05/g3-prep-05-index.json
?? docs/architecture/raptor3-evidence/g3-prep-05/g3-prep-05-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-05/g3-prep-05-recursive-metrics.json
?? docs/architecture/raptor3-evidence/g3-prep-05/receipts/
?? docs/architecture/raptor3-evidence/g3-prep-06/corpora/
?? docs/architecture/raptor3-evidence/g3-prep-06/g3-prep-06-SHA256SUMS
?? docs/architecture/raptor3-evidence/g3-prep-06/g3-prep-06-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-06/g3-prep-06-index.json
?? docs/architecture/raptor3-evidence/g3-prep-06/g3-prep-06-matched-cost.json
?? docs/architecture/raptor3-evidence/g3-prep-06/receipts/
?? docs/architecture/raptor3-evidence/g3/unit03/trial100/sqlite-c11-red/generated-failure-158.json
?? docs/architecture/raptor3-evidence/g3/unit03/trial100/transport-c08-red/generated-failure-144.json
?? docs/architecture/raptor3-evidence/g3/unit03/trial100/transport-c11-red/generated-failure-182.json
?? docs/architecture/raptor3-evidence/g3/unit03/trial20/sqlite-green/generated-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit03/trial20/transport-green/generated-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/cs03-extension-a-seeds/receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/cs03-extension-b-seeds/receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/cs03-extension-composition-seeds/receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-3jxvBm.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-3jxvBm.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-3koGK5.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-3koGK5.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-3stXbF.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-3stXbF.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-4d5sKS.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-4d5sKS.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-5hpiZx.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-5hpiZx.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-5ldDMK.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-5ldDMK.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-5rlK9P.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-5rlK9P.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-6UrtnI.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-6UrtnI.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-8QY2XL.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-8QY2XL.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-8pmvrB.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-8pmvrB.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-92NaNH.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-92NaNH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-9NKR40.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-9NKR40.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-9R0sHK.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-9R0sHK.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-AFJo6o.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-AFJo6o.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-DTRfYo.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-DTRfYo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-DjHHAi.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-DjHHAi.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-HgZhzL.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-HgZhzL.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-HqN1Ck.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-HqN1Ck.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-JMejZr.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-JMejZr.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-JYQy7s.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-JYQy7s.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-KcMnUY.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-KcMnUY.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-PKiias.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-PKiias.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-Q7G4tZ.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-Q7G4tZ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-QVzwqI.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-QVzwqI.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ScJhuW.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ScJhuW.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-StTsMB.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-StTsMB.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-TyAcHr.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-TyAcHr.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-UNsQZj.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-UNsQZj.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-Yk8PP7.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-Yk8PP7.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ZmQmd6.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ZmQmd6.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-beyQeJ.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-beyQeJ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-d1FA69.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-d1FA69.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-d31kLm.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-d31kLm.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-hEBFD4.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-hEBFD4.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ia2QUa.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ia2QUa.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ija99D.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ija99D.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-jqxXdh.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-jqxXdh.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-kDB2iP.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-kDB2iP.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-knWpL1.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-knWpL1.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-mX6jN6.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-mX6jN6.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-oOXWe9.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-oOXWe9.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-pogww5.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-pogww5.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-t0zIHm.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-t0zIHm.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-tfuNKX.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-tfuNKX.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ulz1fE.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-ulz1fE.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-v5FXXu.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-v5FXXu.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-vvPBdu.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-vvPBdu.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-y8KTe2.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-y8KTe2.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-yhIUGo.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-yhIUGo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-yy8pTH.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-seeds/viborm-raptor3-g0-yy8pTH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-0Qbu6d.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-0Qbu6d.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-0YbrUO.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-0YbrUO.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-3Le0W0.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-3Le0W0.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-5DaipC.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-5DaipC.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-5jKNyY.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-5jKNyY.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-5xbrOz.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-5xbrOz.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-6dTx8p.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-6dTx8p.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-76RwDJ.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-76RwDJ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-8EfQzG.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-8EfQzG.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-B4v1Kk.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-B4v1Kk.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-COLpak.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-COLpak.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-DAcATG.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-DAcATG.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-F0BkVp.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-F0BkVp.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-FDTZMj.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-FDTZMj.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-FlW1eL.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-FlW1eL.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ItMXfg.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ItMXfg.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-J9V7gN.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-J9V7gN.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-JAps2v.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-JAps2v.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-LDgQe5.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-LDgQe5.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-LTCkkh.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-LTCkkh.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-QbmbFE.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-QbmbFE.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-RWaVsw.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-RWaVsw.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-TLJCMU.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-TLJCMU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-TSwAk7.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-TSwAk7.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-Vsrv1Y.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-Vsrv1Y.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-X638eQ.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-X638eQ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ZJSu1z.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ZJSu1z.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-aoPqoz.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-aoPqoz.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-c2JQFW.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-c2JQFW.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-cJ6NpN.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-cJ6NpN.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-cdLOf8.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-cdLOf8.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-eGDYeA.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-eGDYeA.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ey8Hdo.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ey8Hdo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-g2gBO3.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-g2gBO3.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-hTqumg.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-hTqumg.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-iaTRfx.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-iaTRfx.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-imCw3f.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-imCw3f.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-nXNQSB.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-nXNQSB.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-p4TEup.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-p4TEup.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-p9Z66m.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-p9Z66m.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-reXArE.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-reXArE.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-t3jyOW.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-t3jyOW.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-tDsPx0.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-tDsPx0.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-tZZzRD.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-tZZzRD.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-txepgH.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-txepgH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-wXoNnp.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-wXoNnp.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-xkALjP.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-xkALjP.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ypo4WH.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-ypo4WH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-zWbLTI.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-zWbLTI.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-zrrYTt.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g2-transport-seeds/viborm-raptor3-g0-zrrYTt.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-0ooQo8.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-1GV2Rt.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-26GPy0.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-3oNjWi.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-4EWr6d.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-4oZj9C.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-5sq7Is.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-63kRmL.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-6eDHlN.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-7R7OPA.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-7ajzT4.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-7iCoZk.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-98C1p7.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-9Hnymz.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-9pcte7.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-Aqe6b3.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-Aqh70c.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-B1oQpy.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-BeKwKw.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-DKqvxm.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-Dw9gRe.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-FDJq7b.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-FPKunq.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-GNvv5K.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-GxWfni.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-Hx2KV8.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-JQOUYU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-Jpdwfu.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-M0f79w.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-MJElyn.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-N2Yp2d.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-N3hKaX.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-NTmwUe.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-P6Zbpu.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-P7CO2C.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-PnPGSQ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-QGfV6Y.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-QVSaDC.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-QeOtKR.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-QonFjk.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-R7yB3T.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-REWoOM.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-RxqtNR.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-SSRpc9.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-SUF1n7.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-TKkD5y.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-Tna73u.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-TuxNob.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-UsXD06.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-VUJIU7.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-XSXDeQ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-XbTBJZ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-YIFL3T.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-YNcyK0.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-YsvcFc.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-YwoSfd.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-Zvwhvq.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-azN0d2.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-bLIVRo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-bMh3SG.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-d0FZCD.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-dP3r3G.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-dYubtA.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-f6e84K.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-gADk2w.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-hAlso6.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-hK4UAt.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-hNnCww.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-hSzx7j.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-hUFOpe.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-i91U2a.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-iKpt7C.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-iRRaMt.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-jmaEiy.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-jmvZQw.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-k5bM0M.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-k6WLsr.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-kkZBfa.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-lbIprW.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-lxzKat.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-nXJBNT.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-oNiFfo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-r2dZob.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-s0VFt6.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-sDj3DQ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-tKCFBU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-tN2X8n.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-ufUEDs.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-vemHgs.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-vmC7Pu.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-vmxvsF.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-wfWZwY.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-x0QC9l.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-x0T7VU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-yQkyUC.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-yRTVUP.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-yVER6H.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-yySyER.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-yzwcFn.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-seeds/viborm-raptor3-g0-zE4FQl.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-01AbnV.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-1G0NaN.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-2WdnIu.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-31FTwW.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-3FJy0M.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-4WvX6a.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-4q4RA9.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-4tPDUo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-55BGsy.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-5PsP1a.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-5cP6DV.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-6BsCv4.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-7X5zzh.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-7hUJHK.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-8Q4Iew.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-8ZpFvD.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-8e6o9j.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-BH0YTl.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-BRekjk.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-DbKj6F.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-EI405S.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-FbV3JD.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Fysyqo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-GaS1kD.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-HP7Pdd.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Hv46Sd.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-JDlgQ6.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-JScR7v.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-JWNrjS.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Jt44IV.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-KhEw76.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-KpTJLf.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-KxciZO.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-LbOxJH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-LgD5S6.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-MDFleU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-MK8tD1.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-MZI8CU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-NL8KaN.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-NYkXLz.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Ni3mWl.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Nn4qsU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-NnE4Y2.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-OOlgN1.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-OxHeaU.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-P0pEhH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-PKSpWm.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Pwxc57.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Qbhzp2.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-QnAHas.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-RJIoHn.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-RTJUuH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-SUNpaB.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-SzeBuf.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-U5xjXN.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-VYfdFk.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Vw5rET.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-X34Gti.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-X91oCo.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Xg1nmr.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Y73sc0.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Ywixm6.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-ZWygIV.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Zezcak.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-Zo9s2P.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-bTSegN.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-c9itHZ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-cXyjPq.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-ckTttb.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-eDq5N5.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-ec9o6t.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-egRgxi.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-ehthUH.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-ejeeNq.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-hnYlkK.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-k7YavD.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-k8eUSO.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-kKOsIB.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-kXszBG.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-muYOtf.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-nPoUqK.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-o8sNSs.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-oCScev.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-pXK2xR.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-qVzxBG.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-rAnygy.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-rHWvnh.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-rhLiij.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-s3Be6r.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-sewNOV.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-t3PYlJ.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-tlVwgr.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-uDb2Cb.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-uf5ism.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-uoZOAW.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-v1AiBr.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-va4GSI.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-vq6Mr8.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-wCTbxm.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3-transport-seeds/viborm-raptor3-g0-wFIohG.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3p06-seeds/viborm-raptor3-g0-47GCCq.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3p06-seeds/viborm-raptor3-g0-47GCCq.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3p06-transport-seeds/viborm-raptor3-g0-WwLIj5.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/campaigns/g3p06-transport-seeds/viborm-raptor3-g0-WwLIj5.receipt/generated-campaign-progress.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g0.receipt/corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-compare.receipt/adjudicated-instance-admission-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-contracts.receipt/adjudicated-upsert-admission-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-contracts.receipt/cleanup-sqlite-atomic-batch-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-contracts.receipt/cleanup-sqlite-interactive-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-generated.receipt/shrink-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-lost-progress-scripted-returning-ack-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-lost-progress-scripted-returning-weak-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-multifault-scripted-returning-ack-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-multifault-scripted-returning-weak-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-overlap-scripted-returning-ack-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-overlap-scripted-returning-weak-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-wrong-publication-scripted-returning-ack-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g1-transport.receipt/transport-wrong-publication-scripted-returning-weak-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-baseline.receipt/g2-conditional-upsert-legacy-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-baseline.receipt/g2-junction-identity-legacy-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-baseline.receipt/g2-membership-own-write-legacy-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-baseline.receipt/g2-mixed-key-transitions-legacy-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-baseline.receipt/g2-own-write-legacy-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-baseline.receipt/g2-shared-key-suppliers-legacy-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-baseline.receipt/g2-variant-removals-legacy-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-conditional-upsert-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-junction-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-junction-identity-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-key-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-lattice-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-membership-own-write-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-mixed-key-transitions-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-occupied-keys-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-own-write-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-required-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-series-staleness-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-shared-key-suppliers-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-singular-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-staleness-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-supplier-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-contracts.receipt/g2-variant-removals-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-generated.receipt/g2-generated-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g2-transport.receipt/g2-transport-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/fixed/g25-contracts.receipt/g25-polish-corpus.json
?? docs/architecture/raptor3-evidence/g3/unit04/structural-measurement/work-copy-path.txt
?? docs/architecture/raptor3-evidence/g4/release/closure-final/gate/
?? docs/architecture/raptor3-evidence/g4/release/closure-final/perf/
?? docs/architecture/raptor3-evidence/g4/release/closure-final/receipts/
?? docs/architecture/raptor3-evidence/g4/release/closure-final/recount/
?? docs/architecture/raptor3-local-release-finish.md
?? exa-results/raptor3-code-reduction-2026-09-01.md
?? exa-results/raptor3-orm-pattern-audit-2026-09-07.md
?? transport-lost-progress-scripted-returning-ack-corpus.json
?? transport-lost-progress-scripted-returning-weak-corpus.json
?? transport-multifault-scripted-returning-ack-corpus.json
?? transport-multifault-scripted-returning-weak-corpus.json
?? transport-overlap-scripted-returning-ack-corpus.json
?? transport-overlap-scripted-returning-weak-corpus.json
?? transport-wrong-publication-scripted-returning-ack-corpus.json
?? transport-wrong-publication-scripted-returning-weak-corpus.json
```


## 2. Harness identity

- registered test files: 663
- harness identity: `7daded95c7a9e96e810c096c3da8e95cab3a2d726b1ec132574cbb58bce04264`

| manifest module | sha256 |
| --- | --- |
| `scripts/raptor3-manifest.mjs` | `0c5cbdf1f3c68304af2753ded37495c63f9e8a65658c6b1e8100587fe4e5a645` |
| `scripts/credential-free-test-manifest.mjs` | `99696bf1d759ea6fe6d63eacd125b5489731ffac0edcf431fb463d1b4df63d7a` |
| `scripts/client-test-manifest.mjs` | `428020660c3028dd2eb36ce722d9eb9e692c779a19fd0b154edb43c761a47a28` |
| `scripts/driver-test-manifest.mjs` | `2a027df21d54fd332332764646b6b9680faa888751583ad9b9281ecb8a5ca8e0` |
| `scripts/migration-test-manifest.mjs` | `28b01fa5f8b0bd45c3c151d7df456b903894660cbcbbba15a9b57fff60e28a5c` |
| `scripts/query-engine-test-manifest.mjs` | `bca818458f2bd9284d7836db3c6e83b57a96801b48b634ce0978654f7d9ed81a` |

## 3. Runtime and dependency identity

- node: `v24.21.0` (v8 `13.6.233.17-node.53`, darwin/arm64)
- pnpm: `10.11.0`, `packageManager`: `pnpm@10.11.0`
- `pnpm-lock.yaml`: `c366c9806e268e19970626c34e0c5ea1bb74cc7c24b388fa072d580d7bf9aceb`
- `package.json`: `2dd00d97b15fdd2ae20a4fa054bd1befa7fad7c8e18bb2331e7264d90e32961a`

## 4. Gate stages

| stage | exit | test files | tests | resources / teardown | log sha256 |
| --- | --- | --- | --- | --- | --- |
| `build` | 0 | — | — | Node resources: 2.57s wall, 867.3 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `153ccb54d969cf3c…` |
| `campaign-receipts` | 0 | — | — | Node resources: 0.48s wall, 62.2 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `7e442838cb2d7ea6…` |
| `census` | 0 | — | — | — | `3a186c0bca7e0406…` |
| `conf-fk` | 0 | Test Files  1 passed (1) | Tests  28 passed (28) | Vitest resources: 4.53s wall, 1588.9 MiB peak sampled process-group RSS (sampled ceiling 2560 MiB, isolated PGlite provider). Teardown verified. | `3df8bcbefafe3d8b…` |
| `conf-m2m` | 0 | Test Files  1 passed (1) | Tests  34 passed (34) | Vitest resources: 6.02s wall, 1535.4 MiB peak sampled process-group RSS (sampled ceiling 2560 MiB, isolated PGlite provider). Teardown verified. | `54884647aea832bd…` |
| `conf-membership` | 0 | Test Files  1 passed (1) | Tests  30 passed (30) | Vitest resources: 6.66s wall, 1582.0 MiB peak sampled process-group RSS (sampled ceiling 2560 MiB, isolated PGlite provider). Teardown verified. | `073d629934b6f86f…` |
| `conf-root-dependency` | 0 | Test Files  1 passed (1) | Tests  30 passed (30) | Vitest resources: 5.22s wall, 1575.8 MiB peak sampled process-group RSS (sampled ceiling 2560 MiB, isolated PGlite provider). Teardown verified. | `bfdd3dad2dc505bd…` |
| `conf-to-one` | 0 | Test Files  1 passed (1) | Tests  19 passed (19) | Vitest resources: 4.79s wall, 1553.9 MiB peak sampled process-group RSS (sampled ceiling 2560 MiB, isolated PGlite provider). Teardown verified. | `6f0efb59fda3658f…` |
| `conf-transitive` | 0 | Test Files  1 passed (1) | Tests  31 passed (31) | Vitest resources: 5.05s wall, 1667.4 MiB peak sampled process-group RSS (sampled ceiling 2560 MiB, isolated PGlite provider). Teardown verified. | `87811ef5f49fa1b1…` |
| `coverage-policy` | 0 | — | — | Node resources: 6.70s wall, 310.7 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `fa05be1da1033685…` |
| `fixed` | 0 | Test Files  89 passed (89) | Tests  955 passed (955) | [test:all] Raptor 3 fixed contracts, harness falsifiers and candidate comparison: 14.12s wall, 60.7 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB, ordinary project). Teardown verified. | `f400c09955135a31…` |
| `g1-compare` | 0 | Test Files  4 passed (4) | Tests  36 passed (36) | Vitest resources: 3.60s wall, 589.1 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `2e195e0a748c0a64…` |
| `g2-baseline` | 0 | Test Files  16 passed (16) | Tests  216 passed (216) | Vitest resources: 4.61s wall, 711.6 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `6b4774a4d59574ad…` |
| `g2-contracts` | 0 | Test Files  16 passed (16) | Tests  216 passed (216) | Vitest resources: 5.93s wall, 757.4 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `8b08a64c390e9670…` |
| `mysql2__mysql-strict-mode-docker` | 0 | Test Files  1 passed (1) | Tests  8 passed (8) | Vitest resources: 3.85s wall, 510.1 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `c7d2671cb030c2a0…` |
| `mysql2__mysql2-cascaded-identity` | 0 | Test Files  1 passed (1) | Tests  4 passed (4) | Vitest resources: 3.30s wall, 480.0 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `dca7e4c109745ede…` |
| `mysql2__mysql2-concurrency-policy` | 0 | Test Files  1 passed (1) | Tests  11 passed (11) | Vitest resources: 4.53s wall, 615.8 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `52696e893692f73f…` |
| `mysql2__mysql2-generated-key` | 0 | Test Files  1 passed (1) | Tests  5 passed (5) | Vitest resources: 3.21s wall, 476.3 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `b9071373a41f2610…` |
| `mysql2__mysql2-read-surface` | 0 | Test Files  1 passed (1) | Tests  122 passed (122) | Vitest resources: 13.52s wall, 669.1 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `86b4eea64aef3927…` |
| `mysql2__mysql2-reference-representability` | 0 | Test Files  1 passed (1) | Tests  5 passed (5) | Vitest resources: 3.35s wall, 488.8 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `0e79e50eb016eb93…` |
| `mysql2__mysql2-relations-ddl` | 0 | Test Files  1 passed (1) | Tests  106 passed (106) | Vitest resources: 19.65s wall, 654.9 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `afcb04fc805a3f2d…` |
| `mysql2__mysql2-scalars` | 0 | Test Files  1 passed (1) | Tests  293 passed (293) | Vitest resources: 24.08s wall, 673.0 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `050c15f10d58957c…` |
| `mysql2__mysql2-schema-attestation` | 0 | Test Files  1 passed (1) | Tests  5 passed (5) | Vitest resources: 3.64s wall, 537.3 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `48472b2552aa3521…` |
| `mysql2__mysql2-writes-raw` | 0 | Test Files  1 passed (1) | Tests  92 passed (92) | Vitest resources: 15.65s wall, 642.3 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `cd76d36c3220d55b…` |
| `mysql2__mysql2` | 0 | Test Files  1 passed (1) | Tests  84 passed \| 1 skipped (85) | Vitest resources: 15.08s wall, 650.8 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `a474ae0034c85849…` |
| `parity-1` | 0 | Test Files  19 passed (19) | Tests  172 passed (172) | Vitest resources: 8.09s wall, 747.5 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `3a7d1ebdabc7c612…` |
| `parity-2` | 0 | Test Files  15 passed (15) | Tests  140 passed (140) | Vitest resources: 8.16s wall, 681.9 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `d35c1e007dde8feb…` |
| `parity-3` | 0 | Test Files  21 passed (21) | Tests  215 passed (215) | Vitest resources: 8.60s wall, 738.1 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `654156f313abbefa…` |
| `pg__pg-captured-set-concurrency` | 0 | Test Files  1 passed (1) | Tests  17 passed (17) | Vitest resources: 16.42s wall, 500.9 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `fbdff7eccde2e3c6…` |
| `pg__pg-nested-write-races` | 0 | Test Files  1 passed (1) | Tests  95 passed (95) | Vitest resources: 122.77s wall, 506.3 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `8b7fc11b81f7aebb…` |
| `pg__pg-polymorphism-ddl` | 0 | Test Files  1 passed (1) | Tests  60 passed (60) | Vitest resources: 105.52s wall, 497.9 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `1ca2fe15f0edeae9…` |
| `pg__pg-read-surface` | 0 | Test Files  1 passed (1) | Tests  76 passed (76) | Vitest resources: 91.79s wall, 507.7 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `48e0c8c7b9c7e162…` |
| `pg__pg-reference-representability` | 0 | Test Files  1 passed (1) | Tests  5 passed (5) | Vitest resources: 4.54s wall, 465.6 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `770eafe92f448640…` |
| `pg__pg` | 0 | Test Files  1 passed (1) | Tests  220 passed \| 7 skipped (227) | Vitest resources: 259.01s wall, 503.2 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `ff4ddbedeef76acc…` |
| `pglite-provider` | 0 | Test Files  3 passed (3) | Tests  7 passed (7) | Vitest resources: 5.09s wall, 1716.9 MiB peak sampled process-group RSS (sampled ceiling 2560 MiB, isolated PGlite provider). Teardown verified. | `43173572081c3f44…` |
| `transaction-array` | 0 | Test Files  1 passed (1) | Tests  4 passed (4) | Vitest resources: 3.12s wall, 481.7 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `16b11c4711494311…` |
| `transport-smoke` | 0 | Test Files  1 passed (1) | Tests  1 passed (1) | Vitest resources: 3.29s wall, 474.3 MiB peak sampled process-group RSS (sampled ceiling 1536 MiB). Teardown verified. | `7e7fab2de239bf5d…` |
| `typecheck` | 0 | — | — | — | `cb64b05914687a5e…` |

Every stage the summary recorded an exit code for has a log above.

## 5. Registered inventory

| list | files |
| --- | --- |
| `CLIENT_COVERAGE_TESTS` | 41 |
| `CS01_EXTENSION_A_TESTS` | 1 |
| `CS01_EXTENSION_B_TESTS` | 1 |
| `CS01_EXTENSION_COMPOSITION_TESTS` | 1 |
| `CS01_STRUCTURAL_REFERENCE_TESTS` | 1 |
| `CS02_REPEATED_OCCURRENCE_TESTS` | 1 |
| `CS02_STRUCTURE_MEASUREMENT_TESTS` | 1 |
| `CS03_EXTENSION_CAMPAIGN_TESTS` | 1 |
| `CS03_EXTENSION_SUPPORT_TESTS` | 2 |
| `CS03_MEMBER_SCOPE_TESTS` | 1 |
| `D50_PROVIDER_TESTS` | 2 |
| `D53_PROVIDER_TESTS` | 1 |
| `DRIVER_CORE_TESTS` | 43 |
| `DRIVER_COVERAGE_TESTS` | 59 |
| `EXTENDED_LOCAL_PGLITE_TESTS` | 12 |
| `EXTENDED_LOCAL_SHARED_FAMILY_TESTS` | 113 |
| `EXTENDED_LOCAL_TESTS` | 191 |
| `G0_FALSIFIERS` | 21 |
| `G1_BASELINE_TESTS` | 4 |
| `G1_CAMPAIGN_TESTS` | 1 |
| `G1_COMPARISON_TESTS` | 4 |
| `G1_CONTRACT_TESTS` | 5 |
| `G1_GENERATED_TESTS` | 2 |
| `G1_PROVIDER_BASELINE_TESTS` | 2 |
| `G1_PROVIDER_TESTS` | 3 |
| `G1_TRANSPORT_CAMPAIGN_TESTS` | 1 |
| `G1_TRANSPORT_TESTS` | 1 |
| `G2_BASELINE_TESTS` | 16 |
| `G2_CAMPAIGN_TESTS` | 1 |
| `G2_CONTRACT_TESTS` | 16 |
| `G2_DIAGNOSTIC_TESTS` | 1 |
| `G2_GENERATED_TESTS` | 2 |
| `G2_MYSQL_BASELINE_TESTS` | 4 |
| `G2_MYSQL_CONTRACT_TESTS` | 4 |
| `G2_PG_BASELINE_TESTS` | 6 |
| `G2_PG_CONTRACT_TESTS` | 6 |
| `G2_PROVIDER_BASELINE_TESTS` | 3 |
| `G2_PROVIDER_CONTRACT_TESTS` | 3 |
| `G2_TRANSPORT_CAMPAIGN_TESTS` | 1 |
| `G2_TRANSPORT_TESTS` | 1 |
| `G25_CONTRACT_TESTS` | 1 |
| `G25_PG_CONTRACT_TESTS` | 1 |
| `G27_CONTRACT_TESTS` | 1 |
| `G27_MYSQL_CONTRACT_TESTS` | 1 |
| `G27_PG_CONTRACT_TESTS` | 1 |
| `G29_DEPENDENCY_BOUNDARY_TESTS` | 1 |
| `G29_DEPENDENCY_CHOICE_TESTS` | 1 |
| `G29_MEMBER_DEPENDENCY_MYSQL_TESTS` | 1 |
| `G29_MEMBER_DEPENDENCY_PG_TESTS` | 1 |
| `G29_MEMBER_DEPENDENCY_TESTS` | 1 |
| `G29_RESULT_PROGRESS_TESTS` | 1 |
| `G3_AUTHOR_EXECUTION_REGRESSION_TESTS` | 1 |
| `G3_BULK_RESULT_BOUNDARY_TESTS` | 1 |
| `G3_BULK_SERIES_TESTS` | 1 |
| `G3_DEPTH_RECURRENCE_TESTS` | 1 |
| `G3_EXECUTION_REVIEW_TESTS` | 1 |
| `G3_GENERATED_CAMPAIGN_TESTS` | 1 |
| `G3_GENERATED_MINIMIZATION_TESTS` | 1 |
| `G3_GENERATED_SMOKE_TESTS` | 1 |
| `G3_GENERATED_TRANSPORT_CAMPAIGN_TESTS` | 1 |
| `G3_GENERATED_TRANSPORT_SMOKE_TESTS` | 1 |
| `G3_SCOPE_COMPOSITION_MYSQL_TESTS` | 1 |
| `G3_SCOPE_COMPOSITION_PG_TESTS` | 1 |
| `G3_SCOPE_FAILURE_TESTS` | 1 |
| `G3_SUPPRESSION_RETRY_TESTS` | 1 |
| `G3_TRANSACTION_ARRAY_TESTS` | 1 |
| `G3P02_CONTRACT_TESTS` | 1 |
| `G3P02_MYSQL_CONTRACT_TESTS` | 1 |
| `G3P02_PG_CONTRACT_TESTS` | 1 |
| `G3P03_CONTRACT_TESTS` | 1 |
| `G3P03_MYSQL_CONTRACT_TESTS` | 1 |
| `G3P03_PG_CONTRACT_TESTS` | 1 |
| `G3P04_CONTRACT_TESTS` | 1 |
| `G3P04_MYSQL_CONTRACT_TESTS` | 1 |
| `G3P04_PG_CONTRACT_TESTS` | 1 |
| `G3P04_REVIEW_CONTRACT_TESTS` | 1 |
| `G3P05_CONTRACT_TESTS` | 3 |
| `G3P05_RECURSIVE_READ_FIT_TESTS` | 1 |
| `G3P05_SELECTOR_DEPENDENCY_TESTS` | 1 |
| `G3P05_VARIANT_COLLECTION_ORDER_TESTS` | 1 |
| `G3P06_CAMPAIGN_TESTS` | 1 |
| `G3P06_TRANSPORT_CAMPAIGN_TESTS` | 1 |
| `G4_GENERATED_CAMPAIGN_TESTS` | 1 |
| `G4_GENERATED_TRANSPORT_CAMPAIGN_TESTS` | 1 |
| `G4_GENERATION_SELFTEST_TESTS` | 1 |
| `G4_NATIVE_MYSQL_TESTS` | 1 |
| `G4_NATIVE_PG_TESTS` | 1 |
| `G4_PARITY_TESTS` | 24 |
| `G4_READ_AGGREGATE_TESTS` | 1 |
| `G4_READ_CODEC_TESTS` | 1 |
| `G4_READ_CONTRACT_FAMILIES` | 5 |
| `G4_READ_FILTERS_TESTS` | 1 |
| `G4_READ_OPERATIONS_TESTS` | 1 |
| `G4_READ_ORDERING_TESTS` | 1 |
| `G4_READ_PAGINATION_TESTS` | 1 |
| `G4_READ_PROJECTION_TESTS` | 1 |
| `G4_READ_RECURSIVE_FIT_TESTS` | 1 |
| `G4_READ_SCHEMA_FAMILIES` | 3 |
| `G4_READ_TESTS` | 8 |
| `G4_UNIT01_AUTHOR_TESTS` | 10 |
| `G4_UNIT01_REVIEW_TESTS` | 29 |
| `G4_UNIT02_AUTHOR_TESTS` | 21 |
| `G4_UNIT02_MYSQL_TESTS` | 3 |
| `G4_UNIT02_PG_TESTS` | 1 |
| `G4_WRITE_CAMPAIGN_TESTS` | 1 |
| `G4_WRITE_TRANSPORT_CAMPAIGN_TESTS` | 1 |
| `LIBSQL_PROVIDER_TESTS` | 6 |
| `MIGRATION_COVERAGE_TESTS` | 120 |
| `PGLITE_PROVIDER_TESTS` | 6 |
| `POST_G3_CLEARABILITY_CONTRACT_TESTS` | 1 |
| `POST_G3_CLEARABILITY_MYSQL_CONTRACT_TESTS` | 1 |
| `POST_G3_CLEARABILITY_PG_CONTRACT_TESTS` | 1 |
| `POST_G3_HISTORY_ANALYSIS_TESTS` | 1 |
| `POST_G3_PROJECTION_PREPARATION_TESTS` | 1 |
| `POST_G3_SCHEMA_VIEW_TESTS` | 1 |
| `POST_G3_SELECTOR_PREPARATION_TESTS` | 1 |
| `QUERY_ENGINE_CORE_TESTS` | 32 |
| `RAPTOR3_DETERMINISTIC_TESTS` | 186 |
| `RAPTOR3_FIXED_LOCAL_TESTS` | 89 |
| `RAPTOR3_LIVE_PROVIDER_TESTS` | 29 |
| `RAPTOR3_PROJECT_TESTS` | 194 |
| `RAPTOR3_PROVIDER_TESTS` | 8 |
| `RAPTOR3_RUNNER_ONLY_TESTS` | 8 |
| `RAPTOR3_TESTS` | 2 |
| `SQLITE3_PROVIDER_TESTS` | 6 |
| `WRITE_ENGINE_CORE_TESTS` | 4 |
| `WRITE_ENGINE_COVERAGE_TESTS` | 5 |
| `WRITE_ENGINE_EXTENDED_COVERAGE_TESTS` | 1 |

| declared-cell map | cells |
| --- | --- |
| `CS01_EXTENSION_A_COUNTS` | 6 |
| `CS01_EXTENSION_B_COUNTS` | 4 |
| `CS01_EXTENSION_COMPOSITION_COUNTS` | 4 |
| `CS01_STRUCTURAL_REFERENCE_COUNTS` | 10 |
| `CS02_REPEATED_OCCURRENCE_COUNTS` | 5 |
| `CS02_STRUCTURE_MEASUREMENT_COUNTS` | 1 |
| `CS03_EXTENSION_CAMPAIGN_COUNTS` | 1 |
| `CS03_EXTENSION_SUPPORT_COUNTS` | 47 |
| `CS03_MEMBER_SCOPE_COUNTS` | 8 |
| `G0_RESOURCES` | 122304 |
| `G1_BASELINE_COUNTS` | 141 |
| `G1_COMPARISON_COUNTS` | 36 |
| `G1_CONTRACT_COUNTS` | 143 |
| `G1_GENERATED_COUNTS` | 35 |
| `G1_TRANSPORT_COUNTS` | 44 |
| `G2_BASELINE_COUNTS` | 216 |
| `G2_CONTRACT_COUNTS` | 216 |
| `G2_DIAGNOSTIC_COUNTS` | 2 |
| `G2_GENERATED_COUNTS` | 52 |
| `G2_MYSQL_BASELINE_COUNTS` | 13 |
| `G2_MYSQL_CONTRACT_COUNTS` | 13 |
| `G2_PG_BASELINE_COUNTS` | 17 |
| `G2_PG_CONTRACT_COUNTS` | 18 |
| `G2_PROVIDER_BASELINE_COUNTS` | 11 |
| `G2_PROVIDER_CONTRACT_COUNTS` | 11 |
| `G2_TRANSPORT_COUNTS` | 16 |
| `G25_CONTRACT_COUNTS` | 6 |
| `G25_PG_CONTRACT_COUNTS` | 2 |
| `G27_CONTRACT_COUNTS` | 6 |
| `G27_MYSQL_CONTRACT_COUNTS` | 1 |
| `G27_PG_CONTRACT_COUNTS` | 1 |
| `G27_PROVIDER_CONTRACT_COUNTS` | 1 |
| `G29_DEPENDENCY_BOUNDARY_COUNTS` | 4 |
| `G29_DEPENDENCY_CHOICE_COUNTS` | 10 |
| `G29_MEMBER_DEPENDENCY_COUNTS` | 14 |
| `G29_MEMBER_DEPENDENCY_MYSQL_COUNTS` | 2 |
| `G29_MEMBER_DEPENDENCY_PG_COUNTS` | 2 |
| `G29_MEMBER_DEPENDENCY_PROVIDER_COUNTS` | 2 |
| `G29_RESULT_PROGRESS_COUNTS` | 2 |
| `G3_AUTHOR_EXECUTION_REGRESSION_COUNTS` | 3 |
| `G3_BULK_RESULT_BOUNDARY_COUNTS` | 5 |
| `G3_BULK_SERIES_COUNTS` | 6 |
| `G3_DEPTH_RECURRENCE_COUNTS` | 6 |
| `G3_EXECUTION_REVIEW_COUNTS` | 6 |
| `G3_GENERATED_MINIMIZATION_COUNTS` | 1 |
| `G3_GENERATED_SMOKE_COUNTS` | 6 |
| `G3_GENERATED_TRANSPORT_SMOKE_COUNTS` | 1 |
| `G3_SCOPE_COMPOSITION_MYSQL_COUNTS` | 2 |
| `G3_SCOPE_COMPOSITION_PG_COUNTS` | 2 |
| `G3_SCOPE_COMPOSITION_PROVIDER_COUNTS` | 2 |
| `G3_SCOPE_FAILURE_COUNTS` | 2 |
| `G3_SUPPRESSION_RETRY_COUNTS` | 2 |
| `G3_TRANSACTION_ARRAY_COUNTS` | 4 |
| `G3P02_CONTRACT_COUNTS` | 4 |
| `G3P02_MYSQL_CONTRACT_COUNTS` | 5 |
| `G3P02_PG_CONTRACT_COUNTS` | 5 |
| `G3P02_PROVIDER_CONTRACT_COUNTS` | 5 |
| `G3P03_CONTRACT_COUNTS` | 6 |
| `G3P03_MYSQL_CONTRACT_COUNTS` | 5 |
| `G3P03_PG_CONTRACT_COUNTS` | 5 |
| `G3P03_PROVIDER_CONTRACT_COUNTS` | 5 |
| `G3P04_CONTRACT_COUNTS` | 5 |
| `G3P04_MYSQL_CONTRACT_COUNTS` | 4 |
| `G3P04_PG_CONTRACT_COUNTS` | 4 |
| `G3P04_PROVIDER_CONTRACT_COUNTS` | 4 |
| `G3P04_REVIEW_CONTRACT_COUNTS` | 5 |
| `G3P05_CONTRACT_COUNTS` | 21 |
| `G3P05_RECURSIVE_READ_FIT_COUNTS` | 6 |
| `G3P05_SELECTOR_DEPENDENCY_COUNTS` | 11 |
| `G3P05_VARIANT_COLLECTION_ORDER_COUNTS` | 4 |
| `G4_GENERATION_SELFTEST_COUNTS` | 6 |
| `G4_NATIVE_MYSQL_COUNTS` | 5 |
| `G4_NATIVE_PG_COUNTS` | 5 |
| `G4_NATIVE_PROVIDER_COUNTS` | 5 |
| `G4_PARITY_COUNTS` | 227 |
| `G4_READ_AGGREGATE_COUNTS` | 5 |
| `G4_READ_CODEC_COUNTS` | 12 |
| `G4_READ_COUNTS` | 62 |
| `G4_READ_FILTERS_COUNTS` | 13 |
| `G4_READ_OPERATIONS_COUNTS` | 11 |
| `G4_READ_ORDERING_COUNTS` | 5 |
| `G4_READ_PAGINATION_COUNTS` | 6 |
| `G4_READ_PROJECTION_COUNTS` | 7 |
| `G4_READ_RECURSIVE_FIT_COUNTS` | 3 |
| `G4_UNIT01_AUTHOR_COUNTS` | 83 |
| `G4_UNIT01_REVIEW_COUNTS` | 198 |
| `G4_UNIT02_AUTHOR_COUNTS` | 131 |
| `G4_UNIT02_MYSQL_COUNTS` | 17 |
| `G4_UNIT02_PG_COUNTS` | 1 |
| `POST_G3_CLEARABILITY_CONTRACT_COUNTS` | 4 |
| `POST_G3_CLEARABILITY_MYSQL_CONTRACT_COUNTS` | 2 |
| `POST_G3_CLEARABILITY_PG_CONTRACT_COUNTS` | 2 |
| `POST_G3_CLEARABILITY_PROVIDER_COUNTS` | 2 |
| `POST_G3_HISTORY_ANALYSIS_COUNTS` | 5 |
| `POST_G3_PROJECTION_PREPARATION_COUNTS` | 4 |
| `POST_G3_SCHEMA_VIEW_COUNTS` | 1 |
| `POST_G3_SELECTOR_PREPARATION_COUNTS` | 4 |

## 6. Bundles

From `docs/architecture/raptor3-evidence/g4/release/closure-final/receipts/source-size-final.json` (commit `b5fde8c1eec56992eaadd898c72e462a191151e5`, clean: false, status `measured-source-and-bundles`).
The per-module detail stays in that file.

| fixture | runtime bytes | gzip bytes | modules | sha256 |
| --- | --- | --- | --- | --- |
| `engine` | 360,882 | 101,533 | 180 | `fc911a824251926e…` |
| `pg-simple` | 656,939 | 193,224 | 313 | `5eef6f7417810c59…` |
| `pg-relations` | 657,220 | 193,352 | 313 | `1201934577f526fb…` |

Targets: engine gzip ratio ≤ 0.75, every public PostgreSQL fixture ≤ 1. The ratios themselves are computed against the frozen bundle baseline, which this index does not hold.

## 7. LOC and the charged perimeter

| class | files | token LOC | physical | bytes |
| --- | --- | --- | --- | --- |
| charged-engine | 38 | 16,098 | 20,700 | 778,824 |
| charged-integration | 12 | 3,757 | 4,502 | 148,971 |
| charged-adapter-integration | 2 | 101 | 165 | 6,631 |
| likeForLike | 52 | 19,956 | 25,367 | 934,426 |
| charged-g3-prep-shared | 11 | 3,935 | 6,098 | 223,511 |
| charged | 63 | 23,891 | 31,465 | 1,157,937 |

| unit | files | charged-engine ± | charged total ± |
| --- | --- | --- | --- |
| `R4` (`cdd787ac8..61c745f49`) | 23 | +0 / −0 | +0 / −0 |
| `R2ab` (`61c745f49..50ad4fac4`) | 66 | +24 / −3 | +24 / −3 |
| `R2c` (`50ad4fac4..7a1e9b0e2`) | 68 | +73 / −10 | +73 / −10 |
| `R13` (`7a1e9b0e2..5499cbed3`) | 60 | +245 / −112 | +245 / −112 |
| `postwave` (`5499cbed3..b5fde8c1e`) | 44 | +47 / −10 | +47 / −10 |

Full detail: `docs/architecture/raptor3-evidence/g4/release/closure-final/receipts/source-size-final.json` and the recount beside it.
