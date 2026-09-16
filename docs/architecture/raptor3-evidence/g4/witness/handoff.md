# Witness handoff to G4-01 / G4-02 — revision 3

Revision 3, 2026-09-15, after the independent review returned REVISE and the
repair landed (`note.md` §13). Revision 1 was a forecast; revisions 2 and 3 are
grounded in executed receipts. Every claim below is backed by
`docs/architecture/raptor3-evidence/g4/witness/repair/g4-fixed-witnesses.repair3.json`
(75 cells: 34 green, 41 red — 62 read cells, 3 lifecycle-events, 4
lifecycle-admission, 6 generation self-tests) unless marked otherwise.

**What changed for you since revision 2.** Six cells were added (four
adversarial read cells the review named, one C13 self-falsification, one
campaign self-test) and one of them is red: `Q-W04 folds only ASCII under the
insensitive mode`, red on the same missing `contains` as the existing Q-W04
cell. Nothing already red became green and nothing green became red. The
command line changed: the campaign subject is now a **flag**, not an
environment variable.

This document states **what the independent witnesses demand**. It is not a
design for the query owner and prescribes no implementation. The full matrix,
with the exact failing message per row, is in `note.md` §2.

## 1. How to run them

```
node scripts/run-raptor3.mjs g4-read-contracts        # all 62 fixed read cells
node scripts/run-raptor3.mjs g4-read-codecs           # one family
node scripts/run-raptor3.mjs g4-generation-selftests  # green today
node scripts/run-raptor3.mjs g4-seed-batch 20000      # candidate: the claim
node scripts/run-raptor3.mjs g4-seed-batch 20000 --subject=shipped
```

`VIBORM_RAPTOR3_G4_SUBJECT` is no longer yours to set: the runner deletes it
from the child environment and writes the subject the command asked for. The
default is `candidate`; `--subject=shipped` runs the same worlds, requests,
oracle and replays against the shipped engine and can never qualify (its
receipt, `verified.json` and the printed line all say so).

The fourth command is the fastest whole-envelope probe there is **for the
request vocabulary**: it stops at the first cell where the candidate disagrees
with an independent JavaScript oracle and writes `generated-failure-<n>.json`
with the recipe, the request and the stack. Today it stops on cell 0 with
`Raptor 3 G1 scalar codec is not implemented: enum`. Its limit, so you do not
over-trust it: the campaign projects only `{id,label,count,status,note}` /
`{id,name,weight}` / `{region,code,label,score}`, so apart from `enum` it
witnesses **no codec** — codec identity is pinned by the 12 fixed cells in
`read-codecs.test.ts` (`note.md` §12.7).

## 2. What is already green — do not regress it

`findUnique` on a mapped compound key including the competing-row case;
extended-unique `where` with its discriminator refusal; `findMany` with
filter + order + skip/take applied before projection, returning fresh arrays
and fresh rows; recursive `AND`/`OR`/`NOT`; the field-reference scope rebinding
inside a nested relation predicate; to-one shorthand plus `is`/`isNot` with
real nullability; `some`/`every`/`none` over both an FK collection and a
junction; `select`/`include` mutual exclusion; both to-one orientations, a
junction and a self-relation in one projection; variant `{ only, variants }`
with arm-local order; the schema default omit; the RF-05 decimal-list refusals;
and the malformed-provider-row error identity.

Green since the repair, and also not to be regressed: a junction collection
shared by two parents windowed per parent; a collection stitched while its
parent's mapped compound key is unselected; a nullable column partitioned at
the NULL itself by `null` and `not: null`; and the refusal of a list container
(`has`) on a scalar column.

## 3. The ordered red list

Roughly in the order in which fixing one unblocks the next.

### 3.1 Codecs (blocks the most cells)

`Queries.decodeValue` and `Queries.columnName` admit only `int`, `string`,
`float` and `decimal`. Everything else raises
`Raptor 3 G1 scalar codec is not implemented: <type>`. The witnesses demand
public values with exact identity for:

| Domain | Public type demanded | Boundary the witness seeds |
| --- | --- | --- |
| `boolean` | `boolean` | stored as `1`/`0` |
| `bigInt` | `bigint` | `±9007199254740993` — one past 2^53 |
| `dateTime` | `Date` | `1970-01-01T00:00:00.000Z` and `.500` ms |
| `date` | `Date` at UTC midnight | never local midnight |
| `time` | `string` | `"00:00:00"`, `"23:59:59"` |
| `enum` | the member string | |
| `json` | fresh detached graph | plus the `DbNull`/`JsonNull`/`AnyNull` partition |
| `blob` | **`Uint8Array`**, not `Buffer` | `[0,1,2,128,253,255]` and `[]` |
| `point` | `{ longitude, latitude }` | stored as JSON on SQLite |
| `vector` | refusal on an incapable provider | SQLite declares no tier |
| SL-01…SL-10 | fresh array per read | decimal members canonicalize (`1.2`, not `1.200`) |

