# T3 — the shared MySQL literal boundary, finished at its owners

Repair prompt §3 (`docs/architecture/raptor3-local-closure-repair-2-prompt.md`),
on base `88fe2814b`. Worktree `/private/tmp/viborm-tm`, branch `closure-tm`,
container `viborm-triage-mysql-20260918` (MySQL 8.4.11), table prefix `tm_`.
Migration owners only (`src/migrations/**`): the engine is untouched and its
census is unchanged at **16,182** token lines. Both defects are the ones U4
measured, named and left open — §6 and §9 of
`closure-repair/u4/note.md`, and the two "neighbours" clause of
`src/migrations/AGENTS.md`'s U4 addendum.

## 1. The failing witnesses

Every cell below fails on the UNCHANGED production source and passes after the
repair. The production files were swapped to their base copies for the red runs
and restored from a backup copy, never by `git checkout`.

| cell | red at base | green after |
| --- | --- | --- |
| `mysql-defaults-docker`'s "round-trips escaped and Unicode enum members, and the default beside them" (new) | errno **1067 ER_INVALID_DEFAULT**, mid-push, as an unattributed driver error: the member of `ENUM('a\b')` is the BACKSPACE MySQL's DDL makes of it, and the default beside it went through `mysqlStringLiteral` | pass |
| `mysql-defaults-docker`'s Unicode cell (re-expressed) | `MIGRATION_DRIFT` — "the final live fingerprint does not match the desired schema": the catalog's `café ☕` came back as nine codepoints | pass |
| `mysql2-schema-attestation`'s "an escaped enum member and a Unicode default survive the attestation" (new) | errno **1067**, mid-push | pass |
| `mysql-provider-free-catalog.core`'s "reads an enum's printed members back through the same table" (new) | `ENUM('a\b', 'line1nline2', …)` — the printed `\n` read as the letter `n`, the member spelled without its escape | pass |
| `mysql-provider-free-catalog.core`'s "reads an expression default's bytes back through its introducer, or keeps the text" (new) | `('cafÃ© â\u0098\u0095')` — one codepoint per byte | pass |
| `mysql-provider-free-catalog.core`'s enum-identity pin (re-expressed) | `ENUM('a,b', 'it''s', 'back\slash')` — the spelling MySQL reads back as a BACKSPACE member | pass |

Receipts: `receipts/red-before-provider-free.log`,
`receipts/red-before-defaults-docker.log`, `receipts/red-before-attestation.log`,
and the green runs beside them.

Each production hunk was falsified INDEPENDENTLY on the repaired tree
(`receipts/falsification/`), one mutation at a time, restored by copy:

