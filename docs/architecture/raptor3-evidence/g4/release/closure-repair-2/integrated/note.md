# Closure-repair-2 — the integrated rounds

This directory records the rounds that act on the INTEGRATED tree (branch
`closure-t`), after the three units T1, T2 and T3 landed. Each round has its
own dated section below; the unit notes beside this one (`../t1/` … `../t3/`)
are not reopened except where a finding names a line in them.

> **Where this file lives.** The round's brief spells the directory
> `closure-tepair/integrated/` and its binding prompt
> `raptor3-local-closure-tepair-prompt.md`, a file that exists nowhere; the
> tree's prompt is `docs/architecture/raptor3-local-closure-repair-prompt.md`
> and the round's directory — the one holding `t1`, `t2`, `t3`, named by every
> unit note and by the three ledger records — is `closure-repair-2/`. It is the
> workflow script's own `-r` → `-t` rename artefact, the same one the previous
> lane recorded for `-s` at
> [`../../closure-repair/integrated/note.md`](../../closure-repair/integrated/note.md)
> (lines 8–14), so the note is beside the units it belongs to.

## Integrated repair round (2026-09-22)

**Four findings, all minor. All four applied; none declined.** **No production
source changed in this round**: `git status` lists exactly three Markdown files
— `src/migrations/AGENTS.md`, `docs/architecture/raptor3-evidence/g4.md` and
`../t3/note.md` — plus this note's directory
([`receipts/04-numstat.log`](receipts/04-numstat.log)). Nothing was staged,
committed or formatted. Every finding was a document made to agree with the
tree; one of them is a durable rule, and it is now stated where the rule lives.

### 1 (minor) — the single-byte clause states a rule the code does not follow

`src/migrations/AGENTS.md:305` and the ledger sentence at `g4.md:3917` (the
finding's numbering, before §3 below added its blank line) both said that
`latin1`, `ascii` and `binary` **ARE their bytes, each the codepoint of the
same number**. That is true of `ascii` and `binary` only. MySQL's `latin1` IS
Windows-1252, and the shipped decoder reads it that way: `CP1252_HIGH` +
`decodeLatin1` (`src/migrations/drivers/mysql/introspect.ts`, lines 388–406)
map the 32 bytes 0x80–0x9F to their cp1252 characters — 0x93 to U+201C — and
map the five bytes cp1252 leaves undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) to
the same-numbered control; the decoder table at lines 424–434 sends `latin1`
there and `ascii`/`binary` to `decodeSingleByte`. The provider-free cell
`cp1252_latin1` pins it end to end: the catalog text `_latin1\'\x93hi\'` reads
back as `('“hi')`
(`tests/unit/migrations/mysql-provider-free-catalog.core.test.ts` lines
414–418 and 469).

**Applied — both places, in the paragraph itself.** The guide's table now
reads *“the UTF-8 family decodes, `ascii` and `binary` ARE their bytes — each
the codepoint of the same number — and `latin1` is MySQL's Windows-1252, where
0x93 is U+201C and the five bytes cp1252 leaves undefined map to the
same-numbered control”*, and the ledger sentence *“the UTF-8 family decodes;
`ascii` and `binary` ARE their bytes; `latin1` is the Windows-1252 MySQL means
by it — 0x93 → U+201C, the five bytes cp1252 leaves undefined mapping to the
same-numbered control”*. No addendum was appended anywhere: a durable rule is
corrected where it is stated, and the wording is the code's own
(`introspect.ts:388–392`, `:417–419`). The integrator's addendum at
[`../t3/note.md`](../t3/note.md) line 453 is left exactly as it is — it
records WHEN the fact arrived in that unit's round, which remains true.

No code changed and nothing was re-run for this finding, as it asked.

### 2 (minor) — §5's cost table and numstat were written before the cp1252 addendum

`../t3/note.md` §5 still carried the figures of the draft that preceded the
same cp1252 repair: `introspect.ts` 422 token lines and a unit total of 691
(+38), and a physical numstat of `133 19` for `introspect.ts` and `174 2` for
`mysql-provider-free-catalog.core.test.ts`.

**Applied — the four rows the finding names, re-measured here.** T3's OWN
receipt (`../t3/receipts/token-lines.mjs`) was repointed at this lane's
worktree and TMPDIR (T3's pointed at `/private/tmp/viborm-tm`, which no longer
exists) and nothing else in it was touched; the base copies were extracted
read-only with `git show 88fe2814b:<path>`. Its BASE column reproduces T3's own
numbers exactly — 385 / 220 / 48 — so the function is the same one, and the
AFTER column is [`receipts/01-token-lines.log`](receipts/01-token-lines.log):

```
src/migrations/drivers/mysql/introspect.ts: 385 -> 435 (+50)
src/migrations/drivers/type-mapping.ts: 220 -> 219 (-1)
src/migrations/identity.ts: 48 -> 50 (+2)
total: 653 -> 704 (+51)
```

