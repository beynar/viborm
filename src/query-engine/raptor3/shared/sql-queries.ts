/**
 * What reads and writes a statement in SQL. {@link Queries} owns the descriptions,
 * which no language appears in, and how rows are decoded; aliases, joins, CTEs and
 * flags belong to this language and live here. Another language answers the same
 * abstract members. See `docs/architecture/query-backend-frontier.md`.
 */

import type { ArithmeticTarget } from "@adapters/adapter-core-types";
import {
  adapterPinnedTable,
  assembleAdapterSelect,
} from "@adapters/adapter-internals";
import type { QueryParts } from "@adapters/adapter-query-parts";
import type {
  DatabaseAdapter,
  GeoPointSql,
  TextMatch,
} from "@adapters/database-adapter";
import {
  FeatureNotSupportedError,
  QueryEngineError,
  UnsupportedOperationError,
} from "@errors";
import {
  CURSOR_CARRIER_PREFIX,
  POLYMORPHIC_COLLECTION_ORPHANS_KEY,
} from "@query-engine/result-aliases";
import { jsonNullKindOf } from "@schema/json-null";
import {
  type AnyModel,
  findAddressableKey,
  getModelKeyCatalog,
} from "@schema/model";
import { slotMayBeEmpty } from "@schema/relation/clearability";
import type { ResolvedJunctionSide } from "@schema/relation/junction-topology";
import type { Scalar } from "@schema/scalars/base";
import type { ScalarState } from "@schema/scalars/common";
import type { NativeTypeDeclaration } from "@schema/scalars/native-types";
import { Sql, sql } from "@sql";
import { geoBoundsForDistance } from "@validation/primitives/geo-area-codec";
import type { GeoArea, GeoPoint } from "@validation/primitives/geo-values";
import {
  validateIsoDate,
  validateIsoTime,
  validateIsoTimestamp,
} from "@validation/primitives/iso";
import type { NormalizedRecurrence } from "@validation/relations/recurrence";
import { SqlSlot } from "../../../sql/slot";
import {
  canonicalDecimal,
  decimalMembers,
  decimalSumOperand,
  dividesByZero,
  exactDecimalDomain,
  requireDecimal,
} from "./decimal";
import {
  aggregatedIdentifier,
  encodeIdentifier,
  type IdentifierColumn,
  isCompact,
  transportedIdentifier,
} from "./identifier";
import { unreachable } from "./invariant";
import {
  AGGREGATES,
  type Aggregate,
  admittedTemporal,
  aggregateRow,
  approximateOrder,
  BOOLEAN_LEAF,
  type BoundOperand,
  type BoundOperation,
  balancedOr,
  type CarriedRow,
  type Closure,
  COUNT_LEAF,
  CURSOR_ORDER_REFUSAL,
  callerText,
  distanceUpperBound,
  type Enclosing,
  type FieldGate,
  type FlagChoice,
  type FlagMember,
  type FlagPlan,
  firstRow,
  foldKnownNulls,
  freeze,
  isAggregate,
  isParameterOperand,
  type Leaf,
  type LoweringFrame,
  memberRead,
  NO_GATES,
  NO_RELATIONS,
  type OperationPredicate,
  type OrderJoins,
  type OrderTerm,
  type PlacedBody,
  type PreparedDomain,
  type PreparedOperand,
  type PreparedPredicate,
  type PreparedProjection,
  type PreparedProjectionField,
  type PreparedRelationProjection,
  type PreparedScalar,
  type PreparedSelector,
  type PreparedTarget,
  type PreparedUpdate,
  type Quantified,
  Queries,
  type Query,
  RECURSIVE_CARRIER,
  type Read,
  ROOT_CANDIDATES,
  type RowCondition,
  readsAny,
  readsRelation,
  readUpdate,
  relations,
  reversedRows,
  rowIdentity,
  rowIn,
  rowSet,
  rowValue,
  type ScalarStateOf,
  type SelectControls,
  type Shape,
  type SharedBodies,
  type SharedBody,
  type SplitSumSql,
  sharedKey,
  states,
  type TestedColumns,
  throughDerived,
  wholeValue,
} from "./query";
import { type CallScope, Parameter, type RowPurpose } from "./row-scope";
import { RawRows, RowsOf } from "./rows-of";
import {
  type Arguments,
  entries,
  type Input,
  type ReadOperation,
  record,
} from "./schema";
import { linkMembers, type Membership, physicalField } from "./storage";

/** A select's controls, and a condition spelled for the alias this language gives it. */
export interface SqlSelectControls extends SelectControls {
  /** More of the root row's filter (a function: of its alias). */
  condition?: Sql | ((alias: string) => Sql);
  /** The first order term is a distance an index may serve: {@link approximateOrder}. */
  approximate?: boolean;
}

export class SqlQueries extends Queries {
  declare readonly adapter: DatabaseAdapter;

  /**
   * A raw `Sql` operand is PARENTHESIZED. A caller's fragment is an
   * expression, not a token: `views: { gte: ctx => ctx.sql\`SELECT MAX(...)\` }`
   * composed as `"views" >= SELECT MAX(…)` is a syntax error on every dialect,
   * and a fragment with its own operator would re-associate. The shipped
   * engine wrapped at this same seam (`where-builder.ts:472`, applied `:492`).
   */
  value(value: unknown): Sql {
    return value instanceof Sql
      ? callerText(this.settleRows(value))
      : this.adapter.literals.value(value);
  }