| falsification | result |
| --- | --- |
| `mysqlEnumType` back to quote doubling | red — the enum cells fail (docker: errno 1067; provider-free: the member spelling and the identity pin); the Unicode cells still pass |
| the enum inverse back to "append the next char" | red — the enum cells fail (provider-free: `line1nline2`; docker: `MIGRATION_DRIFT`, the live type is one MySQL never created); the Unicode cells still pass |
| the catalog body used without decoding its bytes | red — the Unicode cells fail; both enum cells still pass |
| the introducer not consulted | red — a `_cp1251` body whose bytes are valid UTF-8 is read as `é` instead of kept (re-run as `falsification/D3-table-not-consulted.log`; `C1-no-introducer-check.log` is the first round's run of the same mutation, when the refused body was `_latin1`) |
| a codepoint wider than a byte admitted | red — an already-decoded `x☕` is read as `x\u0015` instead of kept |
| the decode lenient instead of fatal | red — a body carrying a lone `e9` is read as `caf\ufffd` instead of kept |

## 2. The continuing invariants and their single owners

**(1) A declared string value reaches MySQL as the DECLARED value and comes
back in the one spelling the desired side wrote — an ENUM's members
INCLUDED.**

Owner: `mysqlStringLiteral` (`src/migrations/drivers/type-mapping.ts`), which
U4 made THE spelling for a MySQL string literal. `mysqlEnumType` now calls it
instead of carrying a second rule: a member IS a string literal, so doubling
`'` alone declared a member holding a BACKSPACE (`ENUM('a\b')`), could not
spell a trailing one at all (`ENUM('end\')` is errno 1064, measured), and —
once the default beside such a member went through the shared spelling —
disagreed with it, which is the errno 1067 U4 measured mid-push. One rule, so
the disagreement cannot be restated; the SQL-mode assumption the spelling makes
is one assumption, stated where it already was
(`mysql-strict-mode-docker.test.ts`, on `escapeValue`).

**(2) The catalog's printed escapes are undone through ONE table, in both of
MySQL's catalog vocabularies.**

Owner: `MYSQL_PRINTED_CHARACTERS` (`src/migrations/drivers/mysql/introspect.ts`),
the write table read backwards plus the `\'` MySQL prints. It moves up beside
the other constants because it now has two readers: the expression-default
inverse and `parseEnumValues`. The enum printer writes a strict SUBSET of it
(`\\`, `\n`, `\r`, `\0`; it doubles `'` and prints ctrl-Z, tab, backspace, `"`
raw — measured, `receipts/probe-enum-printer.log`), so one table covers both
and leaves the same remainder unowned: an escape outside it keeps the catalog's
`COLUMN_TYPE` exactly as read, registers no enum identity, and fails the final
attestation — the same fail-closed direction the string inverse takes.

**(3) An EXPRESSION default's catalog text is a BYTE SEQUENCE in the charset
its introducer names.**

Owner: `deparsedStringValue` / `decodeIntroducedLiteral` (same file) — the
place that already parsed MySQL's `_charset\'…\'` deparse and DISCARDED the
introducer. Where the encoding is lost was established hypothesis by
hypothesis before anything was changed
(`receipts/measurements.md`, with the probes beside it):

- the connection's character set is not it — the ordinary connection is already
  `utf8mb4` in all three variables, and an explicit `charset: "utf8mb4"`
  connection returns the same bytes;
- the `COLUMN_DEFAULT` column's own charset is not it — `CHARSET()` is
  `utf8mb3` for both rows, and a LITERAL default comes back through that same
  column DECODED (`HEX` = `636166C3A920E29895`, 9 bytes / 6 characters) while
  the EXPRESSION default beside it is expanded;
- the DDL spelling is not it — `SHOW CREATE TABLE` prints
  `DEFAULT (_utf8mb4'café ☕')` with the true bytes, same server, same column,
  same session;
- the ORM's decoding is not it — the expansion is in the server's own
  `HEX(COLUMN_DEFAULT)` (26 bytes, 21 characters, for a 9-byte value).

What is left is MySQL's own rendering of a stored expression, and the ORM's
only choice is how to READ it. The bytes are the literal in the charset the
introducer names — measured exactly, for 1-, 2-, 3- and 4-byte characters, and
measured to follow the SESSION the DDL arrived in (a `charset: "latin1"`
connection is reported `_latin1\'caf<e9>\'`, `receipts/probe-session-charset.log`).
So they are read with it, and nothing global is re-decoded. The introducer is
frozen in the stored expression at CREATE time, so it is the session that WROTE
the column that decides which charset arrives here, whatever the reading
connection speaks (`receipts/probe-frozen-introducer.log`): a `_latin1` body
reaches an ordinary utf8mb4 connection, and the charset table reads it with
latin1's own rule — each byte the codepoint of the same number — which is what
the base returned for every introducer. What the table does NOT name is kept
instead of guessed, and that is a CHANGE of outcome, reported in §9 rather than
claimed away.

Three facts must hold, and each covers a body the other two admit — each is
pinned by its own provider-free cell and falsified above:

| fact | the body it alone refuses | what a guess would do |
| --- | --- | --- |
| the introducer names a charset the table reads | `_cp1251\'Ã©\'` | those bytes are two Cyrillic letters in cp1251, so both readings are a guess |
| every codepoint is a byte | a transport that already decoded the text: `x☕` | `2615` truncated to `15`, a valid character, silently wrong |
| the bytes are valid in that charset | `_utf8mb4\'café\'` (a lone `e9`) | `caf\ufffd`, the corruption U4 named when it declined a blanket re-decode |

## 3. What disappeared

Three real deletions, no wrappers and no policy bit:

- `mysqlEnumType`'s own escaping rule — `values.map((value) =>
  `'${value.replace(/'/g, "''")}'`)` — the duplicate spelling the prompt names.
  The function is now one line and `type-mapping.ts` is one token line
  SHORTER.
- `parseEnumValues`' "backslash escape — append next char and skip both": the
  reading that turned the printed `\n` of a declared NEWLINE into the letter
  `n`.
- the DISCARDED introducer: `MYSQL_STRING_EXPRESSION_DEFAULT` matched
  `_[A-Za-z0-9_]+` and threw it away. It is captured now, and it is the fact
  that decides how the body is read.

## 4. A second applicable consumer

- `mysqlStringLiteral` as the member speller closes a neighbour U4's reviewer
  named and U4 could not fix: `buildMySQLEnumReplacementUpdates` renders
  `UPDATE … SET col = <escapeValue> WHERE col = <escapeValue>`, so with the two
  spellings disagreeing a rename of a backslash-bearing member matched no rows.
  One rule, so the `WHERE` now names the member as MySQL stores it — a
  consequence of the consolidation, not a patch beside it.
- `MYSQL_PRINTED_CHARACTERS` gains the enum inverse beside the string inverse;
  the decimal-list JSON container default still reads through the same table
  (`decimal-list-defaults-mysql-docker`, green).
- `decodeIntroducedLiteral` serves EVERY expression default — every default on
  a TEXT, BLOB, JSON or GEOMETRY column, on every MySQL transport that shares
  this introspector — ASCII ones included, where the decode is the identity.
- The repair round's `ignoreBOM: true` is on the SHARED `decodeUtf8`
  (`src/migrations/identity.ts`), whose second consumer is `sql-blob.ts`'s
  `validateSqlRanges`: it discards the decoded text and refuses a leading BOM
  as a BYTE before calling, so one decoder now means "exactly the characters
  these bytes encode" for both, and the blob pins are unchanged and green.

## 5. Cost

| denominator | before | after |
| --- | --- | --- |
| charged-engine (16,182) | 16,182 | **16,182** (+0) |
| like-for-like (20,040) | 20,040 | **20,040** (+0) |
| charged (23,975) | 23,975 | **23,975** (+0) |

No file this unit touched is inside any charged class: `mysql/introspect.ts`,
`drivers/type-mapping.ts` and `migrations/identity.ts` are all
`excluded-shared-boundary` in the closure's own classification
(`closure-final/receipts/source-size-final.json`). Their cost, kept visible
separately and measured with the census's OWN token-line function
(`receipts/token-lines.mjs`, which reproduces U4's base numbers exactly;
`receipts/repair-token-lines.log` after the repair round):

| file | token lines before | after |
| --- | --- | --- |
| `src/migrations/drivers/mysql/introspect.ts` | 385 | 435 (+50) |
| `src/migrations/drivers/type-mapping.ts` | 220 | **219 (−1)** |
| `src/migrations/identity.ts` | 48 | 50 (+2) |
| total | 653 | **704 (+51)** |

`git diff --numstat` (physical):

```
60	0	docs/architecture/raptor3-evidence/g4.md
71	0	src/migrations/AGENTS.md
154	19	src/migrations/drivers/mysql/introspect.ts
8	2	src/migrations/drivers/type-mapping.ts
11	1	src/migrations/identity.ts
101	0	tests/providers/docker/mysql2-schema-attestation.test.ts
183	47	tests/unit/migrations/mysql-defaults-docker.test.ts
182	2	tests/unit/migrations/mysql-provider-free-catalog.core.test.ts
```

plus this evidence directory.

## 6. Re-expressed cells

Nothing was deleted, skipped or weakened. Two recorded expectations were
re-expressed because the repaired contract changed the answer, each naming §3
at the cell:

1. `mysql-defaults-docker`'s "refuses a Unicode expression default, and keeps
   the literal one" → "round-trips a Unicode default in both the expression and
   the literal form". That cell pinned the fail-closed OUTCOME of the very gap
   this unit repairs — U4 wrote it so "the next repair has a red cell to turn
   green" — and it now runs the initial push, the unchanged repush, a declared
   change and a RAW INSERT omitting the column as the oracle, on a BMP
   character, an astral one, and the literal half as the control.
2. `mysql-provider-free-catalog.core`'s enum spelling, in both places
   (`snapshot.enums[0].name` and the column type): `back\slash` →
   `back\\slash`. The catalog INPUT is unchanged and so is the parsed VALUE;
   what moved is how the estate spells that member, which is the whole defect.

## 7. Runs

One file per invocation, credential-free files in batches; no wide runs. All
exit 0 on the final source.

| file | project | result |
| --- | --- | --- |
| `tests/unit/migrations/mysql-defaults-docker.test.ts` | provider-mysql2 | 4 passed (3 at base + 1) |
| `tests/providers/docker/mysql2-schema-attestation.test.ts` | provider-mysql2 | 6 passed (5 at base + 1) |
| `tests/unit/migrations/mysql-strict-mode-docker.test.ts` (control) | provider-mysql2 | 9 passed |
| `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts` (the inverse's other consumer) | provider-mysql2 | 1 passed |
| `mysql-provider-free-catalog.core` | layer-migrations + coverage-migrations | 14 executions (7 ×2; 5 ×2 at base) |
| `ddl-drivers.core`, `decimal-list-defaults.core`, `mysql-catalog-namespace.core`, `mysql-namespace-ddl.core`, `mysql-recovery-and-session-coverage.core`, `mysql-sequential-program.core`, `operators-mysql-branch-closure.core`, `provider-driver-entrypoints-coverage.core`, `serializer.core`, `format-and-type-mapping.core`, `decimal-descriptor-ddl.core` | layer-migrations + coverage-migrations | 910 executions |

**Registrations — none.** This unit added no test FILE: both witnesses extend
files that are already registered, and the registration U4 had to make twice
over is untouched. `tests/unit/migrations/mysql-defaults-docker.test.ts` is
named explicitly in `vitest.workspace.ts`'s `providerProject("mysql2", …)` (it
is not matched by that project's `tests/providers/docker/mysql2*.test.ts` glob)
AND in `extendedLocalExclusions` in
`scripts/credential-free-test-manifest.mjs`, which keeps the credential-free
file WALK from adopting it; `tests/providers/docker/mysql2-schema-attestation.test.ts`
is matched by the glob. Cell counts, for the integrator's inventory:
`mysql-defaults-docker` 3 → **4**, `mysql2-schema-attestation` 5 → **6**,
`mysql-provider-free-catalog.core` 5 → **7** (in two projects, so +4
executions). `scripts/raptor3-manifest.mjs` is untouched.

## 8. Typecheck, census, Biome

- **Typecheck:** `node scripts/run-typecheck.mjs` — exit 0, 0 diagnostics
  (`receipts/typecheck.log`; re-run once after the repair round,
  `receipts/repair-typecheck.log`).
- **Census:** `node scripts/query-engine-structure.mjs` — engine token lines
  **16,182**, unchanged. `node scripts/raptor3-refusal-census.mjs` — exit 0; no
  engine sentence or error class was touched (no `MigrationError` message was
  added, changed or removed by this unit) (`receipts/census.log`, and
  `receipts/repair-census.log` after the repair round).
- **Biome:** `npx biome check` on all six changed source and test files —
  clean (`receipts/biome.log`, `receipts/repair-biome.log`). Every base copy
  was format-clean, verified before anything was written (`identity.ts`
  included, before the repair round touched it); the formatter was run only on
  the two test files whose base copy is clean, and on nothing else.

## 9. Unverified

- **A transport that returns `COLUMN_DEFAULT` already DECODED loses every
  non-ASCII expression default.** Hosted MySQL transports (PlanetScale) were
  not exercised and they share this introspector. If such a transport hands the
  text back decoded, the byte fact refuses it and the catalog's text is kept,
  so the push fails at the final attestation with `MIGRATION_DRIFT` — and at
  base that same body CONVERGED, because the boundary returned it unread
  (`_utf8mb4\'x☕\'` → `('x☕')`, the correct value). This repair therefore takes
  such a transport from green to refused for every non-ASCII expression
  default; the body is pinned provider-free (`not_bytes`) as the refusal it is,
  not as the status quo. Distinguishing the two transports needs a fact neither
  hands over — this boundary cannot tell an expanded text from a decoded one
  when both are byte-sized — so it is disclosed, and a transport that hands
  back the bytes behaves like this container. ASCII defaults are unaffected on
  either.
