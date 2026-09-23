# U4 — what MySQL 8.4.11 stores and prints for the characters a default can carry

Measured on this lane's own container by `probe-deparse.mjs` (retained beside this
file), in two tables it created and dropped in the same script (`sm_deparse_today`,
`sm_deparse_repaired`); nothing else in the database was touched. Each column was
declared `TEXT NOT NULL DEFAULT (<spelling>)`, then read back from
`information_schema.COLUMNS` and from the row a bare `INSERT` left behind. Every
cell is printed through `JSON.stringify`, so a doubled backslash in the table is ONE
backslash character.

## 1. The spelling this unit repairs to

| declared value | DDL written | catalog `COLUMN_DEFAULT` | stored value | value intact |
| --- | --- | --- | --- | --- |
| `"plain"` | `"'plain'"` | `"_utf8mb4\\'plain\\'"` | `"plain"` | yes |
| `"it's"` | `"'it''s'"` | `"_utf8mb4\\'it\\\\\\'s\\'"` | `"it's"` | yes |
| `"a\\b"` | `"'a\\\\b'"` | `"_utf8mb4\\'a\\\\\\\\b\\'"` | `"a\\b"` | yes |
| `"a\\nb"` | `"'a\\\\nb'"` | `"_utf8mb4\\'a\\\\\\\\nb\\'"` | `"a\\nb"` | yes |
| `"end\\"` | `"'end\\\\'"` | `"_utf8mb4\\'end\\\\\\\\\\'"` | `"end\\"` | yes |
| `"line1\nline2"` | `"'line1\nline2'"` | `"_utf8mb4\\'line1\\\\nline2\\'"` | `"line1\nline2"` | yes |
| `"a\rb"` | `"'a\rb'"` | `"_utf8mb4\\'a\\\\rb\\'"` | `"a\rb"` | yes |
| `"a\tb"` | `"'a\tb'"` | `"_utf8mb4\\'a\tb\\'"` | `"a\tb"` | yes |
| `"a\u0000b"` | `"'a\u0000b'"` | `"_utf8mb4\\'a\\\\0b\\'"` | `"a\u0000b"` | yes |
| `"a\u001ab"` | `"'a\u001ab'"` | `"_utf8mb4\\'a\\\\Zb\\'"` | `"a\u001ab"` | yes |
| `"a\bb"` | `"'a\bb'"` | `"_utf8mb4\\'a\bb\\'"` | `"a\bb"` | yes |
| `"say \"hi\""` | `"'say \"hi\"'"` | `"_utf8mb4\\'say \"hi\"\\'"` | `"say \"hi\""` | yes |
| `"100%"` | `"'100%'"` | `"_utf8mb4\\'100%\\'"` | `"100%"` | yes |
| `"cafe ☕"` | `"'cafe ☕'"` | `"_utf8mb4\\'cafe â\u0098\u0095\\'"` | `"cafe ☕"` | yes |
| `""` | `"''"` | `"_utf8mb4\\'\\'"` | `""` | yes |

Read off the table:

1. MySQL's printer writes exactly six escapes: the apostrophe, the backslash, `n`,
   `r`, `0` and `Z`. A TAB, a BACKSPACE and a double quote are printed RAW. That set
   is the inverse's table (`MYSQL_PRINTED_CHARACTERS`), and it is the write table
   (`MYSQL_LITERAL_ESCAPES`) read backwards plus the apostrophe, which the DDL
   spelling doubles instead of escaping.
2. Every declared value reaches the column intact under the repaired spelling,
   including a trailing backslash, a newline, a CR, a NUL and a ctrl-Z.
3. The Unicode row is the exception this repair does NOT own: the VALUE is intact,
   but the catalog hands the expression's UTF-8 bytes back one codepoint per byte,
   so the two sides cannot compare. Measured again by `probe-unicode.mjs`: catalog
   bytes `e2 98 95` as three codepoints for the EXPRESSION default, and the single
   codepoint `2615` for the LITERAL default on the same table. Reported, not
   repaired — see the note, section 6.

## 2. Today's spelling

The probe could not measure today's spelling row by row, because the table it
declares does not parse at all:

```
You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'line1
line2'), `carriage` TEXT NOT NULL DEFAULT ('a
b'), `tab` TEXT NOT NULL DEF' at line 1
```

`escapeValue` left the backslash alone, so a default whose value ENDS in one closed
its own string literal. R2a measured the per-row behaviour of that same spelling on
the values that do parse: `DEFAULT ('a\b')` stores `a<BACKSPACE>`
(`../../closure-final/r2a/receipts/repair-deparse-measurements.md`, row 8).

## 3. The temporal default

| declared column | accepted | catalog `COLUMN_DEFAULT` | `EXTRA` |
| --- | --- | --- | --- |
| `DATETIME(3) DEFAULT CURRENT_TIMESTAMP` | **no** — ER_INVALID_DEFAULT Invalid default value for 'at' | `` | `` |
| `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)` | yes | `"CURRENT_TIMESTAMP(3)"` | `"DEFAULT_GENERATED"` |
| `DATETIME DEFAULT CURRENT_TIMESTAMP` | yes | `"CURRENT_TIMESTAMP"` | `"DEFAULT_GENERATED"` |
| `DATETIME DEFAULT CURRENT_TIMESTAMP(0)` | yes | `"CURRENT_TIMESTAMP"` | `"DEFAULT_GENERATED"` |
| `DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)` | yes | `"CURRENT_TIMESTAMP(6)"` | `"DEFAULT_GENERATED"` |
| `TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3)` | yes | `"CURRENT_TIMESTAMP(3)"` | `"DEFAULT_GENERATED"` |
| `DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)` | yes | `"CURRENT_TIMESTAMP(3)"` | `"DEFAULT_GENERATED on update CURRENT_TIMESTAMP(3)"` |

The precision must AGREE: `DATETIME(3) DEFAULT CURRENT_TIMESTAMP` is errno 1067,
and `DATETIME(3)` is what `.dateTime()` resolves to. A type with no declared
precision takes the bare `CURRENT_TIMESTAMP` and reports it bare, so the expression
is derived from the resolved type rather than stated as a constant.

Server: MySQL 8.4.11, `sql_mode` = `IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`.
