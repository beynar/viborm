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
 * A materialized view's definition ends with it the same way (measured on
 * PostgreSQL 18 and PGlite).
 */

import { MigrationError, VibORMErrorCode } from "../errors";
import {
  autoViewBodyName,
  autoViewObjectName,
} from "../schema/view/auto-names";
import { childrenBeforeParents, type TableReference } from "./drop-order";
import type {
  AutoViewObject,
  AutoViewStorage,
  DiffOperation,
  IndexDef,
  SchemaSnapshot,
  ViewDef,
} from "./types";

const VIEW_HASH = /^[0-9a-f]{40}$/;
const byName = (a: string, b: string): number => (a < b ? -1 : Number(a > b));
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
 * The objects a `refresh: "auto"` view needs on a dialect whose triggers are
 * named apart from a function, beside `extra`: its three triggers on its
 * source and the view that holds its body, sorted by kind then name.
 */
export function autoViewObjects(
  view: string,
  storage: AutoViewStorage,
  extra: readonly AutoViewObject[] = []
): AutoViewObject[] {
  const triggers = ["_d", "_i", "_u"].map(
    (suffix): AutoViewObject => ({
      kind: "trigger",
      name: autoViewObjectName(view, suffix),
      table: storage.source,
    })
  );
  return sortAutoViewObjects([
    ...extra,
    ...triggers,
    { kind: "view", name: autoViewBodyName(view) },
  ]);
}

/** Objects sorted by kind then name, the order a snapshot and its introspection hold them in. */
export function sortAutoViewObjects(
  objects: readonly AutoViewObject[]
): AutoViewObject[] {
  const order = (object: AutoViewObject) =>
    `${object.kind}\u0000${object.name}`;
  return [...objects].sort((a, b) => byName(order(a), order(b)));
}

/** Whether two snapshots hold one view's keepers alike: one missing or moved replaces the view. */
export function sameAutoViewObjects(
  current: ViewDef | undefined,
  desired: ViewDef
): boolean {
  const key = (view: ViewDef | undefined) =>
    JSON.stringify(
      view?.auto?.objects.map(({ kind, name, table }) => [kind, name, table])
    );
  return key(current) === key(desired);
}

/** A table of the live namespace whose marker says it holds a view kept by triggers. */
export interface LiveAutoTable {
  readonly name: string;
  readonly hash: string;
  /** Its indexes beside its primary key, read as a table's. */
  readonly indexes: readonly IndexDef[];
}

/** A trigger or a function of the live namespace that carries a marker. */
export interface LiveAutoKeeper extends AutoViewObject {
  readonly kind: "function" | "trigger";
  /** The hash its marker names. */
  readonly hash: string;
}

/** The hash a keeper's text names in its marker, wherever it stands in it. */
export function readKeeperMarker(
  text: string | null | undefined
): string | undefined {
  return text?.match(KEEPER_MARKER)?.[1];
}
const KEEPER_MARKER = new RegExp(`${MARKER_PREFIX}([0-9a-f]{40})`);

/**
 * The views kept by triggers of a live namespace, each a marked table with
 * the objects that carry its marker under the names its view gives them
 * (two views of one declaration share a hash, never a name), its body's
 * view taken out of `views`. One missing is missing from its objects, which
 * the declared view then does not match.
 */
export function readAutoViews(
  tables: readonly LiveAutoTable[],
  keepers: readonly LiveAutoKeeper[],
  views: ViewDef[]
): ViewDef[] {
  return tables.map(({ name, hash, indexes }) => {
    const objects: AutoViewObject[] = [];
    const names = new Set(
      ["", "_i", "_u", "_d"].map((suffix) => autoViewObjectName(name, suffix))
    );
    for (const keeper of keepers)
      if (
        keeper.hash === hash &&
        (names.has(keeper.name) ||
          (keeper.table !== undefined &&
            keeper.name === autoViewObjectName(name, `_on_${keeper.table}`)))
      )
        objects.push({
          kind: keeper.kind,
          name: keeper.name,
          ...(keeper.table === undefined ? {} : { table: keeper.table }),
        });
    const at = views.findIndex(
      (view) => view.name === autoViewBodyName(name) && view.hash === hash
    );
    const [body] = at < 0 ? [] : views.splice(at, 1);
    if (body) objects.push({ kind: "view", name: body.name });
    return {
      name,
      hash,
      dependsOn: body?.dependsOn ?? [],
      ...(indexes.length > 0 ? { indexes: [...indexes] } : {}),
      auto: { objects: sortAutoViewObjects(objects) },
    };
  });
}

/** The drop of `view`, as the snapshot that holds it says it is stored. */
export function dropViewOperation(view: ViewDef): DropViewOperation {
  return {
    type: "dropView",
    viewName: view.name,
    ...(view.materialized ? { materialized: true } : {}),
    ...(view.auto ? { auto: view.auto } : {}),
  };
}