- **A charset outside the table is REFUSED where the base converted it.** The
  introducer follows the session the DDL arrived in and MySQL freezes it in the
  stored expression, so the WRITING session decides what arrives — another
  tool, an older estate, a pool with its own `charset` — and the ordinary
  utf8mb4 connection reads it back unchanged (measured:
  `receipts/probe-frozen-introducer.log`, a column created over `latin1`
  reporting `_latin1\'plain\'` and `_latin1\'café\'` to a `{utf8mb4, utf8mb4}`
  session). The table reads the UTF-8 family and the single-byte
  ASCII-compatible charsets MySQL admits as a connection charset (`latin1`,
  `ascii`, `binary`), which is where this repair round widened it after review;
  anything else (`cp1251`, `sjis`, …) keeps the catalog's text and the push
  fails at the final attestation with `MIGRATION_DRIFT`. At base that body was
  CONVERTED — the unread text was returned as the value, i.e. read as latin1
  whatever the introducer said — so this is a deliberate change from a silent
  guess to a refusal, not the base's outcome. Owning those charsets means
  owning a byte table per charset, which is a public semantic decision, not
  this repair's.
- **`NO_BACKSLASH_ESCAPES` is unchanged from U4's disclosure and now reaches
  enum members too**, because they are the same rule. The session owner
  (`checkPinnedMySQLSession`) admits that mode; on such a server this spelling
  stores a doubled backslash where the base converged, and now a member as well
  as a default. §3 keeps unsupported SQL modes out of scope, and the guide
  states it beside the paragraph it corrects.
