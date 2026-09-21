# T3 — where the encoding is lost, and what MySQL prints for an enum member

Measured on this lane's own container (`viborm-triage-mysql-20260918`, MySQL
8.4.11) by the probes retained beside this file, each in tables it created and
dropped itself (`tm_unicode_probe`, `tm_introducer_probe`, `tm_enum_probe`,
`tm_enum_printer`, `tm_session_charset`; `probe-upgrade-path.mjs` measures the
upgrade path and is reported in the note's §9 instead). Nothing else in the
database was touched. `mysql2` 3.16.1, the driver's own pool options.

## 1. The Unicode default — one hypothesis at a time

The brief names four candidate boundaries. Each is answered by a measurement,
not by reasoning about the other three.

| hypothesis | measurement | verdict |
| --- | --- | --- |
| the connection's character set for the introspection query (`SET NAMES` / the driver's `charset` option) | `probe-unicode-boundary.log`: the ordinary connection reports `character_set_client/connection/results = utf8mb4` already, and a connection opened with an explicit `charset: "utf8mb4"` returns the SAME bytes for the same column | **not it** |
| the `COLUMN_DEFAULT` column's own charset | same log: `CHARSET(COLUMN_DEFAULT)` is `utf8mb3` for BOTH rows, and the LITERAL default on the same table comes back through it as `636166C3A920E29895` — the true UTF-8 bytes of `café ☕`, six characters — while the EXPRESSION default in the same result set is `…636166C383C2A920C3A2C298C295…` | **not it**: one column, two outcomes |
| the DDL spelling of the literal (a `_utf8mb4` introducer?) | same log: `SHOW CREATE TABLE` prints `DEFAULT (_utf8mb4'café ☕')` with the TRUE bytes (`27636166C3A920E2989527`), from the same server, for the same column, in the same session | **not it**: the DDL stored the right thing |
| the ORM's own decoding of the catalog row | same log: the expansion is in the SERVER's own `HEX(COLUMN_DEFAULT)` (26 bytes, 21 characters, for a 9-byte value), so the client decoded faithfully what it was handed | **not it** |

What is left, and what the numbers say positively: `information_schema` renders
a STORED EXPRESSION's text with each byte of the literal as its own character.
The text that arrives is therefore a byte sequence, and MySQL's own deparse
NAMES the charset those bytes are in — the `_utf8mb4` introducer the ORM
parsed and threw away. `probe-introducer.log` measures that this is exact, not
approximate:

| declared | column | catalog body, codepoints | bytes read with the introducer |
| --- | --- | --- | --- |
| `café ☕` | `TEXT CHARACTER SET utf8mb4` | `63 61 66 c3 a9 20 e2 98 95` | `café ☕` |
| `e😀nd` (astral) | utf8mb4 | `65 f0 9f 98 80 6e 64` | `e😀nd` |
| `café ☕` | utf8mb3 column | `63 61 66 c3 a9 20 e2 98 95` | `café ☕` |
| `café` | latin1 column | `63 61 66 c3 a9` | `café` |
| `plain` | ascii column | `70 6c 61 69 6e` | `plain` |
| `a\b é it's\n` | utf8mb4 | `61 5c 5c 5c 5c 62 20 c3 a9 …` | the doubly-escaped literal, unchanged for ASCII |

Read off the table:

1. The body is EXACTLY the bytes of the introducer's charset, one per
   codepoint, for 1-, 2-, 3- and 4-byte characters.
2. The introducer names the charset the DDL ARRIVED in, not the column's: a
   latin1 COLUMN's default is still reported as `_utf8mb4` bytes here. That it
   follows the SESSION is measured too, on a connection opened with
   `charset: "latin1"` (`probe-session-charset.log`): the same declaration is
   then reported `_latin1\'caf<e9>\'`, one latin1 byte. So the introducer is
   the only thing at this boundary that knows how to read the bytes, which is
   why the inverse keys on it instead of assuming UTF-8 — and why a body it
   does not decode keeps the catalog's text rather than being guessed at.
