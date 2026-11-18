/**
 * Views (`s.view`): a read of the schema's tables that the database keeps
 * under a name, which migrations create, replace and drop.
 *
 * A view's identity is its hash, never its text: every catalog rewrites the
 * statement it is given. The database holds that identity in the statement
 * itself: the body is wrapped as `SELECT * FROM (<body>) AS <marker>`, and the
 * marker alias `viborm_view_<hash>` is the last token of what PostgreSQL's
 * `pg_get_viewdef`, MySQL's `VIEW_DEFINITION` and SQLite's `sqlite_master.sql`
 * give back (measured on PostgreSQL 18, PGlite, MySQL 8.4 and SQLite 3.53;
 * each planner flattens the wrapper). It is lowercase because MySQL lowercases
 * an alias where a column names it. A view without the marker is not VibORM's.
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import { childrenBeforeParents, type TableReference } from "./drop-order";
import type { DiffOperation, SchemaSnapshot, ViewDef } from "./types";

const VIEW_HASH = /^[0-9a-f]{40}$/;
const MARKER_PREFIX = "viborm_view_";

/**
 * The marker at the end of a view's definition, as every catalog prints it:
 * the closing parenthesis of the wrapped body, an optional `AS` (SQLite keeps
 * it, PostgreSQL and MySQL drop it), the alias bare or quoted, and an optional
 * `;` (PostgreSQL's). Anchored at the end of the text, so a string literal in
 * the body that spells a marker is never read as one. The same text is a
 * PostgreSQL regular expression, which the catalog digest applies in SQL.
 */
export const VIEW_MARKER_PATTERN = String.raw`\)\s*(?:[Aa][Ss]\s+)?["\x60]?${MARKER_PREFIX}([0-9a-f]{40})["\x60]?\s*;?\s*$`;
const VIEW_MARKER = new RegExp(VIEW_MARKER_PATTERN);

/** Whether `value` has a view hash's form: 40 lowercase hex characters. */
export function isViewHash(value: unknown): value is string {
  return typeof value === "string" && VIEW_HASH.test(value);
}

/** The alias that carries a view's identity in the database. */
export function viewMarker(hash: string): string {
  return `${MARKER_PREFIX}${hash}`;
}

/**
 * What follows `CREATE VIEW <name> AS`: the body wrapped so that the marker
 * is its last token. `quote` is the dialect's identifier quoting.
 */
export function wrappedViewBody(
  view: ViewDef,
  quote: (name: string) => string
): string {
  if (view.sql === undefined)
    throw new MigrationError(
      `The view "${view.name}" was read from the database, and this schema does not declare it, so nothing says how to create it again.`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { relation: view.name, feature: "view" } }
    );
  return `SELECT * FROM (${view.sql}) AS ${quote(viewMarker(view.hash))}`;
}

/**
 * The hash a view definition's marker names, or undefined when the definition
 * does not end with one (a view VibORM did not create).
 */
export function readViewMarker(
  definition: string | null | undefined
): string | undefined {
  if (definition === null || definition === undefined) return;
  return VIEW_MARKER.exec(definition)?.[1];
}

/** A program operation on a view. */
type ViewOperation = Extract<
  DiffOperation,
  { type: "createView" } | { type: "dropView" }
>;

function isViewOperation(operation: DiffOperation): operation is ViewOperation {
  return operation.type === "createView" || operation.type === "dropView";
}

/**
 * The tables an operation changes in a way a view reading them does not
 * survive everywhere: PostgreSQL refuses a column type change and a table
 * drop under a view (and an enum recreation retypes its columns), MySQL's
 * view breaks on a column rename, SQLite rewrites a view's text on a rename
 * and refuses to rebuild a table a view reads (a key, a unique or a column
 * change rebuilds one there). Only an index's creation or drop leaves every
 * view as it was.
 */
function changedTables(operations: readonly DiffOperation[]): Set<string> {
  const names = new Set<string>();
  for (const operation of operations) {
    switch (operation.type) {
      case "renameTable":
        names.add(operation.from).add(operation.to);
        break;
      case "createTable":
        names.add(operation.table.name);
        break;
      case "alterEnum":
      case "dropEnum":
        for (const column of operation.dependentColumns ?? [])
          names.add(column.tableName);
        break;
      case "createIndex":
      case "dropIndex":
      case "createEnum":
      case "createView":
      case "dropView":
        break;
      default:
        names.add(operation.tableName);
    }
  }
  return names;
}

const byName = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

/**
 * The views of `views` named in `names`, each before every one it reads when
 * `dependentsFirst` (the order their drops need), after them otherwise (the
 * order their creations need). A cycle, which no database admits, keeps name
 * order.
 */