- **An enum member outside the BMP cannot converge**, and this boundary cannot
  repair it: `information_schema.COLUMN_TYPE` is utf8mb3 and prints `e😀nd` as
  `e?nd` (measured) although the member itself stores and reads back intact.
  The same character in an EXPRESSION default DOES round-trip, because its
  bytes survive the expansion. Unchanged by this repair, named in the guide,
  carried by no cell.
- **An estate CREATED under the old enum spelling converges on the next push
  only if no row holds the corrupted member.** Measured
  (`receipts/probe-upgrade-path.log`): `ENUM('plain','a\b')` created a member
  `a<BS>`; with a row holding it, the repaired `MODIFY` is refused under the
  strict mode the pinned session proves — errno **1265 WARN_DATA_TRUNCATED** —
  and the column is left exactly as it was, so the push fails and no row is
  silently re-valued; with no such row, the `MODIFY` is accepted and the column
  carries the declared member. Measured with a probe, not pinned by a cell: the
  ORM path to it is an ordinary declared change, which IS pinned.
- The full `provider-mysql2` project was not run in one go (no wide runs by a
  unit); the integrator's frozen gate owns that inventory.

## 10. Blockers

None.

## 11. Repair round — 2026-09-21

The independent review returned two majors and one minor. All three are
applied; nothing was declined.

