# N1 — a dependent lookup is an ordered observation or an established producer (brief, integrator's draft)

Owner file: `docs/architecture/raptor3-nesting-and-refusals-plan.md` §1 (revision 2)
and the N3c review's restatement (`g4/release/n3c/review.md` §1, §5.4). Worktree,
contract before code, cell-identity comparison for every measurement.

## The one rule (D-51, the plan's principle)

*The membership names the parent's key as it is at the lookup's own execution
point; a lookup that depends on an earlier sibling write is executed after
that write, with the premises that protect the write riding the same unit.*

Three cases the dependency pass already distinguishes (`commands.ts:536-693`,
the overlap fact: disjoint / equal / unknown) — it keeps computing the fact
and stops spending it on a refusal:

1. **Disjoint** — unchanged: an independent capture-phase read.
2. **Established producer** — the earlier write's EXECUTED outcome establishes
   the consumer's identity and conditions: an unconditional record write (not
   a `Choose` arm, not a suppressed insert, not a delete, not a set mutation,
   not a target another sibling moves before the consumer) whose known
   literals cover every field of the lookup's selector, for a consumer with no
   remaining condition (`selection.facts.fields.size === 0`). Then the lookup
   is the producer-sourced selection (`execution.ts:236-248` on the live
   route; on the batch route the produced key rides the reference scratch as
   D-50's child foreign key does — NEW work at the same owner). The
   `connectOrCreate` first-create-wins rule (`relation-body.ts:416-440`) is
   this case for one verb.
3. **Ordered observation** — otherwise the lookup leaves the capture phase and
   is placed after its prerequisite effects (the occurrence tree's own
   placement, `"after"`), so no earlier capture caches an answer for it. Live
   route: the read runs in order (nothing new). Batch route: the read is a
   barrier that SUBMITS the queued unit WITH its premises (not `flush`, whose
   premise-withholding is right for a planning read and wrong here) and reads
   in the next unit — a committed segment on a batch-only transport, D-51's
   "succession of statements"; the array route keeps refusing an unbatchable
   member (D-46).

**What each observation is valid for.** An observation before a sibling
write of the same target is stale for consumers after it; the pass gives such
a consumer its own observation point. A premise the next unit requires of the
observation (presence, membership) is asserted INSIDE that unit's batch,
before its writes (N3's rule: where the observation is taken, never where it
is consumed).

**The child-held key under a parent transition (N3c's finding).** The
child-held lookup is placed `"after"` (`relation-body.ts:870-871`); on the
live route it runs after the parent's UPDATE and the cascade, so
`parent.fields` (the post-write key) is right there; on the batch route the
same read is dispatched BEFORE the batch with a scratch reference no read can
carry (42P01). Under case 3 the batch route dispatches it after the barrier
that carries the parent's UPDATE — the value the live route already names is
then valid on both routes. The legality cells and the cascade cell are the
witnesses; the pins under `g4/release/n3c/pins/` need a live-route cell that
reaches the lookup (assert bound parameters; add a cascade arm).

## What disappears

The two dependency sentences at `commands.ts:573/607/676` and their meta; the
`program/` specimen (dead; a third copy of the refusal); DESIGN §6.2's
uniformity as a contract (named reversal, D-51).

## Reachable paths, walked (ELEGANCE "Apply")

`Choose` arms and `activeRefusal` (`commands.ts:874-884`); the six
nested-target sites in `relation-body.ts`; the retained-row re-check
(`:504-508`, a same-lookup race — not touched); `flush`'s premise withholding
(unchanged for planning reads); D-29's "a premise rides the unit it protects".

## Witnesses

The nested-write conformance suites (fk, m2m, membership, root-dependency,
to-one, transitive — 37 cells: every "allows" cell as written; every
"rejects" cell that pinned DESIGN §6.2's veto re-expressed to the executed
end state, named per cell; tx-versus-batch parity booleans stay true); the
D-16 family-5 cells; the five legality cells + the cascade cell; new pins on
a recording batch-only driver, one per case (an established producer — no
read, the scratch reference in the dependent statement, and the ineligible
producers falling to case 3; an ordered observation — the premises of the
preceding unit in ITS batch, the read in the next, `committedSegments`
reported; a disjoint read unchanged; the stale-observation case — two
consumers of one target across a write, two observation points);
`g29-dependency-boundaries` unchanged; the fixed stage; the estate per shard
by cell identity.

## Sequencing inside the unit

1. Contract first: the three cases and the validity rule in the guide, the
   pins written and RED at HEAD for the unit's own reason.
2. Case 3 on the live route (the refusal becomes placement; nothing else
   moves) — measure.
3. Case 3 on the batch route (the barrier) — measure, including
   `uncertain-outcome-meta` and the D-29 premise cells.
4. Case 2 (the producer-sourced selection's batch leg through the scratch).
5. The specimen deletion and the guide.