/**
 * The tables whose change a view kept by triggers does not survive, beside
 * what its body reads: each table a trigger of it fires on (its source, and
 * on MySQL each parent of a cascade) and each child such a trigger changes.
 * Its triggers name their columns, and none of them follows a change: a
 * plpgsql body is checked when it runs, MySQL keeps a trigger's text as
 * written, and SQLite drops a table's triggers when it rebuilds it.
 */
function watchedTables(view: ViewDef | undefined): string[] {
  const auto = view?.auto;
  if (auto === undefined) return [];
  return [
    ...auto.objects.flatMap(({ table }) => (table ? [table] : [])),
    ...(auto.storage?.cascades ?? []).flatMap(({ children }) =>
      children.map(({ table }) => table)
    ),
  ];
}

/** A view's body, to create it with: a view read from the database has none. */
export function declaredViewSql(view: ViewDef): string {
  if (view.sql === undefined)
    throw new MigrationError(
      `The view "${view.name}" was read from the database, and this schema does not declare it, so nothing says how to create it again.`,
      VibORMErrorCode.MIGRATION_INVALID_STATE,
      { meta: { relation: view.name, feature: "view" } }
    );
  return view.sql;
}

/** How to create a view kept by triggers: a view read from the database has none. */
export function declaredAutoViewStorage(view: ViewDef): AutoViewStorage {
  const storage = view.auto?.storage;
  if (storage === undefined) declaredViewSql({ ...view, sql: undefined });
  return storage!;
}

/**
 * What follows `CREATE VIEW <name> AS`: the body wrapped so that the marker
 * is its last token. `quote` is the dialect's identifier quoting.
 */