  #nextAlias = 0;
  /**
   * The statement's aliases that read a stored row of a model's table as it
   * stands ({@link table}), by model: a derived row (a produced row, a masked
   * or paged window, a locked source) is never one.
   */
  readonly #rows = new Map<string, AnyModel>();
  /**
   * The produced row a judgement is lowering over ({@link holds}): the alias
   * it is read under, and per field whether the value the write sets is
   * null, where the write states it.
   */
  #known:
    | { readonly alias: string; readonly nulls: ReadonlyMap<string, boolean> }
    | undefined;
  /**
   * The statement part lowering here reads a masked window (K5): its read-
   * gated columns are already NULL where their rows do not carry them.
   */
  #masked = false;
  /**
   * The relation filter bodies of the statement lowering here, where the
   * adapter shares them ({@link sharingBodies}).
   */
  #shared: SharedBodies | undefined;
  /**
   * The read lowering here is bounded: a unique, first or existence read, or
   * a `take` (`capabilities.joinsJunctionFilters`). Each read sets it; a
   * write's owner never reads, so its statements are never bounded.
   */
  #bounded = false;
  /**
   * `build`'s statement, where the adapter shares relation bodies
   * (`capabilities.sharesRelationBodies`): each body the statement lowers
   * more than once is stated once, in a `WITH` before it, as the key set
   * every arm repeating it tests ({@link relationExists}); a body lowered once
   * keeps its place, so a statement that repeats none is unchanged. One scope
   * per statement: a statement lowered inside another's joins it.
   *
   * A recursive filter's walk stays in place, and each key set is tested
   * where it is read, until the statement references more relations than
   * the adapter's `relationsPerStatement` ({@link relations}): then walks it
   * repeats become reaching sets ({@link sharedWalk}), those saving the most
   * relations first, until it fits, and if still over, rows join the key
   * sets they test ({@link flagging}), the largest saving first. Each costs
   * plans: a reaching set is computed for every row of its table (a check of
   * one row reads them all), and a joined flag member is read again per row
   * of a correlated subquery, where the test it replaces was hashed once
   * (PostgreSQL holds a one-column set as an array instead, computed once).
   * The bound is the driver's to state (Neki: 256); absent, nothing changes.
   */
  #sharingBodies(build: () => Sql): Sql {
    if (this.#shared !== undefined) return build();
    const shared: SharedBodies = {
      byKey: new Map(),
      order: [],
      attach: new Map(),
    };
    this.#shared = shared;
    let statement: Sql;
    try {
      statement = build();
    } finally {
      this.#shared = undefined;
    }
    const repeated: SharedBody[] = [];
    for (const body of shared.order)
      if (body.slots.length > 1) repeated.push(body);
      else body.slots[0]!.slot.settle(body.slots[0]!.inline);
    const walks = repeated.filter((body) => body.recursive === true);
    const budget = this.adapter.capabilities.relationsPerStatement;
    const settle = (
      reaching: ReadonlySet<SharedBody>,
      flagged: FlagChoice = () => [],
      materialized?: Set<SharedBody>,
      whole?: boolean
    ) =>
      this.#settled(
        statement,
        shared,
        repeated,
        reaching,
        flagged,
        materialized,
        whole
      );
    const materialized = new Set<SharedBody>();
    let query = settle(new Set(), undefined, materialized);
    // A walk its author states selective (the teams the actor belongs to,
    // through their subteams), read only inside bodies computed over their
    // whole tables, walks once per row of each in place: it is computed
    // once as a set instead, from the few rows it reaches back from. Read in
    // a body kept inlined (a body reading no other, or one read at a single
    // place, which PostgreSQL inlines), it stays: lifted, it would make that
    // body read a set, so computed over its whole table, and a keyed read
    // would lose its index (SQLite and D1 materialize it), or it would find
    // its seeds over their whole table where one row's walk reads a few.
    // Lifting one changes no body's form, so it needs no bound: a statement
    // past one starts from it.
    const lifted = new Set(
      walks.filter(
        (walk) =>
          walk.selective === true &&
          walk.slots.every(
            ({ within }) =>
              within?.body !== undefined && materialized.has(within.body)
          )
      )
    );
    if (lifted.size > 0) query = settle(lifted);
    if (budget === undefined) return query;
    let count = relations(query);
    if (count <= budget) return query;
    // Walks first, those saving the most relations, until the estimate fits;
    // then key sets joined, the largest saving first, until it does.
    const reaching = new Set<SharedBody>(lifted);
    for (const { body, saves } of this.#rankedWalks(query, walks)) {
      if (count <= budget) break;
      reaching.add(body);
      count -= saves;
    }
    query = settle(reaching);
    count = relations(query);
    if (count <= budget) return query;
    const largest: FlagChoice = (plans) =>
      [...plans]
        .sort((left, right) => right.saves - left.saves)
        .filter((plan) => {
          if (count <= budget) return false;
          count -= plan.saves;
          return true;
        });
    query = settle(reaching, largest);
    if (relations(query) <= budget) return query;
    // An estimate counts each walk or member where the others are not: one
    // nested in another saves less. Short, the most compact form.
    query = settle(new Set(walks), (plans) => plans);
    // Still over: one row, computed once, holds what the whole root read
    // tests, and `$exists` answers join it too (Neki only refuses here).
    return relations(query) <= budget || !this.adapter.arrays.ofRows
      ? query
      : settle(new Set(walks), (plans) => plans, undefined, true);
  }
  /**
   * `statement` with each repeated body stated once but walks outside
   * `reaching`, which stay in place, and the flag members `flagged` picks
   * ({@link flagging}) joined; `materialized` collects the relation bodies
   * it states computed over their whole tables: each reads another stated
   * body, so is not inlined, and is read at more than one place.
   */
  #settled(
    statement: Sql,
    shared: SharedBodies,
    repeated: readonly SharedBody[],
    reaching: ReadonlySet<SharedBody>,
    flagged: FlagChoice,
    materialized?: Set<SharedBody>,
    whole?: boolean
  ): Sql {
    const stated: SharedBody[] = [];
    for (const body of repeated)
      if (body.recursive !== true || reaching.has(body)) {
        stated.push(body);
        for (const placed of body.slots) placed.slot.settle(placed.use);
      } else for (const placed of body.slots) placed.slot.settle(placed.inline);
    for (const slots of shared.attach.values())
      for (const slot of slots) slot.settle(sql.empty);
    // A relation body is inlined where it reads no other shared body: a
    // nested one, inlined into every use of every body that reads it,
    // multiplies the plan (a 40-model policy's `can`: 9.8 s materialized,
    // 113 s inlined, 11 s inlining the leaves only).
    // By the slots a stated body settled to, not by text: a table may be
    // named like a body. The same pass finds the aliases each body joins
    // flags after ({@link flagging}).
    const uses = new Map<Sql, SharedBody>();
    for (const body of stated)
      for (const placed of body.slots) uses.set(placed.slot, body);
    // How many places the statement reads each stated body at.
    const readers = new Map<SharedBody, number>();
    const attached = new Map<Sql, string>();
    for (const [alias, slots] of shared.attach)
      for (const slot of slots) attached.set(slot, alias);
    const reads = new Set<SharedBody>();
    // The aliases the statement states (a body lowered more than once states
    // its first text only), by the first stated body holding each.
    const within = new Map<string, number>();
    const scan = (query: Sql, index: number, body?: SharedBody) => {
      Sql.peekRuns(query, (node) => {
        const used = uses.get(node);
        if (used !== undefined) {
          readers.set(used, (readers.get(used) ?? 0) + 1);
          if (body !== undefined) reads.add(body);
        }
        const alias = attached.get(node);
        if (alias !== undefined && !within.has(alias)) within.set(alias, index);
        return false;
      });
    };
    for (const [index, body] of stated.entries()) scan(body.query, index, body);
    scan(statement, stated.length);
    const flags = this.#flagging(
      shared,
      stated,
      within,
      flagged,
      whole ? readers : undefined
    );
    for (const body of stated)
      for (const placed of body.slots)
        placed.slot.settle(flags.atoms.get(placed) ?? placed.use);
    // Not inlined and read at two places or more: PostgreSQL materializes
    // such a member (it inlines one read once), SQLite is told to.
    if (materialized !== undefined)
      for (const body of reads)
        if (body.correlated && (readers.get(body) ?? 0) > 1)
          materialized.add(body);
    const definitions = stated.flatMap((body) => [
      ...(flags.held.has(body)
        ? []
        : body.recursive
          ? [{ name: body.name, query: body.query, recursive: true }]
          : [
              {
                name: body.name,
                query: body.query,
                inlined: body.correlated && !reads.has(body),
              },
            ]),
      ...(flags.after.get(body) ?? []),
    ]);
    return definitions.length === 0
      ? statement
      : sql`${this.adapter.cte.with(definitions)} ${statement}`;
  }
  /**
   * `walks`, placed in `query`, by how many relations stating each as a
   * reaching set saves where the others stay: the relations of each place
   * `query` reads it, less its set's and one per place. A walk `query` does
   * not read (lowered in a body stated elsewhere) saves nothing.
   */
  #rankedWalks(
    query: Sql,
    walks: readonly SharedBody[]
  ): { readonly body: SharedBody; readonly saves: number }[] {
    const of = new Map<Sql, SharedBody>();
    for (const body of walks)
      for (const placed of body.slots) of.set(placed.slot, body);
    const read = new Map<SharedBody, Sql[]>();
    relations(query, (fragment) => {
      const body = of.get(fragment);
      if (body === undefined) return;
      const places = read.get(body);
      if (places === undefined) read.set(body, [fragment]);
      else places.push(fragment);
    });
    return [...read]
      .map(([body, places]) => ({
        body,
        saves:
          places.reduce((sum, place) => sum + relations(place), 0) -
          relations(body.query) -
          places.length,
      }))
      .sort((left, right) => right.saves - left.saves);
  }
  /**
   * Where aliases test repeated bodies' key sets on the same columns more
   * often than joining them costs, and their `FROM` items can join them
   * ({@link attached}), each joins them ONCE: one `WITH` member holds each
   * key any set of a group holds, with one flag per set, `LEFT JOIN`ed after
   * the item on those columns, and each test reads its set's flag, `IS NOT
   * NULL` for an `EXISTS`, `IS NULL` for a `NOT EXISTS`: two-valued as they
   * are, a NULL key holding no flag. PlanetScale's Neki bounds one statement
   * to 256 relations and counts each test's `FROM` item; a member costs one
   * per set it reads (and its union one more), and each alias joining it
   * one. Aliases testing overlapping groups share one member of all their
   * sets where that costs less and every body joining it (`within`, the
   * first repeated body whose text holds the alias) follows its last set;
   * else each distinct group has its own, which always does: each set an
   * alias tests is lowered inside that alias's body. A member is stated
   * after the last set it reads. Where the dialect holds a value list
   * (`arrays.ofRows`, PostgreSQL), a group of one-column keys is instead one
   * row of arrays, one per set (each one relation, no union), `CROSS JOIN`ed,
   * each test `COALESCE(key = ANY(array), FALSE)` or its negation: a joined
   * flag member is read again for each row of a correlated subquery (a
   * nested include's 10x page read: 1.3 s in place, 5.1 s with flags, 1.4 s
   * with arrays), an array once per statement.
   */
  #flagging(
    shared: SharedBodies,
    repeated: readonly SharedBody[],
    within: ReadonlyMap<string, number>,
    flagged: FlagChoice,
    whole?: ReadonlyMap<SharedBody, number>
  ): {
    readonly atoms: Map<PlacedBody, Sql>;
    readonly after: Map<SharedBody, FlagMember[]>;
    readonly held: ReadonlySet<SharedBody>;
  } {
    const a = this.adapter;
    const atoms = new Map<PlacedBody, Sql>();
    const after = new Map<SharedBody, FlagMember[]>();
    const inRow = new Set<SharedBody>();
    const order = new Map(repeated.map((body, index) => [body, index]));
    const tested = new Map<string, TestedColumns>();
    // What `whole` joins once: each place of the root read, whatever it tests
    // of one column or none, reads the root's row.
    const { root } = shared;
    const rooted = new Set<Sql>();
    if (whole && root && within.has(root.alias))
      Sql.peekRuns(root.scope, (node) => {
        rooted.add(node);
        return false;
      });
    for (const body of repeated)
      for (const placed of body.slots) {
        const { test } = placed;
        const width = test.columns.length;
        const held = width < 2 && rooted.has(placed.slot);
        if (!(held || within.has(test.alias)) || (width === 0 && !whole))
          continue;
        const key = held ? "\0" : `${test.alias}\0${test.columns.join("\0")}`;
        let group = tested.get(key);
        if (group === undefined) {
          group = {
            test: held ? { ...test, alias: root!.alias, columns: [] } : test,
            bodies: [],
            placed: [],
          };
          tested.set(key, group);
        }
        group.placed.push([body, placed]);
        if (!group.bodies.includes(body)) group.bodies.push(body);
      }
    const byOrder = (left: SharedBody, right: SharedBody) =>
      order.get(left)! - order.get(right)!;
    // A one-column key set is held as an array where the dialect has one
    // (`arrays.ofRows`): one read per set, no union.
    const arrays = (width: number) =>
      width < 2 && a.arrays.ofRows !== undefined;
    const member = (sets: number, width: number) =>
      sets === 1 || arrays(width) ? sets : sets + 1;
    const tests = (groups: readonly TestedColumns[]) =>
      groups.reduce((sum, group) => sum + group.placed.length, 0);
    // Each distinct group's own member, where it costs less than its tests.
    const own = (groups: readonly TestedColumns[]) => {
      const combinations = new Map<string, TestedColumns[]>();
      for (const group of groups) {
        const combination = [...group.bodies]
          .sort(byOrder)
          .map((body) => body.name)
          .join(",");
        const same = combinations.get(combination);
        if (same === undefined) combinations.set(combination, [group]);
        else same.push(group);
      }
      return [...combinations.values()].map((same) => {
        const sets = [...same[0]!.bodies].sort(byOrder);
        return {
          sets,
          groups: same,
          saves:
            tests(same) -
            member(sets.length, same[0]!.test.columns.length) -
            same.length,
        };
      });
    };
    // Groups of one key width that share a set, joined transitively: a
    // group testing once gains nothing by a join.
    const components: TestedColumns[][] = [];
    for (const group of tested.values()) {
      if (group.placed.length < 2) continue;
      const joined = components.filter((component) =>
        component.some(
          (other) =>
            Math.max(other.test.columns.length, 1) ===
              Math.max(group.test.columns.length, 1) &&
            other.bodies.some((body) => group.bodies.includes(body))
        )
      );
      const merged = [group, ...joined.flat()];
      for (const component of joined)
        components.splice(components.indexOf(component), 1);
      components.push(merged);
    }
    const plans: FlagPlan[] = components.flatMap((component) => {
      const separate = own(component).filter((plan) => plan.saves > 0);
      const sets = [
        ...new Set(component.flatMap((group) => group.bodies)),
      ].sort(byOrder);
      const last = order.get(sets.at(-1)!)!;
      const together = {
        sets,
        groups: component,
        saves:
          tests(component) -
          member(sets.length, component[0]!.test.columns.length) -
          component.length,
      };
      const ordered = component.every(
        (group) => within.get(group.test.alias)! > last
      );
      return ordered &&
        together.saves > separate.reduce((sum, plan) => sum + plan.saves, 0)
        ? [together]
        : separate;
    });
    const joins = new Map<string, Sql[]>();
    let named = shared.order.length;
    const chosen = new Set(flagged(plans));
    for (const { sets, groups } of plans.filter((plan) => chosen.has(plan))) {
      const keys = groups[0]!.test.columns.map((_, index) => `k${index}`);
      const name = `__shared_${named++}`;
      const last = sets.at(-1)!;
      const held = arrays(keys.length);
      // A set only this row reads is written in it, with no member to read.
      const own = new Set(
        whole && held
          ? sets.filter(
              (body) =>
                !body.recursive &&
                groups
                  .flatMap((group) => group.placed)
                  .filter(([placedBody]) => placedBody === body).length ===
                  whole.get(body)
            )
          : []
      );
      for (const body of own) inRow.add(body);
      after.set(last, [
        ...(after.get(last) ?? []),
        {
          name,
          query: held ? this.#keyArrays(sets, own) : this.#flagSet(sets, keys),
          inlined: false,
        },
      ]);
      for (const { test, placed } of groups) {
        const flag = this.alias();
        const member = a.identifiers.aliased(a.identifiers.escape(name), flag);
        const joined = joins.get(test.alias) ?? [];
        joined.push(
          held
            ? a.joins.cross(member)
            : a.joins.left(
                member,
                a.operators.and(
                  ...test.columns.map((column, index) =>
                    a.operators.eq(
                      a.identifiers.column(flag, keys[index]!),
                      a.identifiers.column(test.alias, column)
                    )
                  )
                )
              )
        );
        joins.set(test.alias, joined);
        for (const [body, slot] of placed) {
          const index = sets.indexOf(body);
          if (held) {
            const column = a.identifiers.column(flag, `f${index}`);
            // Two-valued as the EXISTS it replaces: a NULL key, or a key an
            // array holding a NULL does not hold, is not held.
            const holds =
              slot.test.columns.length === 0
                ? column
                : a.expressions.coalesce(
                    a.arrays.has(
                      column,
                      a.identifiers.column(
                        slot.test.alias,
                        slot.test.columns[0]!
                      )
                    ),
                    a.literals.false()
                  );
            atoms.set(slot, slot.test.holds ? holds : a.operators.not(holds));
            continue;
          }
          const flagged = a.identifiers.column(
            flag,
            sets.length === 1 ? keys[0]! : `f${index}`
          );
          atoms.set(
            slot,
            slot.test.holds
              ? a.operators.isNotNull(flagged)
              : a.operators.isNull(flagged)
          );
        }
      }
    }
    for (const [alias, slots] of shared.attach) {
      const joined = joins.get(alias);
      if (joined === undefined) continue;
      for (const slot of slots) slot.settle(sql` ${sql.join(joined, " ")}`);
    }
    return { atoms, after, held: inRow };
  }
  /**
   * One row holding each of `bodies`' one-column key sets as an array, `f<n>`
   * for the n-th ({@link DatabaseAdapter.arrays.ofRows}), and an `$exists`
   * body's answer as itself: computed once per statement, each row joining it
   * tests membership without reading a set again.
   */
  #keyArrays(bodies: readonly SharedBody[], own: ReadonlySet<SharedBody>): Sql {
    const a = this.adapter;
    return a.clauses.select(
      sql.join(
        bodies.map((body, index) =>
          a.identifiers.aliased(
            body.slots[0]!.test.columns.length === 0
              ? own.has(body)
                ? a.filters.some(body.query)
                : body.slots[0]!.use
              : a.arrays.ofRows!(
                  own.has(body)
                    ? body.query
                    : assembleAdapterSelect(a, {
                        columns: a.identifiers.column(body.name, "k0"),
                        from: memberRead(a, body.name),
                      })
                ),
            `f${index}`
          )
        ),
        ", "
      )
    );
  }
  /**
   * The keys `bodies`' sets hold, once each: with one set, its keys; with
   * more, each key and per set `f<n>`, 1 where that set holds the key and
   * NULL where it does not.
   */
  #flagSet(bodies: readonly SharedBody[], keys: readonly string[]): Sql {
    const a = this.adapter;
    if (bodies.length === 1) {
      const columns = keys.map((key) =>
        a.identifiers.column(bodies[0]!.name, key)
      );
      return assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: memberRead(a, bodies[0]!.name),
        groupBy: sql.join(columns, ", "),
      });
    }
    const flags = bodies.map((_, index) => `f${index}`);
    // Typed: PostgreSQL types a bare NULL arm by arm, as text.
    const absent = a.expressions.cast(a.literals.null(), "integer");
    const arms = bodies.map((body, member) =>
      assembleAdapterSelect(a, {
        columns: sql.join(
          [
            ...keys.map((key) =>
              a.identifiers.aliased(a.identifiers.column(body.name, key), key)
            ),
            ...flags.map((flag, index) =>
              a.identifiers.aliased(index === member ? sql`1` : absent, flag)
            ),
          ],
          ", "
        ),
        from: memberRead(a, body.name),
      })
    );
    // A transport bounding a compound's terms (D1: 5) reads a longer union
    // through derived tables of at most that many.
    const bound = a.capabilities.compoundSelectTerms ?? arms.length;
    const union = (terms: readonly Sql[]): Sql =>
      terms.length <= bound
        ? a.setOperations.unionAll(...terms)
        : union(
            Array.from({ length: Math.ceil(terms.length / bound) }, (_, at) =>
              terms.slice(at * bound, (at + 1) * bound)
            ).map((chunk) =>
              chunk.length === 1
                ? chunk[0]!
                : throughDerived(
                    a,
                    a.setOperations.unionAll(...chunk),
                    this.alias()
                  )
            )
          );
    const held = this.alias();
    const columns = keys.map((key) => a.identifiers.column(held, key));
    return assembleAdapterSelect(a, {
      columns: sql.join(
        [
          ...columns,
          ...flags.map((flag) =>
            a.identifiers.aliased(
              a.aggregates.max(a.identifiers.column(held, flag)),
              flag
            )
          ),
        ],
        ", "
      ),
      from: a.subqueries.correlate(union(arms), held),
      groupBy: sql.join(columns, ", "),
    });
  }
  /**
   * A write's statement, sharing its bodies where the adapter does: every
   * repeated body its WHERE (and its produced row's judgement) lowers is one
   * `WITH` member ahead of the `UPDATE` or `DELETE`, as a read's is.
   */
  sharing(build: () => Sql): Sql {
    return this.#sharing(build)!;
  }
  /** `build`'s statement, sharing its bodies where the adapter does. */
  #sharing(build: () => Sql | undefined): Sql | undefined {
    if (!this.sharesBodies) return build();
    let built = true;
    const statement = this.#sharingBodies(() => {
      const made = build();
      built = made !== undefined;
      return made ?? sql.empty;
    });
    return built ? statement : undefined;
  }
  /** `args`, ordered by {@link defaultOrder} when it states no order. */
  #ordered(model: AnyModel, args: Arguments): Arguments {
    if (args.orderBy !== undefined) return args;
    const orderBy = this.defaultOrder(model);
    return orderBy === undefined ? args : { ...args, orderBy };
  }
  /** This view's `Queries` reading under `domain`, for `call`'s values. */
  override under(domain: PreparedDomain, call?: CallScope): Queries {
    return new SqlQueries(this.schema, this.adapter, this.result, domain, call);
  }
  /**
   * The rows a set computed over `model`'s whole table may hold while a
   * layer's predicates lower here: what its own `where` of related rows
   * states ({@link PreparedDomain.bound}), at `alias`. Rows reached through
   * a relation from a row it admits need none: they are such rows already.
   */
  #setBound(model: AnyModel, alias: string): readonly Sql[] {
    const bound = this.#boundOf(model);
    const lowered = bound && this.lowerSelector(bound, alias);
    return lowered ? [lowered] : [];
  }
  /**
   * What a declared junction's link rows may hold while a layer's predicates
   * lower here, where a positive test reads them ({@link setBound}), so a walk
   * reads its tenant's links rather than filtering the whole table's. Only a
   * bound over columns both of a link's keys hold: their foreign keys make them
   * the joined rows' own, so it changes no answer. Over any other column a link
   * may disagree with the rows it joins, and a bound would drop it. A generated
   * junction has no field to bound.
   */
  #linkBound(
    edge: Extract<Membership, { kind: "junction" }>,
    link: string
  ): readonly Sql[] {
    const model = edge.declared?.model;
    const bound = model && this.#boundOf(model);
    if (!bound) return [];
    const holds = (side: typeof edge.sourceSide, field: string) =>
      side.members.some((pair) => pair.junctionField === field);
    for (const field of bound.facts.fields)
      if (!(holds(edge.sourceSide, field) && holds(edge.targetSide, field)))
        return [];
    return this.#setBound(model, link);
  }
  /** {@link setBound}'s selector, where one applies here. */
  #boundOf(model: AnyModel): PreparedSelector | undefined {
    const excluded = this.excluded;
    return excluded === undefined ||
      excluded.length === 0 ||
      this.#negative ||
      this.#unbounded > 0
      ? undefined
      : this.domain?.bound(model, excluded);
  }
  /** How many read gates are lowering here: none of their sets is bounded. */
  #unbounded = 0;
  /** The relation bodies lowering here, innermost last ({@link Enclosing}). */
  readonly #enclosing: Enclosing[] = [];
  /** `lower`, read inside `enclosing`'s body ({@link Enclosing}). */
  #inside<T>(enclosing: Enclosing, lower: () => T): T {
    this.#enclosing.push(enclosing);
    try {
      return lower();
    } finally {
      this.#enclosing.pop();
    }
  }
  /**
   * Whether what lowers here stands negated (under a `NOT`, a `none`, an
   * `isNot`, an `unless`): a set bounded there would hold fewer rows, and
   * its negation more, so none is ({@link setBound}).
   */
  #negative = false;
  /** `lower` with the polarity of what it lowers turned over. */
  #opposite<T>(lower: () => T): T {
    this.#negative = !this.#negative;
    try {
      return lower();
    } finally {
      this.#negative = !this.#negative;
    }
  }
  /** Whether a layer's predicates are lowering here. */
  get #lowersLayer(): boolean {
    return (this.excluded?.length ?? 0) > 0;
  }
  alias(): string {
    return `q${this.#nextAlias++}`;
  }
  /**
   * The FIRST alias of one statement, which opens that statement's alias scope.
   *
   * An alias is a fact of the statement it names, not of this owner's history,
   * so a statement whose first alias is minted by one of the owners named
   * below starts at `q0`, and the same logical query always emits the same
   * text. Without it the engine-lifetime read owner
   * (`commands/index.ts`) minted `q0, q1, … q10000` for the SAME
   * `findUnique`, so its statement text was unique per call — measured as an
   * obstacle by the cutover protocol (`g4/cutover/protocol.md` §7.2) and a
   * guaranteed miss for any transport that caches by statement text
   * (PostgreSQL named statements, `mysql2`'s prepare cache, D1/PlanetScale).
   *
   * The statement owners are {@link select}, {@link aggregated},
   * {@link grouped}, {@link selectSeries} and {@link junction} — every method
   * here that assembles a complete statement —
   * and each calls this before any other alias of that statement. Nothing else
   * may: a `lower…` fragment continues the statement it is part of, because a
   * mutation statement is assembled from several of them by the physical owner
   * (`OperationContext`'s `lowerMutationLimit` + `lowerProjection` pair) and
   * two fragments of ONE statement must not both start at `q0`. For the same
   * reason no statement owner may be entered while another statement is being
   * built: a nested complete statement is a subquery of its parent and shares
   * the parent's scope, which is why the nested relation projection, the
   * correlated count and the cursor window mint plain {@link alias}es.
   */
  #rootAlias(): string {
    this.#nextAlias = 0;
    this.#rows.clear();
    return this.alias();
  }
  /**
   * `model`'s table read as `alias`, followed, inside a statement sharing its
   * bodies, by the slot where `alias` joins the key sets it is tested
   * against ({@link sharingBodies}). Only where nothing after the item but
   * other joins and the clauses of its own query read `alias`.
   */
  #attached(model: AnyModel, alias: string): Sql {
    return sql`${this.table(model, alias)}${this.#attachPoint(alias)}`;
  }
  /** The slot after `alias`'s `FROM` item ({@link attached}). */
  #attachPoint(alias: string): Sql {
    const shared = this.#shared;
    if (shared === undefined) return sql.empty;
    const slot = new SqlSlot(sql.empty);
    const slots = shared.attach.get(alias);
    if (slots === undefined) shared.attach.set(alias, [slot]);
    else slots.push(slot);
    return slot;
  }
  /** A fresh alias for a stored row of `model`, known before its `FROM` is. */
  #rowAlias(model: AnyModel): string {
    const alias = this.alias();
    this.#rows.set(alias, model);
    return alias;
  }
  table(model: AnyModel, alias?: string): Sql {
    if (alias !== undefined) this.#rows.set(alias, model);
    return this.#tableNamed(model["~"].names.sql!, alias);
  }
  /** Every persistent table this lowering names: pinned under {@link rowsOf}. */
  #tableNamed(name: string, alias?: string): Sql {
    return (this.#pinned ?? this.adapter.identifiers.table)(name, alias);
  }
  #pinned: ((name: string, alias?: string) => Sql) | undefined;
  column(model: AnyModel, field: string, alias?: string): Sql {
    const name = this.columnName(model, field);
    return alias
      ? this.adapter.identifiers.column(alias, name)
      : this.adapter.identifiers.escape(name);
  }
  /**
   * A caller's fragment with every {@link RowsOf} in it settled to this
   * call's root domain at its alias (under its judgement, and its `where`,
   * where it states them): a read an extension writes takes the rows the
   * call may see, or write, as every read here does.
   */
  settleRows(fragment: Sql): Sql {
    Sql.each(fragment, (node) => {
      if (!(node instanceof RowsOf)) return;
      const { model } = node;
      // Settled here, it would take this call's domain, not its own client's.
      if (node instanceof RawRows)
        throw new UnsupportedOperationError(
          `${model["~"].names.ts}.$rows() is for a tagged $queryRaw only`
        );
      const domain = this.domainOf(model, "root", node.judgement);
      // A `where` the extension passes on is admitted as a `findMany`'s.
      const named =
        node.where === undefined
          ? domain
          : this.andSelectors(model, [
              ...(domain ? [domain] : []),
              this.prepareSelector(
                model,
                this.schema.admit(model, "findMany", { where: node.where })
                  .where
              ),
            ]);
      node.settle(
        (named && this.lowerSelector(named, node.alias)) ?? sql.raw("1 = 1")
      );
    });
    return fragment;
  }
  /**
   * The rows of `model` this view's call may read, as a `FROM` item named
   * `alias` (`$rows`): the domain a root `findMany` takes, in a derived
   * table, so the text around it cannot place it under an `OR` or an outer
   * join's `ON`. Inside, its own statement scope reads the row under a minted
   * alias, so no name the caller chooses meets one the lowering writes.
   */
  rowsOf(model: AnyModel, alias: string): Sql {
    const row = this.#rootAlias();
    const domain = this.domainOf(model, "root");
    // Every table pinned: the caller's text around it may define a CTE named
    // like a table the domain reads, which would otherwise stand for it.
    this.#pinned = adapterPinnedTable(this.adapter);
    try {
      return this.adapter.subqueries.rows(
        this.table(model, row),
        row,
        domain && this.lowerSelector(domain, row),
        alias,
        !model["~"].withoutRowid
      );
    } finally {
      this.#pinned = undefined;
    }
  }
  /**
   * The one destination-aware operand owner: filters, cursors, order operands,
   * assignments and reference values all bind a value through this function,
   * so a column is never written in one vocabulary and read in another.
   */
  fieldValue(model: AnyModel, field: string, value: unknown): Sql {
    return this.#scalarValue(
      physicalField(this.schema, model, field).scalar,
      value,
      field,
      this.scalarShape(model, field).id
    );
  }
  /**
   * `id` is the destination column's identifier storage, which the scalar
   * alone cannot answer: a foreign key DERIVES its domain and a private
   * carrier column names the key it stands in for. Only a COLUMN operand
   * carries native storage; min/max operands additionally pass through the
   * same transport expression their aggregate reads.
   */
  #scalarValue(
    scalar: Scalar,
    value: unknown,
    field: string,
    id?: IdentifierColumn
  ): Sql {
    const a = this.adapter;
    const state = scalar["~"].state;
    if (value instanceof Sql) {
      const fragment = callerText(this.settleRows(value));
      return state.type === "decimal" && state.array !== true
        ? a.expressions.decimalCast(fragment, state.decimal)
        : fragment;
    }
    const sentinel = jsonNullKindOf(value);
    if (sentinel)
      return sentinel === "DbNull" ? a.literals.null() : a.json.value(null);
    if (value === null || value === undefined) return a.literals.null();
    if (state.array === true && Array.isArray(value))
      return this.#listValue(state, value, field);
    // A COMPACT identifier binds its physical form — the payload's bytes, or
    // a PostgreSQL `uuid`'s canonical text — through the adapter's one
    // identifier literal. A text-stored domain holds the public string itself
    // and takes the ordinary arm below, byte for byte what it took before.
    if (isCompact(id))
      return a.literals.id(encodeIdentifier(id, value), id.representation);
    switch (state.type) {
      case "bigint":
        return a.literals.value(state.array === true ? String(value) : value);
      case "decimal":
      case "json":
      case "point":
      case "vector":
      case "datetime":
      case "date":
      case "time":
        return this.#typedScalarValue(scalar, value, field);
      default:
        return a.literals.value(value);
    }
  }
  /** The scalars whose operand spelling depends on their type, out of line. */
  #typedScalarValue(scalar: Scalar, value: unknown, field: string): Sql {
    const a = this.adapter;
    const state = scalar["~"].state;
    // A single value bound against a LIST field is one MEMBER of that field's
    // container (`has` is the operator that asks for one), and a container
    // carries what it was WRITTEN with — the same fact {@link nativeType}
    // already states for the decode leaf, which refuses to hand a list's
    // native type to a literal. The two scalars whose column spelling is
    // PHYSICAL have to consume it: a decimal's exact `DECIMAL(p,s)` operand
    // cast, and a datetime's dialect rendering of the instant (MySQL's naive
    // `DATETIME`, which a JSON container has no column to hold). Every other
    // scalar crosses a container exactly as it crosses its column.
    const member = state.array === true;
    switch (state.type) {
      case "decimal":
        return member
          ? a.literals.value(
              decimalMembers(state, [value], field, this.adapter.result)[0]!
            )
          : a.literals.decimal(
              canonicalDecimal(value, field),
              requireDecimal(state, field)
            );
      case "json":
        return a.literals.json(value);
      case "point":
        return this.#geoPoint("value").value(
          this.value((value as GeoPoint).longitude),
          this.value((value as GeoPoint).latitude)
        );
      case "vector":
        // Providers without a native vector tier store the admitted JSON array.
        return a.capabilities.supportsVector
          ? a.vector.literal(value as number[])
          : a.literals.json(value);
      case "datetime": {
        const wire = admittedTemporal(value, validateIsoTimestamp);
        return typeof wire === "string"
          ? a.literals.dateTime(
              wire,
              member ? undefined : this.nativeType(scalar),
              member
            )
          : a.literals.value(wire);
      }
      case "time": {
        const admitted = validateIsoTime(value);
        return a.literals.value("value" in admitted ? admitted.value : value);
      }
      case "date": {
        const wire = admittedTemporal(value, validateIsoDate);
        return typeof wire === "string"
          ? a.literals.dateTime(wire, undefined, member)
          : a.literals.value(wire);
      }
      default:
        return a.literals.value(value);
    }
  }
  /** A whole list, bound as the container the destination column stores. */
  #listValue(
    state: ScalarState,
    values: readonly unknown[],
    field: string
  ): Sql {
    if (state.type === "decimal")
      return this.adapter.arrays.value(
        decimalMembers(state, values, field, this.adapter.result)
      );
    return state.type === "enum"
      ? this.adapter.arrays.enumValue([...values])
      : this.adapter.arrays.value(
          [...values],
          state.type === "datetime" || state.type === "date"
            ? state.type
            : undefined
        );
  }
  /** The provider's settled point protocol, or its named capability refusal. */
  #geoPoint(usage: string): GeoPointSql {
    const geoPoint = this.adapter.geoPoint;
    if (!geoPoint)
      throw new FeatureNotSupportedError(
        "point",
        usage,
        "GeoPoint requires a provider with its physical point tier enabled."
      );
    return geoPoint;
  }
  projectedColumn(model: AnyModel, field: string, alias?: string): Sql {
    const column = this.column(model, field, alias);
    const leaf = this.scalarShape(model, field);
    const state = physicalField(this.schema, model, field).scalar["~"].state;
    if (state.type === "bigint" && state.array !== true)
      return this.adapter.expressions.cast(column, "text");
    if (
      state.array === true &&
      (state.type === "bigint" || state.type === "number")
    )
      return this.adapter.arrays.exactNumericProjection(column);
    if (
      state.type === "decimal" ||
      (state.type === "point" && state.array !== true)
    )
      return this.#projectedTypedColumn(state, column);
    return transportedIdentifier(this.adapter, leaf.id, column, leaf.nullable);
  }
  /** A decimal or point column's projection spelling, out of line. */
  #projectedTypedColumn(state: ScalarStateOf, column: Sql): Sql {
    if (state.type === "decimal")
      return state.array === true
        ? this.adapter.arrays.exactNumericProjection(column)
        : this.adapter.expressions.cast(column, "text");
    // A scalar point: a JSON document of its two coordinates.
    const geoPoint = this.#geoPoint("projection");
    const projected = this.adapter.json.objectFromColumns([
      [
        "longitude",
        this.adapter.json.document(
          this.adapter.json.number(geoPoint.longitude(column))
        ),
      ],
      [
        "latitude",
        this.adapter.json.document(
          this.adapter.json.number(geoPoint.latitude(column))
        ),
      ],
    ]);
    return state.nullable
      ? this.adapter.expressions.caseWhen(
          [
            {
              when: this.adapter.operators.isNull(column),
              then: this.adapter.literals.null(),
            },
          ],
          projected
        )
      : projected;
  }
  /**
   * A projected value carried INSIDE a JSON document. A value that is already
   * JSON stays a document; a value the container would round stays exact text.
   */
  #carriedValue(leaf: Shape | Leaf, expression: Sql): Sql {
    if (leaf.kind !== "scalar") return this.adapter.json.document(expression);
    // A decimal crossed the projection in the spelling {@link projectedColumn}
    // states — a text cast for a scalar, the adapter's decimal array
    // projection for a list — and its codec reads an exact value only from
    // that spelling: carried as a JSON number it is rounded by the container,
    // and carried as a JSON array its members are. This is the same physical
    // fact the projection stated, consumed rather than re-derived from the leaf.
    if (
      leaf.type === "decimal" ||
      ((leaf.type === "bigint" || leaf.type === "number") && leaf.list)
    )
      return leaf.list
        ? this.adapter.arrays.exactNumericProjection(expression)
        : this.adapter.expressions.cast(expression, "text");
    if (
      leaf.list ||
      leaf.type === "json" ||
      leaf.type === "point" ||
      leaf.type === "vector"
    )
      return this.adapter.json.document(expression);
    if (leaf.type === "bigint")
      return this.adapter.expressions.cast(expression, "text");
    if (leaf.type === "number") return this.adapter.json.number(expression);
    if (leaf.type === "blob")
      return this.adapter.expressions.caseWhen(
        [
          {
            when: this.adapter.operators.isNull(expression),
            then: this.adapter.literals.null(),
          },
        ],
        this.adapter.expressions.blobToHex(expression)
      );
    return expression;
  }
  junctionWhere(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    alias?: string
  ): Sql {
    return this.adapter.operators.and(
      ...linkMembers(edge)
        .filter(({ pair }) => Object.hasOwn(values, pair.junctionField))
        .map(({ side, pair }) =>
          this.adapter.operators.eq(
            alias
              ? this.adapter.identifiers.column(alias, pair.junctionField)
              : this.adapter.identifiers.escape(pair.junctionField),
            this.fieldValue(
              side.model,
              pair.referencedField,
              values[pair.junctionField]
            )
          )
        )
    );
  }
  junctionSideConditions(
    side: ResolvedJunctionSide,
    junctionAlias: string | undefined,
    endpoint: string | Input | CarriedRow
  ): Sql[] {
    const a = this.adapter;
    return side.members.map((pair) =>
      a.operators.eq(
        junctionAlias
          ? a.identifiers.column(junctionAlias, pair.junctionField)
          : a.identifiers.escape(pair.junctionField),
        typeof endpoint === "string"
          ? this.column(side.model, pair.referencedField, endpoint)
          : typeof endpoint === "function"
            ? endpoint(pair.referencedField)
            : this.fieldValue(
                side.model,
                pair.referencedField,
                endpoint[pair.referencedField]
              )
      )
    );
  }
  override junction(
    edge: Extract<Membership, { kind: "junction" }>,
    values: Input,
    forUpdate = false
  ): Query {
    const a = this.adapter;
    const alias = this.#rootAlias();
    const owner =
      edge.uniqueSide === "target" ? edge.sourceSide : edge.targetSide;
    const fields: Record<string, Leaf> = {};
    const columns = owner.members.map((pair) => {
      const shape = this.scalarShape(owner.model, pair.referencedField);
      fields[pair.junctionField] = shape;
      const column = a.identifiers.column(alias, pair.junctionField);
      return a.identifiers.aliased(
        shape.type === "decimal" || shape.type === "bigint"
          ? a.expressions.cast(column, "text")
          : transportedIdentifier(a, shape.id, column, shape.nullable),
        pair.junctionField
      );
    });
    return {
      sql: assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: this.#tableNamed(edge.table, alias),
        where: this.junctionWhere(edge, values, alias),
        forUpdate,
      }),
      shape: { kind: "object", fields },
    };
  }
  /** The payload {@link readUpdate} reads, refused where it cannot run. */
  #prepareUpdate(
    model: AnyModel,
    field: string,
    value: unknown
  ): PreparedUpdate {
    const update = readUpdate(value);
    // An exact decimal divided by zero fails HERE, before any statement is
    // issued: the operand's value is knowable and every dialect answers it
    // differently otherwise (SQLite NULL, MySQL NULL or an error,
    // PostgreSQL raises). The shipped refusal, verbatim.
    if (
      update.kind === "arithmetic" &&
      update.operator === "divide" &&
      exactDecimalDomain(
        physicalField(this.schema, model, field).scalar["~"].state
      ) &&
      dividesByZero(update.by)
    )
      throw new QueryEngineError(
        `Cannot divide decimal field '${field}' by zero.`
      );
    return update;
  }
  /**
   * The target domain an arithmetic assignment lands back inside: an integer
   * column divides as an integer, an exact decimal is quantized to its scale.
   * The adapter owns both spellings; this only names the destination.
   */
  #arithmeticTarget(model: AnyModel, field: string): ArithmeticTarget {
    const state = physicalField(this.schema, model, field).scalar["~"].state;
    return {
      integer: state.type === "int" || state.type === "bigint",
      decimal: exactDecimalDomain(state),
    };
  }
  /**
   * One admitted update payload as the provider's own `SET` assignment. Every
   * operator crosses through the adapter's `set` vocabulary, so the dialect owns
   * integer truncation, decimal quantization and list concatenation, and the
   * query owner spells no arithmetic of its own.
   */
  override updateAssignment(
    model: AnyModel,
    field: string,
    value: unknown
  ): Sql {
    const a = this.adapter;
    const column = this.column(model, field);
    const update = this.#prepareUpdate(model, field, value);
    if (update.kind === "value")
      return a.set.assign(column, this.fieldValue(model, field, update.value));
    if (update.kind === "list")
      return a.set[update.operator](
        column,
        this.fieldValue(model, field, update.members)
      );
    return a.set[update.operator](
      column,
      this.fieldValue(model, field, update.by),
      this.#arithmeticTarget(model, field)
    );
  }
  /**
   * The same admitted update payload named over an ALREADY-KNOWN value: the
   * key a row will carry after the mutation, which a non-returning readback and
   * a relation-key transition both have to state in SQL.
   *
   * Every operator is named through the SAME adapter vocabulary its assignment
   * uses, so the expression and the `SET` clause cannot disagree: `+`, `-` and
   * `*` are the dialect's own native arithmetic in every non-decimal domain,
   * and an integer `divide` asks `expressions.integerDivide` for the dialect's
   * truncation — the same provider fact `set.divide`'s `target.integer` flag
   * carries, in expression form.
   *
   * The one shape with no expression form is an EXACT DECIMAL under `multiply`
   * or `divide`: there the provider's assignment is a guarded coefficient
   * rewrite that rounds half-even back to the field's scale and refuses an
   * intermediate the dialect cannot represent, and restating it here would be a
   * second arithmetic owner. The refusal is registered and recorded as a
   * decision for Arnaud (note §R2.1).
   *
   * WHICH PAYLOAD REACHES IT, measured for the N4 census (the earlier reading
   * of this paragraph named the wrong shape). A decimal RELATION key does NOT
   * reach it: a relation key written beside a mutation of that relation must be
   * a literal (`Assignments.requireLiteral`, `commands/relation-body.ts:127`),
   * so no operator survives to be named, and a key transition is the only thing
   * that would ask. The reachable shape is a decimal PRIMARY key on an UPSERT's
   * FOUND arm whose update payload names NO relation: `EngineSchema.admit`
   * states `keyPortabilityRefusal` for `update` / `updateMany`, and the found
   * arm carries it only when the update payload names relations
   * (`commands/commands.ts:1743`, the shipped gate) — so
   * `upsert({ update: { decimalKey: { multiply: n } } })` arrives here through
   * `OperationContext.updatedIdentity`, which has to ADDRESS the row it just
   * wrote. It is a TRANSPORT boundary, not an invariant: the same payload
   * succeeds on a provider with RETURNING, where the post-update key is read
   * back instead of named. Executing it therefore belongs to that read-back's
   * owner (D-50's scratch at the column's declared type), not here; an ordered
   * observation cannot answer it, because what is missing is the row's address,
   * not a value a dependent consumes.
   */
  updateValue(
    model: AnyModel,
    field: string,
    value: unknown,
    before: Sql
  ): Sql {
    const a = this.adapter;
    const update = this.#prepareUpdate(model, field, value);
    if (!this.named(model, field, update))
      throw new QueryEngineError(
        `Cannot determine the updated value of '${model["~"].names.ts ?? "unknown"}.${field}' before '${update.operator}' executes: the database determines the stored result.`
      );
    if (update.kind === "value")
      return this.fieldValue(model, field, update.value);
    const state = physicalField(this.schema, model, field).scalar["~"].state;
    const base =
      state.type === "int" ? a.expressions.cast(before, "integer") : before;
    const operand = this.fieldValue(model, field, update.by);
    if (update.operator === "increment")
      return a.expressions.add(base, operand);
    if (update.operator === "decrement")
      return a.expressions.subtract(base, operand);
    if (update.operator === "multiply")
      return a.expressions.multiply(base, operand);
    return state.type === "int" || state.type === "bigint"
      ? a.expressions.integerDivide(base, operand)
      : a.expressions.divide(base, operand);
  }
  /**
   * The rows of `model` a write produces, as ONE FROM item read under
   * `alias`: every stored field, each row's value as `row` lowers it (NULL
   * where it says nothing). The model's own columns type them, through an
   * empty read of the table, so a bound value takes its column's type where
   * PostgreSQL would resolve a bare parameter as text; how the rows follow
   * it is the dialect's (`setOperations.typedRows`), so a chunk is bounded
   * by its binds alone.
   */
  #producedRows(
    model: AnyModel,
    rows: readonly ((field: string) => Sql | undefined)[],
    alias: string
  ): Sql {
    const a = this.adapter;
    const fields = this.schema.storedFields(model);
    const typed = this.alias();
    const from = this.table(model, typed);
    const head = assembleAdapterSelect(a, {
      columns: sql.join(
        fields.map((field) => this.column(model, field, typed)),
        ", "
      ),
      from,
      where: a.literals.false(),
    });
    return a.setOperations.typedRows(
      {
        head,
        from,
        table: this.table(model),
        alias: typed,
        columns: fields.map((field) => this.columnName(model, field)),
      },
      rows.map((row) => fields.map((field) => row(field) ?? a.literals.null())),
      alias
    );
  }
  /**
   * `judged` over the produced row `from` reads (and, for each `acyclic`
   * relation, the row outside its own subtree), as the adapter's assertion:
   * 1, or the statement that carries it fails before it writes. `undefined`
   * where nothing is left to judge: the call drops every layer `judged` is
   * made of (R6).
   */
  #holds(
    model: AnyModel,
    judged: Pick<PreparedSelector, "model" | "predicate"> | undefined,
    alias: string,
    nulls: ReadonlyMap<string, boolean>,
    from?: Sql,
    acyclic: readonly string[] = NO_RELATIONS,
    kept?: Sql
  ): Sql | undefined {
    const a = this.adapter;
    const outer = this.#known;
    this.#known = { alias, nulls };
    let lowered: Sql | undefined;
    try {
      lowered = judged && this.lowerSelector(judged, alias);
    } finally {
      this.#known = outer;
    }
    const conditions = [
      ...(lowered === undefined ? [] : [lowered]),
      ...acyclic.map((relation) =>
        this.#outsideOwnSubtree(model, relation, alias)
      ),
    ];
    if (conditions.length === 0) return undefined;
    const held = a.operators.and(...conditions);
    return a.subqueries.scalar(
      a.assertions.holds(
        kept ? a.assertions.keptWhere!(kept, held) : held,
        from
      )
    );
  }
  /**
   * The row read as `alias` does not reach itself through `relation`, a
   * to-one relation of its model to itself: no row its new target leads to,
   * that target included, is the row. The walk is physical, read under no
   * domain: a cycle through a row the caller cannot see is still a cycle.
   */
  #outsideOwnSubtree(model: AnyModel, relation: string, alias: string): Sql {
    const a = this.adapter;
    const edge = this.schema.membership(model, relation);
    const { cte, cteName, walk, childColumns } = this.#walk(
      edge,
      alias,
      { depth: false, self: false },
      false
    );
    return a.filters.none(
      sql`${cte} ${assembleAdapterSelect(a, {
        columns: sql.raw("1"),
        from: a.identifiers.aliased(a.identifiers.escape(cteName), walk),
        where: this.#sameRow(
          model,
          alias,
          childColumns.map((name) => a.identifiers.column(walk, name))
        ),
      })}`
    );
  }
  /**
   * The SELECT an INSERT of `rows` reads its values from when the rows it
   * creates are judged (R4): each row a value of the derived table, kept
   * where `judged` holds of it and failing the statement where it does not,
   * before any row is written or any constraint is checked. One statement:
   * nothing it writes is visible to its own judgement.
   */
  producedSource(
    model: AnyModel,
    columns: readonly string[],
    rows: readonly Input[],
    judged: PreparedSelector
  ): Sql | undefined {
    const a = this.adapter;
    const alias = this.alias();
    const written = new Set(columns);
    const from = this.#producedRows(
      model,
      rows.map(
        (row) => (field) =>
          written.has(field)
            ? this.fieldValue(model, field, row[field])
            : undefined
      ),
      alias
    );
    // A field's nullness folds where every row states the same one; a field
    // no row writes is null in each.
    const nulls = new Map<string, boolean>();
    for (const field of this.schema.storedFields(model)) {
      const states = new Set(
        rows.map((row) => {
          const value = written.has(field) ? row[field] : null;
          return value instanceof Sql
            ? undefined
            : value === null || value === undefined;
        })
      );
      const [state] = states;
      if (states.size === 1 && state !== undefined) nulls.set(field, state);
    }
    return this.#sharing(() => {
      const guard = this.#holds(model, judged, alias, nulls);
      if (guard === undefined) return undefined;
      return assembleAdapterSelect(a, {
        columns: sql.join(
          columns.map((field) => this.column(model, field, alias)),
          ", "
        ),
        from,
        where: sql`${guard} = 1`,
      });
    });
  }
  /**
   * The WHERE of an UPDATE of `model` assigning `values` that judges the
   * rows it produces (R4): the keys of the rows `candidates` selects
   * (lowered at the alias it is handed; the first `limit` in key order),
   * read ONCE, before the statement writes any of them, each group of one
   * key kept where its produced row's assertion holds (the row as it stands
   * with the assignments applied, typed as {@link producedRows}): 1, or the
   * statement fails before it writes.
   *
   * An aggregate is computed over the rows its WHERE kept, so a row the
   * update does not write is never judged: a guard in a select list or a
   * WHERE is not, since PostgreSQL and MySQL flatten an `IN` subquery and
   * order its conditions by cost (measured: a viewed row's refused guard
   * raised before the predicate that excludes it). A set read once is
   * judged against the rows as they stand before the write, never against
   * a row the statement wrote earlier: SQLite and MySQL evaluate an
   * UPDATE's own SET row by row (measured: a team's lead demoted early made
   * its other members' new rows unwritable). On MySQL, which refuses to read
   * the written table from its own subquery, the set is a derived table,
   * materialized before the write (`#capped`'s form). `undefined` where
   * nothing is left to judge.
   */
  producedWhere(
    model: AnyModel,
    candidates: (alias: string) => Sql | undefined,
    values: Input,
    judged: PreparedSelector | undefined,
    acyclic: readonly string[] = NO_RELATIONS,
    limit?: number
  ): Sql | undefined {
    if (judged === undefined && acyclic.length === 0) return undefined;
    const a = this.adapter;
    const row = this.alias();
    const produced = this.alias();
    const current = (field: string) => this.column(model, field, row);
    const rowKeys = this.schema.keys(model);
    // A value only the database computes (a list append, an exact
    // decimal's multiply or divide) has no value to judge: it is refused
    // where the judgement reads it (`updateValue`), and stands as it was
    // where nothing does, since no answer depends on it.
    const unread = (field: string) =>
      !(
        this.namesUpdate(model, field, values[field]) ||
        (judged?.predicate &&
          readsAny(judged.predicate, new Set([field]), rowKeys)) ||
        acyclic.some((relation) => {
          const edge = this.schema.membership(model, relation);
          return (
            edge.kind === "reference" &&
            edge.pairs.some((pair) => pair.source === field)
          );
        })
      );
    const from = this.#producedRows(
      model,
      [
        (field) =>
          values[field] === undefined || unread(field)
            ? current(field)
            : this.updateValue(model, field, values[field], current(field)),
      ],
      produced
    );
    const nulls = new Map<string, boolean>();
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const whole = wholeValue(value);
      if (whole && !(whole.value instanceof Sql))
        nulls.set(field, whole.value === null);
    }
    const judgedSet = (): Sql | undefined => {
      // Lowered before the guard only where the guard reads it: the other
      // dialects mint their aliases in the order they always have.
      const kept =
        a.assertions.keptWhere && (candidates(row) ?? a.literals.true());
      const guard = this.#holds(
        model,
        judged,
        produced,
        nulls,
        from,
        acyclic,
        kept
      );
      if (guard === undefined) return undefined;
      const keys = this.keyOrder(model).map(current);
      return assembleAdapterSelect(a, {
        columns: sql.join(keys, ", "),
        from: this.table(model, row),
        ...(kept
          ? { where: a.operators.and(kept, sql`${guard} = 1`) }
          : {
              where: candidates(row),
              groupBy: sql.join(keys, ", "),
              having: sql`${a.aggregates.min(guard)} = 1`,
            }),
        ...(limit !== undefined && {
          orderBy: this.#ascendingKeys(model, row),
          limit: this.value(limit),
        }),
      });
    };
    const set = this.#sharing(judgedSet);
    if (set === undefined) return undefined;
    const table = model["~"].names.sql!;
    return rowIn(
      a,
      this.keyOrder(model).map((field) => this.column(model, field, table)),
      a.capabilities.supportsMutationTargetInSubquery
        ? set
        : throughDerived(a, set, this.alias())
    );
  }
  /**
   * A read's own candidates: `selector` (absent: every row) under `purpose`.
   * Reads consume only the predicate, so the conjunction carries no facts:
   * the key-preserving form, {@link candidates}, is the write lookups'.
   */
  #within(
    model: AnyModel,
    selector: Pick<PreparedSelector, "model" | "predicate"> | undefined,
    purpose: RowPurpose
  ): Pick<PreparedSelector, "model" | "predicate"> | undefined {
    const scope = this.scope(model, purpose);
    if (scope?.predicate === undefined) return selector;
    if (selector?.predicate === undefined) return scope;
    return freeze({
      model,
      predicate: freeze({
        kind: "and",
        predicates: freeze([selector.predicate, scope.predicate]),
      }),
    });
  }
  /** `undefined` where it states nothing, or the call drops all it states. */
  override lowerSelector(
    selector: Pick<PreparedSelector, "model" | "predicate">,
    alias?: string
  ): Sql | undefined {
    if (!selector.predicate) return undefined;
    const frames = this.#frames;
    this.#frames = [{ alias, escaped: false }];
    try {
      return this.#lowerStated(selector.predicate, alias);
    } finally {
      this.#frames = frames;
    }
  }
  /**
   * The aliases of the rows a predicate being lowered reads, from its root
   * to the relation body it is in, each marked once a `{ $row, up }` inside
   * it names a row above it: such a body is correlated past its parent, so
   * it is never shared. A semijoin body's `joins` are the relations joined
   * into its `FROM` ({@link lowerRelationPredicate}); `undefined` where the
   * body takes none, and while what is lowered is not one of its conjuncts.
   */
  #frames: LoweringFrame[] = [];
  /** The alias of the row `up` bodies above the current one. */
  #outerAlias(up: number | undefined, alias: string | undefined): string {
    const frames = this.#frames;
    const at = frames.length - 1 - (up ?? 0);
    const owner = up === undefined || up === 0 ? alias : frames[at]?.alias;
    if (owner === undefined)
      throw new UnsupportedOperationError(
        "An enclosing row's column ({ $row, up }) has no row to read here."
      );
    for (let index = at + 1; index < frames.length; index++)
      frames[index]!.escaped = true;
    return owner;
  }
  /**
   * `predicate` lowered; `undefined` where it is made of layers the call
   * drops (R6), so a statement without them is the one without the domain.
   */
  #lowerStated(predicate: PreparedPredicate, alias?: string): Sql | undefined {
    if (predicate.kind === "layer") {
      let resolved = this.resolve(predicate);
      if (resolved === undefined) return undefined;
      const known = this.#known;
      if (known !== undefined && alias === known.alias)
        resolved = foldKnownNulls(resolved, known.nulls);
      // A stack, made at the first layer this `Queries` lowers: what reads
      // it reads it while it lowers (the selectors' memo keys its content).
      const excluded = (this.excluded ??= []);
      excluded.push(predicate.layer);
      try {
        return this.#lowerPredicate(resolved, alias);
      } finally {
        excluded.pop();
      }
    }
    if (predicate.kind !== "and") return this.#lowerPredicate(predicate, alias);
    // No closure here: this runs at every filter node of every statement.
    const { predicates } = predicate;
    if (predicates.length === 1) {
      const only = this.#lowerStated(predicates[0]!, alias);
      return only && this.adapter.operators.and(only);
    }
    const members: Sql[] = [];
    // biome-ignore lint/style/useForOf: no iterator at every filter node (E5.1, measured).
    for (let index = 0; index < predicates.length; index++) {
      const lowered = this.#lowerStated(predicates[index]!, alias);
      if (lowered !== undefined) members.push(lowered);
    }
    return members.length === 0 && predicates.length > 0
      ? undefined
      : this.adapter.operators.and(...members);
  }
  /** An aggregate read's root filter: its `where` under the root domain. */
  lowerWhere(
    model: AnyModel,
    where: Input | undefined,
    alias?: string
  ): Sql | undefined {
    const selector = this.#within(
      model,
      where === undefined
        ? undefined
        : this.prepareSelector(model, where, false, false),
      "root"
    );
    return selector && this.lowerSelector(selector, alias);
  }
  /**
   * The value a LOCATED row holds for one field, read where it is SPENT:
   * `(SELECT <column> FROM <target> WHERE <this arm's selector> LIMIT 1)`,
   * inside the statement that writes it.
   *
   * A parent-held `connect` folds its target's referenced value into the
   * parent's own SET. Its planning probe answers EXISTENCE and the branch; the
   * bytes that land in the column are the target's own, read at the write — so
   * no second, re-derived provenance stands between the row the selector named
   * and the key written, and a collation that makes the selector's literal
   * differ from the stored value cannot change the answer (E1 U1, and the
   * create root's `toOneFkAssign` before it).
   *
   * `mutating` is the model the enclosing statement writes: where the provider
   * refuses to read the table its own statement mutates (MySQL ERROR 1093) the
   * read hides behind a derived table, the same one condition
   * {@link hideMutationTarget} already owns — the SELF relation's shape.
   */
  override locatedValue(
    model: AnyModel,
    field: string,
    selector: PreparedSelector,
    mutating?: AnyModel
  ): Sql {
    const alias = this.alias();
    const located = assembleAdapterSelect(this.adapter, {
      columns: this.column(model, field, alias),
      from: this.table(model, alias),
      where: this.lowerSelector(selector, alias),
      limit: this.value(1),
    });
    return this.adapter.subqueries.scalar(
      this.hideMutationTarget(located, model, mutating?.["~"].names.sql)
    );
  }
  lowerMutationLimit(
    model: AnyModel,
    selector: PreparedSelector,
    limit: number | undefined
  ): { readonly where?: Sql; readonly suffix?: Sql } {
    const adapter = this.adapter;
    // The UPDATE/DELETE target carries no alias, so it is addressable only by
    // its NAME. Without that qualifier a correlated `EXISTS` emits the parent
    // column bare and it rebinds to the CHILD table wherever both carry the
    // name — `some` matches nothing, `none`/`every` match everything, and a
    // `deleteMany` removes the complement of the intended set. The shipped
    // engine passed the table name for exactly this reason
    // (`operations/update.ts:79-90`, `delete.ts:85-92`).
    const mutated = model["~"].names.sql!;
    // MySQL answers an UPDATE/DELETE's subquery row by row while the statement
    // and the referential actions it fires change the rows that subquery
    // reads, which is also why it refuses to read the mutated table there
    // (ERROR 1093). A selector that reads other rows is therefore its keys,
    // read into a derived table before any write: the statement snapshot
    // PostgreSQL and SQLite answer from.
    const where =
      !adapter.capabilities.supportsMutationTargetInSubquery &&
      selector.predicate !== undefined &&
      readsRelation(selector.predicate)
        ? this.#capped(selector)
        : this.lowerSelector(selector, mutated);
    if (limit === undefined) return { where };
    // A limited write takes the first `limit` rows in key order, the order a
    // read's `take` completes with: every path picks the same rows. MySQL,
    // which refuses a `LIMIT` inside `IN`, states it on the statement itself.
    if (!adapter.capabilities.supportsMutationRowLimit)
      return {
        where: adapter.operators.and(
          ...[where, this.#capped(selector, limit)].filter(
            (condition): condition is Sql => condition !== undefined
          )
        ),
      };
    return {
      where,
      suffix: sql`${adapter.clauses.orderBy(this.#ascendingKeys(model))} ${adapter.clauses.limit(this.value(limit))}`,
    };
  }
  /**
   * Every row of `selector` locked, answered as ONE row: the inner read takes
   * the row locks (`FOR UPDATE`), and the count over it, which must consume
   * every row, is all that crosses the wire. Locking a million candidates
   * then costs one row back, not a million keys.
   */
  override lockAll(selector: PreparedSelector): Query {
    const a = this.adapter;
    const inner = this.#rootAlias();
    const locked = assembleAdapterSelect(a, {
      columns: a.literals.true(),
      from: this.table(selector.model, inner),
      where: this.lowerSelector(selector, inner),
      forUpdate: true,
    });
    return {
      sql: assembleAdapterSelect(a, {
        columns: a.identifiers.aliased(a.aggregates.count(), "_count"),
        from: a.subqueries.correlate(locked, this.alias()),
      }),
      shape: { kind: "object", fields: { _count: COUNT_LEAF } },
    };
  }
  /**
   * `<keys> IN (SELECT * FROM (SELECT <keys> FROM <model> WHERE <selector>
   * ORDER BY <keys> LIMIT <limit>) AS <alias>)`, the keys outside addressed
   * through `alias`: the first `limit` rows in key order, a mutation's limit
   * where the provider has no `UPDATE … LIMIT`, and a {@link window}; without
   * a `limit`, every row, a MySQL mutation's keyed snapshot
   * ({@link lowerMutationLimit}). Where the provider cannot read a mutation's
   * own table in a subquery (MySQL), the read sits in a derived table, as
   * {@link hideMutationTarget}'s does: MySQL also refuses a `LIMIT` directly
   * inside `IN (…)`, and the derived table answers both, in the premise's
   * SELECT and in the effect.
   */
  #capped(selector: PreparedSelector, limit?: number, alias?: string): Sql {
    const adapter = this.adapter;
    const model = selector.model;
    const inner = this.alias();
    const keys = this.keyOrder(model);
    const capped = assembleAdapterSelect(adapter, {
      columns: sql.join(
        keys.map((field) => this.column(model, field, inner)),
        ", "
      ),
      from: this.table(model, inner),
      where: this.lowerSelector(selector, inner),
      ...(limit === undefined
        ? {}
        : {
            orderBy: this.#ascendingKeys(model, inner),
            limit: this.value(limit),
          }),
    });
    return rowIn(
      adapter,
      keys.map((field) => this.column(model, field, alias)),
      adapter.capabilities.supportsMutationTargetInSubquery
        ? capped
        : throughDerived(adapter, capped, this.alias())
    );
  }
  /** `<key> ASC, …` in {@link keyOrder}, the keys addressed through `alias`. */
  #ascendingKeys(model: AnyModel, alias?: string): Sql {
    return sql.join(
      this.keyOrder(model).map((field) =>
        this.adapter.orderBy.asc(this.column(model, field, alias))
      ),
      ", "
    );
  }
  lowerIdentity(model: AnyModel, identity: Input, alias?: string): Sql {
    return this.adapter.operators.and(
      ...Object.entries(identity).map(([field, value]) =>
        this.adapter.operators.eq(
          this.column(model, field, alias),
          this.fieldValue(model, field, value)
        )
      )
    );
  }
  /**
   * `predicate` lowered under an `OR` or a `NOT`: not a conjunct of the body
   * it is in, so no relation in it joins that body.
   */
  #apart(predicate: PreparedPredicate, alias?: string): Sql {
    const frame = this.#frames.at(-1);
    const joins = frame?.joins;
    if (joins === undefined) return this.#lowerPredicate(predicate, alias);
    frame!.joins = undefined;
    try {
      return this.#lowerPredicate(predicate, alias);
    } finally {
      frame!.joins = joins;
    }
  }
  #lowerPredicate(predicate: PreparedPredicate, alias?: string): Sql {
    const a = this.adapter;
    // biome-ignore lint/style/useDefaultSwitchClause: the prepared predicate union is exhaustive; a default would be dead code.
    switch (predicate.kind) {
      case "and":
      case "layer":
        return this.#lowerStated(predicate, alias) ?? a.literals.true();
      case "or":
        // A balanced tree, not a chain: SQLite parses `a OR b OR …` one
        // expression level deep per arm and refuses depth 1000 (platform-15).
        return balancedOr(
          predicate.predicates.map((member) => this.#apart(member, alias)),
          (arms) => a.operators.or(...arms)
        );
      case "not":
        return a.operators.not(
          this.#opposite(() => this.#apart(predicate.predicate, alias))
        );
      case "always":
        return predicate.value ? a.literals.true() : a.literals.false();
      case "condition":
        return predicate.condition.holds(this.values, this.instant)
          ? a.literals.true()
          : a.literals.false();
      case "operation":
        return this.lowerOperation(this.#bound(predicate), alias);
      case "relation":
        return this.#lowerRelationPredicate(predicate, alias);
      case "exists":
        return this.#lowerExists(predicate, alias ?? "");
      case "window":
        return this.#capped(predicate.selector, predicate.limit, alias);
      case "through": {
        const { model, last } = predicate;
        const keys = this.keyOrder(model);
        const row = keys.map((field) => this.column(model, field, alias));
        const bound = keys.map((field) =>
          this.fieldValue(model, field, last[field])
        );
        return a.operators.rows
          ? a.operators.rows(row, bound)
          : a.operators.lte(rowValue(row), rowValue(bound));
      }
    }
  }
  /**
   * The operation with its parameters' values read for this call, so the
   * value-dependent lowering reads them as any value. R6 has made each
   * present (a spread one a list).
   */
  #bound(predicate: OperationPredicate): BoundOperation {
    if (
      predicate.operand?.kind !== "parameter" &&
      !(predicate.value instanceof Parameter) &&
      !predicate.operands?.some(isParameterOperand)
    )
      return predicate as BoundOperation;
    return this.#boundParameters(predicate);
  }
  /** {@link bound}'s operation, which reads at least one parameter. */
  #boundParameters(predicate: OperationPredicate): BoundOperation {
    const { operand, operands, value, ...rest } = predicate;
    const read = (parameter: Parameter) =>
      parameter.read(this.values, this.instant);
    const bound = (member: PreparedOperand): BoundOperand[] => {
      if (member.kind !== "parameter") return [member];
      const given = read(member.parameter);
      return member.spread
        ? (given as unknown[]).map((item) => ({ kind: "value", value: item }))
        : [{ kind: "value", value: given }];
    };
    return {
      ...rest,
      ...(operand && { operand: bound(operand)[0]! }),
      ...(operands && { operands: operands.flatMap(bound) }),
      value: value instanceof Parameter ? read(value) : value,
    };
  }
  #preparedColumn(scalar: PreparedScalar, alias?: string): Sql {
    return this.#guarded(
      scalar.model,
      scalar.field,
      alias
        ? this.adapter.identifiers.column(alias, scalar.physical.name)
        : this.adapter.identifiers.escape(scalar.physical.name),
      alias
    );
  }
  /**
   * `column`, `model`'s `field` at `alias`, as an operand the caller wrote
   * (K5): a read-gated field reads NULL on a row that does not carry it, in
   * every position a caller writes it. A layer's predicates read the column
   * itself: they lower inside the layer.
   */
  #guarded(model: AnyModel, field: string, column: Sql, alias?: string): Sql {
    if (this.#lowersLayer || this.#masked) return column;
    const gate = this.domain?.projected(model)?.gates.get(field);
    // Every row a caller's operand is read on is one the domain takes, so
    // `read` holds there: the gate's own predicate decides.
    const holds = gate && this.#gateHolds(model, gate, alias, true);
    return holds === undefined
      ? column
      : this.adapter.expressions.caseWhen(
          [{ when: holds, then: column }],
          this.adapter.literals.null()
        );
  }
  /** `model`'s `field` at `alias` as an operand the caller wrote ({@link guarded}). */
  #operand(model: AnyModel, field: string, alias?: string): Sql {
    return this.#guarded(model, field, this.column(model, field, alias), alias);
  }
  /** Whether a caller's operand over `model`'s `field` may read NULL (K5). */
  #gatedHere(model: AnyModel, field: string): boolean {
    return (
      !this.#lowersLayer &&
      this.domain?.projected(model)?.gates.has(field) === true
    );
  }
  /**
   * Whether `model`'s rows lower through a masked window: a read-gated field
   * the call reads under aggregation, where a gate repeated per expression
   * would bind its values again in every copy.
   */
  #masks(model: AnyModel): boolean {
    return (
      !(this.#lowersLayer || this.#masked) &&
      (this.domain?.projected(model)?.gates.size ?? 0) > 0
    );
  }
  /** `fn` lowered over a masked window ({@link masked}). */
  #overMasked<T>(fn: () => T): T {
    this.#masked = true;
    try {
      return fn();
    } finally {
      this.#masked = false;
    }
  }
  #lowerTarget(target: PreparedTarget, alias?: string): Sql {
    return target.kind === "column"
      ? this.#preparedColumn(target.scalar, alias)
      : this.#aggregateExpression(target.aggregate, target.scalar, alias);
  }
  private lowerOperation(predicate: BoundOperation, alias?: string): Sql {
    const a = this.adapter;
    const { operator, target, operand } = predicate;
    const scalar = target.scalar;
    // A `_count` compares with `COUNT(col)`, a row count on every storage, and
    // admission types its operand as a number (`numericFilterOps`). It has no
    // column domain: no JSON document class, no text collation, no identifier
    // or decimal binding — every domain dispatch below reads `state`, so the
    // fact is stated once, here.
    const counted =
      target.kind === "aggregate" && target.aggregate === "_count";
    const state = counted ? undefined : scalar?.physical.scalar["~"].state;
    const column = this.#lowerTarget(target, alias);
    if (state?.type === "json" && state.array !== true)
      return this.#lowerJsonOperation(predicate, column);
    const insensitive = predicate.insensitive === true;
    // A discriminator member is compared by the constraint that answers it; the
    // engine's case-sensitivity contract governs every other comparison. An
    // `insensitive` mode is a filter spelling and never reaches a discriminator,
    // so it keeps the folded pair rather than silently folding one side.
    // A COLUMN target's identifier storage: its value operands bind the
    // physical form, and a compact column is compared as the bytes (or the
    // `uuid`) it holds — never collated or ASCII-folded as text.
    const id =
      target.kind === "column" && scalar
        ? this.scalarShape(scalar.model, scalar.field).id
        : undefined;
    const text =
      !(target.kind === "column" && target.key === true && !insensitive) &&
      state !== undefined &&
      state.array !== true &&
      (state.type === "string" || state.type === "enum") &&
      !isCompact(id);
    const pattern =
      operator === "contains" ||
      operator === "startsWith" ||
      operator === "endsWith";
    const exact = (expression: Sql, field = scalar) =>
      text
        ? a.expressions.caseSensitiveText(
            expression,
            field?.physical.scalar["~"].nativeType,
            pattern || insensitive
          )
        : expression;
    const nativeType = scalar?.physical.scalar["~"].nativeType;
    // The database's own case fold, compared exactly: case is the one
    // difference `mode: "insensitive"` ignores, and which letters have a case
    // is the database's answer.
    const folded =
      text && insensitive
        ? a.expressions.caseSensitiveText(
            a.expressions.caseFold(column, nativeType)
          )
        : column;
    /**
     * An enum compared against ANOTHER COLUMN compares its SPELLING — on BOTH
     * sides, on every dialect. PostgreSQL gives each enum field its own type,
     * so `status = review_status` has no operator there (42883) while MySQL and
     * SQLite, which store the value as text, answer it; casting the operand
     * alone left the filtered column typed as its own enum and produced
     * `post_status = text`. A LITERAL operand still binds an enum-typed
     * parameter against the bare column, so ordinary enum equality keeps its
     * index. Ordered comparison has no portable answer and is refused at
     * admission (`validation/scalars/enum.ts`), so equality — and the `not`
     * that negates it — is the whole reach of this fact.
     */
    const spelledAsText = (member: BoundOperand): boolean =>
      member.kind === "field" &&
      (state?.type === "enum" ||
        member.scalar.physical.scalar["~"].state.type === "enum");
    const comparableColumn = (member: BoundOperand): Sql =>
      exact(
        spelledAsText(member) ? a.expressions.cast(column, "text") : column
      );
    /** An operand as it stands: neither folded nor compared exactly. */
    const raw = (member: BoundOperand): Sql => {
      if (member.kind === "field") {
        const reference = this.#preparedColumn(
          member.scalar,
          member.up === undefined ? alias : this.#outerAlias(member.up, alias)
        );
        return spelledAsText(member)
          ? a.expressions.cast(reference, "text")
          : reference;
      }
      if (member.kind === "sql")
        return this.value(
          new Sql(
            member.strings,
            member.operands.map((slot) =>
              slot.kind === "field"
                ? this.#preparedColumn(slot.scalar, alias)
                : slot.value
            )
          )
        );
      return scalar && !counted
        ? this.#targetValue(target, scalar, member.value, id)
        : this.value(member.value);
    };
    const bind = (member: BoundOperand, fold = false): Sql => {
      const operand = raw(member);
      if (member.kind !== "field")
        return fold ? a.expressions.caseFold(operand) : operand;
      return fold
        ? a.expressions.caseSensitiveText(
            a.expressions.caseFold(
              operand,
              member.scalar.physical.scalar["~"].nativeType
            )
          )
        : exact(operand, member.scalar);
    };
    switch (operator) {
      case "equals": {
        const single = operand!;
        const literal = single.kind === "value" ? single.value : undefined;
        if (single.kind === "value" && literal === null)
          return a.operators.isNull(column);
        if (state?.type === "point" && state.array !== true)
          return this.#geoPoint("equals").equals(column, literal as GeoPoint);
        if (state?.array === true && Array.isArray(literal))
          return a.operators.eq(column, bind(single));
        if (
          insensitive &&
          (single.kind !== "value" ||
            typeof literal === "string" ||
            literal instanceof Sql)
        )
          return a.operators.eq(folded, bind(single, true));
        if (text && single.kind === "value" && !(literal instanceof Sql))
          return a.operators.exactTextEq(
            column,
            bind(single),
            scalar?.physical.scalar["~"].nativeType
          );
        return a.operators.eq(comparableColumn(single), bind(single));
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte":
        return a.operators[operator](
          text && insensitive ? folded : exact(column),
          bind(operand!, text && insensitive)
        );
      default:
        return this.#lowerOtherOperation(predicate, {
          column:
            pattern &&
            !(
              operator === "startsWith" &&
              operand?.kind === "value" &&
              typeof operand.value === "string"
            )
              ? exact(column)
              : column,
          source: column,
          folded,
          insensitive,
          text,
          exact,
          bind,
          raw,
          nativeType,
          state,
        });
    }
  }
  /**
   * The less common filter operators, kept out of {@link lowerOperation} so a
   * first query that compares by equality never compiles them.
   */
  #lowerOtherOperation(
    predicate: BoundOperation,
    {
      column,
      source,
      folded,
      insensitive,
      text,
      exact,
      bind,
      raw,
      nativeType,
      state,
    }: {
      column: Sql;
      /** The target before any case-sensitivity wrapping. */
      source: Sql;
      folded: Sql;
      insensitive: boolean;
      text: boolean;
      exact: (expression: Sql) => Sql;
      bind: (member: BoundOperand, fold?: boolean) => Sql;
      raw: (member: BoundOperand) => Sql;
      nativeType: NativeTypeDeclaration | undefined;
      state: ScalarStateOf | undefined;
    }
  ): Sql {
    const a = this.adapter;
    const { operator, operand } = predicate;
    const scalar = predicate.target.scalar;
    const members = () => predicate.operands ?? [];
    switch (operator) {
      case "in":
      case "notIn": {
        const negated = operator === "notIn";
        const operands = members();
        if (operands.length === 0)
          return negated ? a.literals.true() : a.literals.false();
        if (insensitive) {
          const comparisons = operands.map((member) =>
            negated
              ? a.operators.neq(folded, bind(member, true))
              : a.operators.eq(folded, bind(member, true))
          );
          // One comparison per member: balanced, as an `OR` is (platform-15).
          return balancedOr(comparisons, (arms) =>
            negated ? a.operators.and(...arms) : a.operators.or(...arms)
          );
        }
        const list = a.literals.list(operands.map((member) => bind(member)));
        if (negated) return a.operators.notIn(exact(column), list);
        return text
          ? a.operators.exactTextIn(
              column,
              list,
              scalar?.physical.scalar["~"].nativeType
            )
          : a.operators.in(column, list);
      }
      case "contains":
      case "startsWith":
      case "endsWith":
        if (insensitive)
          return a.operators.insensitiveText(
            operator,
            source,
            raw(operand!),
            nativeType
          );
        return operator === "startsWith" &&
          operand!.kind === "value" &&
          typeof operand!.value === "string"
          ? a.operators.startsWithPrefix(column, operand!.value, nativeType)
          : a.operators[`${operator}Text`](column, bind(operand!));
      case "has":
        return predicate.value === null
          ? a.literals.false()
          : a.arrays.has(
              column,
              this.#scalarValue(
                scalar!.physical.scalar,
                predicate.value,
                scalar!.field
              )
            );
      case "hasEvery": {
        const values = predicate.value as unknown[];
        return values.length === 0
          ? a.operators.isNotNull(column)
          : a.arrays.hasEvery(
              column,
              this.#scalarValue(scalar!.physical.scalar, values, scalar!.field)
            );
      }
      case "hasSome": {
        const values = predicate.value as unknown[];
        return values.length === 0
          ? a.literals.false()
          : a.arrays.hasSome(
              column,
              this.#scalarValue(scalar!.physical.scalar, values, scalar!.field)
            );
      }
      case "isEmpty":
        return predicate.value
          ? a.arrays.isEmpty(column)
          : a.operators.not(a.arrays.isEmpty(column));
      case "within": {
        const area = predicate.value as GeoArea;
        const geoPoint = this.#geoPoint("within");
        if ("bounds" in area) return geoPoint.withinBounds(column, area.bounds);
        if (geoPoint.withinPolygon)
          return geoPoint.withinPolygon(column, area.polygon);
        throw new FeatureNotSupportedError(
          "point",
          "within polygon",
          "GeoPoint polygon filtering is not supported by this provider."
        );
      }
      default: {
        // `distance`, the one operator left. Admission enumerates this
        // operator set once, per scalar type (`validation/scalars/**`), and
        // `prepareOperation` carries the key it admitted; there is no second
        // operator list here to disagree with it (AGENTS.md: "Do not add a
        // second operator switch").
        const specification = record(predicate.value);
        const expression = this.#distanceExpression(
          column,
          state!,
          scalar!.field,
          specification,
          "filter"
        );
        // The index probe. `distance <= X` implies `withinBounds(box(X))`, so
        // the box is a redundant conjunct the provider can answer from the
        // spatial index before it evaluates one great-circle distance. It is
        // added only where preparation saw POSITIVE polarity
        // ({@link PreparedPredicate.probe}); the adapter spells both arms.
        const upper = predicate.probe
          ? distanceUpperBound(specification)
          : undefined;
        const probe =
          upper === undefined
            ? []
            : [
                this.#geoPoint("distance filter").withinBounds(
                  column,
                  geoBoundsForDistance(specification.to as GeoPoint, upper)
                ),
              ];
        return a.operators.and(
          ...probe,
          ...(["lt", "lte", "gt", "gte"] as const)
            .filter((bound) => specification[bound] !== undefined)
            .map((bound) =>
              a.operators[bound](expression, this.value(specification[bound]))
            )
        );
      }
    }
  }
  /**
   * One operand, bound in the domain of the expression it is COMPARED WITH.
   * A `_count` never reaches here: `lowerOperation` binds its row-count
   * operand as a plain value.
   *
   * Everything compares inside the field's own domain except a `_sum` over an
   * exact decimal: the compared expression is the column's sum, whose value is
   * wider than one column can hold, so the operand's cast widens the PRECISION
   * while keeping the field's SCALE — every summed row carries that scale, and an
   * operand at another one would be a different number on SQLite. The adapter
   * states how wide its exact HAVING cast can be; the refusal below is the
   * shipped sentence, verbatim.
   */
  #targetValue(
    target: PreparedTarget,
    scalar: PreparedScalar,
    value: unknown,
    id: IdentifierColumn | undefined
  ): Sql {
    if (
      target.kind === "aggregate" &&
      (target.aggregate === "_min" || target.aggregate === "_max")
    ) {
      const aggregateId = this.scalarShape(scalar.model, scalar.field).id;
      if (isCompact(aggregateId))
        return aggregatedIdentifier(
          this.adapter,
          aggregateId,
          this.#scalarValue(
            scalar.physical.scalar,
            value,
            scalar.field,
            aggregateId
          )
        );
    }
    if (target.kind === "aggregate" && target.aggregate === "_sum")
      return this.#sumTargetValue(scalar, value, id);
    return this.#scalarValue(scalar.physical.scalar, value, scalar.field, id);
  }
  /** A `_sum` operand, out of line: only a decimal HAVING widens its cast. */
  #sumTargetValue(
    scalar: PreparedScalar,
    value: unknown,
    id: IdentifierColumn | undefined
  ): Sql {
    const state = scalar.physical.scalar["~"].state;
    const domain = exactDecimalDomain(state);
    const operand = domain ? decimalSumOperand(value, domain) : undefined;
    // A value that is not an exact decimal is the ordinary binder's refusal.
    if (!domain || operand === undefined)
      return this.#scalarValue(scalar.physical.scalar, value, scalar.field, id);
    const { canonical, coefficient } = operand;
    const precision =
      this.adapter.aggregates.decimalSumOperandPrecision(coefficient);
    if (precision === undefined) {
      const digits = coefficient.startsWith("-")
        ? coefficient.length - 1
        : coefficient.length;
      throw new QueryEngineError(
        `The 'having' _sum operand for decimal field '${scalar.field}' needs ${digits} coefficient digits, but its value is outside this provider's exact HAVING operand cast domain. ` +
          "The provider may compute a wider sum, but VibORM cannot express this operand through its exact decimal cast without changing or refusing the value written."
      );
    }
    return this.adapter.literals.decimal(canonical, {
      precision: Math.max(domain.precision, precision),
      scale: domain.scale,
    });
  }
  /**
   * THE JSON NULL TRUTH TABLE and the document operator set. A JSON column's
   * operands are documents rather than scalars, which is a storage difference,
   * not a second semantic interpretation of the same operator.
   *
   * The target always names a scalar here: `lowerOperation` reaches this only
   * when that scalar's own state is a JSON document — never for a `_count`,
   * which has no column domain. A path with a null sentinel is refused at
   * admission (`pathSentinelRefusal`, validation/scalars/json.ts).
   */
  #lowerJsonOperation(predicate: BoundOperation, column: Sql): Sql {
    const a = this.adapter;
    const path = [
      ...(predicate.target.kind === "column"
        ? (predicate.target.path ?? [])
        : []),
    ];
    const value = predicate.value;
    const target = a.json.extract(column, path);
    const text = (kind: TextMatch, member: unknown): Sql => {
      const operand = a.literals.value(member);
      return predicate.insensitive
        ? a.operators.insensitiveText(
            kind,
            a.json.foldableStringAtPath(column, path),
            operand
          )
        : a.operators[`${kind}Text`](
            a.json.stringAtPath(column, path),
            operand
          );
    };
    switch (predicate.operator) {
      case "equals": {
        const sentinel = jsonNullKindOf(value);
        if (sentinel) {
          const isDatabaseNull = a.operators.isNull(column);
          const isJsonNull = a.json.equals(target, a.json.value(null));
          if (sentinel === "DbNull") return isDatabaseNull;
          if (sentinel === "JsonNull") return isJsonNull;
          return a.operators.or(isDatabaseNull, isJsonNull);
        }
        if (value === null && path.length === 0)
          return a.operators.isNull(column);
        return a.json.equals(target, a.json.value(value));
      }
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const compare = a.operators[predicate.operator];
        if (typeof value === "number")
          return compare(a.json.numberAtPath(column, path), this.value(value));
        if (typeof value === "string")
          return compare(a.json.stringAtPath(column, path), this.value(value));
        throw new QueryEngineError(
          `JSON filter '${predicate.operator}' requires a number or string operand.`
        );
      }
      case "string_contains":
        return text("contains", value);
      case "string_starts_with":
        return text("startsWith", value);
      case "string_ends_with":
        return text("endsWith", value);
      case "array_contains":
        return a.json.contains(
          target,
          a.json.value(Array.isArray(value) ? value : [value])
        );
      case "array_starts_with":
        return a.json.equals(
          a.json.extract(column, [...path, "0"]),
          a.json.value(value)
        );
      default:
        // `array_ends_with`, the one operator left: the same upstream owner as
        // the scalar operator switch above enumerates the JSON document
        // operators once, at admission.
        return a.json.equals(a.json.lastElement(target), a.json.value(value));
    }
  }
  /** One distance expression, for filters, ordering and projection alike. */
  #distanceExpression(
    column: Sql,
    state: ScalarState,
    field: string,
    specification: Input,
    usage: "filter" | "orderBy" | "select",
    servable = false
  ): Sql {
    if (state.type === "vector") {
      if (!this.adapter.capabilities.supportsVector)
        throw new FeatureNotSupportedError(
          "vector",
          usage,
          usage === "orderBy"
            ? "vector ordering requires a pgvector-enabled PostgreSQL driver"
            : "vector distance select requires a pgvector-enabled PostgreSQL driver"
        );
      const to = specification.to as number[];
      const { dimension } = state;
      if (dimension !== undefined && to.length !== dimension)
        throw new UnsupportedOperationError(
          `Vector distance ${usage} dimension mismatch for '${field}': expected ${dimension} values, received ${to.length}.`
        );
      const metric = specification.metric === "cosine" ? "cosine" : "l2";
      return this.adapter.vector[metric](
        column,
        this.adapter.vector.literal(to),
        usage === "orderBy" ? (servable ? "servable" : "exact") : undefined
      );
    }
    const geoPoint = this.#geoPoint(`distance ${usage}`);
    if (!geoPoint.distance)
      throw new FeatureNotSupportedError(
        "point",
        `distance ${usage}`,
        "GeoPoint distance is not supported by this provider."
      );
    const target = specification.to as GeoPoint;
    return geoPoint.distance(
      column,
      geoPoint.value(this.value(target.longitude), this.value(target.latitude))
    );
  }
  #lowerRelationPredicate(
    predicate: Extract<PreparedPredicate, { kind: "relation" }>,
    parentAlias?: string
  ): Sql {
    const a = this.adapter;
    if (
      predicate.quantifier === "every" &&
      predicate.link === undefined &&
      !(predicate.predicate && states(predicate.predicate))
    )
      return a.literals.true();
    const { edge, closure } = predicate;
    const childAlias = this.#rowAlias(edge.target);
    const linkAlias = predicate.link ? this.alias() : undefined;
    // A semijoin over a plain reference: `some`/`is` with a body, neither a
    // walk nor a variant arm. Its `FROM` takes the semijoins among its
    // conjuncts that read a row above it (`joins`), and it is one of those
    // where it is a conjunct of a semijoin body and reads above that body.
    const semijoin =
      closure === undefined &&
      predicate.predicate !== undefined &&
      (predicate.quantifier === "some" || predicate.quantifier === "is") &&
      edge.kind === "reference" &&
      edge.discriminator === undefined;
    const frame: LoweringFrame = {
      alias: childAlias,
      escaped: false,
      ...(semijoin && { joins: [] }),
    };
    const parent = semijoin ? this.#frames.at(-1) : undefined;
    const joinable = parent?.joins !== undefined;
    // The body reads above its parent where lowering it marks the parent, so
    // the parent's own mark waits aside meanwhile.
    const marked = parent?.escaped === true;
    if (joinable) parent!.escaped = false;
    this.#frames.push(frame);
    let nested: Sql | undefined;
    const body = predicate.predicate;
    const enclosing: Enclosing = {};
    try {
      nested =
        body === undefined
          ? undefined
          : this.#inside(enclosing, () =>
              predicate.quantifier === "none" ||
              predicate.quantifier === "isNot"
                ? this.#opposite(() => this.#lowerPredicate(body, childAlias))
                : this.#lowerPredicate(body, childAlias)
            );
    } finally {
      this.#frames.pop();
    }
    if (predicate.link) {
      // A policy's own rule reads what it states; a caller's filter is a test
      // of a column a direct read of it could hide.
      if (!this.#lowersLayer)
        this.refuseHiddenLinkRow(edge, predicate.linkFields!, "filter");
      const held = this.#lowerPredicate(predicate.link, linkAlias);
      nested = nested ? a.operators.and(nested, held) : held;
    }
    if (joinable) {
      const above = parent!.escaped;
      parent!.escaped ||= marked;
      if (above) {
        // `EXISTS (… WHERE p AND EXISTS (… WHERE q))` is `EXISTS (… JOIN …
        // WHERE p AND q)`: the inner EXISTS is two-valued, so a conjunct
        // that holds for one joined row holds for the outer row. Correlated
        // past its parent, the nested EXISTS is a subplan PostgreSQL runs per
        // outer row and parent row; joined, the outer one is one semijoin
        // (PGlite, 200k rows: a count 864 ms to 87 ms).
        parent!.joins!.push(
          a.joins.inner(
            this.table(edge.target, childAlias),
            this.#correlated(
              edge,
              parentAlias ?? "",
              childAlias,
              predicate.unscoped === undefined,
              readsRelation(predicate.predicate!)
            )
          ),
          ...frame.joins!
        );
        return nested!;
      }
    }
    const stated = nested
      ? [predicate.quantifier === "every" ? a.operators.not(nested) : nested]
      : [];
    const quantified = this.#quantified(predicate);
    // What the quantifier ranges over (membership, the related domain, a
    // walk's hops) stands negated where it does not hold (`none`, `every`,
    // `isNot`): fewer rows there make the test hold more often.
    const range = (): Sql => {
      if (closure) {
        // The walk is this EXISTS's OWN `WITH`, never wrapped in a derived table
        // or a LATERAL: MySQL answers every outer row from one evaluation of a
        // wrapped correlated recursive CTE wherever the EXISTS is not flattened.
        // The walk owns membership and visibility; the reader joins by key.
        const { cte, cteName, walk, childColumns } = this.#walk(
          edge,
          parentAlias ?? "",
          closure
        );
        const query = sql`${cte} ${a.subqueries.existsCheck(
          sql`${a.identifiers.aliased(a.identifiers.escape(cteName), walk)} ${a.joins.inner(
            this.table(edge.target, childAlias),
            this.#sameRow(
              edge.target,
              childAlias,
              childColumns.map((name) => a.identifiers.column(walk, name))
            )
          )}${this.#attachPoint(childAlias)}`,
          a.operators.and(...stated)
        )}`;
        // Admission refuses a `$row` across a recursive relation: what the
        // walk states reads no row above the one it reaches.
        return this.#sharedWalk(
          edge,
          parentAlias ?? "",
          childAlias,
          closure,
          stated,
          query,
          quantified,
          // A walk `every` judges reaches back from the rows its predicate
          // does not hold of: never the few its author stated.
          closure.selective === true && predicate.quantifier !== "every"
        );
      }
      return this.#relationExists(
        edge,
        parentAlias ?? "",
        childAlias,
        predicate.unscoped === undefined,
        stated,
        quantified,
        enclosing,
        predicate.predicate !== undefined && readsRelation(predicate.predicate),
        frame.escaped,
        frame.joins,
        linkAlias
      );
    };
    return quantified.holds ? range() : this.#opposite(range);
  }
  /** How `predicate`'s quantifier tests its relation's subquery. */
  #quantified(
    predicate: Extract<PreparedPredicate, { kind: "relation" }>
  ): Quantified {
    const { filters } = this.adapter;
    switch (predicate.quantifier) {
      case "some":
        return { of: (query) => filters.some(query), holds: true };
      case "none":
        return { of: (query) => filters.none(query), holds: false };
      case "every":
        return { of: (query) => filters.every(query), holds: false };
      case "is":
        return predicate.predicate
          ? { of: (query) => filters.is(query), holds: true }
          : { of: (query) => filters.isNot(query), holds: false };
      default:
        // `isNot`, the one quantifier left: every relation filter that spells
        // quantifiers refuses a payload naming none of them in its own
        // registered sentence, at admission, so this switch only ever
        // receives an already-admitted quantifier.
        return predicate.predicate
          ? { of: (query) => filters.isNot(query), holds: false }
          : { of: (query) => filters.is(query), holds: true };
    }
  }
  /**
   * The related domain of a relation's rows, where `scoped`. Where the filter
   * goes on below (`deeper`), a dialect that sums nested heights adds this
   * level's `WHERE` height to every level under it: the domain, isolated,
   * pays its own height once, at the end of its branch
   * (`subqueries.isolated`; ENG-6, review 2).
   */
  #relatedWhere(
    edge: Membership,
    child: string,
    scoped: boolean,
    deeper: boolean
  ): Sql | undefined {
    const domain = scoped ? this.domainOf(edge.target, "related") : undefined;
    const lowered = domain && this.lowerSelector(domain, child)!;
    return lowered && deeper
      ? this.adapter.subqueries.isolated(lowered)
      : lowered;
  }
  /** A joined relation's `ON`: its membership, then its related domain. */
  #correlated(
    edge: Membership,
    parent: string,
    child: string,
    scoped: boolean,
    deeper: boolean
  ): Sql {
    const member = this.#membershipWhere(edge, child, parent);
    const related = this.#relatedWhere(edge, child, scoped, deeper);
    return related ? this.adapter.operators.and(member, related) : member;
  }
  /**
   * `EXISTS (SELECT 1 FROM target WHERE correlation AND stated)`: inside a
   * statement sharing its bodies ({@link sharingBodies}), a slot the
   * statement settles to that where the body is lowered once, and else to a
   * test of the body's key set, `EXISTS (SELECT 1 FROM <set> WHERE set.k =
   * parent.fk)`: a semijoin on the correlated columns, read under the same
   * layers and values, so it takes exactly the rows the EXISTS takes. A
   * reference edge only (a junction's and a variant's membership stay
   * where they are), and a body that states something. A junction's
   * membership is its join where the dialect plans that better, on
   * PostgreSQL outside a bounded read ({@link junctionJoin}).
   */
  #relationExists(
    edge: Membership,
    parent: string,
    child: string,
    scoped: boolean,
    stated: readonly Sql[],
    quantified: Quantified,
    enclosing: Enclosing,
    deeper = false,
    correlatedAbove = false,
    joins: readonly Sql[] = [],
    link?: string
  ): Sql {
    const a = this.adapter;
    const junctions = a.capabilities.joinsJunctionFilters;
    // A `$through` condition reads the link row, so that row is joined whatever
    // the dialect prefers: the membership's `IN` keeps it out of the body.
    const joined =
      edge.kind === "junction" &&
      (link !== undefined ||
        junctions === true ||
        (junctions === "unbounded" && !this.#bounded))
        ? this.#junctionJoin(edge, child, parent, link)
        : undefined;
    const member =
      joined?.correlation ?? this.#membershipWhere(edge, child, parent);
    // The related domain is read in this body: a walk it holds lives where
    // its text does.
    const related = this.#inside(enclosing, () =>
      this.#relatedWhere(edge, child, scoped, deeper)
    );
    // A flag join keeps SQLite from flattening the derived table each level
    // of a nested filter reads from on D1, adding the level's height to every
    // level above it (a three-arm policy at 15 levels passes depth 100).
    const table =
      joined?.from ??
      (a.capabilities.boundsExpressionDepth === true
        ? this.table(edge.target, child)
        : this.#attached(edge.target, child));
    const inline = quantified.of(
      a.subqueries.existsCheck(
        joins.length === 0 ? table : sql`${table} ${sql.join(joins, " ")}`,
        a.operators.and(
          related ? a.operators.and(member, related) : member,
          ...stated
        )
      )
    );
    const shared = this.#shared;
    const conditions = related ? [related, ...stated] : stated;
    if (
      shared === undefined ||
      correlatedAbove ||
      joins.length > 0 ||
      edge.kind !== "reference" ||
      edge.discriminator !== undefined ||
      conditions.length === 0
    )
      return inline;
    const query = assembleAdapterSelect(a, {
      columns: sql.join(
        edge.pairs.map((pair, index) =>
          a.identifiers.aliased(
            this.column(edge.target, pair.target, child),
            `k${index}`
          )
        ),
        ", "
      ),
      from: this.#attached(edge.target, child),
      where: a.operators.and(
        ...conditions,
        ...(quantified.holds ? this.#setBound(edge.target, child) : [])
      ),
    });
    const key = sharedKey(query);
    let body = shared.byKey.get(key);
    if (body === undefined) {
      body = {
        name: `__shared_${shared.order.length}`,
        query,
        correlated: true,
        slots: [],
      };
      shared.byKey.set(key, body);
      shared.order.push(body);
    }
    enclosing.body = body;
    const { name } = body;
    const use = quantified.of(
      a.subqueries.existsCheck(
        memberRead(a, name),
        a.operators.and(
          ...edge.pairs.map((pair, index) =>
            a.operators.eq(
              this.column(edge.source, pair.source, parent),
              a.identifiers.column(name, `k${index}`)
            )
          )
        )
      )
    );
    const slot = new SqlSlot(use);
    body.slots.push({
      slot,
      inline,
      use,
      test: {
        alias: parent,
        columns: edge.pairs.map((pair) =>
          this.columnName(edge.source, pair.source)
        ),
        holds: quantified.holds,
      },
    });
    return slot;
  }
  /**
   * A recursive filter's walk from `parent`, `inline`, inside a statement
   * sharing its bodies: a slot the statement settles to `inline` where the
   * walk is lowered once, and else to a test of its REACHING SET, `EXISTS
   * (SELECT 1 FROM <set> WHERE set.k = parent.key)`. Equal walks (the same
   * text once aliases are renumbered, and the same values: the same edge,
   * range, related domain and `stated`) share one set ({@link sharedKey}).
   * The set holds the key of every stored row from which the walk reaches a
   * row `stated` holds of ({@link reachingSet}), so it answers for `parent`
   * where `parent` reads the stored row ({@link rows}) or the walk's first
   * hop reads only its key: elsewhere (a produced row's new value, a masked
   * window) the walk keeps its place, as it does on a dialect bounding
   * recursion iterations, whose walks stay as they were. `selective`: its
   * author stated the rows it reaches back from few, which may lift it from
   * the start ({@link sharingBodies}).
   */
  #sharedWalk(
    edge: Membership,
    parent: string,
    child: string,
    closure: Closure,
    stated: readonly Sql[],
    walk: Sql,
    quantified: Quantified,
    selective: boolean
  ): Sql {
    const a = this.adapter;
    const shared = this.#shared;
    const model = edge.source;
    const keys = this.schema.keys(model);
    const inline = quantified.of(walk);
    if (
      shared === undefined ||
      a.capabilities.boundsRecursionIterations === true ||
      !(
        this.#rows.get(parent) === model ||
        this.#hopFields(edge).every((field) => keys.includes(field))
      )
    )
      return inline;
    // A set a positive test reads may be bounded, one a negative test reads
    // never is ({@link setBound}): the two, and two bounds, are not one set.
    const bound = quantified.holds ? this.#setBound(model, child) : [];
    const bounded = bound.length > 0;
    const key = bounded
      ? `${sharedKey(walk)} bounded ${sharedKey(bound[0]!)}`
      : sharedKey(walk);
    let body = shared.byKey.get(key);
    if (body === undefined) {
      const name = `__shared_${shared.order.length}`;
      body = {
        name,
        query: this.#reachingSet(name, edge, child, closure, stated, bounded),
        correlated: false,
        recursive: true,
        slots: [],
      };
      shared.byKey.set(key, body);
      shared.order.push(body);
    }
    if (selective) body.selective = true;
    const { name } = body;
    const use = quantified.of(
      a.subqueries.existsCheck(
        memberRead(a, name),
        a.operators.and(
          ...keys.map((field, index) =>
            a.operators.eq(
              this.column(model, field, parent),
              a.identifiers.column(name, `k${index}`)
            )
          )
        )
      )
    );
    const slot = new SqlSlot(use);
    body.slots.push({
      slot,
      inline,
      use,
      test: {
        alias: parent,
        columns: keys.map((field) => this.columnName(model, field)),
        holds: quantified.holds,
      },
      within: this.#enclosing.at(-1),
    });
    return slot;
  }
  /**
   * The two terms of a walk's reaching set `name`: the key of every stored
   * row from which 1..`depth` hops of `edge` (every hop when `depth` is
   * false), each into a row of the related domain, reach a row `stated`
   * (lowered on `child`) holds of, and, where `self` holds, of every row it
   * holds of. Read backwards from those rows: the anchor states them (at
   * depth 0 where `self` holds; their predecessors at depth 1, each through a
   * row of the domain, where it does not), and the recursive member adds the
   * predecessors of each row of the set the domain takes, one depth further,
   * below `depth`. A hidden row stops the walk below it, as forwards: it
   * passes nothing on. `UNION` on the key (and depth, when bounded) ends
   * every cycle and states a diamond's row once per depth.
   */
  #reachingSet(
    name: string,
    edge: Membership,
    child: string,
    closure: Closure,
    stated: readonly Sql[],
    bounded: boolean
  ): Sql {
    const a = this.adapter;
    const model = edge.source;
    const { depth, self } = closure;
    const keys = this.schema.keys(model);
    const keyColumns = keys.map((_, index) => `k${index}`);
    const depthColumn = "depth";
    const at = (value: Sql) =>
      depth === false ? [] : [a.identifiers.aliased(value, depthColumn)];
    const domain = this.domainOf(edge.target, "related");
    const related = (alias: string) =>
      domain ? [this.lowerSelector(domain, alias)!] : [];
    const conditions = (all: readonly Sql[]) =>
      all.length === 0 ? undefined : a.operators.and(...all);
    const bound = bounded
      ? (alias: string) => this.#setBound(model, alias)
      : undefined;
    let anchor: Sql;
    if (self)
      anchor = assembleAdapterSelect(a, {
        columns: sql.join(
          [
            ...this.#aliased(keyColumns, this.#rowKey(model, child)),
            ...at(a.expressions.cast(this.value(0), "integer")),
          ],
          ", "
        ),
        from: this.#attached(model, child),
        where: conditions([...stated, ...(bound?.(child) ?? [])]),
      });
    else {
      const first = this.#predecessor(
        edge,
        (field) => this.column(model, field, child),
        bound
      );
      anchor = assembleAdapterSelect(a, {
        columns: sql.join(
          [
            ...this.#aliased(keyColumns, first.key),
            ...at(a.expressions.cast(this.value(1), "integer")),
          ],
          ", "
        ),
        from: sql.join([this.#attached(model, child), ...first.joins], " "),
        where: conditions([...related(child), ...stated]),
      });
    }
    const set = this.alias();
    const carried = (column: string) => a.identifiers.column(set, column);
    // Every key the set states is a stored row's where its predecessors are
    // joined rows: with no domain to read, the row is not joined again.
    const reached =
      domain !== undefined || !this.#joinsPredecessor(edge)
        ? this.alias()
        : undefined;
    const before = this.#predecessor(
      edge,
      (field) =>
        reached === undefined
          ? carried(keyColumns[keys.indexOf(field)]!)
          : this.column(model, field, reached),
      bound
    );
    const recursive = assembleAdapterSelect(a, {
      columns: sql.join(
        [
          ...this.#aliased(keyColumns, before.key),
          ...at(a.expressions.add(carried(depthColumn), this.value(1))),
        ],
        ", "
      ),
      from: sql.join(
        [
          a.identifiers.aliased(a.identifiers.escape(name), set),
          ...(reached === undefined
            ? []
            : [
                a.joins.inner(
                  this.table(model, reached),
                  a.operators.and(
                    this.#sameRow(model, reached, keyColumns.map(carried)),
                    ...related(reached)
                  )
                ),
              ]),
          ...before.joins,
        ],
        " "
      ),
      where: conditions(
        depth === false
          ? []
          : [a.operators.lt(carried(depthColumn), this.value(depth))]
      ),
    });
    return a.setOperations.union(anchor, recursive);
  }
  /**
   * Whether the rows one hop of `edge` leads from are joined to be named
   * ({@link predecessor}), reading nothing of the row they lead into but its
   * key: then each names a stored row.
   */
  #joinsPredecessor(edge: Membership): boolean {
    const keys = this.schema.keys(edge.source);
    if (edge.kind !== "reference")
      return (
        !this.#covers(
          edge.sourceSide.members.map((member) => member.referencedField),
          keys
        ) &&
        edge.targetSide.members.every((member) =>
          keys.includes(member.referencedField)
        )
      );
    return (
      edge.discriminator === undefined &&
      !this.#covers(
        edge.pairs.map((pair) => pair.source),
        keys
      ) &&
      edge.pairs.every((pair) => keys.includes(pair.target))
    );
  }
  /** Whether `fields` are exactly `keys`, in any order. */
  #covers(fields: readonly string[], keys: readonly string[]): boolean {
    return (
      fields.length === keys.length &&
      keys.every((field) => fields.includes(field))
    );
  }
  /**
   * The rows one hop of `edge` leads into `into` from, as their keys and the
   * joins that read them: the hop's own columns where they are the key (a
   * reference's target columns, a junction's source columns), and else the
   * row joined by its membership. A key read from a column names a row that
   * may not exist; it then passes nothing on and matches no row.
   */
  #predecessor(
    edge: Membership,
    into: CarriedRow,
    bound?: (row: string) => readonly Sql[]
  ): { readonly key: readonly Sql[]; readonly joins: readonly Sql[] } {
    const a = this.adapter;
    const model = edge.source;
    const keys = this.schema.keys(model);
    if (edge.kind === "reference") {
      const sources = edge.pairs.map((pair) => pair.source);
      // A bounded walk joins the row its bound reads.
      if (
        bound === undefined &&
        edge.discriminator === undefined &&
        this.#covers(sources, keys)
      )
        return {
          key: keys.map((field) =>
            into(edge.pairs[sources.indexOf(field)]!.target)
          ),
          joins: [],
        };
      const row = this.alias();
      const arm = edge.discriminator;
      return {
        key: this.#rowKey(model, row),
        joins: [
          a.joins.inner(
            this.table(model, row),
            a.operators.and(
              ...(arm === undefined
                ? []
                : [
                    a.operators.eq(
                      arm.side === "source"
                        ? this.column(model, arm.field, row)
                        : into(arm.field),
                      this.value(arm.value)
                    ),
                  ]),
              ...edge.pairs.map((pair) =>
                a.operators.eq(
                  this.column(model, pair.source, row),
                  into(pair.target)
                )
              ),
              ...(bound?.(row) ?? [])
            )
          ),
        ],
      };
    }
    const link = this.alias();
    const linked = a.joins.inner(
      this.#tableNamed(edge.table, link),
      a.operators.and(
        ...this.junctionSideConditions(edge.targetSide, link, into),
        ...this.#linkBound(edge, link)
      )
    );
    const referenced = edge.sourceSide.members.map(
      (member) => member.referencedField
    );
    if (bound === undefined && this.#covers(referenced, keys))
      return {
        key: keys.map((field) =>
          a.identifiers.column(
            link,
            edge.sourceSide.members[referenced.indexOf(field)]!.junctionField
          )
        ),
        joins: [linked],
      };
    const row = this.alias();
    return {
      key: this.#rowKey(model, row),
      joins: [
        linked,
        a.joins.inner(
          this.table(model, row),
          a.operators.and(
            ...this.junctionSideConditions(edge.sourceSide, link, row),
            ...(bound?.(row) ?? [])
          )
        ),
      ],
    };
  }
  /**
   * A relation filter's junction joined to its target, `junction INNER JOIN
   * target ON target.key = junction.target`, and the junction's correlation to
   * the parent row, `junction.source = parent.key`, for the EXISTS's own
   * `WHERE`: the same rows as the target's membership in a correlated junction
   * subquery ({@link membershipWhere}), a pair joined on equal keys being a
   * pair the membership's `IN` admits (a NULL key matches in neither). SQLite
   * walks it from the junction's key per parent row instead of rebuilding the
   * membership's set for every target row (200k posts, 300k links: a
   * tagged-post count 1,240 → 61 ms, an `every` count 2,910 → 65 ms).
   * PostgreSQL hashes it into a semijoin: the same count on PostgreSQL 18,
   * 479 → 7 ms, but 0.2 ms more planning, so a bounded read keeps the
   * membership.
   */
  #junctionJoin(
    edge: Extract<Membership, { kind: "junction" }>,
    child: string,
    parent: string,
    link = this.alias()
  ): { readonly from: Sql; readonly correlation: Sql } {
    const a = this.adapter;
    return {
      from: sql`${this.#tableNamed(edge.table, link)} ${a.joins.inner(
        this.table(edge.target, child),
        a.operators.and(
          ...edge.targetSide.members.map((field) =>
            a.operators.eq(
              this.column(edge.target, field.referencedField, child),
              a.identifiers.column(link, field.junctionField)
            )
          )
        )
      )}`,
      correlation: a.operators.and(
        ...this.junctionSideConditions(edge.sourceSide, link, parent),
        ...this.#linkBound(edge, link)
      ),
    };
  }
  /**
   * `EXISTS (SELECT 1 FROM target WHERE related AND stated)`, correlated to
   * nothing: inside a statement sharing its bodies, every occurrence with the
   * same text and values settles to one `WITH` member holding at most one row,
   * and each reads it as `EXISTS (SELECT 1 FROM <member>)`.
   */
  #lowerExists(
    predicate: Extract<PreparedPredicate, { kind: "exists" }>,
    alias: string
  ): Sql {
    const a = this.adapter;
    const { model } = predicate;
    const child = this.#rowAlias(model);
    const frame = { alias: child, escaped: false };
    this.#frames.push(frame);
    let stated: Sql[];
    try {
      stated = predicate.predicate
        ? [this.#lowerPredicate(predicate.predicate, child)]
        : [];
    } finally {
      this.#frames.pop();
    }
    const domain = this.domainOf(model, "related");
    const lowered = domain && this.lowerSelector(domain, child);
    const related =
      lowered && predicate.predicate && readsRelation(predicate.predicate)
        ? a.subqueries.isolated(lowered)
        : lowered;
    const conditions = related ? [related, ...stated] : stated;
    const where =
      conditions.length === 0
        ? a.literals.true()
        : a.operators.and(...conditions);
    const inline = a.subqueries.existsCheck(
      this.#attached(model, child),
      where
    );
    const shared = this.#shared;
    // Correlated to a row above it: written where it is.
    if (shared === undefined || frame.escaped) return a.filters.some(inline);
    const query = assembleAdapterSelect(a, {
      columns: sql`1`,
      from: this.#attached(model, child),
      where,
      limit: this.value(1),
    });
    const key = sharedKey(query);
    let body = shared.byKey.get(key);
    if (body === undefined) {
      body = {
        name: `__shared_${shared.order.length}`,
        query,
        correlated: false,
        slots: [],
      };
      shared.byKey.set(key, body);
      shared.order.push(body);
    }
    const use = a.filters.some(
      a.subqueries.existsCheck(memberRead(a, body.name), a.literals.true())
    );
    const slot = new SqlSlot(use);
    body.slots.push({
      slot,
      inline: a.filters.some(inline),
      use,
      test: { alias, columns: [], holds: true },
    });
    return slot;
  }
  /**
   * MySQL ERROR 1093: a subquery may not read the table its own statement is
   * mutating. A derived table sidesteps it — it is materialized before the
   * write — while the correlation to the outer mutation survives as an outer
   * reference (MySQL 8.0.14+). The capability the adapter already declares
   * (`supportsMutationTargetInSubquery`) is the whole condition; the wrap goes
   * inside the caller's scalar subquery, which supplies its own parentheses.
   * A mutation's own selector needs no wrap: on MySQL it is the keyed snapshot
   * ({@link lowerMutationLimit}).
   */
  private hideMutationTarget(
    subquery: Sql,
    child: AnyModel,
    mutationTarget: string | undefined
  ): Sql {
    if (
      mutationTarget === undefined ||
      this.adapter.capabilities.supportsMutationTargetInSubquery ||
      child["~"].names.sql !== mutationTarget
    )
      return subquery;
    return throughDerived(this.adapter, subquery, this.alias());
  }
  /**
   * Does the PARENT row claim a membership in this arm?
   *
   * A variant ROW carrier stores the claim on the parent itself — a
   * discriminator naming the arm and a reference to the row — so "linked" is
   * answerable without reading the target at all. That is what separates an
   * EMPTY slot (no claim) from an ORPHANED one (a claim whose row is gone),
   * which the target subquery alone reports identically as `null`.
   *
   * `undefined` where the claim is not the parent's to make: the membership is
   * then the child's or a junction's, and this owner says nothing about it.
   */
  #parentClaimsArm(edge: Membership, parentAlias: string): Sql | undefined {
    if (
      edge.kind !== "reference" ||
      edge.owner !== "source" ||
      edge.discriminator?.side !== "source"
    )
      return undefined;
    const a = this.adapter;
    return a.operators.and(
      a.operators.eq(
        this.column(edge.source, edge.discriminator.field, parentAlias),
        this.value(edge.discriminator.value)
      ),
      ...edge.pairs.map((pair) =>
        a.operators.isNotNull(
          this.column(edge.source, pair.source, parentAlias)
        )
      )
    );
  }
  /** The one join of a relation to its parent, under the {@link related} domain. */
  correlation(
    edge: Membership,
    parent: string | CarriedRow,
    target: string,
    scoped = true
  ): Sql {
    const member = this.#membershipWhere(edge, target, parent);
    return scoped ? this.#related(edge, target, member) : member;
  }
  /**
   * The one place the related domain enters a relation read, conjoined to the
   * `member` condition that reached `target`: outside any quantifier's
   * negation, so `every`, `none` and a negated count read "every VISIBLE
   * member", and on every edge, so a to-one projection, `is`/`isNot`, a to-one
   * order term and an upward recursion read a hidden target as an absent one.
   */
  #related(edge: Membership, target: string, member: Sql): Sql {
    const domain = this.domainOf(edge.target, "related");
    if (domain === undefined) return member;
    return this.adapter.operators.and(
      member,
      this.lowerSelector(domain, target)!
    );
  }
  memberWhere(edge: Membership, parent: Input, alias: string): Sql {
    return this.#membershipWhere(edge, alias, parent);
  }
  /**
   * The rows OUTSIDE a membership, in three-valued logic: a member-side
   * column left NULL, or a parent that holds no key, is outside — where a
   * plain negation of {@link memberWhere} would answer NULL and select nothing
   * (an ordered observation's found requirement, N1).
   */
  outsideWhere(edge: Membership, parent: Input, alias: string): Sql {
    const a = this.adapter;
    const inside = this.#membershipWhere(edge, alias, parent);
    if (edge.kind !== "reference") return a.operators.not(inside);
    const unbound = edge.pairs.some(
      (pair) =>
        parent[pair.source] === null || parent[pair.source] === undefined
    );
    if (unbound) return sql`1 = 1`;
    const columns = [
      ...(edge.discriminator?.side === "target"
        ? [edge.discriminator.field]
        : []),
      ...edge.pairs.map((pair) => pair.target),
    ];
    return a.operators.or(
      a.operators.not(inside),
      ...columns.map((field) =>
        a.operators.isNull(this.column(edge.target, field, alias))
      )
    );
  }
  #membershipWhere(
    edge: Membership,
    target: string,
    source: string | Input | CarriedRow
  ): Sql {
    const a = this.adapter;
    if (edge.kind === "reference") {
      // The source row's own column, where the source is a row and not values.
      const given = typeof source === "object" ? source : undefined;
      const read =
        typeof source === "string"
          ? (field: string) => this.column(edge.source, field, source)
          : typeof source === "function"
            ? source
            : undefined;
      return a.operators.and(
        ...(edge.discriminator
          ? [
              a.operators.eq(
                edge.discriminator.side === "source"
                  ? read
                    ? read(edge.discriminator.field)
                    : this.value(given![edge.discriminator.field])
                  : this.column(edge.target, edge.discriminator.field, target),
                this.value(edge.discriminator.value)
              ),
            ]
          : []),
        ...edge.pairs.map((pair) =>
          read
            ? a.operators.eq(
                read(pair.source),
                this.column(edge.target, pair.target, target)
              )
            : a.operators.eq(
                this.column(edge.target, pair.target, target),
                this.fieldValue(edge.target, pair.target, given![pair.source])
              )
        )
      );
    }
    const junction = this.alias();
    // Membership first: the index on the source side finds the small target
    // worklist before the provider visits those target identities.
    return rowIn(
      a,
      edge.targetSide.members.map((field) =>
        this.column(edge.target, field.referencedField, target)
      ),
      assembleAdapterSelect(a, {
        columns: sql.join(
          edge.targetSide.members.map((field) =>
            a.identifiers.column(junction, field.junctionField)
          ),
          ", "
        ),
        from: this.#tableNamed(edge.table, junction),
        where: a.operators.and(
          ...this.junctionSideConditions(edge.sourceSide, junction, source),
          ...this.#linkBound(edge, junction)
        ),
      })
    );
  }
  #lowerOrder(terms: readonly OrderTerm[]): Sql | undefined {
    if (terms.length === 0) return undefined;
    const a = this.adapter;
    return sql.join(
      terms.map((term) => {
        const direction = term.descending ? "desc" : "asc";
        if (!term.nullable || term.nulls === undefined)
          return a.orderBy[direction](term.expression);
        return term.nulls === "first"
          ? a.orderBy.nullsFirst(term.expression, direction)
          : a.orderBy.nullsLast(term.expression, direction);
      }),
      ", "
    );
  }
  /**
   * One order owner. A scalar key, a to-one relation path, a collection
   * `_count`, a distance and a grouped aggregate are all sort keys; only a
   * direct scalar key can also serve as a cursor's total order.
   */
  #orderTerms(
    model: AnyModel,
    input: Arguments["orderBy"],
    alias: string,
    cursored = false,
    joins?: OrderJoins,
    approximate = false
  ): OrderTerm[] {
    if (!input) return [];
    const terms: OrderTerm[] = [];
    for (const order of entries(input)) {
      for (const field of Object.keys(order)) {
        const direction = order[field];
        if (direction !== undefined)
          terms.push(
            this.#orderTerm(
              model,
              field,
              direction,
              alias,
              cursored,
              joins,
              approximate && terms.length === 0
            )
          );
      }
    }
    return terms;
  }
  #orderTerm(
    model: AnyModel,
    field: string,
    direction: unknown,
    alias: string,
    cursored = false,
    joins?: OrderJoins,
    servable = false
  ): OrderTerm {
    if (model["~"].state.relations[field])
      return this.#relationOrderTerm(
        model,
        field,
        record(direction),
        alias,
        joins
      );
    const physical = physicalField(this.schema, model, field);
    const state = physical.scalar["~"].state;
    const column = this.#operand(model, field, alias);
    const nullable = physical.nullable || this.#gatedHere(model, field);
    if (direction !== "asc" && direction !== "desc") {
      const specification = record(direction);
      if (specification._distance !== undefined) {
        // A cursor's eligibility is a fact about the REQUEST; a provider's
        // vector support is a fact about the PROVIDER. Classifying the order
        // first is what keeps `page`'s sentence the answer on a driver that
        // happens not to support vectors — `distanceExpression` consults the
        // capability while it BUILDS, so it would otherwise pre-empt it.
        if (cursored) throw new UnsupportedOperationError(CURSOR_ORDER_REFUSAL);
        const distance = record(specification._distance);
        const point = state.type === "point";
        return this.#sortKey(
          this.#distanceExpression(
            column,
            state,
            field,
            distance,
            "orderBy",
            servable
          ),
          distance.sort === "desc",
          point ? "last" : undefined,
          point,
          undefined,
          point ? true : undefined
        );
      }
      return this.#sortKey(
        column,
        specification.sort === "desc",
        specification.nulls as "first" | "last" | undefined,
        nullable,
        field
      );
    }
    return this.#sortKey(
      column,
      direction === "desc",
      undefined,
      nullable,
      field
    );
  }
  /**
   * A to-one path is one value of the related row; a collection orders by
   * `_count`. Where the page takes joins and the edge reaches at most one row
   * by a key ({@link #joinsOnce}), the row is LEFT JOINed once per path, its
   * related domain in the ON clause so a parent whose row is hidden or absent
   * stays with NULL, and a deeper hop chains off the joined alias. Otherwise
   * it is a correlated scalar subquery, whose inner hops stay inside it.
   */
  #relationOrderTerm(
    model: AnyModel,
    field: string,
    specification: Input,
    alias: string,
    joins?: OrderJoins
  ): OrderTerm {
    const a = this.adapter;
    // A collection orders by `_count`, and that count is the projection's own
    // count owner — including a variant carrier, which has no single membership.
    const { edges: counted } = this.countedMemberships(model, field);
    if (
      counted.length > 1 ||
      counted[0]!.many ||
      specification._count !== undefined
    )
      return this.#sortKey(
        this.#correlatedCount(counted, undefined, alias),
        specification._count === "desc",
        undefined,
        false
      );
    const edge = counted[0]!;
    const [nested] = Object.entries(specification);
    if (joins && this.#joinsOnce(edge)) {
      const path = `${alias}.${field}`;
      let joined = joins.aliases.get(path);
      if (joined === undefined) {
        joined = this.alias();
        joins.aliases.set(path, joined);
        joins.joins.push(
          a.joins.left(
            this.table(edge.target, joined),
            this.correlation(edge, alias, joined)
          )
        );
      }
      const term = this.#orderTerm(
        edge.target,
        nested![0],
        nested![1],
        joined,
        false,
        joins
      );
      return this.#sortKey(term.expression, term.descending, term.nulls, true);
    }
    const childAlias = this.alias();
    const correlation = this.correlation(edge, alias, childAlias);
    const inner = this.#orderTerm(
      edge.target,
      nested![0],
      nested![1],
      childAlias
    );
    const value = assembleAdapterSelect(a, {
      columns: inner.expression,
      from: this.table(edge.target, childAlias),
      where: correlation,
      limit: this.value(1),
    });
    return this.#sortKey(
      a.subqueries.scalar(value),
      inner.descending,
      inner.nulls,
      true
    );
  }
  /**
   * A join keeps one row per parent only where the resolver proves the
   * correlated key unique on the target: the parent holds the key, which
   * references a target key, or the target holds it under a unique key. A
   * junction or a variant carrier has no such proof.
   */
  #joinsOnce(edge: Membership): boolean {
    const resolved = edge.scope.edge;
    return (
      edge.kind === "reference" &&
      resolved.kind === "foreignKey" &&
      (edge.owner === "source" || resolved.unique)
    );
  }
  #sortKey(
    expression: Sql,
    descending: boolean,
    nulls: "first" | "last" | undefined,
    nullable: boolean,
    field?: string,
    expressionNulls?: true
  ): OrderTerm {
    return freeze({
      expression,
      descending,
      nulls: nulls ?? (descending ? "first" : "last"),
      expressionNulls,
      nullable,
      field,
    });
  }
  #reverseOrder(terms: readonly OrderTerm[]): OrderTerm[] {
    return terms.map((term) =>
      freeze({
        ...term,
        descending: !term.descending,
        nulls:
          term.nulls === undefined || term.expressionNulls
            ? term.nulls
            : term.nulls === "first"
              ? ("last" as const)
              : ("first" as const),
      })
    );
  }
  /**
   * One page owner: the root read and every nested node use it, so a nested
   * window is the ordinary page operator inside its parent's correlation.
   */
  #page(
    model: AnyModel,
    args: Pick<
      Partial<Arguments>,
      "orderBy" | "take" | "skip" | "cursor" | "distinct"
    >,
    alias: string,
    purpose?: RowPurpose,
    joined = true,
    approximate = false
  ): {
    readonly orderBy?: Sql;
    /** The to-one order joins the page's FROM takes after its own. */
    readonly joins?: Sql[];
    readonly limit?: Sql;
    readonly offset?: Sql;
    readonly cursor?: Sql;
    readonly distinct?: Sql;
    readonly distinctOrderBy?: Sql;
    readonly distinctOrder?: QueryParts["distinctOrder"];
  } {
    const backward = args.take !== undefined && args.take < 0;
    const cursored = args.cursor !== undefined;
    const joins: OrderJoins | undefined = joined
      ? { aliases: new Map(), joins: [] }
      : undefined;
    const requested = this.#orderTerms(
      model,
      args.orderBy,
      alias,
      cursored,
      joins,
      approximate
    );
    const total = this.#totalOrder(model, requested, args.cursor, alias);
    // The single raise point for every other non-scalar key: a relation term
    // builds with `field: undefined` and is classified here.
    if (cursored && requested.some((term) => term.field === undefined))
      throw new UnsupportedOperationError(CURSOR_ORDER_REFUSAL);
    const terms = total ?? requested;
    const presented = backward ? this.#reverseOrder(terms) : terms;
    const distinct = (args.distinct?.length ?? 0) > 0;
    return {
      orderBy: this.#lowerOrder(presented),
      joins: joins?.joins.length ? joins.joins : undefined,
      distinctOrderBy:
        backward && distinct ? this.#lowerOrder(terms) : undefined,
      distinctOrder:
        distinct && terms.length > 0
          ? this.#distinctOrder(terms, presented)
          : undefined,
      limit:
        args.take === undefined ? undefined : this.value(Math.abs(args.take)),
      offset: args.skip === undefined ? undefined : this.value(args.skip),
      cursor:
        args.cursor === undefined
          ? undefined
          : this.#cursorCondition(
              model,
              backward ? this.#reverseOrder(total!) : total!,
              args.cursor,
              purpose
            ),
      distinct: args.distinct?.length
        ? sql.join(
            args.distinct.map((field) => this.#operand(model, field, alias)),
            ", "
          )
        : undefined,
    };
  }
  /**
   * A distinct page's order read from its own rows: each term projected once
   * as `_ordN` beside the window that picks each group's representative, and
   * the presented order over those columns. The emulation's outer `ORDER BY`
   * reads them, so one window (`_rn`) does the work a second one ranking every
   * row (`_ord`) did: one sort fewer (200k rows: PGlite 273 → 127 ms, SQLite
   * 253 → 121 ms). `presented` is `terms`, reversed where the page is.
   */
  #distinctOrder(
    terms: readonly OrderTerm[],
    presented: readonly OrderTerm[]
  ): QueryParts["distinctOrder"] {
    const a = this.adapter;
    return {
      keys: sql.join(
        terms.map((term, index) =>
          a.identifiers.aliased(term.expression, `_ord${index}`)
        ),
        ", "
      ),
      orderBy: this.#lowerOrder(
        presented.map((term, index) => ({
          ...term,
          expression: a.identifiers.escape(`_ord${index}`),
        }))
      )!,
    };
  }
  /** A windowed read needs a deterministic total order, not just the caller's. */
  #totalOrder(
    model: AnyModel,
    requested: readonly OrderTerm[],
    cursor: Input | undefined,
    alias: string
  ): OrderTerm[] {
    if (getModelKeyCatalog(model).rowKey === undefined && cursor === undefined)
      return [...requested];
    const terms = this.#completeOrder(
      model,
      requested,
      alias,
      cursor ? Object.keys(this.#identityEntries(model, cursor)) : []
    );
    // Fill the owned completed array directly. Nullable keys need an explicit
    // placement, and cursor comparisons consume the complete term descriptors;
    // ordinary non-nullable ordering does not use a null placement.
    for (let index = 0; index < terms.length; index++) {
      const term = terms[index]!;
      if (term.nulls === undefined && (term.nullable || cursor !== undefined)) {
        terms[index] = freeze({
          ...term,
          nulls: term.descending ? "first" : "last",
        });
      }
    }
    return terms;
  }
  /**
   * The caller's terms completed by the model's identity: the ONE complete-key
   * tie-break. A windowed page and a recursive sibling order both need a
   * deterministic order and both read it here, so equal sort keys break the
   * same way wherever one parent's rows are ordered — a second spelling (the
   * row key in constraint order) ordered the same tied siblings differently
   * under recursion than under the ordinary window.
   */
  #completeOrder(
    model: AnyModel,
    requested: readonly OrderTerm[],
    alias: string,
    cursorFields: readonly string[] = []
  ): OrderTerm[] {
    const terms = [...requested];
    const ordered = new Set<string>();
    for (const term of terms) {
      if (term.field !== undefined) ordered.add(term.field);
    }
    const identity = this.keyOrder(model);
    const completion =
      cursorFields.length === 0 ? identity : [...identity, ...cursorFields];
    for (const field of completion) {
      if (ordered.has(field)) continue;
      ordered.add(field);
      const physical = physicalField(this.schema, model, field);
      terms.push(
        this.#sortKey(
          this.#operand(model, field, alias),
          false,
          "last",
          physical.nullable || this.#gatedHere(model, field),
          field
        )
      );
    }
    return terms;
  }
  /** A strict unique selector's exact field values, compound keys expanded. */
  #identityEntries(model: AnyModel, input: Input): Input {
    const identity: Input = {};
    for (const [name, value] of Object.entries(input)) {
      const key = findAddressableKey(model, name);
      if (key?.name)
        for (const field of key.fields) identity[field] = record(value)[field];
      else identity[name] = value;
    }
    return identity;
  }
  /**
   * One null-aware lexicographic window against the cursor row. Where every
   * key is NOT NULL and shares a direction the same meaning is spelled as a
   * row-value comparison, which a planner can turn into a range seek; any
   * other window with a NOT NULL leading key states that key's bound beside
   * it, so the seek survives mixed directions and nullable later keys.
   */
  #cursorCondition(
    model: AnyModel,
    order: readonly OrderTerm[],
    cursor: Input,
    purpose: RowPurpose | undefined
  ): Sql {
    const a = this.adapter;
    const identity = this.#identityEntries(model, cursor);
    const sourceAlias = this.alias();
    // The anchor is a candidate like any other: a hidden one is a missing one.
    const scope = purpose && this.domainOf(model, purpose);
    const where = a.operators.and(
      ...(scope ? [this.lowerSelector(scope, sourceAlias)!] : []),
      ...Object.entries(identity).map(([field, value]) => {
        if (value === null)
          throw new QueryEngineError(
            `Cursor field '${field}' cannot be null. Cursor must point to a specific record.`
          );
        return a.operators.eq(
          this.#operand(model, field, sourceAlias),
          this.fieldValue(model, field, value)
        );
      })
    );
    const descending = order[0]!.descending;
    const sargable = order.every(
      (term) => !term.nullable && term.descending === descending
    );
    const cursorRow = (columns: Sql[]) =>
      assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: this.table(model, sourceAlias),
        where,
        limit: this.value(1),
      });
    const keyColumns = order.map((term) =>
      this.#operand(model, term.field!, sourceAlias)
    );
    if (sargable && !a.operators.rows)
      return (descending ? a.operators.lte : a.operators.gte)(
        rowValue(order.map((term) => term.expression)),
        a.subqueries.scalar(cursorRow(keyColumns))
      );
    const cursorAlias = this.alias();
    const carrier = (index: number) => `${CURSOR_CARRIER_PREFIX}${index}`;
    const derived = cursorRow(
      keyColumns.map((column, index) =>
        a.identifiers.aliased(column, carrier(index))
      )
    );
    const comparisons = order.map((term, index) => ({
      row: term.expression,
      cursor: a.identifiers.column(cursorAlias, carrier(index)),
      term,
    }));
    const equalities: Sql[] = [];
    const afterTerms: Sql[] = [];
    for (const { row, cursor: key, term } of comparisons) {
      const compare = term.descending ? a.operators.lt : a.operators.gt;
      const strict = a.operators.and(
        a.operators.isNotNull(row),
        compare(row, key)
      );
      afterTerms.push(
        a.operators.and(
          ...equalities,
          term.nulls === "first"
            ? a.operators.or(
                a.operators.and(
                  a.operators.isNull(key),
                  a.operators.isNotNull(row)
                ),
                a.operators.and(a.operators.isNotNull(key), strict)
              )
            : a.operators.and(
                a.operators.isNotNull(key),
                a.operators.or(a.operators.isNull(row), strict)
              )
        )
      );
      equalities.push(
        a.operators.or(
          a.operators.and(a.operators.isNull(row), a.operators.isNull(key)),
          a.operators.and(
            a.operators.isNotNull(row),
            a.operators.isNotNull(key),
            a.operators.eq(row, key)
          )
        )
      );
    }
    afterTerms.push(a.operators.and(...equalities));
    const window = a.operators.exists(
      assembleAdapterSelect(a, {
        columns: a.literals.true(),
        from: a.subqueries.correlate(derived, cursorAlias),
        where: a.operators.or(...afterTerms),
      })
    );
    // Every row after the anchor sorts at or past its NOT NULL leading key:
    // that bound, implied by the window, is the range a planner can seek.
    const [lead] = order;
    if (lead!.nullable) return window;
    return a.operators.and(
      (lead!.descending ? a.operators.lte : a.operators.gte)(
        lead!.expression,
        a.subqueries.scalar(cursorRow([keyColumns[0]!]))
      ),
      window
    );
  }
  /**
   * One `SELECT`, its statement sharing its relation bodies where the adapter
   * does ({@link sharingBodies}): a row a write locates or captures
   * (`FOR UPDATE`, after the `WITH`) or re-reads, and a premise's probe, as
   * a read's. Inside a statement already sharing (a read's), it joins that
   * statement's scope.
   */
  override select(
    model: AnyModel,
    args: Partial<Arguments>,
    membership?: { edge: Membership; parent: Input; outside?: boolean },
    controls: SqlSelectControls = {}
  ): Query {
    if (!this.sharesBodies)
      return this.#select(model, args, membership, controls);
    let query: Query | undefined;
    const statement = this.#sharingBodies(() => {
      query = this.#select(model, args, membership, controls);
      return query.sql;
    });
    return statement === query!.sql ? query! : { ...query!, sql: statement };
  }
  #select(
    model: AnyModel,
    args: Partial<Arguments>,
    membership:
      | { edge: Membership; parent: Input; outside?: boolean }
      | undefined,
    controls: SqlSelectControls
  ): Query {
    const alias = this.#rootAlias();
    if (controls.source === undefined) this.#rows.set(alias, model);
    // The shipped owner sequence, and the reason it is stated here: when one
    // call violates two contracts at once, the refusal the caller sees is the
    // one whose owner runs first. `buildFind` (`operations/find-common.ts`)
    // pages before it selects and selects before it builds the `where`, so the
    // cursor refusal outranks a projection refusal and both outrank a `where`
    // refusal. Nothing below reads the projection or the selector, so this is
    // an ORDER, not a dependency (`g4/unit01-review-followup-3.md` finding K).
    // A locking read keeps its order terms correlated: PostgreSQL refuses
    // FOR UPDATE on the nullable side of an outer join.
    const page = this.#page(
      model,
      args,
      alias,
      controls.purpose,
      !controls.forUpdate,
      controls.approximate
    );
    const prepared = controls.projection ?? this.prepareProjection(model, args);
    const projection = this.lowerProjection(
      prepared,
      alias,
      controls.purpose !== undefined
    );
    const given =
      controls.selector ??
      (args.where === undefined
        ? undefined
        : this.prepareSelector(model, args.where, false, false));
    const selector =
      controls.purpose === undefined
        ? given
        : this.#within(model, given, controls.purpose);
    const filter = selector ? this.lowerSelector(selector, alias) : undefined;
    const a = this.adapter;
    const unless =
      controls.unless &&
      a.operators.not(
        a.expressions.coalesce(
          this.#opposite(() => this.lowerSelector(controls.unless!, alias)) ??
            a.literals.true(),
          a.literals.false()
        )
      );
    const columns = sql.join(projection, ", ");
    const where = this.#selectWhere(
      model,
      alias,
      membership,
      filter,
      unless,
      page.cursor,
      controls
    );
    const shared = this.#shared;
    if (shared && controls.source === undefined && !controls.forUpdate)
      shared.root ??= { alias, scope: sql`${columns} ${where ?? sql.empty}` };
    return {
      sql: assembleAdapterSelect(this.adapter, {
        columns,
        from:
          controls.source === undefined
            ? // FOR UPDATE refuses the nullable side of an outer join.
              controls.forUpdate
              ? this.table(model, alias)
              : this.#attached(model, alias)
            : a.identifiers.aliased(
                a.identifiers.escape(controls.source),
                alias
              ),
        joins: page.joins,
        where,
        orderBy: page.orderBy,
        limit: page.limit,
        offset: page.offset,
        forUpdate: controls.forUpdate,
        ...(page.distinct
          ? {
              distinct: page.distinct,
              distinctOrderBy: page.distinctOrderBy,
              distinctOrder: page.distinctOrder,
              distinctColumnAliases: prepared.fields.map((field) => field.name),
            }
          : {}),
      }),
      shape: prepared.shape,
    };
  }
  /** {@link select}'s conjunction, in its order; `undefined` for none. */
  #selectWhere(
    model: AnyModel,
    alias: string,
    membership:
      | { edge: Membership; parent: Input; outside?: boolean }
      | undefined,
    filter: Sql | undefined,
    unless: Sql | undefined,
    cursor: Sql | undefined,
    controls: Pick<SqlSelectControls, "condition" | "identity" | "row">
  ): Sql | undefined {
    const where: Sql[] = [];
    if (membership)
      where.push(
        membership.outside
          ? this.outsideWhere(membership.edge, membership.parent, alias)
          : this.memberWhere(membership.edge, membership.parent, alias)
      );
    if (filter) where.push(filter);
    if (unless) where.push(unless);
    if (cursor) where.push(cursor);
    if (controls.identity)
      where.push(this.lowerIdentity(model, controls.identity, alias));
    if (controls.row) where.push(this.#rowCondition(model, controls.row));
    const { condition } = controls;
    if (condition)
      where.push(
        typeof condition === "function" ? condition(alias) : condition
      );
    return where.length === 0
      ? undefined
      : this.adapter.operators.and(...where);
  }
  #rowCondition(model: AnyModel, row: RowCondition): Sql {
    const a = this.adapter;
    switch (row.kind) {
      case "fieldNull":
        return a.operators.isNull(this.column(model, row.field));
      case "notIdentity":
        return a.operators.not(
          a.operators.or(
            ...row.identities.map((identity) =>
              this.lowerIdentity(model, identity)
            )
          )
        );
      default:
        return a.operators.or(
          ...row.fields.map((field) => {
            const held = this.fieldValue(row.model, field, row.before[field]);
            return a.operators.not(
              a.operators.eq(
                held,
                this.updateValue(row.model, field, row.after[field], held)
              )
            );
          })
        );
    }
  }
  /**
   * Every read verb is one cardinality and shape decision over the same
   * select, projection and decoder owners, its statement sharing its
   * relation bodies where the adapter does ({@link sharingBodies}).
   */
  override read(
    model: AnyModel,
    operation: ReadOperation,
    args: Arguments
  ): Read {
    this.#bounded =
      operation === "findUnique" ||
      operation === "findFirst" ||
      operation === "exist" ||
      (operation !== "groupBy" && args.take !== undefined);
    if (!this.sharesBodies) return this.#read(model, operation, args);
    let read: Read | undefined;
    const statement = this.#sharingBodies(() => {
      read = this.#read(model, operation, args);
      return read.query.sql;
    });
    return { ...read!, query: { ...read!.query, sql: statement } };
  }
  #read(model: AnyModel, operation: ReadOperation, args: Arguments): Read {
    switch (operation) {
      case "findUnique": {
        // The one read verb whose `where` is a unique selector: its addressable
        // entries name the row through the constraint, exactly as the shipped
        // `buildWhereUnique` compiles them, while `findFirst`/`findMany` read
        // the same object as a filter.
        const query = this.select(model, args, undefined, {
          selector:
            args.where === undefined
              ? undefined
              : this.prepareSelector(model, args.where, true, false),
          purpose: "root",
        });
        return {
          query,
          single: true,
          value: query.shape,
          result: firstRow,
        };
      }
      case "findFirst": {
        // A negative take selects from the end of the window: the signed unit
        // limit flips the total order and still returns one row.
        const take = args.take === undefined ? 1 : Math.sign(args.take);
        const query = this.select(
          model,
          { ...this.#ordered(model, args), take },
          undefined,
          this.#candidates(operation, args)
        );
        return {
          query,
          single: true,
          value: query.shape,
          result: firstRow,
        };
      }
      case "findMany": {
        const backward = args.take !== undefined && args.take < 0;
        const query = this.select(
          model,
          this.#ordered(model, args),
          undefined,
          this.#candidates(operation, args)
        );
        return {
          query,
          single: false,
          value: rowSet(query),
          result: backward ? reversedRows : rowIdentity,
        };
      }
      default:
        return this.#readAggregate(model, operation, args);
    }
  }
  /** A row read's root candidates, its order servable where it may be. */
  #candidates(operation: ReadOperation, args: Arguments): SqlSelectControls {
    return approximateOrder(operation, args)
      ? { ...ROOT_CANDIDATES, approximate: true }
      : ROOT_CANDIDATES;
  }
  /** Counting and aggregate reads, out of line from the row reads above. */
  #readAggregate(
    model: AnyModel,
    operation: Exclude<ReadOperation, "findUnique" | "findFirst" | "findMany">,
    args: Arguments
  ): Read {
    switch (operation) {
      case "exist": {
        // Existence is order-blind and `exist` admits only `where`: the
        // filtered table itself, with no total order to sort or scan by.
        const a = this.adapter;
        const alias = this.#rootAlias();
        const rows = assembleAdapterSelect(a, {
          columns: a.literals.true(),
          from: this.table(model, alias),
          where: this.lowerWhere(model, args.where, alias),
        });
        const query: Query = {
          sql: a.clauses.select(
            a.identifiers.aliased(a.operators.exists(rows), "_count")
          ),
          shape: { kind: "object", fields: { _count: BOOLEAN_LEAF } },
          expectedRows: {
            count: 1,
            missing: new QueryEngineError(
              "Provider omitted the required existence result row."
            ),
          },
        };
        return {
          query,
          single: false,
          value: BOOLEAN_LEAF,
          result: (rows) => rows[0]?._count ?? false,
        };
      }
      case "count": {
        const selected = args.select ? record(args.select) : undefined;
        const outputs: { name: string; field?: string }[] = selected
          ? [
              ...(selected._all ? [{ name: "_all" }] : []),
              ...Object.keys(selected)
                .filter((field) => field !== "_all" && selected[field])
                .map((field) => ({ name: field, field })),
            ]
          : [{ name: "_count" }];
        const fields = outputs.flatMap(({ field }) =>
          field === undefined ? [] : [field]
        );
        const query = this.aggregated(
          model,
          args,
          fields,
          (alias) =>
            outputs.map(({ name, field }): [string, Sql] => [
              name,
              this.adapter.aggregates.count(
                field === undefined
                  ? undefined
                  : this.#operand(model, field, alias)
              ),
            ]),
          () => ({
            kind: "object",
            fields: Object.fromEntries(
              outputs.map(({ name }) => [name, COUNT_LEAF])
            ),
          })
        );
        query.expectedRows = {
          count: 1,
          missing: new QueryEngineError(
            "Provider omitted the required aggregate result row."
          ),
        };
        return {
          query,
          // `count` publishes a number and `exist` a boolean: one VALUE, not one
          // row, so neither is `single` — the row they decode is scaffolding.
          single: selected !== undefined,
          value: selected ? query.shape : COUNT_LEAF,
          result: (rows) =>
            selected ? (rows[0] ?? {}) : ((rows[0]?._count as number) ?? 0),
        };
      }
      case "aggregate": {
        const prepared = this.#prepareAggregates(model, args);
        const query = this.aggregated(
          model,
          args,
          prepared.fields,
          (alias) => prepared.columns(alias),
          () => ({ kind: "object", fields: prepared.fields_ })
        );
        return {
          query,
          single: true,
          value: query.shape,
          result: aggregateRow,
        };
      }
      case "groupBy": {
        const query = this.grouped(model, args);
        return {
          query,
          single: false,
          value: rowSet(query),
          result: rowIdentity,
        };
      }
      default:
        return unreachable(operation, "read operation");
    }
  }
  /**
   * One aggregate statement. Aggregates are order-blind, so only a page
   * (`take`, `skip`, `cursor`) needs a window: the same filter, total order,
   * cursor and page, aggregated outside it. An unpaged aggregate reads the
   * filtered table itself, which leaves the provider its count fast path and
   * covering indexes instead of a key-ordered scan or a sort.
   */
  private aggregated(
    model: AnyModel,
    args: Arguments,
    fields: readonly string[],
    columns: (alias: string) => [string, Sql][],
    shape: (alias: string) => Extract<Shape, { kind: "object" }>
  ): Query {
    const a = this.adapter;
    const inner = this.#rootAlias();
    // The default order only decides which rows a page holds.
    const page = this.#page(model, this.#ordered(model, args), inner, "root");
    const filter = this.lowerWhere(model, args.where, inner);
    const aggregate = (alias: string, from: Sql, where?: Sql): Query => ({
      sql: assembleAdapterSelect(a, {
        columns: sql.join(
          columns(alias).map(([name, expression]) =>
            a.identifiers.aliased(expression, name)
          ),
          ", "
        ),
        from,
        where,
      }),
      shape: shape(alias),
    });
    // A read-gated model aggregates a masked window (K5): its gate lowered
    // once per row, not once per aggregate over the field.
    if (!((page.limit ?? page.offset ?? page.cursor) || this.#masks(model)))
      return aggregate(inner, this.table(model, inner), filter);
    const window = assembleAdapterSelect(a, {
      columns: fields.length
        ? sql.join(
            [...new Set(fields)].map((field) =>
              a.identifiers.aliased(
                this.#operand(model, field, inner),
                this.columnName(model, field)
              )
            ),
            ", "
          )
        : a.identifiers.aliased(this.value(1), "0viborm_row"),
      from: this.table(model, inner),
      joins: page.joins,
      where: a.operators.and(
        ...(filter ? [filter] : []),
        ...(page.cursor ? [page.cursor] : [])
      ),
      orderBy: page.orderBy,
      limit: page.limit,
      offset: page.offset,
    });
    const outer = this.alias();
    // The window masks its read-gated columns: the aggregate reads them as
    // they are.
    return this.#overMasked(() =>
      aggregate(outer, a.subqueries.correlate(window, outer))
    );
  }
  /** The admitted aggregate selections, as columns and as decoder leaves. */
  #prepareAggregates(
    model: AnyModel,
    args: Arguments
  ): {
    readonly fields: string[];
    readonly fields_: Record<string, Shape | Leaf>;
    columns(alias: string): [string, Sql][];
  } {
    const a = this.adapter;
    const fields: string[] = [];
    const shape: Record<string, Shape | Leaf> = {};
    const builders: ((alias: string) => [string, Sql])[] = [];
    for (const name of AGGREGATES) {
      const selection = args[name];
      if (!selection) continue;
      if (name === "_count" && selection === true) {
        shape._count = COUNT_LEAF;
        builders.push(() => ["_count", a.aggregates.count()]);
        continue;
      }
      const selected = Object.entries(record(selection)).filter(
        ([, include]) => include
      );
      if (selected.length === 0) continue;
      const leaves: Record<string, Leaf> = {};
      for (const [field] of selected) {
        if (field !== "_all") fields.push(field);
        leaves[field] = this.#aggregateLeaf(model, name, field);
      }
      shape[name] = { kind: "object", fields: leaves };
      builders.push((alias) => [
        name,
        a.json.objectFromColumns(
          selected.map(([field]) => {
            const leaf = leaves[field]!;
            const scalar =
              field === "_all" ? undefined : this.scalar(model, field);
            const split = this.splitSum(leaf);
            if (split)
              return [
                field,
                a.json.array(
                  split
                    .sql(this.#preparedColumn(scalar!, alias))
                    .parts.map((part) => this.#carriedValue(leaf, part))
                ),
              ];
            return [
              field,
              this.#carriedValue(
                leaf,
                this.#aggregateExpression(name, scalar, alias)
              ),
            ];
          })
        ),
      ]);
    }
    return {
      fields,
      fields_: shape,
      columns: (alias) => builders.map((build) => build(alias)),
    };
  }
  /** One aggregate leaf classification: projection, `having` and `orderBy`. */
  #aggregateLeaf(model: AnyModel, aggregate: Aggregate, field: string): Leaf {
    if (aggregate === "_count") return COUNT_LEAF;
    const leaf = this.scalarShape(model, field);
    if (aggregate === "_avg" && leaf.type !== "decimal")
      return freeze({ kind: "scalar", type: "number", nullable: true });
    // Admission admits `_sum` only on the summable types, every one widened.
    return freeze({
      ...leaf,
      nullable: true,
      widened: aggregate === "_sum" ? true : undefined,
    });
  }
  /**
   * A split `_sum` as `having` compares it and a grouped `orderBy` sorts it:
   * the sum the projection publishes, not the provider's own `SUM`, which
   * can raise or answer another number (engine-10).
   */
  #splitSumSql(scalar: PreparedScalar, column: Sql): SplitSumSql | undefined {
    return this.splitSum(
      this.#aggregateLeaf(scalar.model, "_sum", scalar.field)
    )?.sql(column);
  }
  #aggregateExpression(
    aggregate: Aggregate,
    scalar: PreparedScalar | undefined,
    alias?: string
  ): Sql {
    const a = this.adapter;
    const column = scalar ? this.#preparedColumn(scalar, alias) : undefined;
    const state = scalar?.physical.scalar["~"].state;
    // biome-ignore lint/style/useDefaultSwitchClause: the Aggregate union is exhaustive; a default would be dead code.
    switch (aggregate) {
      case "_count":
        return a.aggregates.count(column);
      case "_sum":
        return (
          this.#splitSumSql(scalar!, column!)?.value ??
          a.aggregates.sum(column!)
        );
      case "_min":
      case "_max": {
        // Admission admits `_all` under `_count` alone, so these name a
        // column. A compact identifier is aggregated in the spelling it
        // TRAVELS in (`identifier.ts`); every other column is aggregated as
        // stored.
        const operand = aggregatedIdentifier(
          a,
          this.scalarShape(scalar!.model, scalar!.field).id,
          column!
        );
        return aggregate === "_min"
          ? a.aggregates.min(operand, state?.type === "boolean")
          : a.aggregates.max(operand, state?.type === "boolean");
      }
      case "_avg":
        return state?.type === "decimal" && state.decimal
          ? a.aggregates.decimalAvg(column!, state.decimal)
          : a.aggregates.avg(column!);
    }
  }
  override selectSeries(
    prepared: PreparedProjection,
    identities: Input[],
    operation: "createMany" | "updateMany" = "createMany"
  ): Query {
    const model = prepared.model;
    const alias = this.#rootAlias();
    const projection = this.lowerProjection(prepared, alias);
    const predicates = identities.map((identity) =>
      this.lowerIdentity(model, identity, alias)
    );
    return {
      sql: assembleAdapterSelect(this.adapter, {
        columns: sql.join(projection, ", "),
        from: this.table(model, alias),
        where: balancedOr(predicates, (arms) =>
          this.adapter.operators.or(...arms)
        ),
        orderBy: this.adapter.expressions.caseWhen(
          predicates.map((when, index) => ({
            when,
            then: this.value(index),
          })),
          this.value(identities.length)
        ),
      }),
      shape: prepared.shape,
      expectedRows: this.seriesExpectation(model, identities.length, operation),
    };
  }
  /**
   * `visible`: every row this projection reads is one the domain takes, so
   * each layer's `read` holds there and its evidence tests the rest alone; a
   * row captured by identity (a write's) is not (K5).
   */
  lowerProjection(
    projection: PreparedProjection,
    alias?: string,
    visible = false
  ): Sql[] {
    const columns: Sql[] = [];
    for (const field of projection.fields) {
      columns.push(
        this.adapter.identifiers.aliased(
          this.#lowerProjectionField(projection, field, alias, visible),
          field.name
        )
      );
    }
    return columns;
  }
  /** Count, distance and polymorphic members, out of line from plain columns. */
  #lowerSpecialProjectionField(
    projection: PreparedProjection,
    field: Exclude<
      PreparedProjectionField,
      { kind: "scalar" | "sentinel" | "relation" | "evidence" | "gate" }
    >,
    alias?: string
  ): Sql {
    const a = this.adapter;
    let expression: Sql;
    if (field.kind === "counts") {
      expression = a.json.objectFromColumns(
        field.counts.map((count) => [
          count.relation,
          this.#correlatedCount(
            count.edges,
            count.selector,
            alias ?? "",
            count.negated
          ),
        ])
      );
    } else if (field.kind === "distance") {
      expression = this.#distanceExpression(
        this.column(projection.model, field.field, alias),
        physicalField(this.schema, projection.model, field.field).scalar["~"]
          .state,
        field.field,
        field.specification,
        "select"
      );
    } else {
      // The slot's own document: one entry per SELECTED arm, and — for a
      // junction-carried slot — one integrity entry naming every CONFIGURED
      // member (D-26). The integrity entry is a sibling of the arms, so it is
      // answered whatever `only` selected, including nothing at all.
      const integrity: [string, Sql][] =
        field.memberships.length === 0
          ? []
          : [
              [
                POLYMORPHIC_COLLECTION_ORPHANS_KEY,
                a.json.document(
                  a.json.objectFromColumns(
                    field.memberships.map((member) => [
                      member.variant,
                      this.#orphanedMemberships(member.edge, alias ?? ""),
                    ])
                  )
                ),
              ],
            ];
      const resolved = this.schema.index
        .get(projection.model)!
        .get(field.name)!;
      if (resolved.edge.kind === "variantRowCarrier") {
        const edge = resolved.edge;
        const type = this.column(
          projection.model,
          edge.storage.typeColumn.name,
          alias
        );
        const id = this.column(
          projection.model,
          edge.storage.idColumn.name,
          alias
        );
        const empty = slotMayBeEmpty(resolved)
          ? a.operators.and(a.operators.isNull(type), a.operators.isNull(id))
          : a.literals.false();
        const valid = a.operators.and(
          a.operators.isNotNull(id),
          a.operators.or(
            ...edge.members.map((member) =>
              a.operators.eq(type, this.value(member.entry.storedValue))
            )
          )
        );
        const invalid = a.expressions.caseWhen(
          [{ when: a.operators.or(empty, valid), then: this.value(0) }],
          this.value(1)
        );
        integrity.push([
          POLYMORPHIC_COLLECTION_ORPHANS_KEY,
          a.json.document(a.json.objectFromColumns([["$storage", invalid]])),
        ]);
      }
      expression = a.json.object([
        ...field.arms.map((arm) => {
          const row = this.#lowerRelationProjection(arm, alias ?? "");
          const claim = field.many
            ? undefined
            : this.#parentClaimsArm(arm.edge, alias ?? "");
          // A claimed arm always carries a DOCUMENT: the empty one says
          // "linked, and the row is gone", which the decoder refuses from
          // the arm's own selected keys (Arnaud's D-19 — no private carrier
          // column). An unclaimed arm stays null, which is an empty slot.
          return [
            arm.variant,
            a.json.document(
              claim
                ? a.expressions.caseWhen(
                    [
                      {
                        when: claim,
                        then: a.expressions.coalesce(
                          row,
                          this.#missingArm(arm.edge, alias ?? "")
                        ),
                      },
                    ],
                    a.literals.null()
                  )
                : row
            ),
          ] as [string, Sql];
        }),
        ...integrity,
      ]);
    }
    return expression;
  }
  #lowerProjectionField(
    projection: PreparedProjection,
    field: PreparedProjectionField,
    alias?: string,
    visible = false
  ): Sql {
    const a = this.adapter;
    let expression: Sql;
    if (field.kind === "scalar") {
      expression = this.projectedColumn(projection.model, field.name, alias);
    } else if (field.kind === "sentinel") {
      expression = a.expressions.cast(a.literals.value(1), "integer");
    } else if (field.kind === "evidence") {
      expression = this.#lowerEvidence(projection.model, field, alias, visible);
    } else if (field.kind === "gate") {
      expression = this.#truth(
        this.#gateHolds(projection.model, field.gate, alias, visible)
      );
    } else if (field.kind === "relation") {
      expression = this.#duplicateMembershipGuard(
        field.edge,
        alias ?? "",
        field.recurrence
          ? this.#lowerRecursiveRelationProjection(
              field,
              field.recurrence,
              alias ?? ""
            )
          : this.#lowerRelationProjection(field, alias ?? "")
      );
    } else {
      expression = this.#lowerSpecialProjectionField(projection, field, alias);
    }
    return expression;
  }
  /**
   * Where `input`, one of `model`'s predicates in `layer`, holds on the row
   * at `alias`, as that layer's node: R5 and R6 judge it as they judge the
   * layer's filter. `undefined` where the call drops it (it holds).
   */
  #layerHolds(
    model: AnyModel,
    layer: number,
    input: Input,
    alias?: string
  ): Sql | undefined {
    return this.lowerSelector(this.domain!.layered(model, layer, input), alias);
  }
  /** Where a read-gated field's row carries it: every gating layer's `read` and predicate. */
  #gateHolds(
    model: AnyModel,
    gate: FieldGate,
    alias: string | undefined,
    visible: boolean
  ): Sql | undefined {
    const held: Sql[] = [];
    // A gate masks a value: neither a positive nor a negative test, so no
    // set it reads is bounded ({@link setBound}) and it holds where it would.
    this.#unbounded++;
    try {
      for (const [layer, read, input] of gate) {
        const tested = input === read ? [read] : [read, input];
        for (const where of visible ? tested.slice(1) : tested) {
          const lowered = this.#layerHolds(model, layer, where, alias);
          if (lowered !== undefined) held.push(lowered);
        }
      }
    } finally {
      this.#unbounded--;
    }
    return held.length === 0 ? undefined : this.adapter.operators.and(...held);
  }
  /** A condition as a value: true or false, never NULL; `undefined` holds. */
  #truth(condition: Sql | undefined): Sql {
    const a = this.adapter;
    return condition === undefined
      ? a.literals.true()
      : a.expressions.caseWhen(
          [{ when: condition, then: a.literals.true() }],
          a.literals.false()
        );
  }
  /**
   * A declared projection key's value on the row at `alias` (K5): the
   * layer's `read` once, around one test per name. Ordered, the last name
   * that holds; else a document of one boolean per name.
   */
  #lowerEvidence(
    model: AnyModel,
    field: Extract<PreparedProjectionField, { kind: "evidence" }>,
    alias: string | undefined,
    taken: boolean
  ): Sql {
    const a = this.adapter;
    const { layer, read, ordered } = field.evidence;
    const visible = taken
      ? undefined
      : this.#layerHolds(model, layer, read, alias);
    const test = (input: Input) =>
      input === read ? undefined : this.#layerHolds(model, layer, input, alias);
    if (ordered) {
      const highest = a.expressions.caseWhen(
        [...field.names].reverse().map(([name, input]) => ({
          when: test(input) ?? a.literals.true(),
          then: a.expressions.cast(this.value(name), "text"),
        })),
        a.literals.null()
      );
      return visible === undefined
        ? highest
        : a.expressions.caseWhen(
            [{ when: visible, then: highest }],
            a.literals.null()
          );
    }
    const held = a.json.objectFromColumns(
      field.names.map(([name, input]) => [name, this.#truth(test(input))])
    );
    return visible === undefined
      ? held
      : a.expressions.caseWhen(
          [{ when: visible, then: held }],
          a.json.objectFromColumns(
            field.names.map(([name]) => [name, a.literals.false()])
          )
        );
  }
  /**
   * What a claimed arm whose row did not come back carries: the empty
   * document, "the row is gone", which the decoder refuses. Under a related
   * domain the row may exist and be hidden, which reads as an empty slot, so
   * the empty document then also needs the row to be physically absent: a
   * membership test with no domain, evaluated only for a claim that read no
   * row. Without a domain, the bytes are the ones a plain client emits.
   */
  #missingArm(edge: Membership, parentAlias: string): Sql {
    const a = this.adapter;
    if (this.domainOf(edge.target, "related") === undefined)
      return a.json.object([]);
    const target = this.alias();
    return a.expressions.caseWhen(
      [
        {
          when: a.operators.exists(
            a.subqueries.existsCheck(
              this.table(edge.target, target),
              this.correlation(edge, parentAlias, target, false)
            )
          ),
          then: a.literals.null(),
        },
      ],
      a.json.object([])
    );
  }
  /**
   * How many of this member's memberships name a row that is gone.
   *
   * A polymorphic member table carries no real foreign key to its target on
   * every provider, so a disabled constraint or a raw write can leave the
   * membership behind; reading the slot must then FAIL, not report the row as
   * absent — existence and membership are execution semantics (rule 4), and a
   * silent absence is a wrong answer.
   *
   * The probe is a SIBLING scalar subquery of the arm's row window: it carries
   * no user filter, no cursor and no window, so it is evaluated outside — and
   * therefore ahead of — the arm's own `WHERE` and `LIMIT`, exactly as the
   * shipped `guardJunctionIntegrity` did
   * (`builders/include-many-to-many.ts` at `ff5e77ca`). It is emitted for every
   * configured member, so `only` cannot hide one (Arnaud's D-26).
   */
  /**
   * A SINGULAR polymorphic inverse holding more than one membership is
   * malformed provider state, even where a missing unique constraint allowed
   * it — and the row window cannot say so: a target filter that leaves one
   * visible row, or the `LIMIT 1` itself, hides the second member.
   *
   * So the count is a SIBLING scalar subquery over the member table, ahead of
   * the row subquery's `WHERE` and its `LIMIT`, and the refusal is carried in
   * the VALUE, not raised in SQL — no provider has a portable `RAISE`. The
   * branch emits a JSON ARRAY where the leaf owes one row object, which is the
   * shape the decoder already refuses by name and which no projection of a
   * model row can produce (the shipped `guardJunctionIntegrity`,
   * `builders/include-many-to-many.ts` at `ff5e77ca`).
   *
   * Only a polymorphic member table: an ordinary pair table's inverse is
   * enforced by its own unique constraint and its bytes are unchanged.
   */
  #duplicateMembershipGuard(
    edge: Membership,
    parentAlias: string,
    projected: Sql
  ): Sql {
    if (
      edge.kind !== "junction" ||
      edge.many ||
      edge.scope.edge.kind !== "variantJunctionCarrier"
    )
      return projected;
    const a = this.adapter;
    const junction = this.alias();
    const members = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.aggregates.count(),
        from: this.#tableNamed(edge.table, junction),
        where: a.operators.and(
          ...this.junctionSideConditions(edge.sourceSide, junction, parentAlias)
        ),
      })
    );
    return a.expressions.caseWhen(
      [
        {
          when: a.operators.gt(members, this.value(1)),
          then: a.json.emptyArray(),
        },
      ],
      projected
    );
  }
  #orphanedMemberships(
    edge: Extract<Membership, { kind: "junction" }>,
    parentAlias: string
  ): Sql {
    const a = this.adapter;
    const junction = this.alias();
    const target = this.alias();
    return a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.aggregates.count(),
        from: this.#tableNamed(edge.table, junction),
        where: a.operators.and(
          ...this.junctionSideConditions(
            edge.sourceSide,
            junction,
            parentAlias
          ),
          a.filters.none(
            a.subqueries.existsCheck(
              this.table(edge.target, target),
              a.operators.and(
                ...this.junctionSideConditions(
                  edge.targetSide,
                  junction,
                  target
                )
              )
            )
          )
        ),
      })
    );
  }
  /**
   * One slot's correlated count, shared by the `_count` projection and `_count`
   * ordering. A variant carrier's arms are summed, because the slot's population
   * is their union ({@link countedMemberships}).
   */
  #correlatedCount(
    edges: readonly Membership[],
    selector: Pick<PreparedSelector, "model" | "predicate"> | undefined,
    parentAlias: string,
    negated = false
  ): Sql {
    const a = this.adapter;
    // An ungrouped, unlimited COUNT(*) answers exactly one row, so the
    // scalar subquery is never NULL and needs no COALESCE.
    const counted = edges.map((edge) => {
      const childAlias = this.alias();
      const filter = selector
        ? negated
          ? this.#opposite(() => this.lowerSelector(selector, childAlias)!)
          : this.lowerSelector(selector, childAlias)!
        : undefined;
      return a.subqueries.scalar(
        assembleAdapterSelect(a, {
          columns: a.aggregates.count(),
          from: this.table(edge.target, childAlias),
          where: a.operators.and(
            this.correlation(edge, parentAlias, childAlias),
            ...(filter ? [negated ? a.operators.not(filter) : filter] : [])
          ),
        })
      );
    });
    return counted.reduce((total, arm) => a.expressions.add(total, arm));
  }
  /**
   * One value this unit PRODUCED, published as the field it belongs to.
   *
   * `SELECT <expression> AS <field>` — no FROM, so one row by construction —
   * composed from the owners that already hold the parts: the field's own
   * physical value ({@link fieldValue}, the one destination-aware operand
   * owner) and its own decode leaf ({@link scalarShape}), read back by
   * {@link decodeQuery} like every other row. That is the composition
   * {@link grouped} and {@link junction} already state for every scalar they
   * publish.
   *
   * A user projection was never the question: D-58's segment boundary asks for
   * exactly ONE field, so preparing one to borrow its shape and its lowering
   * was a detour through arms — relation, variant, `_count`, `_distance`,
   * sentinel — that a produced scalar cannot reach, and it ended in a cast back
   * to the scalar arm the caller already knew it had.
   */
  scalarQuery(model: AnyModel, field: string, value: unknown): Query {
    return {
      shape: {
        kind: "object",
        fields: { [field]: this.scalarShape(model, field) },
      },
      sql: this.adapter.clauses.select(
        this.adapter.identifiers.aliased(
          this.fieldValue(model, field, value),
          field
        )
      ),
    };
  }
  #lowerRelationProjection(
    relation: PreparedRelationProjection,
    alias: string
  ): Sql {
    const a = this.adapter;
    const {
      edge,
      arguments: nested,
      projection,
      linkRow,
      linkWhere,
    } = relation;
    const childAlias = this.#rowAlias(edge.target);
    const child = this.lowerProjection(projection, childAlias, true);
    const childFields = Object.keys(projection.shape.fields);
    // A nested node is the ordinary page operator inside the parent's
    // correlation scope; `take: -n` reverses the window exactly as at the root.
    const window = this.#page(edge.target, nested, childAlias, "related");
    const source = this.#memberSource(edge, alias, childAlias);
    const lowered = linkWhere && this.lowerSelector(linkWhere, source.link);
    // The link row is the one this page's own join reads the target through,
    // flat here and an object below: a JSON column in a page would have no
    // equality for `DISTINCT`, and a key holds at most one row per target. No
    // member's name holds a `$` (F001), so none of the page's columns is this.
    const linkColumn = (index: number) => `$through_${index}`;
    if (linkRow)
      for (const [index, field] of linkRow.fields.entries())
        child.push(
          a.identifiers.aliased(
            this.projectedColumn(linkRow.model, field, source.link),
            linkColumn(index)
          )
        );
    const page = assembleAdapterSelect(a, {
      columns: sql.join(child, ", "),
      from: source.from,
      joins:
        source.joins && window.joins
          ? [...source.joins, ...window.joins]
          : (source.joins ?? window.joins),
      where: a.operators.and(
        source.where,
        ...(nested.selector
          ? [this.lowerSelector(nested.selector, childAlias)!]
          : []),
        ...(lowered ? [lowered] : []),
        ...(window.cursor ? [window.cursor] : [])
      ),
      orderBy: window.orderBy,
      // The aggregate below reads this page IN ORDER, so an ordered page
      // states its bound. MySQL merges an UNLIMITED derived table into the
      // query that reads it and the merge takes the ORDER BY with it, and the
      // rows then arrive in storage order — measured, both answers from the
      // same aggregate over the same page. What the bound buys is the MERGE
      // RULE, which is the documented fact: MySQL does not merge a derived
      // table that states a LIMIT. That the same page then answered in the
      // requested order is the measurement beside it, not a documented
      // property of materialising. The caller's window is that bound wherever
      // it asked for one — including the offset-only window, whose bare
      // OFFSET already needs the same spelling — and where it asked for none,
      // the dialect's own "no limit" value is. A dialect that needs no bound
      // to keep a derived order declares none (PostgreSQL) and emits nothing.
      limit: edge.many
        ? (window.limit ?? (window.orderBy ? a.noLimitValue : undefined))
        : this.value(1),
      offset: window.offset,
      ...(window.distinct
        ? {
            distinct: window.distinct,
            distinctOrderBy: window.distinctOrderBy,
            distinctOrder: window.distinctOrder,
            distinctColumnAliases: [
              ...projection.fields.map((field) => field.name),
              ...(linkRow ? linkRow.fields.map((_, i) => linkColumn(i)) : []),
            ],
          }
        : {}),
    });
    const pageAlias = this.alias();
    const members = childFields.map((field): [string, Sql] => [
      field,
      this.#carriedValue(
        projection.shape.fields[field]!,
        a.identifiers.column(pageAlias, field)
      ),
    ]);
    for (const gate of projection.shape.gates ?? NO_GATES)
      members.push([gate, a.identifiers.column(pageAlias, gate)]);
    if (linkRow)
      members.push([
        "$through",
        a.json.object(
          linkRow.fields.map((field, index): [string, Sql] => [
            field,
            this.#carriedValue(
              linkRow.shape.fields[field]!,
              a.identifiers.column(pageAlias, linkColumn(index))
            ),
          ])
        ),
      ]);
    const object = a.json.object(members);
    const expression = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: edge.many ? a.json.agg(object) : object,
        from: a.subqueries.correlate(page, pageAlias),
      })
    );
    return expression;
  }

  /**
   * One physical row identity, encoded through the existing JSON carrier rule:
   * the one encoder of the carrier's root, node keys and edge endpoints, whose
   * texts the decoder matches.
   */
  #recursiveIdentity(model: AnyModel, key: readonly Sql[]): Sql {
    return this.adapter.json.array(
      this.schema.keys(model).map((field, index) => {
        // The carried key is the RAW column, so a byte identifier takes its
        // transport spelling here, as every projected column already has.
        const leaf = this.scalarShape(model, field);
        return this.#carriedValue(
          leaf,
          transportedIdentifier(
            this.adapter,
            leaf.id,
            key[index]!,
            leaf.nullable
          )
        );
      })
    );
  }

  /** One row's complete key, addressed through `alias`. */
  #rowKey(model: AnyModel, alias: string): Sql[] {
    return this.schema
      .keys(model)
      .map((field) => this.column(model, field, alias));
  }
  /** The complete-key join of one model alias to carried key columns. */
  #sameRow(model: AnyModel, alias: string, carried: readonly Sql[]): Sql {
    const a = this.adapter;
    return a.operators.and(
      ...this.#rowKey(model, alias).map((column, index) =>
        a.operators.eq(column, carried[index]!)
      )
    );
  }

  /**
   * One hop of a walk, from `current` into `next`, under the {@link related}
   * domain. A reference hop is the ordinary {@link correlation}; a junction
   * hop joins the junction table, and its target as a relation page does
   * ({@link memberSource}): the membership's `IN (SELECT … WHERE link.source =
   * current.key)` correlates to `next`'s sibling, which PostgreSQL cannot turn
   * into a semi-join, so it would run once per target row at every hop.
   */
  #step(
    edge: Membership,
    current: string | CarriedRow,
    next: string,
    scoped = true
  ): Sql {
    const a = this.adapter;
    if (edge.kind !== "junction")
      return a.joins.inner(
        this.table(edge.target, next),
        this.correlation(edge, current, next, scoped)
      );
    const link = this.alias();
    return sql`${a.joins.inner(
      this.#tableNamed(edge.table, link),
      a.operators.and(
        ...this.junctionSideConditions(edge.sourceSide, link, current),
        ...this.#linkBound(edge, link)
      )
    )} ${this.#junctionTarget(edge, link, next)}`;
  }
  /**
   * Where one parent's relation page reads its rows. A junction membership
   * reads FROM the junction, joined to its target by key, so the junction's
   * source-side index drives the page whatever the target's statistics say:
   * behind {@link correlation}'s `IN (SELECT …)` SQLite, once ANALYZE has
   * run, scans a target smaller than its fixed guess of the list's length,
   * once per parent (parity-04). PostgreSQL and MySQL already plan that
   * membership as this join. The junction's primary key spans both sides
   * and each side references a complete row key, so every member is read
   * once, as the membership reads it.
   */
  #memberSource(
    edge: Membership,
    parent: string,
    child: string
  ): { from: Sql; joins?: Sql[]; where: Sql; link?: string } {
    if (edge.kind !== "junction")
      return {
        from: this.#attached(edge.target, child),
        where: this.correlation(edge, parent, child),
      };
    const link = this.alias();
    return {
      link,
      from: this.#tableNamed(edge.table, link),
      joins: [this.#junctionTarget(edge, link, child)],
      where: this.adapter.operators.and(
        ...this.junctionSideConditions(edge.sourceSide, link, parent)
      ),
    };
  }
  /** A junction's target joined from `link`, under the {@link related} domain. */
  #junctionTarget(
    edge: Extract<Membership, { kind: "junction" }>,
    link: string,
    next: string
  ): Sql {
    const a = this.adapter;
    return a.joins.inner(
      this.table(edge.target, next),
      this.#related(
        edge,
        next,
        a.operators.and(
          ...this.junctionSideConditions(edge.targetSide, link, next)
        )
      )
    );
  }

  /**
   * The ONE walk of a recursive membership: a recursive CTE of the rows
   * reached from `parentAlias` by 1..`depth` hops of `edge` (every hop when
   * `depth` is false). Each hop reads the related domain (the anchor's
   * {@link correlation}, then {@link step}), so a hidden row stops the walk
   * below it, and `UNION` on
   * the carried key (and depth, when bounded) ends every cycle and visits a
   * diamond's row once per depth. Two readers:
   * - the recursive projection asks for `edges`: each reached row carries the
   *   row it was reached from, and the per-hop `selector` narrows every hop;
   * - a recursive filter reads the reached SET, plus the start row itself at
   *   depth 0 when `self` holds. The start row joins the FIRST hop in the
   *   anchor, so the recursive member stays the projection's and needs no
   *   depth guard: a start-only anchor would spend one of MySQL's
   *   `cte_max_recursion_depth` iterations and fail `{ depth: 1000 }`.
   *   The two are ONE derived-table term, so the CTE keeps exactly two
   *   top-level terms: PlanetScale's Neki cannot resolve the CTE from the
   *   recursive member of a third (42P01).
   * Where the driver bounds a statement's relations (`sharesRelationBodies`),
   * each reached row carries the columns its next hop reads ({@link hopFields}), so the
   * recursive member joins no row again to leave it; the start row carries
   * them as the statement reads it, so where the hop reads more than its key
   * and it is not the stored row ({@link rows}: a produced row's new value, a
   * masked window), the walk joins every row again, and so also leaves the
   * start row by its stored columns, as it always has. The first hop stays in
   * the anchor even where the start row alone would do: PostgreSQL plans the
   * recursive member as a hash join over a scan of the table, and an anchor
   * hop is an index probe (10× the acceptance fixture: an `accessGrant` read
   * 124 → 785 ms with the start row alone).
   */
  #walk(
    edge: Membership,
    parentAlias: string,
    start:
      | Closure
      | {
          readonly depth: number | false;
          readonly edges: true;
          readonly selector?: Pick<PreparedSelector, "model" | "predicate">;
        },
    scoped = true
  ) {
    const a = this.adapter;
    const model = edge.target;
    const keys = this.schema.keys(model);
    const scope = this.alias();
    const cteName = `__${scope}_recursive`;
    const { depth } = start;
    const edges = "edges" in start;
    const parentColumns = edges
      ? keys.map((_, index) => `__${scope}_parent_${index}`)
      : [];
    const childColumns = keys.map((_, index) => `__${scope}_child_${index}`);
    const depthColumn = `__${scope}_depth`;
    const selector = edges ? start.selector : undefined;
    const hop = (value: Sql) =>
      depth === false ? [] : [a.identifiers.aliased(value, depthColumn)];
    const reached = (alias: string) =>
      selector ? [this.lowerSelector(selector, alias)!] : [];

    const self = !edges && start.self;
    const carries =
      this.sharesBodies &&
      (!self ||
        this.#rows.get(parentAlias) === model ||
        this.#hopFields(edge).every((field) => keys.includes(field)));
    const hopFields = carries
      ? this.#hopFields(edge).filter((field) => !keys.includes(field))
      : [];
    const hopColumns = hopFields.map((_, index) => `__${scope}_hop_${index}`);
    const row = (alias: string) => [
      ...this.#aliased(childColumns, this.#rowKey(model, alias)),
      ...this.#aliased(
        hopColumns,
        hopFields.map((field) => this.column(model, field, alias))
      ),
    ];
    const anchorChild = this.alias();
    const firstHop = assembleAdapterSelect(a, {
      columns: sql.join(
        [
          ...this.#aliased(parentColumns, this.#rowKey(model, parentAlias)),
          ...row(anchorChild),
          ...hop(a.expressions.cast(this.value(1), "integer")),
        ],
        ", "
      ),
      from: this.table(model, anchorChild),
      where: a.operators.and(
        this.correlation(edge, parentAlias, anchorChild, scoped),
        ...reached(anchorChild)
      ),
    });
    const seed = self ? this.alias() : undefined;
    const anchor = seed
      ? assembleAdapterSelect(a, {
          columns: sql.join(
            [
              ...childColumns,
              ...hopColumns,
              ...(depth === false ? [] : [depthColumn]),
            ].map((column) => a.identifiers.column(seed, column)),
            ", "
          ),
          from: a.subqueries.correlate(
            a.setOperations.union(
              a.clauses.select(
                sql.join(
                  [
                    ...row(parentAlias),
                    ...hop(a.expressions.cast(this.value(0), "integer")),
                  ],
                  ", "
                )
              ),
              firstHop
            ),
            seed
          ),
        })
      : firstHop;

    const walk = this.alias();
    const carried = (column: string) => a.identifiers.column(walk, column);
    let current: string | CarriedRow;
    let reread: Sql | undefined;
    if (carries)
      current = (field) =>
        carried(
          keys.includes(field)
            ? childColumns[keys.indexOf(field)]!
            : hopColumns[hopFields.indexOf(field)]!
        );
    else {
      current = this.alias();
      reread = a.joins.inner(
        this.table(model, current),
        this.#sameRow(model, current, childColumns.map(carried))
      );
    }
    const next = this.alias();
    // An unbounded, unfiltered walk states no WHERE rather than `WHERE TRUE`.
    const all = (bounds: Sql[]) =>
      bounds.length === 0 ? undefined : a.operators.and(...bounds);
    const recursive = assembleAdapterSelect(a, {
      columns: sql.join(
        [
          ...this.#aliased(parentColumns, childColumns.map(carried)),
          ...row(next),
          ...hop(a.expressions.add(carried(depthColumn), this.value(1))),
        ],
        ", "
      ),
      from: sql.join(
        [
          a.identifiers.aliased(a.identifiers.escape(cteName), walk),
          ...(reread ? [reread] : []),
          this.#step(edge, current, next, scoped),
        ],
        " "
      ),
      where: all([
        ...(depth === false
          ? []
          : [a.operators.lt(carried(depthColumn), this.value(depth))]),
        ...reached(next),
      ]),
    });
    return {
      cte: a.cte.recursive(cteName, anchor, recursive, "distinct"),
      cteName,
      scope,
      /** The walk's own alias, free again for a reader outside the CTE. */
      walk,
      parentColumns,
      childColumns,
      depthColumn,
    };
  }
  /** The fields of the row it leaves that one hop of `edge` reads. */
  #hopFields(edge: Membership): readonly string[] {
    return edge.kind === "reference"
      ? [
          ...(edge.discriminator?.side === "source"
            ? [edge.discriminator.field]
            : []),
          ...edge.pairs.map((pair) => pair.source),
        ]
      : edge.sourceSide.members.map((member) => member.referencedField);
  }
  /** Each expression aliased as the column of the same index. */
  #aliased(names: readonly string[], expressions: readonly Sql[]): Sql[] {
    return names.map((name, index) =>
      this.adapter.identifiers.aliased(expressions[index]!, name)
    );
  }

  /**
   * A recursive relation remains one ordinary projected field. The recursive
   * CTE carries only edge facts; one node table supplies each projected row,
   * and the decoder owns path occurrences and cutoff omission. The recursive
   * member expands every reached row below the bound with the same
   * correlation and filter and prunes nothing (the cycle policy belongs to the
   * decoder), because `decodeRecursiveCarrier` refuses a carrier in which a
   * parent lacks its children at any level it is reached below the cutoff.
   */
  #lowerRecursiveRelationProjection(
    relation: PreparedRelationProjection,
    recurrence: NormalizedRecurrence,
    parentAlias: string
  ): Sql {
    const a = this.adapter;
    const model = relation.edge.target;
    const {
      cte,
      cteName,
      scope,
      walk,
      parentColumns,
      childColumns,
      depthColumn,
    } = this.#walk(relation.edge, parentAlias, {
      depth: recurrence.depth,
      edges: true,
      selector: relation.arguments.selector,
    });
    const walkColumn = (name: string) => a.identifiers.column(walk, name);

    const ids = this.alias();
    const idColumns = childColumns.map((_, index) => `__${scope}_id_${index}`);
    const distinctIds = assembleAdapterSelect(a, {
      distinct: sql.join(childColumns.map(walkColumn), ", "),
      distinctColumnAliases: idColumns,
      columns: sql.join(
        this.#aliased(idColumns, childColumns.map(walkColumn)),
        ", "
      ),
      from: a.identifiers.aliased(a.identifiers.escape(cteName), walk),
    });
    const node = this.#rowAlias(model);
    const nodeDocument = a.json.object(
      relation.projection.fields.map((field) => [
        field.name,
        this.#carriedValue(
          // A gate is the one member the decoded shape does not list.
          relation.projection.shape.fields[field.name] ?? BOOLEAN_LEAF,
          this.#lowerProjectionField(relation.projection, field, node, true)
        ),
      ])
    );
    const nodeCarrier = a.json.object([
      [
        RECURSIVE_CARRIER.key,
        this.#recursiveIdentity(model, this.#rowKey(model, node)),
      ],
      [RECURSIVE_CARRIER.row, nodeDocument],
    ]);
    const idTable = a.subqueries.correlate(distinctIds, ids);
    const table = this.table(model, node);
    const sameNode = this.#sameRow(
      model,
      node,
      idColumns.map((name) => a.identifiers.column(ids, name))
    );
    // Where the caller states each walk reaches few rows (`fewRows`), each is
    // read by its key (`capabilities.readsNodesByKey`): joined, PostgreSQL,
    // guessing ten rows a level, hashed the whole table once per outer row.
    const byKey =
      recurrence.fewRows &&
      a.capabilities.readsNodesByKey &&
      a.json.document(
        a.subqueries.scalar(
          assembleAdapterSelect(a, {
            columns: nodeCarrier,
            from: table,
            where: sameNode,
          })
        )
      );
    const nodes = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.json.agg(byKey || nodeCarrier),
        from: byKey
          ? idTable
          : sql`${idTable} ${a.joins.inner(table, sameNode)}`,
      })
    );

    const edgeWalk = this.alias();
    const edgeChild = this.alias();
    const edgeColumn = (name: string) => a.identifiers.column(edgeWalk, name);
    const edgeCarrierName = `__${scope}_edge`;
    const edgePairs: [string, Sql][] = [
      [
        RECURSIVE_CARRIER.parent,
        this.#recursiveIdentity(model, parentColumns.map(edgeColumn)),
      ],
      [
        RECURSIVE_CARRIER.child,
        this.#recursiveIdentity(model, childColumns.map(edgeColumn)),
      ],
    ];
    if (recurrence.depth !== false)
      edgePairs.push([RECURSIVE_CARRIER.depth, edgeColumn(depthColumn)]);
    const edgeCarrier = a.json.object(edgePairs);
    // Each parent's siblings in the caller's order, ties broken by the order
    // owner's one complete key — the ordinary window's tie-break, not another.
    // An order of key columns alone is read from the walk's own: joined
    // only to be ordered, PostgreSQL, guessing ten rows a level, hashed the
    // whole table once per outer row. Any other term is read from the joined
    // child, after the walk's `UNION`, never carried through it.
    const keys = this.schema.keys(model);
    const order = this.#completeOrder(
      model,
      this.#orderTerms(model, relation.arguments.orderBy, edgeChild),
      edgeChild
    );
    const keyed = order.map((term) =>
      term.field === undefined || this.#gatedHere(model, term.field)
        ? -1
        : keys.indexOf(term.field)
    );
    const joins = keyed.includes(-1);
    const siblingOrder = this.#lowerOrder(
      joins
        ? order
        : order.map((term, index) => ({
            ...term,
            expression: edgeColumn(childColumns[keyed[index]!]!),
          }))
    );
    const walked = a.identifiers.aliased(
      a.identifiers.escape(cteName),
      edgeWalk
    );
    const edgePage = assembleAdapterSelect(a, {
      columns: a.identifiers.aliased(edgeCarrier, edgeCarrierName),
      from: joins
        ? sql`${walked} ${a.joins.inner(
            this.table(model, edgeChild),
            this.#sameRow(model, edgeChild, childColumns.map(edgeColumn))
          )}`
        : walked,
      orderBy: sql.join(
        [
          ...parentColumns.map((name) => a.orderBy.asc(edgeColumn(name))),
          ...(siblingOrder ? [siblingOrder] : []),
        ],
        ", "
      ),
      // MySQL otherwise merges the derived page into the aggregate reader and
      // drops its ORDER BY. The adapter's unbounded LIMIT prevents that merge.
      limit: a.noLimitValue,
    });
    const edgePageAlias = this.alias();
    const edges = a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: a.json.agg(
          a.json.document(a.identifiers.column(edgePageAlias, edgeCarrierName))
        ),
        from: a.subqueries.correlate(edgePage, edgePageAlias),
      })
    );

    const carrier = (nodeFacts: Sql, edgeFacts: Sql) =>
      a.json.object([
        [
          RECURSIVE_CARRIER.root,
          this.#recursiveIdentity(model, this.#rowKey(model, parentAlias)),
        ],
        [RECURSIVE_CARRIER.nodes, a.json.document(nodeFacts)],
        [RECURSIVE_CARRIER.edges, a.json.document(edgeFacts)],
      ]);
    if (!a.capabilities.supportsLateralJoins)
      return a.subqueries.scalar(
        sql`${cte} ${a.clauses.select(carrier(nodes, edges))}`
      );
    // MySQL materializes a correlated recursive CTE that is read twice (the
    // nodes and the edges) once for the whole statement and hands every outer
    // row the first row's facts. A lateral derived table is re-evaluated per
    // outer row by definition, so the CTE and both readers live inside one
    // wherever the provider spells LATERAL (PostgreSQL, MySQL); SQLite, which
    // has no LATERAL, evaluates the correlated CTE per row as written above.
    const one = this.alias();
    const facts = this.alias();
    const nodeFacts = `__${scope}_nodes`;
    const edgeFacts = `__${scope}_edges`;
    return a.subqueries.scalar(
      assembleAdapterSelect(a, {
        columns: carrier(
          a.identifiers.column(facts, nodeFacts),
          a.identifiers.column(facts, edgeFacts)
        ),
        from: a.subqueries.correlate(a.clauses.select(sql`1`), one),
        joins: [
          a.joins.lateral(
            sql`${cte} ${a.clauses.select(
              sql.join(
                [
                  a.identifiers.aliased(nodes, nodeFacts),
                  a.identifiers.aliased(edges, edgeFacts),
                ],
                ", "
              )
            )}`,
            facts
          ),
        ],
      })
    );
  }
  grouped(model: AnyModel, args: Arguments): Query {
    const a = this.adapter;
    const alias = this.#rootAlias();
    // The ONE `by` authority. Admission normalises `by` to an array and
    // refuses its duplicates; the grouped read computes the grouped column SET
    // once and hands it to the two owners that have to know it — `having` and
    // the grouped `orderBy` — instead of each re-reading `args`.
    const by = args.by!;
    const grouped: ReadonlySet<string> = new Set(by);
    // A read-gated model groups a masked window of its filtered rows (K5): a
    // gate lowered once per row, where a gate repeated in the grouping, the
    // projection and the order would be three expressions to the provider.
    if (this.#masks(model)) {
      const inner = this.alias();
      const window = assembleAdapterSelect(a, {
        columns: sql.join(
          this.schema
            .storedFields(model)
            .map((field) =>
              a.identifiers.aliased(
                this.#operand(model, field, inner),
                this.columnName(model, field)
              )
            ),
          ", "
        ),
        from: this.table(model, inner),
        where: this.lowerWhere(model, args.where, inner),
      });
      return this.#overMasked(() =>
        this.#grouped(model, args, alias, by, grouped, {
          from: a.subqueries.correlate(window, alias),
        })
      );
    }
    return this.#grouped(model, args, alias, by, grouped, {
      from: this.table(model, alias),
      where: this.lowerWhere(model, args.where, alias),
    });
  }
  #grouped(
    model: AnyModel,
    args: Arguments,
    alias: string,
    by: readonly string[],
    grouped: ReadonlySet<string>,
    rows: { readonly from: Sql; readonly where?: Sql }
  ): Query {
    const a = this.adapter;
    const aggregates = this.#prepareAggregates(model, args);
    const fields: Record<string, Shape | Leaf> = {};
    const gates = this.#masked
      ? this.domain?.projected(model)?.gates
      : undefined;
    const columns: Sql[] = by.map((field) => {
      const leaf = this.scalarShape(model, field);
      // A masked group reads a gated key as absent: the NULL group.
      fields[field] = gates?.has(field)
        ? freeze({ ...leaf, nullable: true })
        : leaf;
      return a.identifiers.aliased(
        this.projectedColumn(model, field, alias),
        field
      );
    });
    for (const [name, expression] of aggregates.columns(alias)) {
      fields[name] = aggregates.fields_[name]!;
      columns.push(a.identifiers.aliased(expression, name));
    }
    return {
      sql: assembleAdapterSelect(a, {
        columns: sql.join(columns, ", "),
        from: rows.from,
        where: rows.where,
        groupBy: sql.join(
          by.map((field) => this.column(model, field, alias)),
          ", "
        ),
        having: args.having
          ? this.#lowerPredicate(
              this.#prepareHaving(model, record(args.having)),
              alias
            )
          : undefined,
        orderBy: this.#lowerOrder(
          this.#groupOrderTerms(model, args.orderBy, alias, grouped)
        ),
        limit: args.take === undefined ? undefined : this.value(args.take),
        offset: args.skip === undefined ? undefined : this.value(args.skip),
      }),
      shape: { kind: "object", fields },
    };
  }
  /** `having` is the same predicate vocabulary over aggregate targets. */
  #prepareHaving(model: AnyModel, having: Input): PreparedPredicate {
    return freeze({
      kind: "and",
      predicates: freeze(
        Object.entries(having).flatMap(([key, value]) => {
          if (value === undefined) return [];
          // Prisma negates each NOT arm and conjoins the negations.
          if (this.combinator(model, key))
            return [
              this.combine(
                key,
                entries(value).map((clause) =>
                  this.#prepareHaving(model, record(clause))
                )
              ),
            ];
          const scalar = this.scalar(model, key);
          const filter = record(value);
          const aggregated = AGGREGATES.filter(
            (name) => filter[name] !== undefined
          );
          // A field-keyed condition names a grouped column: admission refuses
          // one outside `by` at its path (`args/aggregate.ts`).
          if (aggregated.length === 0)
            return [
              this.prepareOperations(freeze({ kind: "column", scalar }), value),
            ];
          return aggregated.map((aggregate) =>
            this.prepareOperations(
              freeze({ kind: "aggregate", aggregate, scalar }),
              filter[aggregate]
            )
          );
        })
      ),
    });
  }
  /**
   * A grouped read orders by a grouped field or by an aggregate; admission
   * refuses any other field at its `orderBy` path (`args/aggregate.ts`).
   */
  #groupOrderTerms(
    model: AnyModel,
    input: Arguments["orderBy"],
    alias: string,
    grouped: ReadonlySet<string>
  ): OrderTerm[] {
    const terms = entries(input ?? {}).flatMap((order) =>
      Object.entries(order).flatMap(([name, direction]) => {
        if (direction === undefined) return [];
        if (!isAggregate(name))
          return [this.#orderTerm(model, name, direction, alias)];
        return Object.entries(record(direction)).flatMap(([field, sort]) => {
          const scalar =
            field === "_all" ? undefined : this.scalar(model, field);
          const split =
            name === "_sum" &&
            this.#splitSumSql(scalar!, this.#preparedColumn(scalar!, alias));
          return (
            split
              ? split.order
              : [this.#aggregateExpression(name, scalar, alias)]
          ).map((key) => this.#sortKey(key, sort === "desc", undefined, false));
        });
      })
    );
    const ordered = new Set(terms.map((term) => term.field));
    for (const field of grouped)
      if (!ordered.has(field))
        terms.push(this.#orderTerm(model, field, "asc", alias));
    return terms;
  }
}