`git diff 88fe2814b --numstat` gives
`154 19 src/migrations/drivers/mysql/introspect.ts` and
`182 2 tests/unit/migrations/mysql-provider-free-catalog.core.test.ts`
([`receipts/05-numstat-t3-files-vs-base.log`](receipts/05-numstat-t3-files-vs-base.log)).
Note lines 172, 175, 182 and 187 now carry those four numbers. The CHARGED rows
are left at **+0** exactly as the finding directs, and so are the two numstat
rows the finding does not name (`g4.md`, `AGENTS.md`) — see *Unverified* below.

### 3 (minor) — the T3 ledger record was glued to the T2 record

`g4.md:3890` ("…both were declined by the prompt.") and `:3891` ("**T3 — one
MySQL string literal…") were consecutive non-blank lines, so the two records
rendered as one paragraph; the T1→T2 and T3→R3 boundaries both carry the blank
line.

**Applied.** One blank line inserted between them. Nothing else in either
record changed.

### 4 (minor) — the commit draft's trailer disagreed with the tree

`../t3/note.md:450` — the last line of the fenced commit-message draft the
integrator squashes from — ended `Co-Authored-By: Claude Opus 5 (1M context)
<noreply@anthropic.com>`, while the lane rules, both sibling drafts
(`../t1/note.md:425`, `../t2/note.md:356`) and both commits already on
`closure-t` (`9b30b9cd5`, `e82264058`) carry `Co-Authored-By: Claude Fable 5.1
<noreply@anthropic.com>`.

**Applied.** The draft's trailer is now the one the tree uses.

### Runs

**No test file was re-run, and none was owed:** this round changed three
Markdown files and no code (`receipts/04-numstat.log`), and finding 1 — the
only one that states a rule ABOUT code — says so itself: "No code change, no
re-run". Finding 2's numbers were re-measured with the receipt above, not with
a test.

**Typecheck:** once, at the end, whole estate, 0 diagnostics
([`receipts/02-typecheck.log`](receipts/02-typecheck.log)).

**Census:** not owed. No sentence, error class or engine file was touched, so
the refusal census and `scripts/query-engine-structure.mjs` are unmoved by this
round; the engine's 16,259 stands as T2 and T3 measured it.

**Biome:** per changed file. All three are Markdown, which this configuration
does not check — `npx biome check` on the three reports *"Checked 0 files… These
paths were provided but ignored"*
([`receipts/03-biome-markdown-ignored.log`](receipts/03-biome-markdown-ignored.log)),
so the before/after comparison is trivially identical. No file was formatted.

**Cost:** +0 on every charged denominator — no source file changed. This
round's own physical delta is 4/1 (`g4.md`), 4/2 (`AGENTS.md`) and 5/5
(`../t3/note.md`), plus this directory.

### Unverified / blockers

- **`g4.md:3946` still reads "+38 token lines on three
  `excluded-shared-boundary` files"** (3943 before this round's three added
  lines) — the same stale figure finding 2 corrects in `../t3/note.md`, and
  from the same cause: both were written before the cp1252 addendum, and the
  tree's number is **+51**, measured above. The finding's `requested_change`
  names only `note.md:172/175/182/187`, so the ledger sentence is reported
  here and NOT changed. It is a one-token repair (`+38` → `+51`) whenever the
  integrator wants it.
- The two numstat rows the finding does not name are stale for a different,
  benign reason: `60 0 g4.md` and `71 0 src/migrations/AGENTS.md` were T3's own
  hunks, and both files have since taken T1's and T2's ledger records and this
  round's edits (`178 0` and `73 0` against `88fe2814b` now). Left as written,
  per "nothing more".
- No database was used and no connection string was read, printed or
  substituted in this round; no container was started or stopped.
- **No ledger record was added for this round.** The brief names one
  deliverable — this note — and "exactly the requested changes and nothing
  more"; the only `g4.md` edits here are the two a finding asked for (the blank
  line, the qualified clause). If the integrator wants this round recorded in
  `g4.md` the way POSTWAVE (`g4.md:4012`) is, that record is still owed and is
  this section's text.

**Blockers:** none.

### Commit message draft

```
docs(raptor3): the integrated re-check's four repairs — `latin1` is Windows-1252 where the rule is stated, and T3's cost table is the tree's

The guide and the ledger both said `latin1`, `ascii` and `binary` ARE their
bytes, each the codepoint of the same number. The shipped decoder has not
done that for `latin1` since the repair round: MySQL's `latin1` IS
Windows-1252, so `CP1252_HIGH` + `decodeLatin1` read 0x93 as U+201C and leave
the five bytes cp1252 leaves undefined at the same-numbered control, and the
provider-free `cp1252_latin1` cell pins it. Both sentences now say that, in
the paragraph that states the rule rather than as an addendum elsewhere.

T3's §5 was written before that same addendum landed: introspect.ts measures
435 token lines, not 422, and the unit total 704 (+51), not 691 (+38);
the physical numstat is 154/19 for introspect.ts and 182/2 for
mysql-provider-free-catalog.core. Re-measured with T3's own receipt,
repointed at this worktree — its base column reproduces 385/220/48 exactly.
The charged rows stay +0.

The T3 ledger record gains the blank line that separates it from T2's, and
the draft trailer the integrator squashes from is the one the tree uses.

No production source changed: three Markdown files, no code, no test re-run
owed. Typecheck 0; census not owed; Biome does not check Markdown here.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