3. Every escape MySQL prints is ASCII and survives the expansion unchanged, so
   the two escape layers are undone AFTER the bytes are read, in the order the
   text was built.
4. UTF-8 decoding is the IDENTITY on an ASCII body — but only for a body
   under a UTF-8 introducer. Which introducer arrives is decided elsewhere:
   §3.

## 2. The enum member — the same literal, and MySQL's printer

`probe-enum.log` runs the two spellings against the server:

| spelling | result |
| --- | --- |
| quote doubling only (the base `mysqlEnumType`) | `CREATE` refused outright: **errno 1064 ER_PARSE_ERROR** — the member `end\` closes its own string literal, exactly as the string default did before U4 |
| the shared literal (`mysqlStringLiteral`) | the table is created; every member — `plain`, `a\b`, `line1\nline2`, `it's`, `café ☕`, `end\` — inserts and reads back as the DECLARED value (the server's own oracle) |
| the shared literal WITH `DEFAULT 'a\b'` | created, and `COLUMN_DEFAULT` is the bare `a\b`: the member and the default are one spelling, so the errno 1067 U4 measured for the mixed spellings does not arise |

`probe-enum-printer.log` measures what the catalog prints back, which is what
the inverse must undo:

```
enum('p1a\\b','p2a\nb','p3a\rb','p4a\0b','p5a<CTRL-Z>b','p6a<TAB>b','p7a<BS>b',
     'say "hi"','it''s','100%','café ☕','e?nd')
```

1. The `COLUMN_TYPE` printer writes exactly four escapes: `\\`, `\n`, `\r`,
   `\0`. It DOUBLES the apostrophe (it does not write `\'`), and prints
   ctrl-Z, tab, backspace, `"` and `%` raw. That is a strict SUBSET of
   `MYSQL_PRINTED_CHARACTERS`, so one table serves both catalog vocabularies
   and leaves the same remainder unowned.
2. `COLUMN_TYPE` is NOT byte-expanded: `café ☕` comes back as the real
   codepoints `63 61 66 e9 20 2615`.
3. It is utf8mb3, so a member outside the BMP is printed `?` (`e😀nd` →
   `e?nd`) although the member itself stores and reads back intact. Such a
   schema cannot converge; it is a measured limit of the catalog, unchanged by
   this repair and named in the guide.

## 3. Which introducer arrives (repair round, 2026-09-21)

`probe-frozen-introducer.log` answers the question §1 left open — whose charset
the introducer names — because the first review round read it as "the reading
connection's, so only a caller-supplied `charset` reaches anything else". It is
the WRITING session's, and MySQL freezes it in the stored expression:

| step | measurement |
| --- | --- |
| a `tm_` table CREATED over a `charset: "latin1"` connection, `note TEXT NOT NULL DEFAULT ('plain')` and `accent TEXT NOT NULL DEFAULT ('café')` | created |
| the SAME table read from an ordinary connection (no `charset` option; session `{client, connection, results} = utf8mb4`) | `note` → `_latin1\'plain\'`, `accent` → `_latin1\'café\'` (bytes `63 61 66 e9`) |
| `SHOW CREATE TABLE` from that same ordinary connection | `DEFAULT (_latin1'plain')`, `DEFAULT (_latin1'caf?')` |

Read off the table:

1. The introducer is frozen at CREATE time. The reading session's charset does
   not change it, so `_latin1` — and any other charset some other tool wrote
   with — reaches this inverse on an ordinary connection.
2. A PURE-ASCII default arrives under that introducer too (`_latin1\'plain\'`),
   so a rule that keys on the introducer alone decides the fate of bodies that
   carry no non-ASCII byte at all.
3. What the base did with such a body was return it unread, which for a
   single-byte charset is exactly the right value (`63 61 66 e9` read one
   codepoint per byte IS latin1's `café`) and for any other charset is a silent
   guess. The repaired table therefore reads `latin1`, `ascii` and `binary` as
   the identity and the UTF-8 family with UTF-8, and keeps the catalog's text
   for the rest.

