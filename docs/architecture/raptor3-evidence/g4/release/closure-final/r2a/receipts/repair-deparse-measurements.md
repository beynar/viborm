# Repair round — how MySQL 8.4.11 reports an expression default

Measured on the lane's own container (MySQL 8.4.11), in two tables this unit
created and dropped in the same script (`r2a_deparse_probe`,
`r2a_deparse_probe2`); nothing else in the database was touched. Each column
below was declared with the DDL in the first column, then read back from
`information_schema.COLUMNS` and from the row a bare `INSERT` leaves behind.
The catalog text is printed through `JSON.stringify`, so `\\` in the middle
column is ONE backslash character.

| declared | `COLUMN_DEFAULT` (JSON-escaped) | stored value |
| --- | --- | --- |
| `TEXT DEFAULT ('plain')` | `"_utf8mb4\\'plain\\'"` | `plain` |
| `TEXT DEFAULT ('it''s')` | `"_utf8mb4\\'it\\\\\\'s\\'"` | `it's` |
| `TEXT DEFAULT ('a''b''c')` | `"_utf8mb4\\'a\\\\\\'b\\\\\\'c\\'"` | `a'b'c` |
| `TEXT DEFAULT ('a\\b')` (a real backslash) | `"_utf8mb4\\'a\\\\\\\\b\\'"` | `a\b` |
| `TEXT DEFAULT ('say "hi"')` | `"_utf8mb4\\'say \"hi\"\\'"` | `say "hi"` |
| `JSON DEFAULT ('{"k": "v''w"}')` | `"_utf8mb4\\'{\"k\": \"v\\\\\\'w\"}\\'"` | `{"k":"v'w"}` |
| `VARCHAR(50) DEFAULT 'it''s'` | `"it's"` (EXTRA empty) | `it's` |
| `TEXT DEFAULT ('a\b')` — what `escapeValue` writes for the value `a\b` | `"_utf8mb4\\'a\b\\'"` (a RAW backspace) | `a<BACKSPACE>` |
| `TEXT DEFAULT ('line1<newline>line2')` | `"_utf8mb4\\'line1\\\\nline2\\'"` | `line1<newline>line2` |
| `TEXT DEFAULT ('a\%b')` | `"_utf8mb4\\'a\\\\\\\\%b\\'"` | `a\%b` |
| `JSON DEFAULT ('["123.45","-0.5"]')` | `"_utf8mb4\\'[\"123.45\",\"-0.5\"]\\'"` | `["123.45","-0.5"]` |

Read off the table:

1. The escaping is applied TWICE. The expression MySQL holds is
   `_utf8mb4'it\'s'` — the literal with `'` escaped once — and
   `information_schema` prints THAT with `'` → `\'` and `\` → `\\`. So the
   backslashes come from MySQL's deparse, never from the declared value: every
   apostrophe-bearing default on a storage class that takes an expression
   default (TEXT, BLOB, JSON, GEOMETRY) arrives carrying them.
2. Undoing one layer, then the other, and accepting only `\'` and `\\`,
   inverts it exactly: `it's`, `a'b'c`, `{"k": "v'w"}` and the decimal-list
   container all come back, and the value is then re-spelled the way
   `escapeValue` writes it (`'it''s'`), wrapped as the expression default
   `('it''s')` the desired side carries.
3. What the inverse must NOT accept: `\n` (a newline — MySQL prints an escape
   the estate would have to guess at) and anything a backslash in the declared
   value produces. `escapeValue` leaves `\` alone, so the DDL `DEFAULT ('a\b')`
   makes MySQL store a BACKSPACE, and the catalog then reports a raw control
   character. Those bodies keep the catalog text, stay different from the
   desired side, and the push fails at the final attestation with
   `MIGRATION_DRIFT` — pinned by `mysql2-schema-attestation`'s "a default
   MySQL's DDL does not read back is refused, not accepted".
   *Annotation (postwave re-check, 2026-09-22): this reading conflates two
   mechanisms. Row 9 (`\n`) keeps the CATALOG TEXT because the inverse does
   not own that escape — witnessed provider-free by
   `mysql-provider-free-catalog.core`'s `multiline` column; row 8 (the
   backslash) reaches the catalog as a BACKSPACE the inverse reconstructs
   into a value that is not the declared one — witnessed live by the
   attestation cell named above. The measured table is unchanged; the split
   is stated in `../note.md` §6.*
4. A literal default (the `VARCHAR` row) is reported bare, with no `EXTRA`, and
   is unaffected by any of this: it was already read back correctly.
