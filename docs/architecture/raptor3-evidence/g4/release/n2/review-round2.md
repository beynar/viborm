# Release unit "n2" — re-check of the applied resolutions (round 2)

Re-checker: independent (Opus), main tree `/Users/arnaud/code/viborm` on
`pattern-engine` @ `29f36fbca`, unit still uncommitted. Scope, exactly: that
the four resolutions of `review.md` are applied as worded and that nothing
else in `note.md` or in the `g4.md` N2 entry moved; that `src`/`tests` are
untouched since the first review; that the pin still passes. Nothing under
`src/` or `tests/` was edited, nothing was committed, staged or stashed, and
no other worktree was entered. `TMPDIR=/private/tmp/viborm-n2-recheck-tmp`.

## Verdict: ACCEPT

All four resolutions are applied, each in the form the review asked for; the
two new `note.md` paragraphs are accurate against the code and against the
first review's measurements; the ledger entry's body is unchanged apart from
the reviewer clause; the engine diff has not moved; the pin is 10 / 10. Two
observations are recorded below — neither asks for a change now.

## 1. The four resolutions

**F1 (numstat) — applied, exact.** `note.md` §3 now reads
`relation-body.ts` **(+18/−9)** and `execution.ts` **(+5/−5)**; the review's
first option, not the "net of comments" one. Re-measured here:
`git diff --numstat -- src tests` gives `18 9 relation-body.ts`,
`5 5 execution.ts`, `10 0 AGENTS.md`, identical to `receipts/numstat.txt`.
The parenthetical also gained "three comment blocks" in the list of what the
hunk contains, which is what the added lines are.

**F2 (the batch-route premise) — applied, §5, every element present.** The
new **"Known exposure"** paragraph states: the lax deletion no longer asserts
the captured member's presence or membership on the batch route (base emitted
the member's `EXISTS`, the unit emits only the parent's); a member deleted or
re-parented between the capture and the batch is deleted by its captured
identity with no refusal where the base refused; the live route is protected
by transaction serialisation and the removal side by re-evaluation at
execution; it is ELEGANCE §6's loss-after-observation, not the initial
absence §5.3 makes lax; the premise for the captured member belongs to
**N3b / D-32**, and re-adding `retained` here would restore the refusal §5.3
forbids — i.e. no code change, as the review required. The attribution
"N3b" is tighter than the review's "N3" and is the plan's own name for that
owner (`raptor3-nesting-and-refusals-plan.md` §3b, and the order line
"N2, N3a, N3b, N1, N4, N5"); it is a correction in the right direction, not
a drift. Mechanically re-checked by reading, not only by trusting probe C:
`requireLookup` does `lookup.retained ??= lookup.required`
(`relation-body.ts:701`) and the premise is emitted only under
`this.context.usesBatch && selection.retained` (`execution.ts:263-264`), so
an unrequired lax lookup carries no premise — exactly the effect the
paragraph names.

**F3 (the dead FK-holder read) — applied, §5, with one wording deviation.**
The new **"Known dead work"** paragraph records the lookup that the lax
FK-holder `disconnect` still builds and places, that nothing reads its rows
(the null literals are contributed unconditionally, the membership
publication is plan-time), that the statement count is unchanged from base,
and that deleting it is a later unit's because the deletion branch of the
same emission needs it. Confirmed by reading: `requireLookup(outgoing)` is
still called unconditionally at `relation-body.ts:246`. *Deviation:* the
review's wording was "known dead work **owned by N5**"; the note says "a
later unit's" and names no owner. See observation O1 — not blocking.

**F4 (the reviewer clause) — applied.** The `g4.md` N2 entry no longer ends
"Sonnet review pending"; it ends with the Arnaud clause naming the Opus
review, its REVISE-on-documentation verdict, the four items, "applied", and
"re-check below".

## 2. Nothing else moved

`note.md` is untracked, so the original was recovered independently — the
heredoc that wrote it survives verbatim in this session's transcript — and
diffed against the file on disk. **Exactly three edits**, the three above,
plus one addition beyond them: the §5 "Unverified" sentence now also
discloses that the plan's §2 witness sentence was corrected by the integrator
and is Arnaud's to confirm. That mirrors the first review's §6 last bullet,
is accurate against `git diff` on the plan (one hunk, +4/−3, the witness
list only), and adds disclosure rather than removing or softening a claim
(observation O2). No other sentence of `note.md` changed — §2 still carries
its original framing, which the review permitted, since F2's sentence was
allowed in §2 *or* §5.

The `g4.md` N2 entry: byte-identical to the entry as first written, from
"**N2 — the lax to-one no-op (2026-09-20, 01:20).**" through "Note and
receipts under `g4/release/n2/`", with only the trailing
"; Sonnet review pending." replaced by the Arnaud clause. No other line of
`g4.md` is modified (`git diff` shows one hunk, +19).

## 3. The engine has not moved

`git diff --stat -- src tests`: `AGENTS.md` +10/−0, `execution.ts` 5/5,
`relation-body.ts` 18/9 — the review's figures. The only untracked file
under `tests/` is the pin `tests/raptor3/g4/parity/lax-to-one.test.ts`.
Stronger: both `.ts` hunks are byte-identical (index lines aside) to the
patch the first reviewer saved at review time,
`/private/tmp/viborm-n2-review-tmp/unit.patch`. No code moved between the
two reviews.

## 4. The pin

`node scripts/run-vitest-safe.mjs tests/raptor3/g4/parity/lax-to-one.test.ts`
(own `TMPDIR`, one run, no lock refusal): **10 / 10**, one file, 51 ms,
exit 0 — matching `receipts/pin.log` (10 / 10, 50 ms).

## 5. Observations (no change asked for now)

**O1 — the dead read is recorded but unowned.** The review suggested N5 as
its owner; the note says "a later unit's". N5 as the plan scopes it (§5) is
the remaining *red gate cells*, and this dead read produces no red cell, so
naming N5 would have been a slight fiction — the integrator's caution is
defensible. The cost is that the item now has no named owner anywhere. If
Arnaud wants it traceable, the minimal fix at commit time is one clause in
`note.md` §5 or in the ledger entry naming the unit that will take it.

**O2 — one addition beyond the four resolutions.** The plan-witness
disclosure in §5's "Unverified" sentence (above). Verified accurate; kept.

## 6. What I did not verify

The 126-file estate, the mode suites, coverage and floors, typecheck and
lint were not re-run — the first review covers them and the unit's files are
unchanged since. Probe B and probe C were not re-executed; probe C's claim
was re-checked statically through `retained ??= required` and the
`usesBatch && retained` guard, which makes it mechanically necessary. The
Docker lane was not run. The ledger's clock stamps ("01:20", "Arnaud
(02:00)") and the quoted instruction attributed to Arnaud are not verifiable
from the repository; both stamps run ahead of this machine's clock (01:00 at
re-check time), as the preceding committed entry's does (stamped 00:40 on a
commit made at 00:27), so this is the ledger's existing drift and not
something this round introduced.