export function orderViews(
  names: ReadonlySet<string>,
  views: readonly ViewDef[],
  dependentsFirst: boolean
): string[] {
  const reads = new Map(views.map((view) => [view.name, view.dependsOn]));
  const references: TableReference[] = [];
  for (const name of names)
    for (const read of reads.get(name) ?? [])
      if (read !== name && names.has(read))
        references.push({ from: name, to: read });
  const { ordered, blocked } = childrenBeforeParents(
    [...names].sort(byName),
    (name) => name,
    references
  );
  const dependents = [...ordered, ...blocked];
  return dependentsFirst ? dependents : dependents.reverse();
}

/**
 * A prepared program with its views where they must run. The differ plans a
 * view's drop and creation when its hash changes or it is declared on one
 * side only; this adds the one rule the program decides: a view is dropped
 * and created again when a table it reads is changed by the program (see
 * `changedTables`), or a view it reads is dropped, transitively. Every drop
 * runs first, dependents before what they read, and every creation last,
 * after what it reads: no table or enum operation runs under a view.
 */
export function withViewReplacements(
  operations: readonly DiffOperation[],
  current: SchemaSnapshot,
  desired: SchemaSnapshot
): DiffOperation[] {
  const rest = operations.filter((operation) => !isViewOperation(operation));
  const dropped = new Set<string>();
  const created = new Map<string, ViewDef>();
  for (const operation of operations) {
    if (operation.type === "dropView") dropped.add(operation.viewName);
    if (operation.type === "createView")
      created.set(operation.view.name, operation.view);
  }
  const declared = new Map(
    (desired.views ?? []).map((view) => [view.name, view])
  );
  const changed = changedTables(rest);
  const live = current.views ?? [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const view of live) {
      if (dropped.has(view.name)) continue;
      const kept = declared.get(view.name);
      const reads = [...view.dependsOn, ...(kept?.dependsOn ?? [])];
      if (!reads.some((name) => changed.has(name) || dropped.has(name)))
        continue;
      dropped.add(view.name);
      if (kept) created.set(kept.name, kept);
      grew = true;
    }
  }
  if (dropped.size === 0 && created.size === 0) return rest;
  return [
    ...orderViews(dropped, live, true).map(
      (viewName): DiffOperation => ({ type: "dropView", viewName })
    ),
    ...rest,
    ...orderViews(new Set(created.keys()), [...created.values()], false).map(
      (name): DiffOperation => ({
        type: "createView",
        view: created.get(name)!,
      })
    ),
  ];
}

/** One relation of the live namespace, as a dialect's preflight reads it. */
export interface LiveRelation {
  readonly name: string;
  /** `other`: what is neither a table nor a view (a materialized view). */
  readonly kind: "table" | "view" | "other";
  /** A view's definition as its catalog prints it. */
  readonly definition?: string | null | undefined;
}

/**
 * Refuses, before any effect, a name the snapshots declare that the database
 * holds as something VibORM cannot take over: a declared table that is a view
 * without VibORM's marker (or any other relation that is not a table), and a
 * declared view that is a table no snapshot declares, or a view without the
 * marker. A marked view is VibORM's: the program drops or keeps it. A table a
 * snapshot declares is the history's: it drops it before the view.
 */
export function refuseRelationCollision(
  database: string,
  snapshots: readonly SchemaSnapshot[],
  relations: readonly LiveRelation[]
): void {
  const tables = new Set(
    snapshots.flatMap((snapshot) => snapshot.tables.map(({ name }) => name))
  );
  const views = new Set(
    snapshots.flatMap((snapshot) =>
      (snapshot.views ?? []).map(({ name }) => name)
    )
  );
  for (const relation of relations) {
    const foreignView =
      relation.kind === "other" ||
      (relation.kind === "view" &&
        readViewMarker(relation.definition) === undefined);
    if (tables.has(relation.name) && foreignView)
      throw new MigrationError(
        `${database} relation "${relation.name}" is a ${relation.kind === "view" ? "view" : "materialized view"} VibORM did not create, but this schema declares a table. Synchronization refuses before effects and preserves the view.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { table: relation.name, feature: "view" } }
      );
    if (
      views.has(relation.name) &&
      !tables.has(relation.name) &&
      (relation.kind === "table" || foreignView)
    )
      throw new MigrationError(
        `${database} relation "${relation.name}" is a ${relation.kind === "table" ? "table" : relation.kind === "view" ? "view VibORM did not create" : "materialized view"}, but this schema declares a view of that name. Synchronization refuses before effects and preserves it: drop or rename it yourself, or give the view another name.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { relation: relation.name, feature: "view" } }
      );
  }
}
