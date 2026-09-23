# CS-03 extension campaign reproduction

Run from the exact reference or candidate source root with Node v24.21.0.
Keep all production, harness, and configuration files unchanged during each
campaign and its saved-corpus replay.

Run the three registered campaigns serially:

```sh
node scripts/run-raptor3.mjs cs03-extension-a-seeds
node scripts/run-raptor3.mjs cs03-extension-b-seeds
node scripts/run-raptor3.mjs cs03-extension-composition-seeds
```

Each command must report 100 seeds under both SQLite profiles, 200 completed
cells, 600 exact same-build Recorder replays, and zero skips. Its receipt and
corpus must carry the source identity that the runner rechecks after execution.

Decompress the archived `corpus.json.gz` into a temporary directory and run
`node scripts/run-raptor3.mjs replay <temporary-corpus.json>` from the same
source identity. Run the receipt owner with
`node --test scripts/raptor3-campaign-receipts.test.mjs`.

Finally call `assertEquivalentExtensionCampaignReceipts` from
`scripts/raptor3-manifest.mjs` for each reference/candidate receipt pair. This
comparison is strict over canonical recipes, schedules, and full semantic
observations. It deliberately excludes SQL text and Recorder tape encoding.