**(1) The introducer gate refused bodies the base read correctly (major).** The
review's reading is confirmed by measurement, not only by code: MySQL freezes
the introducer in the stored expression at CREATE time, so the session that
WROTE the column decides what this inverse sees. A `tm_` table created over a
`charset: "latin1"` connection reports `_latin1\'plain\'` and
`_latin1\'café\'` to an ordinary connection whose session is
`{client, connection, results} = utf8mb4`
(`receipts/probe-frozen-introducer.mjs` / `.log`, table created and dropped by
the probe). The first round's gate turned both into `MIGRATION_DRIFT`,
including the PURE-ASCII one, and the base converged on both. Repaired as the
review asked, by decoding with the charset the introducer NAMES instead of
refusing everything outside the UTF-8 family: `MYSQL_UTF8_INTRODUCERS` becomes
`MYSQL_INTRODUCER_DECODERS`, one table of charset → how that charset's bytes are
read, with the UTF-8 family on `decodeUtf8` and the single-byte
ASCII-compatible charsets MySQL admits as a connection charset (`latin1`,
`ascii`, `binary`) on `decodeSingleByte` — each byte the codepoint of the same
number, which is what the base returned and what those bytes mean. Everything
else (`cp1251`, where identity would be a guess) stays unowned. Cells: the
provider-free `other_charset` body now reads `('Ã©')`, the true latin1 value; a
new `ascii_latin1` body (`_latin1\'plain\'`) reads `('plain')`; and a new
`unowned_charset` body (`_cp1251\'Ã©\'`) keeps the catalog's text, so the first
of the three facts is still pinned by a cell of its own.

