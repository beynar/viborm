# What MySQL 8.4.11 does with the defaults and enum spellings this estate emits

Measured on the R2a lane container (MySQL 8.4.11, `sql_mode` =
`IGNORE_SPACE,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION`),
by executing the DDL directly and reading `information_schema.COLUMNS` back.
Every string below is the RAW catalog text.

| DDL fragment | result | `COLUMN_DEFAULT` | `EXTRA` |
| --- | --- | --- | --- |
| `label TEXT NOT NULL DEFAULT 'x'` | **errno 1101 ER_BLOB_CANT_HAVE_DEFAULT** | — | — |
| `label TEXT NOT NULL DEFAULT ('application-default')` | accepted | `_utf8mb4\'application-default\'` | `DEFAULT_GENERATED` |
| `payload JSON NOT NULL DEFAULT ('[]')` | accepted | `_utf8mb4\'[]\'` | `DEFAULT_GENERATED` |
| `label VARCHAR(191) NOT NULL DEFAULT 'x''y'` | accepted | `x'y` | (empty) |
| `role ENUM('admin','member') NOT NULL DEFAULT 'member'` | accepted | `member` | (empty) |
| `at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP` | **errno 1067 ER_INVALID_DEFAULT** | — | — |
| `at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)` | accepted | `CURRENT_TIMESTAMP(3)` | `DEFAULT_GENERATED` |

So: a literal default is reported as the VALUE, unquoted; an expression default
is reported as MySQL's deparse of the expression, and a string literal inside it
is printed wrapped in `\'…\'` with every special character escaped TWICE.

`TEXT NOT NULL DEFAULT ('<value>')`, value → catalog body between the `\'`
markers (raw text):

| value | catalog `COLUMN_DEFAULT` | round-trips |
| --- | --- | --- |
| `plain` | `_utf8mb4\'plain\'` | yes |
| `100%` | `_utf8mb4\'100%\'` | yes |
| `a"b` | `_utf8mb4\'a"b\'` | yes |
| `it's` (DDL `('it''s')`) | `_utf8mb4\'it\\\'s\'` | body carries backslash escapes |
| newline | `_utf8mb4\'line\\nbreak\'` | body carries backslash escapes |
| tab | `_utf8mb4\'tab<TAB>here\'` | tab stays literal |
| `a\b` (DDL `('a\b')`) | `_utf8mb4\'a<BS>\'` | **no** — MySQL read `\b` as BACKSPACE |

The last row is a PRE-EXISTING escaping gap in `MigrationDriver.escapeValue`
(it doubles `'` and leaves `\` alone, which MySQL reads as an escape
introducer). It is not this unit's subject and is not repaired here; the
translation added in `cleanDefault` stays fail-closed for exactly these bodies —
a body carrying a backslash keeps MySQL's catalog spelling and therefore keeps
reading as a difference, which is what re-plans the column rather than silently
accepting it.

`DATETIME(3) DEFAULT CURRENT_TIMESTAMP` (errno 1067) is what `s.dateTime().now()`
emits on MySQL today: `getAutoGenerateExpression` answers `CURRENT_TIMESTAMP`
with no fractional-seconds precision while `MYSQL_TYPE_DEFAULTS.datetime` is
`DATETIME(3)`, and MySQL requires the two to agree. No test in the native MySQL
inventory declares `.now()` / `.updatedAt()` (`grep` over
`tests/providers/docker/*.test.ts` and `tests/contracts/drivers/behaviors/*.ts`
matches only this unit's own probe), so it is OUT OF this unit's lane scope and
is reported as a separate finding rather than repaired here.
