# Validation kinds round: decimal (D1) and geo (D2)

Round 2 of the footprint program, run 2026-09-23 under
[`validation-elegance-plan.md`](validation-elegance-plan.md) and the ELEGANCE
standard. Base: `validation-kinds` at `0abb904f8` (WS1 own `Decimal` + SHA3,
merged with WS2's scalar families). Two lanes, `vk-decimal` and `vk-geo`, each
read → implement → two adversarial reviews → fix; ten Opus agents. Merged here
in that order. D3 (scalar classes) was deferred by the owner and is not in this
round. Every number below is quoted from a log or a `git` command on this tree.

## Outcome, in three parts

**Supported behaviour that changed (decisions, not compression).**

- A decimal position admits `Decimal | string`; a JavaScript number is refused
  with one issue at every position (create, update bags, every filter operand,
  `having`, cursor, unique). `new Decimal()` takes `string | Decimal | bigint`.
  The `String(number)` rule and the `0.1 + 0.2` doc case are gone. The decimal
  input JSON Schema is the string arm alone.
- A geographic value is admitted only as the record VibORM returns, validated by
  the one record walker: refusal wording and issue paths follow the walker
  (`Unknown key: …`, `Missing required field: …`, keyed paths). Twelve former
  polygon refusals (bowtie, repeated vertex, zero area, pole, half globe, hole
  placement, …) now reach the database as written; SQLite raises
  `FeatureNotSupportedError` after admission.
- Everything public is listed under `Decimal (breaking)` and `Geo` in
  `CHANGELOG.md`, and in `docs/content/docs/schema/scalars/{decimal,point}.mdx`.

**Dead mechanisms removed, with the invariant that retires each** (ledger
entries `Decimal descriptor and default` and `Addendum — geographic values as
ordinary records`).

- Decimal: the number arm of admission; two duplicate admission bodies; the
  string coefficient arithmetic (`splitCanonical`, `coefficientDigits`,
  `renderCoefficientLogical`, `coefficientToLogical`, …) — the value type's
  BigInt coefficient is exact; the descriptor's hostile reader (`readOnce`,
  `ownKeys`, `isDescriptorObject`, five-message `readBound`, list snapshot,
  property-by-property Standard-Schema reading) — a `ScalarState` is built only
  from developer arguments.
- Geo: the bespoke readers (`snapshotGeoRecord`, `readExactGeoRecord`,
  `readGeoRecordWithOptional`, `readGeoVariantRecord`, `prefixGeoFailure`);
  ring self-intersection, ring-vs-ring intersection, closure, planar and
  spherical area, half-globe test and the unwrapping they needed — polygon
  validity is the database's execution fact.

**Integrity boundaries intact.**

- Query shapes: `git diff 0abb904f8..HEAD` is empty for
  `tests/unit/scalars/scalar-shape-census.core.test.ts`,
  `tests/unit/scalars/_scalar-shape-census.ts`,
  `src/validation/scalars/decimal.ts` and `src/validation/scalars/point.ts`.
- Kept, each naming its consumer in code: `south <= north`; exactly one of
  `bounds`/`polygon`; a ring has at least three vertices, judged before its
  vertices; polygon winding normalization (outer CCW, holes CW — the lane's
  retirement of it was reverted as outside D2 and unproven on MySQL/PostGIS);
  `-0 → 0`, `-180 → 180`; `holes: []` omitted (now pinned strictly);
  `geoBoundsForDistance`; the engine's physical decimal seams, including
  `decimalDefaultText` pad-only (a reviewer caught an intermediate rounding).
- Public types and JSON Schema of point/bounds/polygon are pinned whole and
  unchanged; the public-surface golden passes unchanged.

## Validation

