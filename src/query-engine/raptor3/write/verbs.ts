/**
 * What the verbs mean, and nothing else: written as if the store were the
 * database itself and answered at once. No transport, no provider, no row
 * scope, no word about what is known when.
 */
import {
  NestedWriteError,
  NotFoundError,
  QueryEngineError,
  UnsupportedOperationError,
} from "@errors";
import type { AnyModel } from "@schema/model";
import { getModelKeyCatalog } from "@schema/model/keys";
import { Stored } from "../shared/insert-value";
import { readUpdate } from "../shared/query";
import { parseStamped } from "../shared/row-scope";
import type { Arguments, Input } from "../shared/schema";
import type { Membership } from "../shared/storage";
import type { Question } from "./statements";
import type { Row, Store } from "./store";

const list = (value: unknown): unknown[] => {
  if (value === undefined || value === false) return [];
  return Array.isArray(value) ? value : [value];
};

export function verbs(store: Store) {
  const { operation } = store;
  const { schema } = operation;
  const q = operation.queries;
  /** What the caller wrote of each node of what was admitted of it. One entry is written as itself, or as the list of one. */
  const said = new WeakMap<object, unknown>();
  const paired = <T>(admitted: T, raw: unknown): T => {
    if (typeof admitted === "object" && admitted) {
      said.set(admitted, raw);
      for (const [key, child] of Object.entries(admitted)) {
        const next = (raw as Input | undefined)?.[key];
        paired(child, next === undefined && key === "0" ? raw : next);
      }
    }
    return admitted;
  };
  const stated = (admitted: Input): Input =>
    (said.get(admitted) ?? {}) as Input;
  /** The rows the call makes. Of those a `create` makes (`true`), the caller said everything they hold. */
  const made = new WeakMap<Row, boolean>();
  const fresh = { has: (row: Row) => made.get(row) === true };
  /** A field of a row is decided once: by what was written of the row, or by one relation. */
  const once = (
    kind: "create" | "update",
    model: AnyModel,
    own: Input,
    takes: Input,
    relation: string,
    owned = false
  ) => {
    for (const [field, value] of Object.entries(takes)) {
      const written = own[field] as Input | undefined;
      if (written === undefined) continue;
      // The same value said twice is said once.
      const plain =
        written !== null && typeof written === "object" && "set" in written
          ? written.set
          : written;
      if (typeof value !== "object" && Object.is(plain, value)) continue;
      throw new UnsupportedOperationError(
        owned
          ? `Relation '${relation}' owns '${Object.keys(takes).join(", ")}'; omit it from nested create and update data.`
          : `${kind} assigns conflicting values to column '${q.columnName(model, field)}' through relation '${relation}'.`
      );
    }
    return takes;
  };
  /** Whether what was written of a field leaves it another value than it holds. */
  const moves = (held: unknown, written: unknown): boolean => {
    if (written === undefined) return false;
    if (written === null || typeof written !== "object")
      return String(written) !== String(held);
    const { set, increment, decrement, multiply, divide } = written as Input;
    if (set !== undefined) return String(set) !== String(held);
    return !(
      [increment ?? 0, decrement ?? 0].every((by) => Number(by) === 0) &&
      [multiply ?? 1, divide ?? 1].every((by) => Number(by) === 1)
    );
  };
  /**
   * The row what was written of a row names: by its whole key, or by the one
   * other set of fields no two rows may share that it states whole. None
   * where it names none, or more than one.
   */
  const spelled = (model: AnyModel, own: Input): Input | undefined => {
    const whole = (fields: readonly string[]) =>
      fields.every((field) => (own[field] ?? null) !== null)
        ? Object.fromEntries(fields.map((field) => [field, own[field]]))
        : undefined;
    const named = getModelKeyCatalog(model)
      .addressableKeys.filter((key) => key.kind !== "primary")
      .map((key) => whole(key.fields))
      .filter((values) => values !== undefined);
    return (
      whole(schema.keys(model)) ?? (named.length === 1 ? named[0] : undefined)
    );
  };
  /** How many rows the call's own verb writes, where it writes several. */
  let several = 1;
  /** The fields a row took of a relation it holds, in this call, and the verb that gave them. */
  const slots = new WeakMap<
    Row,
    Map<string, { relation: string; verb: string }>
  >();

  /** The relations `data` names of a row of `model`, each with what it asks. */
  const relationsOf = (model: AnyModel, data: Input) =>
    model["~"].relationNames.flatMap((name) => {
      const payload = data[name] as Input | undefined;
      if (payload === undefined) return [];
      const resolved = schema.index.get(model)!.get(name)!;
      // A relation of variants is one relation per variant, each with the
      // entries that name it: `true` asks it of whichever holds, and a set
      // empties every one.
      const arms: [string | undefined, Input][] =
        "members" in resolved.edge && !resolved.member
          ? resolved.edge.members.map(({ variant }) => [
              variant,
              Object.fromEntries(
                Object.entries(payload).flatMap(([verb, given]) => {
                  const mine = list(given)
                    .filter(
                      (entry) =>
                        entry === true || (entry as Input).type === variant
                    )
                    .map((entry) => {
                      if (entry === true) return entry;
                      const { type, ...named } = entry as Input;
                      if (verb === "create") return named.data;
                      return named.data || named.create ? named : named.where;
                    });
                  return mine.length > 0 || (verb === "set" && given)
                    ? [[verb, mine]]
                    : [];
                })
              ),
            ])
          : [[undefined, payload]];
      return arms
        .filter(([, mine]) => Object.keys(mine).length > 0)
        .map(([variant, mine]) => ({
          name,
          edge: schema.membership(model, name, variant),
          payload: mine,
        }));
    });
  /** The row a relation is asked of holds the key of the row it reaches. */
  const holds = (edge: Membership) =>
    edge.kind === "reference" && edge.owner === "source";
  /** What a row holds to reference another: what the other holds of each field it is referenced by, which names no row where it is null. */
  const referencing = (
    edge: Membership,
    row: Row,
    held: "source" | "target"
  ): Input => {
    if (edge.kind !== "reference") return {};
    const referenced = held === "source" ? "target" : "source";
    const { discriminator } = edge;
    return Object.fromEntries([
      // With which of the variants it references, where it may reference several.
      ...(discriminator?.side === held
        ? [[discriminator.field, discriminator.value]]
        : []),
      ...edge.pairs.map((pair) => {
        const field = pair[referenced];
        // A row the call creates holds what it was given, or nothing.
        if (fresh.has(row) && (row[field] ?? null) === null)
          throw new UnsupportedOperationError(
            `Cannot create relation '${edge.name}': referenced field '${field}' must be supplied by the parent record or generated by the database.`
          );
        if (row[field] === null)
          throw new NestedWriteError(
            `Cannot connect relation '${edge.name}': the located target's referenced field '${field}' is null.`,
            edge.name
          );
        return [pair[held], row[field]];
      }),
    ]);
  };
  /** What a row born a member of `parent`'s holds: nothing where the membership is not the row's to hold. */
  const born = (parent: Row, edge: Membership): Input =>
    referencing(edge, parent, "target");
  /** What the row that holds a relation's key takes of the row it reaches. */
  const reaching = (edge: Membership, row: Row): Input =>
    referencing(edge, row, "source");
  /** What empties a relation on the row that holds it. */
  const cleared = (edge: Membership): Input =>
    Object.fromEntries(
      (edge.clearability as { fields?: string[] }).fields!.map((field) => [
        field,
        null,
      ])
    );
  const members = (
    parent: Row,
    edge: Membership,
    where: Input | undefined,
    ask: Partial<Question>
  ): Row[] =>
    store.rows({
      model: edge.target,
      where,
      member: { edge, of: parent },
      ...ask,
    });
  /** What a write of `data` writes of its row, as the caller stated it: none where it writes nothing of it. */
  const writes = (model: AnyModel, data: Input): string[] | undefined => {
    const own = stated(data);
    // A field kept as stored is no field the write writes.
    const fields = Object.keys(schema.scalars(model, own)).filter(
      (field) => !(own[field] instanceof Stored)
    );
    const relations = relationsOf(model, data).flatMap(
      ({ name, edge, payload }) =>
        // A relation whose verbs change which row this one holds, or its links, writes this row.
        Object.keys(payload).some(
          (verb) =>
            payload[verb] !== undefined &&
            verb !== "update" &&
            (holds(edge) || (edge.kind === "junction" && verb !== "updateMany"))
        )
          ? [
              name,
              // The columns of a relation of variants are no field of their own.
              ...(edge.kind === "reference" &&
              holds(edge) &&
              !edge.discriminator
                ? edge.pairs.map((pair) => pair.source)
                : []),
            ]
          : []
    );
    const written =
      Object.keys(store.values(model, "update", data, own)).length > 0;
    return written || relations.length > 0
      ? [...fields, ...relations]
      : undefined;
  };

  /** Makes a row that is there a member of `parent`'s: `through` is what was written of the link itself. */
  const join = (
    parent: Row,
    edge: Membership,
    row: Row,
    verb: string,
    through?: Input
  ) => {
    // A row whose membership is stored once is the member of one row.
    if (
      several > 1 &&
      (edge.kind === "reference" || edge.uniqueSide === "target")
    )
      throw new UnsupportedOperationError(
        `updateMany matched ${several} rows, so it cannot apply '${verb}' to relation '${edge.name.split(".")[0]}': ${
          edge.kind === "junction"
            ? "that target's member-junction slot can belong to only one of them"
            : "that membership is stored on the target row, which can belong to only one of them"
        } — the last row updated would take it from the others. Narrow the filter (or add 'limit: 1') so exactly one row matches, or write this relation in a separate call.`
      );
    if (edge.kind === "junction") {
      store.link(edge, parent, row, through);
      return;
    }
    const takes = born(parent, edge);
    // What the row holds of a relation is decided once: by the relation it holds, or by the row that takes it as a member.
    const mine = slots.get(row);
    for (const field of Object.keys(takes)) {
      const by = mine?.get(field);
      if (by)
        throw new NestedWriteError(
          `Nested operation '${by.verb}' on relation '${by.relation}' depends on an earlier '${verb}' membership write in the same nested write. Split these operations into separate queries.`,
          by.relation,
          { meta: { operation: by.verb, conflictsWith: verb } }
        );
    }
    store.update(row, takes, undefined, edge);
  };
  /** The one link a relation that reaches one row holds is every link of the row that holds it. */
  const leave = (parent: Row, edge: Membership, row: Row) =>
    edge.kind === "junction"
      ? store.unlink(edge, parent, edge.many ? row : undefined)
      : store.update(row, cleared(edge), undefined, edge);
  const make = (
    model: AnyModel,
    data: Input,
    given: Input,
    relation?: string,
    arm = false
  ): Row => {
    const relations = relationsOf(model, data);
    const said = schema.scalars(model, stated(data));
    // The rows whose key this one holds are there before it.
    const held = relations
      .filter(({ edge }) => holds(edge))
      .map(({ edge, payload }) =>
        single(undefined, model, edge, payload, said)
      );
    const takes = Object.assign(
      {},
      relation === undefined
        ? given
        : once("create", model, said, given, relation, true),
      ...held.map((own) => own.takes)
    );
    const row = store.insert(model, data, stated(data), relation, takes);
    made.set(row, !arm);
    for (const own of held) for (const next of own.then) next();
    for (const { edge, payload } of relations)
      if (!holds(edge))
        if (edge.many) relate(row, edge, payload);
        else single(row, model, edge, payload, said);
    return row;
  };
  /** A row that is there takes what `data` states, then what its relations ask of the rows they reach. */
  const write = (
    model: AnyModel,
    row: Row,
    data: Input,
    portable = true,
    /** What it takes to become the member of a row, through that relation. */
    given?: Input,
    relation?: string
  ): void => {
    // What a key may be rewritten with is the key's rule, wherever it is asked.
    const refused = portable && schema.keyPortabilityRefusal(model, data);
    if (refused) throw refused;
    const relations = relationsOf(model, data);
    const said = schema.scalars(model, stated(data));
    // A row that takes another key, and writes a relation whose members hold that key: no member may be left behind, unless the database makes them follow.
    for (const { edge } of relations) {
      if (edge.kind !== "reference" || edge.owner !== "target") continue;
      const moved = edge.pairs.filter((pair) =>
        moves(row[pair.source], said[pair.source])
      );
      for (const { source } of moved)
        if (moves(null, said[source]) === false)
          throw new NestedWriteError(
            `Cannot update relation key field '${source}' to null while mutating relation '${edge.name}'. A null reference names no row for that relation to point at.`,
            edge.name,
            { meta: { operation: "update", field: source } }
          );
      if (
        moved.length > 0 &&
        edge.reference &&
        edge.reference.onUpdate !== "cascade" &&
        !edge.pairs.some((pair) => row[pair.source] === null)
      )
        store.none(
          { model: edge.target, member: { edge, of: { ...row } } },
          {
            kind: "nestedWrite",
            relation: edge.name,
            message: `Cannot update relation '${edge.name}' with onUpdate('${edge.reference.onUpdate ?? "restrict"}') while the current relation is occupied.`,
            raceable: false,
          }
        );
    }
    const own = relations.filter(({ edge }) => holds(edge));
    const singles = own.map(({ edge, payload }) =>
      single(row, model, edge, payload, said)
    );
    for (const [at, { edge, payload }] of own.entries()) {
      const verb = [
        "upsert",
        "connectOrCreate",
        "connect",
        "create",
        "delete",
        "disconnect",
      ].find((each) => payload[each] !== undefined)!;
      const fields = slots.get(row) ?? new Map();
      for (const field of Object.keys(singles[at]!.takes))
        fields.set(field, { relation: edge.name.split(".")[0]!, verb });
      slots.set(row, fields);
    }
    const takes = Object.assign(
      {},
      given && once("update", model, said, given, relation!, true),
      ...singles.map((each) => each.takes)
    );
    // A relation the caller wrote decides the fields the row holds it by: nothing else writes them.
    const decided = Object.fromEntries(
      own.flatMap(({ edge }) =>
        (edge as Extract<Membership, { kind: "reference" }>).pairs.map(
          (pair) => [pair.source, true]
        )
      )
    );
    store.update(
      row,
      {
        ...store.values(model, "update", data, {
          ...decided,
          ...stated(data),
          ...takes,
        }),
        ...takes,
      },
      writes(model, data)
    );
    for (const each of singles) for (const next of each.then) next();
    for (const { edge, payload } of relations)
      if (!holds(edge))
        if (edge.many) relate(row, edge, payload);
        else single(row, model, edge, payload, said);
  };
  /**
   * A relation that reaches one row: the row it reaches goes, another is
   * supplied, and the row supplied, or the one there, is updated — in that
   * order, however they were written. Where the row the relation is asked of
   * holds the key, it answers what that row takes and what follows its own
   * write; the row is not there yet where it is being created.
   */
  function single(
    row: Row | undefined,
    model: AnyModel,
    edge: Membership,
    payload: Input,
    said: Input
  ): { takes: Input; then: (() => void)[] } {
    const held = holds(edge);
    const then: (() => void)[] = [];
    const { target } = edge;
    const kind = row ? "update" : "create";
    /** What the row takes of the relation: nothing the caller wrote of the row itself. */
    const takes: Input = {};
    const take = (more: Input) =>
      Object.assign(takes, once(kind, model, said, more, edge.name));
    const first = (verb: string) =>
      list(payload[verb])[0] as Input | true | undefined;
    // The relation reaches the row the row's key names once its own write is made: what the caller wrote of that key is where it ends.
    const final =
      held && edge.kind === "reference"
        ? edge.pairs.filter((pair) => said[pair.source] !== undefined)
        : [];
    // A key the relation is held by is given a value: what the database would compute of it names no row the relation could be asked of.
    const stated = (field: string) => readUpdate(said[field]);
    for (const { source } of final)
      if (stated(source).kind !== "value")
        throw new NestedWriteError(
          `Cannot update relation key field '${source}' with a non-literal operation while mutating relation '${edge.name}'. Use a literal value or '{ set: ... }'.`,
          edge.name,
          { meta: { operation: "update", field: source, relation: edge.name } }
        );
    const of =
      row && final.length > 0
        ? new Proxy(row, {
            get: (known, field: string) =>
              said[field] === undefined
                ? known[field]
                : (stated(field) as { value: unknown }).value,
          })
        : row;
    /** The row the relation reaches now. */
    const current = (ask: Partial<Question>, entry?: Input | true) =>
      of
        ? members(of, edge, entry === true ? undefined : entry, {
            ...ask,
            strict: entry === true,
          })[0]
        : undefined;
    const disconnect = first("disconnect");
    // Nothing is read of the row a slot of the row itself gives up.
    if (disconnect === true && held) take(cleared(edge));
    else if (disconnect) {
      const old = current({ intent: "join", verb: "disconnect" }, disconnect);
      if (old && held) take(cleared(edge));
      else if (old) leave(row!, edge, old);
    }
    const remove = first("delete");
    // The row a delete names is whichever the row's own key reaches: not told apart from the row a connect names, which the same key would name next.
    const reads = remove && held && first("connect") && "connect";
    if (reads)
      throw new NestedWriteError(
        `Nested operation '${reads}' on relation '${edge.name}' depends on an earlier 'delete' target write in the same nested write. Split these operations into separate queries.`,
        edge.name,
        { meta: { operation: reads, conflictsWith: "delete" } }
      );
    const removal = { intent: "delete", verb: "delete" } as const;
    const old =
      remove &&
      // The row's own key names a member: one the call cannot delete is a refusal, seen or not.
      (held &&
      of &&
      edge.kind === "reference" &&
      edge.pairs.every((pair) => (of[pair.source] ?? null) !== null)
        ? store.one({
            model: target,
            where: remove === true ? undefined : remove,
            member: { edge, of },
            ...removal,
          })
        : current(removal, remove));
    if (old) {
      // A row the row itself references goes once the row no longer does; a row that is kept is still referenced.
      if (held) {
        if (!store.keeps(target)) take(cleared(edge));
        then.push(() => store.delete(old));
      } else store.delete(old);
    }
    const create = (
      data: Input | true | undefined,
      arm = true,
      through = (data as Input).$through as Input | undefined
    ) => {
      const made = make(
        target,
        data as Input,
        held ? {} : born(row!, edge),
        edge.name,
        arm
      );
      if (edge.kind === "junction") store.link(edge, row!, made, through);
      return made;
    };
    const adopt = (found: Row, verb: string, through?: Input) => {
      if (!held) join(row!, edge, found, verb, through);
      return found;
    };
    /** An entry that names a row, and what it writes of the link to it. */
    const named = (entry: unknown) => {
      const { $through, ...where } = entry as Input;
      return [where, $through as Input | undefined] as const;
    };
    const sought = (where: unknown, verb: string): Question => ({
      model: target,
      where: where as Input,
      unique: true,
      through: edge,
      intent: "join",
      verb,
    });
    let supplied: Row | undefined;
    if (first("create")) supplied = create(first("create"), false);
    if (first("connect")) {
      const [where, through] = named(first("connect"));
      const question = sought(where, "connect");
      const found = store.one(question);
      // The row itself is found as its own data leaves it, and its own data takes the key it would be found for: neither comes first.
      if (found === row && store.reads(question, Object.keys(said)))
        throw new NestedWriteError(
          `Nested operation 'connect' on relation '${edge.name}' depends on an earlier 'update' target write in the same nested write. Split these operations into separate queries.`,
          edge.name,
          { meta: { operation: "connect", conflictsWith: "update" } }
        );
      supplied = adopt(found, "connect", through);
    }
    const either = first("connectOrCreate") as Input | undefined;
    if (either) {
      const [found] = store.rows(sought(either.where, "connectOrCreate"));
      const through = either.$through as Input | undefined;
      supplied = found
        ? adopt(found, "connectOrCreate", through)
        : create(either.create as Input, true, through);
    }
    const upsert = first("upsert") as Input | undefined;
    if (upsert) {
      const found = current(
        {
          intent: "update",
          writes: writes(target, upsert.update as Input),
          verb: "upsert",
        },
        upsert.where as Input | undefined
      );
      if (found) then.push(() => write(target, found, upsert.update as Input));
      else supplied = create(upsert.create as Input);
    }
    if (supplied && held) take(reaching(edge, supplied));
    const update = first("update") as Input | undefined;
    if (update) {
      const data = update.data as Input;
      // The row the relation was just given is the one updated, where nothing more is asked of it; else the one it reaches once the row's own write is made.
      then.push(() =>
        write(
          target,
          supplied && !update.where
            ? supplied
            : store.one({
                model: target,
                where: update.where as Input | undefined,
                member: { edge, of: of! },
                intent: "update",
                writes: writes(target, data),
                verb: "update",
              }),
          data
        )
      );
    }
    if (held) return { takes, then };
    for (const next of then) next();
    return { takes, then: [] };
  }
  /** A relation's verbs where it reaches many rows: in the order they take effect. */
  const nested: Record<
    string,
    (
      parent: Row,
      edge: Membership,
      entry: Input,
      arm?: boolean,
      through?: Input
    ) => void
  > = {
    disconnect(parent, edge, where) {
      leave(
        parent,
        edge,
        store.one({
          model: edge.target,
          where,
          unique: true,
          member: { edge, of: parent },
          intent: "join",
          verb: "disconnect",
        })
      );
    },
    delete(parent, edge, where) {
      store.delete(
        store.one({
          model: edge.target,
          where,
          unique: true,
          member: { edge, of: parent },
          intent: "delete",
          verb: "delete",
        })
      );
    },
    updateMany(parent, edge, { where, data }) {
      const values = paired(data as Input, stated(data as Input));
      const ask = {
        intent: "update" as const,
        writes: writes(edge.target, values),
        verb: "updateMany",
      };
      const set = store.values(edge.target, "update", values, stated(values));
      // Rows that take the same fields are written at once; rows of which a relation or a key is written are each written as an update writes its row.
      if (plain(edge.target, values, set))
        store.all(
          {
            model: edge.target,
            where: where as Input,
            member: { edge, of: parent },
            ...ask,
          },
          set
        );
      else {
        const rows = members(parent, edge, where as Input, ask);
        const outer = several;
        several = rows.length;
        for (const row of rows) write(edge.target, row, values);
        several = outer;
      }
    },
    deleteMany(parent, edge, where) {
      store.all({
        model: edge.target,
        where,
        member: { edge, of: parent },
        intent: "delete",
        verb: "deleteMany",
      });
    },
    update(parent, edge, { where, data }) {
      const values = data as Input;
      write(
        edge.target,
        store.one({
          model: edge.target,
          where: where as Input | undefined,
          unique: true,
          member: { edge, of: parent },
          intent: "update",
          writes: writes(edge.target, values),
          verb: "update",
        }),
        values
      );
    },
    upsert(parent, edge, { where, create, update }) {
      const named: Question = {
        model: edge.target,
        where: where as Input,
        unique: true,
        intent: "update",
        writes: writes(edge.target, update as Input),
        verb: "upsert",
      };
      // The row the filter names, whose ever it is: one that is another row's is not taken, nor made again.
      const [found] = store.rows({ ...named, through: edge });
      if (!found) nested.create!(parent, edge, create as Input, true);
      // A row the call creates has no member yet: the row its upsert finds becomes one.
      else if (made.has(parent)) {
        write(
          edge.target,
          found,
          update as Input,
          true,
          born(parent, edge),
          edge.name
        );
        if (edge.kind === "junction") store.link(edge, parent, found);
      } else
        write(
          edge.target,
          store.one({ ...named, member: { edge, of: parent } }),
          update as Input
        );
    },
    connectOrCreate(parent, edge, { where, create, $through }) {
      const [row] = store.rows({
        model: edge.target,
        where: where as Input,
        unique: true,
        through: edge,
        intent: "join",
        verb: "connectOrCreate",
      });
      if (row) join(parent, edge, row, "connectOrCreate", $through as Input);
      else
        nested.create!(parent, edge, create as Input, true, $through as Input);
    },
    connect(parent, edge, { $through, ...where }) {
      join(
        parent,
        edge,
        store.one({
          model: edge.target,
          where,
          unique: true,
          through: edge,
          intent: "join",
          verb: "connect",
        }),
        "connect",
        $through as Input
      );
    },
    create(parent, edge, data, arm = false, through = data.$through as Input) {
      const row = make(edge.target, data, born(parent, edge), edge.name, arm);
      if (edge.kind === "junction") store.link(edge, parent, row, through);
    },
    createMany(parent, edge, { data, skipDuplicates }) {
      const rows = list(data) as Input[];
      if (!skipDuplicates) {
        for (const entry of rows) nested.create!(parent, edge, entry);
        return;
      }
      const bare = (row: Input) => relationsOf(edge.target, row).length === 0;
      // Under another write, duplicates are passed by only where a part of the unit can be undone alone.
      store.attempts("nested createMany rows");
      // Rows that hold their own membership, and nothing but themselves, are written at once.
      if (
        edge.kind === "reference" &&
        rows.every(bare) &&
        store.skipping(
          edge.target,
          rows.map((row) => [row, stated(row), born(parent, edge)])
        )
      )
        return;
      for (const row of rows) {
        let made: Row | undefined;
        const written = store.attempt(() => {
          made = make(edge.target, row, born(parent, edge), edge.name);
          return made;
        }, "nested createMany rows");
        if (edge.kind !== "junction") continue;
        // A row passed by is not a membership passed by: the row it names is made a member, where it names one and asks nothing else. A member one row alone may have stays whose it is.
        const named =
          !(written || edge.uniqueSide) &&
          bare(row) &&
          spelled(edge.target, stated(row));
        const member = written
          ? made
          : named &&
            store.rows({
              model: edge.target,
              where: named,
              through: edge,
              intent: "join",
              verb: "createMany",
            })[0];
        if (member) store.link(edge, parent, member, row.$through as Input);
      }
    },
  };
  /** A set: the rows it names are the relation's members, and no other. */
  const set = (parent: Row, edge: Membership, entries: Input[]): void => {
    const through: (Input | undefined)[] = [];
    const kept = entries.map(({ $through, ...where }) => {
      through.push($through as Input | undefined);
      return store.one({
        model: edge.target,
        where,
        unique: true,
        through: edge,
        intent: "join",
        verb: "set",
      });
    });
    const others: Question = {
      model: edge.target,
      member: { edge, of: parent },
      except: kept.map((row) => schema.identity(edge.target, row)),
      intent: "join",
      verb: "set",
      strict: `Cannot clear relation '${edge.name}': a connected record may not be disconnected by this call.`,
    };
    if (edge.kind === "junction") {
      store.writable(others);
      store.unlink(edge, parent, undefined, kept);
    } else if (edge.clearability.kind === "none") {
      // A member that cannot give its key up cannot be taken out.
      if (store.rows(others).length > 0)
        throw new NestedWriteError(
          `Cannot set relation '${edge.name}' because foreign key field(s) ${[
            ...(edge.discriminator?.side === "target"
              ? [edge.discriminator.field]
              : []),
            ...edge.pairs.map((pair) => pair.target),
          ].join(
            ", "
          )} are required: rows removed from the set cannot be disconnected. Delete them instead.`,
          edge.name
        );
    } else store.all(others, cleared(edge));
    for (const [at, row] of kept.entries())
      join(parent, edge, row, "set", through[at]);
  };
  function relate(parent: Row, edge: Membership, payload: Input): void {
    // In the order the verbs take effect, whatever order they were written in.
    for (const verb of ["disconnect", "delete"])
      for (const entry of list(payload[verb]))
        nested[verb]!(parent, edge, entry as Input);
    if (payload.set !== undefined)
      set(parent, edge, list(payload.set) as Input[]);
    for (const verb of Object.keys(nested).slice(2))
      for (const entry of list(payload[verb]))
        nested[verb]!(parent, edge, entry as Input);
  }

  /** One row as the caller asked for it: none is no row of the call's. */
  const one = (model: AnyModel, args: Arguments) => {
    const projection = q.prepareProjection(model, args);
    const said = (rows: Input[]) => {
      if (rows.length === 0)
        throw new NotFoundError(model["~"].names.ts!, operation.operation);
      return q.decodeResult(rows, operation.operation, (read) =>
        q.decodeProjection(projection.shape, read)
      )[0];
    };
    return { projection, said };
  };
  /** The call's row, read as the caller asked once the writes before this are sent. */
  const answering = (model: AnyModel, row: Row, args: Arguments) => {
    const { projection, said } = one(model, args);
    let value: unknown;
    store.read(row, projection, (rows) => {
      value = said(rows);
    });
    return () => value;
  };
  /** Whether a write of rows of `model` writes nothing but what `set` says of them, and no key: one statement names the rows itself. */
  const plain = (model: AnyModel, data: Input, set: Input) =>
    relationsOf(model, data).length === 0 &&
    Object.keys(set).length > 0 &&
    !schema.keys(model).some((key) => set[key] !== undefined);
  /** A verb over many rows answers with them as the caller selected them, or with their number. */
  const many = (model: AnyModel, args: Arguments) => {
    const select = args.select as Input | undefined;
    const projection = select && q.prepareProjection(model, { select });
    const decoded = (rows: Input[]) =>
      q.decodeResult(rows, operation.operation, (read) =>
        q.decodeProjection(projection!.shape, read)
      );
    /** The rows written by their keys, read again once every one is written. */
    const again = (rows: Row[], kind: "createMany" | "updateMany") => {
      const returned: Input[] = [];
      if (projection && rows.length > 0)
        store.series(model, rows, projection, kind, (read) =>
          returned.push(...read)
        );
      return () =>
        projection
          ? decoded(returned)
          : {
              // Of rows created, as many as the database said it wrote.
              count: kind === "createMany" ? store.written(rows) : rows.length,
            };
    };
    return { projection, decoded, again };
  };

  return {
    create(model: AnyModel, args: Arguments, raw: Input) {
      const data = paired(args.data as Input, raw.data);
      return answering(model, make(model, data, {}), args);
    },
    createMany(model: AnyModel, args: Arguments, raw: Input) {
      const entries = paired(list(args.data) as Input[], list(raw.data));
      const { projection, decoded, again } = many(model, args);
      // A unit handed over that writes nothing is no unit.
      if (entries.length === 0 && store.handed)
        throw new QueryEngineError("No data to insert for createMany.");
      if (args.skipDuplicates) {
        const bearing = entries.some(
          (data) => relationsOf(model, data).length > 0
        );
        // Rows that are nothing but themselves are written at once, where one statement passes duplicates by.
        const later = bearing
          ? undefined
          : store.skipping(
              model,
              entries.map((data) => [data, stated(data)]),
              projection
            );
        if (later)
          return () =>
            projection
              ? decoded(later.sent!.rows)
              : { count: later.sent!.rowCount };
        // Else each row, with what hangs on it, is undone alone where it is one too many.
        const rows: Row[] = [];
        for (const data of entries)
          store.attempt(
            () => {
              const row = make(model, data, {});
              rows.push(row);
              return row;
            },
            bearing ? "rows involving nested writes" : "duplicate rows"
          );
        return again(rows, "createMany");
      }
      return again(
        entries.map((data) => {
          store.member();
          return make(model, data, {});
        }),
        "createMany"
      );
    },
    update(model: AnyModel, args: Arguments, raw: Input) {
      const data = paired(args.data as Input, raw.data);
      const question: Question = {
        model,
        where: args.where as Input,
        unique: true,
        intent: "update",
        writes: writes(model, data),
      };
      const set = store.values(model, "update", data, stated(data));
      if (plain(model, data, set)) {
        const { projection, said } = one(model, args);
        const later = store.all({ ...question, must: true }, set, projection);
        return () => said(later.sent!.rows);
      }
      const row = store.one(question);
      write(model, row, data, false);
      return answering(model, row, args);
    },
    updateMany(model: AnyModel, args: Arguments, raw: Input) {
      const data = paired(args.data as Input, raw.data);
      const { projection, decoded, again } = many(model, args);
      if (args.limit === 0) return () => (projection ? [] : { count: 0 });
      const relations = relationsOf(model, data);
      const question: Question = {
        model,
        where: args.where as Input | undefined,
        limit: args.limit as number | undefined,
        intent: "update",
        writes: writes(model, data),
      };
      const beside = !relations.some(({ edge }) => holds(edge));
      const set = store.values(model, "update", data, stated(data));
      if (plain(model, data, set)) {
        const later = store.all(question, set, projection);
        return () =>
          projection
            ? decoded(later.sent!.rows)
            : { count: store.writer.count(later.sent!) };
      }
      const rows = store.rows(question);
      several = rows.length;
      // Rows that take the same values are written side by side, before what their relations ask.
      if (beside)
        for (const row of rows) store.update(row, set, question.writes);
      for (const [at, row] of rows.entries()) {
        store.member();
        // Each row is written of its own copy of what the caller wrote: what a default fills is that row's own.
        const own =
          at === 0
            ? data
            : store.copy(`${at}`, () =>
                paired(
                  parseStamped(operation.scope?.rows.stamps ?? new Map(), () =>
                    schema.update(model, raw.data as Input, true)
                  ),
                  raw.data
                )
              );
        if (beside)
          for (const { edge, payload } of relationsOf(model, own))
            relate(row, edge, payload);
        else write(model, row, own);
      }
      return again(rows, "updateMany");
    },
    upsert(model: AnyModel, args: Arguments, raw: Input) {
      const update = paired(args.update as Input, raw.update);
      const guards = [args.targetWhere, args.setWhere].filter(Boolean);
      const create = paired(args.create as Input, raw.create);
      const question: Question = {
        model,
        where: args.where as Input,
        unique: true,
        intent: "update",
        writes: writes(model, update),
      };
      const followed = relationsOf(model, update);
      // A key that rows written beside it must follow has to be nameable before either arm: what it becomes is what they take.
      const unnamed = schema.keyTransitionRefusal(
        model,
        update,
        store.writer.selector(question).facts.keys,
        followed.flatMap(({ edge }) =>
          edge.kind === "reference" && !holds(edge) ? [edge] : []
        )
      );
      if (unnamed) throw unnamed;
      const related = relationsOf(model, create).length + followed.length;
      // An update that says nothing writes nothing: no statement that would write what every update takes.
      if (
        related + guards.length === 0 &&
        Object.keys(stated(update)).length > 0
      ) {
        const { projection, said } = one(model, args);
        const later = store.either(
          question,
          create,
          stated(create),
          store.values(model, "update", update, stated(update)),
          projection
        );
        if (later) return () => said(later.sent!.rows);
      }
      const [found] = store.rows(question);
      // Updated where found, and where it holds what the call asks of it besides.
      const where = args.where as Input;
      const asked = {
        ...question,
        where: { ...where, AND: [...list(where.AND), ...guards] },
      };
      // What a key may be rewritten with is asked of the row found, whatever is asked of it besides.
      const refused =
        found &&
        followed.length > 0 &&
        schema.keyPortabilityRefusal(model, update);
      if (refused) throw refused;
      const matched =
        !found || guards.length === 0 || store.rows(asked).length > 0;
      if (!matched) store.absent(asked);
      // An update that says nothing asks nothing of the row found.
      const updates =
        found && matched && Object.keys(stated(update)).length > 0;
      if (updates) write(model, found, update, false);
      const answer = answering(model, found ?? make(model, create, {}), args);
      return () => {
        // Which of the two it was is told once the call's writes are made: neither where it wrote nothing.
        if (!found || updates) store.sink?.upserted(!found);
        return answer();
      };
    },
    delete(model: AnyModel, args: Arguments) {
      const { projection, said } = one(model, args);
      const later = store.all(
        {
          model,
          where: args.where as Input,
          unique: true,
          intent: "delete",
          must: true,
        },
        undefined,
        projection
      );
      return () => said(later.sent!.rows);
    },
    deleteMany(model: AnyModel, args: Arguments) {
      const { projection, decoded } = many(model, args);
      if (args.limit === 0) return () => (projection ? [] : { count: 0 });
      const later = store.all(
        {
          model,
          where: args.where as Input | undefined,
          limit: args.limit as number | undefined,
          intent: "delete",
        },
        undefined,
        projection
      );
      return () =>
        projection
          ? decoded(later.sent!.rows)
          : { count: store.writer.count(later.sent!) };
    },
  };
}
