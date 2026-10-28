# Local Studio comparison — 2026-10-29

Scope: the daily local database editing workflow. Competitor capabilities were
reviewed from their official documentation and repository feature inventory;
this is not a hands-on benchmark of their released applications. VibORM was
reviewed against the code and exercised locally. Hosted gateways, connection
hosting, desktop distribution and cloud products are separate comparisons.

## Reference points

[Prisma Studio's getting-started guide](https://www.prisma.io/docs/studio/getting-started)
describes browsing, inline editing, creating/deleting rows, filtering, sorting,
relations and CSV/JSON export. Its
[current repository feature inventory](https://raw.githubusercontent.com/prisma/studio/main/FEATURES.md)
also documents grid keyboard/clipboard workflows, staged multi-cell edits,
selection-aware exports and keeping successful results after refresh failures.
Repository features do not establish availability in every released version.

[Drizzle Studio's overview](https://orm.drizzle.team/drizzle-studio/overview)
lists pagination, filtering, multi-sort, column reordering, typed editors,
cell-range clipboard, JSON/CSV/SQL transfer, a SQL console with explain and
telemetry, a Drizzle query runner, and schema management. Its deployment
variants must not be conflated with the local tool.

## Findings and changes

| Workflow | VibORM before this review | Result of this pass |
| --- | --- | --- |
| Browse, filter, sort, follow relations | Already present, including nested relation filters | Retained |
| Typed inline editing and row drawers | Already present | Added duplication without identity/unique values |
| Edit several rows | Delete selection only | Set one editable field across selected loaded rows |
| Clipboard | Native text-editor clipboard only | Copy cell/selected rows; paste TSV rectangles into loaded editable cells |
| Import | Missing | CSV/TSV/JSON preview; stage creates, then save through the client |
| Export | Full filtered CSV/JSON only | Selected/page copy and downloads; exports respect scalar visibility/order |
| Undo | Removed the whole last staged row change | Undo/redo each action; batches are one step |
| Refresh failure | Replaced usable rows with the error state | Keep previous rows with an explicit failure banner and Retry |
| Keyboard discoverability | Shortcuts existed but were scattered | Sidebar help and ⌘/Ctrl+/ |
| Schema diagram, saved views/queries, explain and trace | Already present | Retained; no recommendation cards restored |

Imports, paste and bulk edits use the existing change owner and save endpoint.
They add no separate write path. Parsing failure stages nothing; database
validation failure retains the changes and rolls back the transaction. The
read-only mode keeps selection/export but exposes no import or bulk writes.

Bounds are deliberate: 500 rows / 512 KB per import, 100 undo snapshots in the
mounted app, paste within loaded rows and visible editable columns. The existing
server transaction/export ceilings still apply. Pending changes survive reload;
undo history does not. CSV null conventions and exact numeric strings are
specified in the README; JSON is the lossless transfer format.

## Remaining differences

- Mouse-drag rectangular selection is still absent. The grid supports a focused
  cell, selected rows and rectangular paste; it is not a full spreadsheet.
- Query code has safe single-call parsing and saved queries, but no schema-aware
  autocomplete or query history. A richer editor is a separate interaction to
  design, not a reason to evaluate arbitrary JavaScript.
- No import column-mapping screen or streaming large-file import. Files currently
  name VibORM scalar fields directly and stay within the preview limit.
- No simultaneous table workspace tabs. Clean routes, browser history and saved
  views remain the navigation model.
- Arbitrary SQL, SQL imports, DDL and database-policy editing are intentionally
  outside this pass: they bypass the established client-only editing contract.
  VibORM instead exposes the generated SQL, parsed query calls, explain metrics
  and schema drift. This is a product boundary, not claimed feature parity.

## Verification

- 565 Studio tests passed, including malformed imports, exact numeric strings,
  null/empty/backslash round trips, rectangular-paste refusal, duplicate-field
  policy, export projection/order and invalid export columns. Isolated SQLite
  integration also verifies imported defaults, exact bigints, null/empty values
  and rollback of an invalid batch.
- Studio server coverage remains 100% of statements, branches, functions and
  lines. This does not measure UI interaction coverage.
- Chromium against the PostgreSQL demo: repeated edits of one cell undo
  individually; two-row paste/import/bulk edit undo atomically; duplicate opens
  a create drawer with new identity; copying a selection returns just that row.
- Injected refresh failure retained all six rows, and Retry restored the request.
  An injected save refusal retained the staged values, disabled writes while
  pending and allowed undo afterwards. Read-only mode retained selection/export;
  identical keyless rows remained individually selectable.
- Whole-project TypeScript, Svelte checks, the production build and scoped Biome
  checks pass. The compiled app was exercised on the normal local port.
- These browser checks did not save changes to the demo database. API write and
  transaction behavior is exercised against isolated SQLite test fixtures.