| Gate | Result |
|---|---|
| `pnpm test:core` | 514 files, 10,450 tests green after one pin: the docs fence census counts 159 `ts` fences (the deleted `0.1 + 0.2` example) |
| `pnpm test:types` | green |
| `pnpm test:package` (build + golden) | 11/11 green |
| MySQL docker (`provider-mysql2`) | geo witness `includes antimeridian polygon boundaries and excludes its hole` green; `decimal-wide-arithmetic-docker` 35/35, `decimal-list-defaults-mysql-docker` 1/1 green. 132 failures in `mysql2.test.ts` (4), `mysql-strict-mode-docker` (2), `mysql2-scalars` (126): the failure set is **identical** on the unmodified base tree (`diff` of the `×` lines is empty) — pre-existing |
| pg / postgres.js docker | every GeoPoint test fails with `PostGIS GeoPoint preflight did not prove the required extension` — the container has no PostGIS; pre-existing and unobservable here. **D2 on PostGIS is not proven by this round.** |
| Shape census | byte-identical, see above |

Not observed: what PostgreSQL with PostGIS and MySQL answer for each newly
admitted invalid polygon (bowtie, half globe, …). The docs say "that database's
error or answer". Record it when a PostGIS container exists.

Note (2026-09-24, lane `geo-checks`): observed since, on PGlite 0.5.8 + PostGIS
3.6.2 and MySQL 8. PostGIS raised only for an edge between antipodal endpoints
and answered the rest silently, several wrongly (a hole outside adds its area,
a point in two holes matches) or unlike MySQL (half globe, pole vertex). D2's
premise that a malformed polygon becomes a database error was false on
PostgreSQL, so those polygons are refused again at admission, judged on the
great-circle arcs PostGIS draws, MySQL's ellipsoid edges within a band of them
(a hole touching a straight parallel edge crosses its arc, and PostGIS matched
points beside it, so touches are refused as before D2); repeated consecutive
vertices stay admitted. Review round 3 added the ring-size, 150-degree-edge and
three-planes refusals, the last replacing the half-globe one. Evidence and the
guard list: the ledger addendum "geographic values as ordinary records"; the D2
entry of `validation-elegance-plan.md` (branch `footprint-safe-scope`) needs
the same amendment.

## Lines (production, excluding tests; `wc -l` on `git show`)

| Perimeter | Before | After | Net |
|---|---|---|---|
| Decimal: primitive, value, codec, descriptor, scalar class | 2,190 | 1,698 | −492 (≈62 moved into the value module) |
| Geo: area codec, point codec, values, point primitive | 798 | 346 | −452 (gross −626 / +137, 7 moved) |
| JSON-Schema converters | 689 | 683 | −6 |
| Whole `src/` | 164,058 | 163,108 | −950 |
| Tests | 379,745 | 380,120 | +375 (witnesses, type probes) |

The plan's rows covered by this round were estimated at ≈1,290; delivered
≈950, the gap being the kept winding normalization and the codec aliases below.

## Bundle (separate heading; never inferred from lines)

`node scripts/measure-bundle.mjs`, `pg-representative` fixture, versus PR #43's
`final.json`; this includes WS1, WS2, D1 and D2:

| | raw | gzip | brotli |
|---|---|---|---|
| `final.json` (PR #43) | 845,503 | 230,698 | 191,119 |
| `footprint-2.json` (this tree) | 823,575 | 223,779 | 185,369 |
| delta | −21.9 KB | −6.9 KB | −5.8 KB |

`big.js` and `@noble/hashes` no longer appear in the composition.

## Open, for the owner

1. `s.decimal({ precision, scale })` refuses with one sentence per key (two
   sentences, one owner). The task asked for one message; keep or merge.
2. The codec keeps `canonicalizeDecimal`, `canonicalizeMaterializedDecimal`,
   `toDecimal`, `logicalToCoefficient` as const aliases because the engine
   imports those names and the decimal-language census only sanctions the
   codec as the runtime route. After the engine merge: rename the eight
   importers or widen the census's allowed importers.
3. Winding retirement is parked: only the docker lanes with PostGIS can prove
   MySQL/PostGIS read either orientation the same way.
4. `interpret.ts:288` should call the public `decimal` and `buildDecimalScalar`
   go; outside the lane's ownership, not done.
5. Measured cost: coefficient → canonical text decode is 3.6× slower
   (≈80 ns per value); coefficient → `Decimal` 2.3× faster. The widened-sum
   decode BigInt-parses provider text with no digit bound first.
6. Pre-existing, left: `as` at `primitives/point.ts:39`;
   `Object.defineProperty` state mutation in the decimal scalar class (D3).
