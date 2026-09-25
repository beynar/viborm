# Batch-compiled list decoding — bounded implementation plan

Status: implemented on branch `compiled-list-decoder` (2026-09-25), measured and accepted in [`raptor3-compiled-list-decoder-report.md`](raptor3-compiled-list-decoder-report.md); proposed after a throwaway experiment the same day.

## Decision and scope

Move list-element descriptor construction from each returned list to the
existing decoded-batch compilation boundary. Keep the existing scalar decoder
and all codecs. Do not implement the broader scalar-switch compiler: its PoC
showed no repeatable benefit on flat reads.

This follows PR #50 on `544ab9465`. It is a small lifetime correction inside
`Queries`, not a new decoder architecture, public feature, or general rewrite.
It benefits list-valued columns; it does not promise improvement to the
scalar-only Drizzle benchmark.

## Measured reason

The isolated prototype and harness are on local branch `bey-scalar-list-poc`.
`benchmarks/scalar-list-poc-report.md` there records methods, source identities,
limitations and reproduction. Scalar-only prototype: `9e02517e1`; the branch
tip replaces it with the list-only experiment, not both optimizations together.

Four alternating fresh-process time rounds, Node 24.21.0, real SQLite public
reads of 1000 rows with four ordinary columns and two list columns:

| Elements in each list | Full CPU change | Full wall change | Temporary heap change |
| --- | ---: | ---: | ---: |
| 0 | -13.3% | -12.0% | -16.2% |
| 4 | -4.8% | -8.8% | -12.7% |
| 32 | effectively unchanged | -2.1% | -6.7% |

Heap used three fresh-process rounds, eight samples per worker, forced GC
before each sample and no observed GC inside the windows. It is a heap-growth
proxy, not retained RAM. Full one-row heap increased 240–492 bytes; paired
one-row CPU ratios were 0.993 / 0.992 / 1.014. Small timing differences need
confirmation. List element work dominates long lists, so gains need not grow
with list length. The scalar-only compiler's flat-1000 paired CPU ratio was
0.999: do not revive it based on the list result.

Four-round non-list controls for the list-only candidate were flat-1 CPU 0.981,
flat-1000 0.997, nested-1 0.999 and nested-1000 1.010 (wall 1.014 for the last).
These do not establish a flat-read gain; the small nested overhead must remain
visible during qualification. The 37 existing decoder/placement tests passed.

## Ownership and required deletion

`prepareProjection` still owns immutable shape. `compileReader` binds a reader
to this execution's driver and this decoded batch. The list reader owns the
non-null element descriptor derived from its list leaf. The existing scalar
decoder owns element meaning; the decimal whole-list codec remains distinct.

Delete per-list descriptor spread/freeze. Select the decimal-versus-ordinary
list path once at compilation. No copied scalar switch, global reader cache,
shape mutation, per-provider decoder, SQL change, provider-parser bypass,
relaxed exact-integer transport, or per-row compilation. Readers must not
escape to factory-lifetime prepared shapes. Prefer the smallest bound reader
composition; the PoC's optional callback parameter is not a mandated API.

Null and absence remain checked before provider conversion. Each physical list
crosses driver/adapter parsing once; its elements are carried values and do not
re-enter that chain. Each decode returns fresh public list/output containers.
Custom JSON output schemas keep their existing calls, timing and failures.

## Work units

1. **Freeze behavior and baseline.** Read ELEGANCE.md and the query-engine
   guides. Build immutable current-main and candidate checkouts with the same
   runtime/dependencies. Reuse the PoC fixture and verify expected values
   independently, rather than treating candidate output as an oracle.
2. **Implement the lifetime change.** One author changes `query.ts` at the
   existing compilation/list owner. Reuse every scalar codec. No formatting
   sweep or adjacent scalar specialization. Remove the old construction site
   rather than retaining two paths. Report complete net production LOC/tokens.
3. **Adversarial qualification.** Run existing decoder/placement tests and
   focused list-codec suites. Cover empty/nullable/missing lists, malformed
   containers and members, scalar kinds including enum/decimal/identifier/JSON,
   physical versus carried placement, root and nested/variant results, returning,
   borrowed drivers, middleware, concurrent clients and fresh result identity.
   Execute native PostgreSQL array/enum/decimal list and MySQL JSON-list cases:
   SQLite alone cannot qualify those representations. Run typecheck and build.
4. **Measure and decide.** Repeat alternating full and parse-only 1/20/1000-row
   reads, lengths 0/4/32, timing and separately heap growth. Keep identical SQL,
   row order, result digests and callback counts. Include scalar-only and nested
   non-list controls, cold/empty reads and single-row list reads. Recount bundle
   and source cost. Record paired distributions, not only winning medians.

Review the completed diff once independently; repair only concrete findings.
Do not run the complete estate after every edit. Run the relevant native,
type/package and decoder gates serially on frozen source for final acceptance.

## Known baseline issue: sparse lists

The PoC found that `Array.map` skips holes, making the existing callback's
own-index guard ineffective. Baseline and prototype both preserve sparse
provider lists. This optimization must record and preserve that baseline rather
than silently broadening into an observable rejection change. Resolve the
separate correctness policy before any production change to that behavior;
do not mislabel a parity pin as proof that sparse lists are safely refused.

## Acceptance and handoff

Accept only with identical qualified behavior, one decoder authority, repeatable
list-heavy CPU and/or heap benefit, and no material regression in controls.
A repeatable >5% small-read/control slowdown triggers review, not dismissal as
noise. If additional layers erase the gain, retain current main. No guarantee
of percentage savings is a correctness requirement.

Update the private guide for the new element-descriptor lifetime, with a small
source-bound report. Make one task-scoped implementation commit; do not include
prototype alternatives or unrelated user edits. No push/merge without authority.