**(2) The disclosures stated a wrong diagnosis (major).** Corrected everywhere
the review named it, to what is measured: this repair ADDS a refusal for (a)
any introducer the table does not name — where the base returned the body
unread, i.e. read it as latin1 whatever the introducer said, so the change
there is from a silent guess to a refusal — and (b) any transport that returns
`COLUMN_DEFAULT` already decoded, where every non-ASCII expression default
moves from green to `MIGRATION_DRIFT`. The reachable path (the introducer is
frozen at CREATE time; no caller-supplied `charset` is needed) is named in §9,
in the `src/migrations/AGENTS.md` addendum, in the `g4.md` record and in the
commit message. "No default that round-tripped before this repair moves" is
gone from note.md §2 and the commit message, from `receipts/measurements.md`,
from `g4.md` and from the `decodeIntroducedLiteral` comment; each now says
which bodies move and in which direction.

**(3) `decodeUtf8` swallowed a leading U+FEFF (minor).** Taken at the owner, as
the review's first option: `src/migrations/identity.ts` passes
`ignoreBOM: true`, so the bytes decode to exactly the characters they encode.
The only other caller (`sql-blob.ts:88`) discards the return value and refuses
a leading BOM as a BYTE before calling, so its behaviour is unchanged — its
pins are re-run green below. Pinned by a new provider-free `bom` body, which
reads `('<U+FEFF>x')`.

Four falsifications, one per repaired hunk, each mutation restored by copy
(`receipts/falsification/D1`–`D4`):

