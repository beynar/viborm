# Falsification record — cs03

Method: `extension-a-scenario.ts` was swapped for its pre-fix `HEAD` content at
its real worktree path (never `git checkout` on the dirty file — the fixed
version was backed up to the scratch TMPDIR first and restored by `cp`, not by
any git operation), the self-test was rerun under the same cleared
credential-free environment, then the fixed version was restored from the
scratch backup and rerun once more to confirm green.

## 1. Fixed content → green (all 42)

See `selftest-after-fix.log`: 42 passed (42).

## 2. Re-expression reverted in a scratch copy → red again (same 10 cells)

```
$ cp docs/.../fixed.ts.backup  →  (scratch)
$ git show HEAD:tests/raptor3/core-structure/measurement/extension-a-scenario.ts \
    > (scratch original)
$ cp (scratch original) tests/raptor3/core-structure/measurement/extension-a-scenario.ts
$ TMPDIR=/private/tmp/viborm-cs03-tmp \
  VIBORM_RAPTOR3_REPLAY_PATH= VIBORM_RAPTOR3_SPECIMEN= VIBORM_RAPTOR3_EVIDENCE_DIRECTORY= \
  node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=raptor3 \
    tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts \
    --rss-limit-mb=1536 --heap-limit-mb=768

 Test Files  1 failed (1)
      Tests  10 failed | 32 passed (42)
```

Identical failure set to `repro-before.log`: all 10 cells fail at
`sqlite-world.ts:417`'s `Missing semantic cut capture:nested/root-member/0`
assertion (seeds 7109/7117/7119/7128/7149 × `sqlite-interactive` /
`sqlite-atomic-batch`).

## 3. Fixed content restored from the scratch backup → green again (all 42)

```
$ cp (scratch fixed backup) tests/raptor3/core-structure/measurement/extension-a-scenario.ts
$ diff (scratch fixed backup) tests/raptor3/core-structure/measurement/extension-a-scenario.ts
  → no output (byte-identical restore)
$ TMPDIR=/private/tmp/viborm-cs03-tmp \
  VIBORM_RAPTOR3_REPLAY_PATH= VIBORM_RAPTOR3_SPECIMEN= VIBORM_RAPTOR3_EVIDENCE_DIRECTORY= \
  node scripts/run-vitest-safe.mjs run --workspace vitest.workspace.ts --project=raptor3 \
    tests/raptor3/core-structure/measurement/extension-campaign.selftest.test.ts \
    --rss-limit-mb=1536 --heap-limit-mb=768

 Test Files  1 passed (1)
      Tests  42 passed (42)
   Start at  19:32:09
   Duration  1.51s
```

Conclusion: the re-expression in `extension-a-scenario.ts` is load-bearing —
removing it reproduces the original 10 red cells exactly; restoring it is
green again, byte-identical to the shipped fix.
