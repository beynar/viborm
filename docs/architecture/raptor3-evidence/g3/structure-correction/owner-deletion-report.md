# G3 structural correction: ownership and deletion report

## Status

This is the preserved developmental report for an intermediate identity.
The [final root acceptance](root-acceptance.md) supersedes its pending status
and cost forecast; its historical receipts and measurements below are unchanged.

The bounded source is under independent review. The focused receipts in this
directory are developmental evidence, not final G3 qualification. Final source
identity and measured cost remain pending the review repair and source freeze.

## Authoritative owners

- `Queries.updateValue` remains the only interpreter and SQL lowerer for the
  currently admitted scalar `set` and `increment` operations. An updated key is
  represented by that same `Sql` expression over the captured key. The
  operation context does not inspect update operators or evaluate arithmetic.
- `OperationContext.updatedIdentity` only maps the complete model key: changed
  fields call `Queries.updateValue` with the captured field as the expression
  input, while unchanged fields retain the captured value. The former
  `finalUpdatedIdentity` JavaScript operator and number/bigint ladder are
  deleted.
- Internal locked mutation capture uses the existing internal decode boundary.
  This preserves canonical private decimal values before `lowerIdentity`; it
  adds no decimal representation, coercion, operator, or validation rule.
- `finishOne` and `finishMany` state operation-owned result cardinality.
  `decodeTerminalResults` owns the one terminal window decoder for live and
  prepared results. Physical query count no longer selects public result shape.
- `createMany` prepares its semantic projection and preserves the default-only
  `skipDuplicates` refusal before provider work. It constructs physical
  `RETURNING` SQL and row groups only after it chooses the non-fallback route.
- `Queries.lowerMutationLimit` lowers either the uncapped/native selector or
  the one aliased capped selector. It no longer constructs an unaliased result
  that the capped route discards.

## Deleted duplicate or discarded work

- The operation-context `set`/`increment` ladder and its host-language
  arithmetic are removed.
- Prepared and live terminal loops share one decoder; the old physical
  single-versus-array cardinality inference is removed.
- Fallback/refused `createMany` calls no longer construct unused `RETURNING`
  fragments or group partitions.
- Capped update/delete lowering no longer lowers the selector twice.

No public operation, scalar operator, codec, provider query, preparation
capability, transaction authority, or G4 surface is added.

## Focused evidence

The pre-production reds are retained under `red/`:

- execution boundary: 2 of 5 failed before the correction;
- bulk result boundary: 2 of 5 failed before the correction;
- decimal locked-capture boundary: 1 of 6 failed before the internal decode
  correction.

The current focused identity is production
`3aa093d434fb1b1bd7b432d4ab0adf4d1e32861f18a5881f29ec175baf76b725`
and harness
`20860a5dd3e7dc6541f39ebb2b4452fdd6d0abaace2be3209a8978b464253ae8`.
On Node 24.21.0 it produced these developmental greens:

- `g3-execution-review`: 6/6;
- `g3-author-execution-regressions`: 3/3;
- `g3-bulk-result-boundary`: 5/5;
- `g3p03-contracts`: 6/6;
- `g3-transaction-array`: 4/4;
- `g3-bulk-series`: 6/6;
- runner receipt self-test: 34/34.

The whole-estate type check has only the two pre-existing diagnostics in
`src/query-engine/pattern/pack.ts`. Its raw output is `green/typecheck.log`.
These results must be rerun after the independent review repair; they are not a
waiver of final source-bound qualification.

## Cost boundary

Before the pending review repair, the four changed Raptor production files have
a physical net change of minus 34 lines. That figure includes four lines removed
from the retained comparison `program.ts`; it is not the 12-file command core
delta. The accepted baseline remains 6,955 code-bearing token lines for the
12-file core and 11,877 for the 30-file broader retained perimeter. Fresh
parser-owned measurements, with the same denominators, are required after the
final source freeze.