| falsification | result |
| --- | --- |
| the first round's UTF-8-only gate restored | red — `_latin1\'plain\'` is kept as text instead of read as `('plain')` |
| `ignoreBOM` dropped | red — `('<U+FEFF>x')` is read as `('x')` |
| the charset table not consulted (everything decoded as UTF-8) | red — the `_cp1251` body is read as `('é')` instead of kept |
| the UTF-8 family read as single-byte (the base's unread body) | red — `café ☕` comes back as its nine bytes, one codepoint each |

Runs after the repair round (one file per invocation; docker files one at a
time; no wide runs):

| file | project | result |
| --- | --- | --- |
| `mysql-provider-free-catalog.core` | layer-migrations + coverage-migrations | 14 passed (7 ×2; same cell count, four bodies added inside one cell) |
| `tests/unit/migrations/mysql-defaults-docker.test.ts` | provider-mysql2 | 4 passed |
| `tests/providers/docker/mysql2-schema-attestation.test.ts` | provider-mysql2 | 6 passed |
| `tests/unit/migrations/decimal-list-defaults-mysql-docker.test.ts` | provider-mysql2 | 1 passed |
| `safety-branch-rename-and-blob.core`, `planning-boundaries.core`, `v1-sql-framing.core` (the BOM/blob pins of the changed decoder) | layer-migrations + coverage-migrations | 56 passed |

Receipts: `receipts/repair-green-*.log`, `receipts/repair-token-lines.log`,
`receipts/repair-typecheck.log`, `receipts/repair-census.log`,
`receipts/repair-biome.log`. No test was deleted, skipped or weakened; no cell
count changed; `scripts/raptor3-manifest.mjs` is still untouched.

## Commit message

```
fix(migrations): one MySQL string literal, and a catalog default read in the charset it names

The two neighbours the previous checkpoint measured and left open (repair
prompt §3), repaired at the migration owners that already existed; the engine
is untouched and its census is unchanged at 16,182 token lines.

An ENUM's members ARE MySQL string literals, so `mysqlEnumType` spells them
with `mysqlStringLiteral` and its own quote-doubling rule is deleted. That rule
declared a member holding a BACKSPACE for `a\b`, could not spell `end\` at all
(errno 1064), and — once the default beside such a member went through the
shared spelling — disagreed with it, which MySQL refuses at the CREATE/MODIFY
with errno 1067, mid-push. The catalog inverse is the same table read
backwards: `parseEnumValues` undoes the escapes MySQL's COLUMN_TYPE printer
writes through `MYSQL_PRINTED_CHARACTERS` instead of dropping the backslash and
keeping the letter, which had turned a declared newline into an `n`. What stays
outside the table stays fail-closed: the COLUMN_TYPE is kept as read, no enum
identity is registered, and the push fails at the attestation.

A non-ASCII default is read in the charset MySQL itself names. The loss was
located before anything was changed, one hypothesis at a time: not the
connection's character set, not the catalog column's charset (a LITERAL default
comes back through that same column decoded), not the DDL spelling (SHOW CREATE
TABLE prints the true bytes) and not the driver — `information_schema` renders
a stored expression's text with each byte of the literal as its own character,
and the server's own HEX() carries the expansion. Those bytes are the literal in
the charset the `_utf8mb4` introducer names, and that introducer is what
`deparsedStringValue` had been parsing and discarding. It reads with it now,
through one table of charset → how that charset's bytes are read: the UTF-8
family decodes, the single-byte ASCII-compatible charsets a MySQL session can
speak are read as MySQL means them (`ascii` and `binary` ARE their bytes;
`latin1` is Windows-1252), and everything else keeps
the catalog's own text, as do a text that is not a byte sequence and bytes
invalid in their charset. Two bodies therefore stop converging where the base
converted them, and they are named rather than smoothed over: one under a
charset outside the table (the base read every introducer's bytes as latin1,
silently — and no caller-supplied `charset` is needed to reach that read,
because MySQL freezes the introducer in the stored expression at CREATE time,
so a column another session wrote reports ITS charset to an ordinary utf8mb4
connection), and — on a transport that returns COLUMN_DEFAULT already decoded
instead of expanded — every non-ASCII expression default. The shared UTF-8
decoder also stops swallowing a leading U+FEFF, because these bytes are a value
and not a document.

Witnesses: `mysql-defaults-docker`'s Unicode cell becomes the round-trip it was
holding the place for, and gains an enum cell carrying a backslash, a newline,
an apostrophe and a Unicode member with one of them as the column's default;
`mysql2-schema-attestation` gains the same pair from the outside; the
provider-free inverse gains the enum members, the introducer, one body for each
fact the read requires, a latin1 body with its pure-ASCII twin, a charset the
table does not read, and a value opening with U+FEFF. Each runs the initial
push, the unchanged repush, a declared change and a RAW INSERT omitting the
column as the oracle.
Two limits are measured and reported rather than repaired: COLUMN_TYPE is
utf8mb3, so an enum member outside the BMP comes back as `?`; and an estate
created under the old spelling converges only if no row still holds the
corrupted member, MySQL refusing the MODIFY (errno 1265) rather than re-valuing
a row.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

> **Integrator's addendum (after the re-check, 2026-09-22).** The re-check's one remaining minor is applied: MySQL's `latin1` is Windows-1252, so `decodeLatin1` reads bytes 0x80–0x9F as their cp1252 characters (0x93 → U+201C; the five bytes cp1252 leaves undefined map to the same-numbered control, as MySQL does) and `binary`/`ascii` keep the identity; pinned by the provider-free body `_latin1'\x93hi'` → `('“hi')`.
