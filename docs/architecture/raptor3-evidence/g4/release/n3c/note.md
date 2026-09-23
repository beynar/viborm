# Release unit "n3c" — WITHDRAWN after its Opus review (BLOCK). The finding stands and is N1's.

Integrator: Fable, 2026-09-20 (machine clock 03:10). The unit changed one line
of `commands/relation-body.ts` — the nested-target lookup's membership named
the parent's located identity for a child-held key instead of the parent's
post-write assignments — and it is withdrawn whole: source, guide paragraph,
manifest rename and pins (`pins/`, kept as evidence for N1). Nothing of it is
committed. `review.md` is the reviewer's record; `receipts/` are the unit's
measurements as they were taken.

## 1. The finding, which stands

The gate triage filed five legality cells (`relation-key-update-legality-occupied-to-one`
×3, `-occupied-to-many` ×2: a root update transitioning its own key with a
nested child `update`) as "the batch arm loses the typed error to a raw
QueryError" — an attribution defect. A probe on the batch arm
(`receipts/probe/`) showed otherwise: nothing was batched. The nested child's
lookup is dispatched directly, as every read on the batch route is, with
`WHERE "parentId" = CAST((SELECT "ref_value" FROM "__viborm_batch_refs" …))` —
the parent's post-transition key through the batch scratch, whose setup was
still queued in the unsubmitted batch: PostgreSQL 42P01, mapped to
`QueryError` V2001. The lookup is placed AFTER the parent's write in the
occurrence tree (`relation-body.ts:870-871`: a child-held target is placed
`"after"`), and on the batch route that placement is not honoured by the
read: it runs before the batch that carries the write.

## 2. Why the value swap was wrong (the review's blocker, reproduced)

On the live route the same lookup runs after the parent's UPDATE — the
provider's cascade has already moved the child's foreign key — so the
post-write assignments are the value valid at that position, and naming the
located (pre-write) key refuses a shape HEAD executed: a child-held edge with
`onUpdate("cascade")` under a key transition and a nested `update`
(`nested-write-conformance-membership` "non-self child-holds cascade keeps
membership through a key transition": at HEAD the routes disagree and the
live route is right; with the unit both routes reject). On a batch-only
transport the unit also turned a clean pre-write refusal into a refusal after
the parent's transition had committed. No value is valid at both routes'
execution points, because the live route dispatches this read after the
write and the batch route before the batch. The five legality cells went
green only because their `setNull`/`restrict` transitions are refused by
`requireTransitions` before the lookup is reached — the SQLite pin's
live-route cell was green at HEAD for the same reason and discriminated
nothing.

## 3. Where it belongs

N1, case 3, stated by the reviewer and adopted: *the membership names the
parent's key as it is at the lookup's own execution point.* A parent-held
edge is placed before the parent's write and keeps the shipped verb
distinction (a nested `update` follows the parent's assignments — a rebound
foreign key names the final target, an unchanged one reads the captured row;
an upsert's found requirement and every other verb name the current member).
A child-held edge is placed after the parent's write, so the value valid
there is the post-write key. What is broken is that the batch route
dispatches this `"after"`-placed read as a planning read before the batch,
where neither key is valid: the read is an ordered observation behind a
`submit` barrier, or the produced key rides the reference scratch as D-50's
child foreign key does. The five legality cells and the cascade cell are N1's
witnesses; the two pins under `pins/` are N1's, once given a live-route cell
that reaches the lookup (assert its bound parameters; add a cascade arm).

## 4. Two instrument lessons, applied from the next unit on

- Compare failing **cell identities and messages**, not per-file red counts:
  on this unit the count was right ("no file worse") and the behaviour was
  not — the cascade cell's failing assertion moved from "the routes disagree"
  to "both routes reject".
- A pin must be red at HEAD for the reason the unit names; the SQLite
  live-route cell was not.

## 5. Kept as receipts

`receipts/probe/` (the batch-arm probe and its log), `receipts/attempt1-*`
and `attempt2-*` (the two shapes that lost fixed-stage cells),
`receipts/run3/`, `receipts/final/`, `receipts/regress/` (the estate under the
withdrawn shape), `receipts/comparison.md` (the count comparison the review
showed insufficient), `review.md`, `pins/`.