export function wrappedViewBody(
  view: ViewDef,
  quote: (name: string) => string,
  columns = "*"
): string {
  return `SELECT ${columns} FROM (${declaredViewSql(view)}) AS ${quote(viewMarker(view.hash))}`;
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

/**
 * The hash a view table's comment names, where SurrealDB keeps the marker
 * (`DEFINE TABLE … AS SELECT … COMMENT "<marker>"`, which `INFO FOR DB`
 * reports apart from the body): the marker alone, or undefined.
 */
export function readViewComment(
  comment: string | null | undefined
): string | undefined {
  const hash = comment?.startsWith(MARKER_PREFIX)
    ? comment.slice(MARKER_PREFIX.length)
    : undefined;
  return isViewHash(hash) ? hash : undefined;
}

/** A program operation on a view. */
type ViewOperation = Extract<
  DiffOperation,
  { type: "createView" } | { type: "dropView" }
>;
type DropViewOperation = Extract<DiffOperation, { type: "dropView" }>;

function isViewOperation(operation: DiffOperation): operation is ViewOperation {
  return operation.type === "createView" || operation.type === "dropView";
}

/**
 * The tables an operation changes in a way a view reading them does not
 * survive. Everywhere: a table renamed, dropped or created again, a column
 * dropped, renamed or given another type (PostgreSQL refuses a type change
 * and a drop under a view, and its enum recreation retypes columns; MySQL's
 * view breaks on a rename; SQLite rewrites a view's text on a rename), and a
 * primary key added or dropped: no database refuses that under a view, but a
 * body orders its rows, and the rows of a relation it reads, by the key
 * (which row a `take` or a `distinct` keeps), so the view would stay as the
 * old key wrote it. Where the dialect `rebuilds` a table to change it
 * (SQLite: a column, a unique or a foreign key), every other change to the
 * table too, since it refuses to rebuild a table a view reads. Where a
 * foreign key's column holds `links` (SurrealDB stores a record link there,
 * and the plain value without the key), a foreign key added or dropped too:
 * a view's filter on the column was written for the other form, and would
 * match no row (measured). There a column changed in any way replaces the
 * view as well: its body is not SQL's, where a filter means the same under a
 * nullable column, but a filter lowered for the column as it was (a column
 * that becomes nullable needs a guard its filter did not have, without
 * which every write of `NULL` to the table fails; measured), and the view's
 * hash holds neither the body nor a column the query only filters by. And there a table's rename changes
 * every table holding a foreign key to it: the rename rewrites each link
 * held as a record of the new table, and a view's filter on that column,
 * written with a record of the old one, would match no row (measured). An index's creation or drop leaves
 * every view as it was, on every dialect. A materialized view is refused and
 * survives the same changes as an ordinary one (measured on PostgreSQL 18),
 * and keeps the rows it stored through the ones it survives.
 */
function changedTables(
  operations: readonly DiffOperation[],
  current: SchemaSnapshot,
  rebuilds: boolean,
  links: boolean
): Set<string> {
  const names = new Set<string>();
  for (const operation of operations) {
    switch (operation.type) {
      case "renameTable":
        names.add(operation.from).add(operation.to);
        if (links)
          for (const table of current.tables)
            if (
              table.foreignKeys.some(
                (key) => key.referencedTable === operation.from
              )
            )
              names.add(table.name);
        break;
      case "createTable":
        names.add(operation.table.name);
        break;
      case "alterEnum":
      case "dropEnum":
        for (const column of operation.dependentColumns ?? [])
          names.add(column.tableName);
        break;
      case "dropTable":
      case "dropColumn":
      case "renameColumn":
      case "addPrimaryKey":
      case "dropPrimaryKey":
        names.add(operation.tableName);
        break;
      case "alterColumn":
        if (rebuilds || links || operation.from.type !== operation.to.type)
          names.add(operation.tableName);
        break;
      case "addForeignKey":
      case "dropForeignKey":
        if (rebuilds || links) names.add(operation.tableName);
        break;
      case "createIndex":
      case "dropIndex":
      case "createEnum":
      case "createView":
      case "dropView":
        break;
      default:
        if (rebuilds) names.add(operation.tableName);
    }
  }
  return names;
}

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
 * and created again when a table it reads is changed by the program in a
 * way it does not survive on this dialect (see `changedTables`; `rebuilds`
 * says the dialect rebuilds tables, `links` that a foreign key's column holds
 * record links), or a view it reads is dropped,
 * transitively. Every drop
 * runs first, dependents before what they read, and every creation last,
 * after what it reads: no table or enum operation runs under a view. A
 * replaced materialized view is created with its indexes, so an index
 * operation the differ planned on it goes.
 */
export function withViewReplacements(
  operations: readonly DiffOperation[],
  current: SchemaSnapshot,
  desired: SchemaSnapshot,
  rebuilds: boolean,
  links = false
): DiffOperation[] {
  const dropped = new Map<string, DropViewOperation>();
  const created = new Map<string, ViewDef>();
  for (const operation of operations) {
    if (operation.type === "dropView")
      dropped.set(operation.viewName, operation);
    if (operation.type === "createView")
      created.set(operation.view.name, operation.view);
  }
  const declared = new Map(
    (desired.views ?? []).map((view) => [view.name, view])
  );
  const tableOperations = operations.filter(
    (operation) => !isViewOperation(operation)
  );
  const changed = changedTables(tableOperations, current, rebuilds, links);
  // What a view kept by triggers does not survive: any change but an index's.
  const rebuilt = changedTables(tableOperations, current, true, links);
  const live = current.views ?? [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const view of live) {
      if (dropped.has(view.name)) continue;
      const kept = declared.get(view.name);
      const reads = [...view.dependsOn, ...(kept?.dependsOn ?? [])];
      const watched = [...watchedTables(view), ...watchedTables(kept)];
      if (
        !(
          reads.some((name) => changed.has(name) || dropped.has(name)) ||
          watched.some((name) => rebuilt.has(name))
        )
      )
        continue;
      dropped.set(view.name, dropViewOperation(view));
      if (kept) created.set(kept.name, kept);
      grew = true;
    }
  }
  const rest = operations.filter(
    (operation) =>
      !(
        isViewOperation(operation) ||
        ((operation.type === "createIndex" || operation.type === "dropIndex") &&
          created.has(operation.tableName) &&
          dropped.has(operation.tableName))
      )
  );
  if (dropped.size === 0 && created.size === 0) return rest;
  return [
    ...orderViews(new Set(dropped.keys()), live, true).map(
      (name) => dropped.get(name)!
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
  readonly kind: "table" | "view" | "materialized view";
  /** A view's definition as its catalog prints it, materialized or not. */
  readonly definition?: string | null | undefined;
  /**
   * A view table's comment, where SurrealDB keeps the marker, and a table's
   * where it holds a view kept by triggers (SQLite's marker opening its
   * column list, as the comment it is).
   */
  readonly comment?: string | undefined;
}

/**
 * Refuses, before any effect, a name the snapshots declare that the database
 * holds as something VibORM cannot take over: a declared table that is a
 * view, materialized or not, without VibORM's marker, and a declared view
 * that is a table no snapshot declares, or a view without the marker. A
 * marked view of either kind is VibORM's: the program drops or keeps it. A
 * table a snapshot declares is the history's: it drops it before the view.
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
      relation.kind !== "table" &&
      (readViewMarker(relation.definition) ??
        readViewComment(relation.comment)) === undefined;
    if (tables.has(relation.name) && foreignView)
      throw new MigrationError(
        `${database} relation "${relation.name}" is a ${relation.kind} VibORM did not create, but this schema declares a table. Synchronization refuses before effects and preserves the view.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { table: relation.name, feature: "view" } }
      );
    // A table whose comment is a marker holds a view kept by triggers.
    const foreignTable =
      relation.kind === "table" &&
      readViewComment(relation.comment) === undefined;
    if (
      views.has(relation.name) &&
      !tables.has(relation.name) &&
      (foreignTable || foreignView)
    )
      throw new MigrationError(
        `${database} relation "${relation.name}" is a ${relation.kind === "table" ? "table" : `${relation.kind} ${relation.definition ? "VibORM did not create" : "whose definition this user cannot read, so nothing says VibORM created it (MySQL shows a view's definition to its definer and to a user granted SHOW VIEW)"}`}, but this schema declares a view of that name. Synchronization refuses before effects and preserves it: drop or rename it yourself, or give the view another name.`,
        VibORMErrorCode.MIGRATION_INVALID_STATE,
        { meta: { relation: relation.name, feature: "view" } }
      );
  }
}