**`s.number()` is also unsupported**: `orderBy: { score: … }` on a
`s.number()` column raises `scalar codec is not implemented: number`, so the
candidate's fourth domain is not the one the public `number` factory produces.
That single gap reds the `{ sort, nulls }` witness.

Decimal: SQLite stores the **unscaled coefficient** and `better-sqlite3`
returns it as a JavaScript number. The witnesses compare the candidate's value
against the shipped client's for the same row, so a second decimal or DateTime
language drifts at exactly the boundaries seeded above.

### 3.2 Verbs

`commands/index.ts` `supportsOperation` admits three read verbs. Missing, each
with a witness: `findUniqueOrThrow` and `findFirstOrThrow` (absence raises
`NotFoundError` with the message `No <model> record found for <operation>`),
`findFirst`, `count` (a number, or the selected scalar-count object such as
`{ _all: 4, rating: 3 }`), `exist` (a boolean, no row shape), `aggregate`.

### 3.3 Predicate vocabulary

`prepareScalarOperations` admits seven operators, and `lowerValuePredicate`
repeats the same seven for `having`. Missing, each with a witness: `notIn`
(distinct from `not: { in: … }` on a nullable column — the witness seeds a
NULL row); `contains` / `startsWith` / `endsWith` with `mode: "default"` and
`"insensitive"`, escaping literal `%`, `_` and `\`; list containers `has` /
`hasEvery` / `hasSome` / `isEmpty` / `equals`; JSON `path` plus the null
sentinels (`filter is not implemented: kind`); tagged variant collection
quantifiers — which today raise a bare `TypeError` inside
`buildMembershipView`, not any public error identity.

**One vocabulary.** The witnesses deliberately place the same operator at the
root `where`, inside a nested relation `where`, and in `having`, and require
identical answers. `having` currently has no boolean composition at all
(`physical field is not implemented: AND`).

### 3.4 Ordering, paging, shapes

- `{ sort, nulls }` first/last over a nullable column.
- To-one relation ordering (`physical field is not implemented: author`),
  refused across to-many, capped at eight hops — the witness builds the
  8-hop chain programmatically and requires the 9th to be refused.
- Collection `{ _count: asc|desc }`, ordinary and variant
  (`physical field is not implemented: posts`).
- `cursor`, signed `take` (a negative take reverses the window and the public
  order is restored), `distinct` applied **before** take/skip — all three are
  currently ignored rather than refused, which is the most dangerous failure
  mode in this list: the candidate answers, and answers wrongly.
- Per-parent nested `cursor` is ignored the same way.
- `_count: true` and per-collection `_count` with its own `where`
  (`physical field is not implemented: _count`). Note that `_count: true`
  counts **collections only** — the to-one slot is not a countable member.
- `groupBy` publishes `_count: 3` where the contract is `_count: { _all: 3 }`.
- `_avg` over an `int` column is decoded through the **int** codec and refuses
  a fractional mean: `_avg` needs the numeric domain, not the column's.

### 3.5 Recursive fit (RF-16)

`tests/raptor3/prep/recursive-read-fit.test.ts` is untouched.
`tests/raptor3/g4/read-recursive-fit.test.ts` extends the same private
`Queries.recursive(model, traversal)` to DateTime, decimal, bigint, enum, JSON
and a scalar list over a mapped compound identity path, keeping the existing
rules (no recursive `take`/`skip`, seed-local ordering not emitted inside the
UNION anchor, roots ordered by seed then by the seed's admitted order terms,
one provider statement per traversal). All three cells stop at `columnName`.

## 4. What the witnesses will not accept

- A read answered by falling back to the shipped engine.
- A refusal weakened to make a witness pass: every RF row that reaches these
  files has a witness asserting the refusal still fires.
- A second admission of an already admitted payload (the C13 double-admission
  falsifier is green today on both routes — keep it that way).
- A cached read served inside `$transaction`. The C13 cache-bypass cell is red
  today only because `$withCache` on the route refuses; the candidate section
  now runs the **same three statement-count assertions** as the shipped
  section, and a fifth cell proves that oracle rejects a route that always
  serves the cache. Landing a cache result encoder will not make this cell pass
  on its own.
- A bare `TypeError`/`Error` where the shipped engine publishes an error
  identity. Two such cases exist today and are named in §3.3 and §3.1.

## 5. Requests

1. Keep `Raptor 3 G1 operation is not implemented: <operation>` and
   `Raptor 3 G1 scalar codec is not implemented: <type>` as the exact messages
   while a verb or codec is unimplemented, or tell this stream the replacement:
   the red witnesses pin those strings as the *reason* they are red.
2. When a verb becomes admitted, do not change the public shape of any row
   listed here without recording it as a compatibility decision. The witnesses
   treat a shape change as a disputed row, not as a fix, and will fail on the
   shipped-engine comparison before they reach the candidate.
3. When a family goes green, tell the integrator: its suite can then move from
   `extendedLocalExclusions` into `RAPTOR3_FIXED_LOCAL_TESTS`
   (`note.md` §7 holds the exact edit and the assertion that guards it).

## 6. What the follow-up and the repair added (2026-09-15)

Written after `note.md` §14 (follow-up) and §15 (repair). Everything below is
frozen in code and, until the integrator copies it, is recorded **only** in
`note.md` — `g4.md` does not carry it.

### 6.1 Two new frozen seed ranges

| Constant | Range | Batch / replays | Profiles | Modes |
| --- | --- | --- | --- | --- |
| `G4_WRITE_CAMPAIGN` | **75000–99999** | 100 / 3 | `sqlite-interactive`, `sqlite-atomic-batch` | `g4-write-seeds`, `g4-write-seed-batch <first-seed>` |
| `G4_WRITE_TRANSPORT_CAMPAIGN` | **100000–124999** | 100 / 3 | `scripted-returning-weak`, `scripted-returning-ack` | `g4-write-transport-seeds`, `g4-write-transport-seed-batch <first-seed>` |

Both spread G3's campaign (batch size, replay count, completion limit,
actor/fault quotas, contract rotation) and are **data**. Both first seeds are
multiples of four, which keeps `(seed - firstSeed) % 4` equal to the
generator's `(seed - 8000) % 4`. Neither takes a `--subject`: there is one
subject, the candidate, and the read campaign's flag is refused rather than
ignored. The receipts self-test asserts the disjointness against every frozen
range the manifest declares, not a hand-kept list.

### 6.2 Registered modes and exact counts

| Mode | Files | Cells | Last measured |
| --- | --- | --- | --- |
| `g4-unit01-author` | 10 | **83** | 83/83 green |
| `g4-unit01-review` | 29 | **200** | 200/200 green |
| `g4-read-envelope-pg-contracts` | 1 | **5** | 5/5 green (port 65504) — four provider cells and one provider-free adapter pin |
| `g4-read-envelope-mysql-contracts` | 1 | **5** | 5/5 green (port 65515) — the same four-plus-one split |
| `g4-write-seed-batch` | 1 | 1 | green, 100 seeds / 200 cells / 600 replays |
| `g4-write-transport-seed-batch` | 1 | 1 | **red** at cell 54, phase 2's `src/` |

**Last measured at production `a830d713…`** — every row above, in `note.md`
§17.4 ([receipts/repair2/](receipts/repair2)) and independently by the round-3
reviewer ([witness-followup-review3-receipts/](../witness-followup-review3-receipts)).
The same rows were measured at `7475621b…` in §15.7 and again at `7475621b…` in
§16.2, which is why §16's own framing was corrected (§17.1). The native count
moved from 4 to 5 in the repair: a fifth cell pins the fixture's duplicated
MySQL datetime spelling against `adapter.literals.dateTime`, needs no provider,
and runs in both native modes — so "5" is four provider cells plus that pin,
not four cells grown to five.

The registered G4 fixed estate is **55 files / 392 cells** (54 / 387 excluding
the native file), re-derived from the manifest in
[receipts/repair2/registration-totals.json](receipts/repair2/registration-totals.json)
together with `route-transactions` 11 = 11 and **0** registered-but-absent files.

### 6.3 Requests to the integrator

4. **Copy §6.1 and §6.2 into `g4.md`.** `common.md` calls `g4.md` the authority
   for seed ranges, and the two write ranges are now frozen in code with
   nothing outside `note.md` recording them.
5. **`g4-write-transport-seed-batch 100000` needs a green child at a settled
   production identity** before the lane counts as proven. Its red is
   `g3-transport:script-shape; Unscripted statement: g3-c11-100027-0:recurrence-0;
   actual=INSERT; expected=INSERT,SELECT`, and G3's own untouched
   `g3-generated-transport-smoke` fails identically at `g3-c11-8027-0` — the
   same recipe offset (27). It is the candidate's physical change, not the
   campaign constant.
6. **Neither write parent has ever run** (250 children each). Re-measure free
   space immediately before: the volume read 4.0 GiB at the end of the repair
   and **6.0 GiB** at the end of round 4, against ≈ 679 MB projected for the two
   families. **Read that projection as one measured lane plus one unmeasurable
   one**: its SQLite half reproduces byte-for-byte at every identity since §14
   (62,116,444 B raw, 1,192,711 B gzip per child), while its transport half
   rests on §14.4's child, which was green only at production `d844ae0f…` and
   which the lane has not reproduced since. Re-measure the transport per-child
   cost when request 5 closes.
7. **The replay gate and the CLI self-test cannot both be clean while the
   implementation streams keep writing `tests/raptor3/**` and `scripts/**`.**
   A corpus records the identity it was produced at, so a harness write between
   generation and replay makes the gate refuse it — four attempts in round 4,
   all kept failed (`note.md` §17.8). Schedule the qualification runs in a
   window where no other stream is writing, or they will read as reds that
   belong to no one.
