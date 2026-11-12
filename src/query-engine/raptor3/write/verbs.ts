/**
 * What the verbs mean, and nothing else: written as if the store were the
 * database itself and answered at once. No transport, no provider, no row
 * scope, no word about what is known when.
 */
import type { AnyModel } from "@schema/model";
import { parseStamped } from "../shared/row-scope";
import type { Arguments, Input } from "../shared/schema";
import type { Membership } from "../shared/storage";
import { outside } from "./statements";
import type { Row, Store } from "./store";

const list = (value: unknown): unknown[] => {
  if (value === undefined) return [];
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
  /** The relations `data` names of a row of `model`, each with what it asks. */
  const relationsOf = (model: AnyModel, data: Input) =>
    model["~"].relationNames.flatMap((name) => {
      const payload = data[name] as Input | undefined;
      if (payload === undefined) return [];
      const edge = schema.membership(model, name);
      if (
        edge.discriminator ||
        (edge.kind === "junction"
          ? edge.declared || edge.uniqueSide
          : edge.owner === "source")
      )
        outside();
      return [{ name, edge, payload }];
    });
  /** Whether what a relation asks writes the row it is asked of: the link is the row's own, or the row holds the key. */
  const touches = (edge: Membership): boolean =>
    edge.kind === "junction" || edge.owner === "source";
  /** What a row born a member of `parent`'s holds: none where the membership is not the row's to hold. */
  const born = (parent: Row, edge: Membership): Input =>
    edge.kind === "reference"
      ? Object.fromEntries(
          edge.pairs.map((pair) => [pair.target, parent[pair.source]])
        )
      : {};
  /** Makes a row that is there a member of `parent`'s. */
  const join = (parent: Row, edge: Membership, row: Row): void => {
    if (edge.kind === "junction") store.link(edge, parent, row);
    else outside();
  };
  const make = (
    model: AnyModel,
    data: Input,
    given: Input,
    relation?: string
  ): Row => {
    const row = store.insert(
      model,
      { ...data, ...given },
      { ...stated(data), ...given },
      relation
    );
    relate(model, row, data);
    return row;
  };
  /** A relation's verbs, in the order they take effect. */
  const nested: Record<
    string,
    (parent: Row, edge: Membership, entry: Input) => void
  > = {
    connect(parent, edge, where) {
      join(
        parent,
        edge,
        store.one({
          model: edge.target,
          where,
          unique: true,
          joins: edge,
          verb: "connect",
        })
      );
    },
    create(parent, edge, data) {
      const row = make(edge.target, data, born(parent, edge), edge.name);
      if (edge.kind !== "reference") join(parent, edge, row);
    },
  };
  function relate(model: AnyModel, row: Row, data: Input): void {
    for (const { edge, payload } of relationsOf(model, data)) {
      if (Object.keys(payload).some((verb) => !(verb in nested))) outside();
      for (const verb of Object.keys(nested))
        for (const entry of list(payload[verb]))
          nested[verb]!(row, edge, entry as Input);
    }
  }
  return {
    updateMany(model: AnyModel, args: Arguments, raw: Input): () => unknown {
      const data = paired(args.data as Input, raw.data);
      const select = args.select as Input | undefined;
      const projection = select && q.prepareProjection(model, { select });
      const decoded = (rows: Input[]) =>
        q.decodeResult(rows, "updateMany", (read) =>
          q.decodeProjection(projection!.shape, read)
        );
      if (args.limit === 0 || Object.keys(data).length === 0)
        return () => (projection ? [] : { count: 0 });
      const relations = relationsOf(model, data);
      const set = store.values(model, "update", data, stated(data));
      // What the caller's own data writes of the rows: what the write is judged at.
      const writes = [
        ...Object.keys(set).filter(
          (field) => stated(data)[field] !== undefined
        ),
        ...relations
          .filter(({ edge }) => touches(edge))
          .map(({ name }) => name),
      ];
      const question = {
        model,
        where: args.where as Input | undefined,
        limit: args.limit as number | undefined,
        intent: "update" as const,
        writes:
          writes.length + Object.keys(set).length > 0 ? writes : undefined,
      };
      // Nothing but the rows is written: one statement names them itself.
      if (relations.length === 0) {
        const later = store.updateAll(question, set, projection);
        return () =>
          projection
            ? decoded(later.sent!.rows)
            : { count: store.writer.count(later.sent!) };
      }
      const rows = store.rows(question);
      for (const row of rows) store.update(row, set, question.writes);
      for (const [at, row] of rows.entries())
        relate(
          model,
          row,
          // Each row is written of its own copy of what the caller wrote: what a default fills is that row's own.
          at === 0
            ? data
            : store.copy(`${at}`, () =>
                paired(
                  parseStamped(operation.scope?.rows.stamps ?? new Map(), () =>
                    schema.update(model, raw.data as Input, true)
                  ),
                  raw.data
                )
              )
        );
      // Rows written by their keys are read again once every one is written.
      const returned: Input[] = [];
      if (projection && rows.length > 0)
        for (const query of operation.seriesQueries(
          projection,
          rows.map((row) => schema.identity(model, row)),
          "updateMany"
        ))
          store.after(model, query, (sent) => {
            q.assertExpectedRows(query, sent.rows.length);
            returned.push(...sent.rows);
          });
      return () => (projection ? decoded(returned) : { count: rows.length });
    },
  };
}
