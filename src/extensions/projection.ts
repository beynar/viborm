/**
 * What a read carries beside its rows and what it hides of them, for one
 * prepared domain: the entries' projection keys (`evidence`) and read-gated
 * fields (`reads`). A field a rule hides reads NULL where its row does not
 * carry it, and a declared key says which rules hold of a row. Brought by
 * `gate` and `facts`: a program whose rules neither gate nor report holds
 * none of it. The engine lowers the predicates and decodes the rest.
 */
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { ClientInitializationError, UnsupportedOperationError } from "@errors";
import {
  BOOLEAN_LEAF,
  type DeclaredEvidence,
  type FieldGate,
  type GatedMember,
  type Leaf,
  type PreparedProjection,
  type PreparedProjectionField,
  type PreparedSelector,
  type ProjectedFacts,
  type Shape,
} from "@query-engine/raptor3/shared/query";
import type { JudgedEntry } from "@query-engine/raptor3/shared/row-scope";
import { type Input, memo } from "@query-engine/raptor3/shared/schema";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import { listed } from "@query-engine/raptor3/shared/terms";
import { gateResultKey } from "@query-engine/result-aliases";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import { ALL } from "./entries";
import { gatedDocument, namedGatedFields } from "./gates";
import { admitProjected } from "./projected";
import type { PreparedDomain } from "./row-domain";

/**
 * One model's projection keys across a chain's layers, brought by `facts`:
 * one key, one layer, since a second would hide the first, and never a
 * relation's link row's name.
 */
export function refuseSharedKeys(
  model: string,
  layers: readonly (JudgedEntry | undefined)[]
): void {
  const keys = new Set<string>();
  for (const layer of layers) {
    const key = layer?.as;
    if (key === undefined) continue;
    if (key === "$through" || keys.has(key))
      throw new ClientInitializationError(
        `rule.${model}.read.select "${key}" ${key === "$through" ? "is reserved for a relation's link row" : "is declared by two extensions of the chain"}.`,
        { meta: { model } }
      );
    keys.add(key);
  }
}

/** What the engine asks of what projects and hides a domain's fields. */
export type Projection = ReturnType<typeof projectionOf>;

/** What projects and hides fields, for one domain: brought by `gate` and `facts`. */
export const projectionOf = (domain: PreparedDomain) => {
  const projectedBy = new Map<string, ProjectedFacts | null>();
  const layeredBy = new Map<string, Map<Input, PreparedSelector>>();
  /**
   * The default projections of the models this domain projects facts for:
   * theirs differ from the view's shared ones, which carry no gate.
   */
  const defaultProjections = new WeakMap<AnyModel, PreparedProjection>();
  /**
   * Where `input`, one of `model`'s predicates in `layer`, holds on the row
   * at `alias`, as that layer's node: R5 and R6 judge it as they judge the
   * layer's filter. `undefined` where the call drops it (it holds).
   */
  const layerHolds = (
    q: SqlQueries,
    model: AnyModel,
    layer: number,
    input: Input,
    alias?: string
  ): Sql | undefined =>
    q.lowerSelector(projection.layered(model, layer, input), alias);
  /** `model`'s read-gated fields, each with its gate. */
  const gatesOf = (model: AnyModel) => projection.projected(model)?.gates;
  /** Where a read-gated field's row carries it: every gating layer's `read` and predicate. */
  function gateHolds(
    q: SqlQueries,
    model: AnyModel,
    gate: FieldGate,
    alias: string | undefined,
    visible: boolean
  ): Sql | undefined {
    const held: Sql[] = [];
    // A gate masks a value: neither a positive nor a negative test, so no
    // set it reads is bounded ({@link setBound}) and it holds where it would.
    q.unbounded++;
    try {
      for (const [layer, read, input] of gate) {
        const tested = input === read ? [read] : [read, input];
        for (const where of visible ? tested.slice(1) : tested) {
          const lowered = layerHolds(q, model, layer, where, alias);
          if (lowered !== undefined) held.push(lowered);
        }
      }
    } finally {
      q.unbounded--;
    }
    return held.length === 0 ? undefined : q.adapter.operators.and(...held);
  }
  const projection = {
    /**
     * A projection key's value, or whether a gated field's row carries it, on
     * the row at `alias` (`taken`: a row the domain already took). A key's
     * value is the layer's `read` once, around a document of one boolean per
     * name (K5).
     */
    lower(
      q: SqlQueries,
      model: AnyModel,
      field: Extract<PreparedProjectionField, { kind: "evidence" | "gate" }>,
      alias: string | undefined,
      taken: boolean
    ): Sql {
      if (field.kind === "gate")
        return q.truth(gateHolds(q, model, field.gate, alias, taken));
      const a = q.adapter;
      const { layer, read } = field.evidence;
      const visible = taken
        ? undefined
        : layerHolds(q, model, layer, read, alias);
      const held = q.carriedDocument(
        field.names.map(([name, input]): [string, Sql] => [
          name,
          q.truth(
            input === read
              ? undefined
              : layerHolds(q, model, layer, input, alias)
          ),
        ])
      );
      return visible === undefined
        ? held
        : a.expressions.caseWhen(
            [{ when: visible, then: held }],
            q.carriedDocument(
              field.names.map(([name]): [string, Sql] => [
                name,
                a.literals.false(),
              ])
            )
          );
    },
    /**
     * A read-gated model's rows `where` keeps, as a window whose gated
     * columns read NULL on a row that does not carry them (K5), for a group
     * read: each gate lowered once per row, where a gate repeated in the
     * grouping, the projection and the order would be three expressions to
     * the provider. `undefined` where the model gates nothing.
     */
    window(
      q: SqlQueries,
      model: AnyModel,
      where: Input | undefined
    ): Sql | undefined {
      if (!gatesOf(model)?.size) return undefined;
      const a = q.adapter;
      const inner = q.alias();
      return assembleAdapterSelect(a, {
        columns: listed(
          q.schema
            .storedFields(model)
            .map((field) =>
              a.identifiers.aliased(
                projection.guarded(
                  q,
                  model,
                  field,
                  q.column(model, field, inner),
                  inner
                ),
                q.columnName(model, field)
              )
            )
        ),
        from: q.table(model, inner),
        where: q.lowerWhere(model, where, inner),
      });
    },
    gatedDocument,
    /**
     * `column`, `model`'s `field` at `alias`, as an operand the caller wrote
     * (K5): NULL on a row that does not carry a read-gated field. Every row a
     * caller's operand is read on is one the domain takes, so `read` holds
     * there: the gate's own predicate decides.
     */
    guarded(
      q: SqlQueries,
      model: AnyModel,
      field: string,
      column: Sql,
      alias?: string
    ): Sql {
      const gate = gatesOf(model)?.get(field);
      const holds = gate && gateHolds(q, model, gate, alias, true);
      const a = q.adapter;
      return holds === undefined
        ? column
        : a.expressions.caseWhen(
            [{ when: holds, then: column }],
            a.literals.null()
          );
    },
    /**
     * A call's arguments admitted with the projection keys this domain
     * declares kept beside the schema's.
     */
    admit: admitProjected,
    /**
     * A `$through` that reads or tests a gated field of its junction `model`
     * is refused before any statement, as a hidden link row is: the hop has no
     * faithful answer for a field its reader may not see.
     */
    refuseGatedLink(
      edge: Membership,
      model: AnyModel,
      fields: readonly string[],
      use: "read" | "filter"
    ): void {
      const gates = gatesOf(model);
      const gated = gates && fields.find((field) => gates.has(field));
      const name = model["~"].names.ts;
      if (gated !== undefined)
        throw new UnsupportedOperationError(
          `Cannot ${use} $through.${gated} of relation '${edge.name}': this client gates that field of '${name}'. Read it through the '${name}' delegate.`
        );
    },
    /** `$rows()` hands a caller the table's columns as they are: refused where a field of them is read-gated. */
    refuseGatedRows(model: AnyModel): void {
      const gates = gatesOf(model);
      if (gates?.size)
        throw new UnsupportedOperationError(
          `${model["~"].names.ts}.$rows() refuses read-gated fields: ${[...gates.keys()]}`
        );
    },
    /** `input`, one of `model`'s predicates in `layer`, as that layer's node. */
    layered(model: AnyModel, layer: number, input: Input): PreparedSelector {
      const name = model["~"].names.ts!;
      const inputs = memo(layeredBy, `${name} ${layer}`, () => new Map());
      return memo(
        inputs,
        input,
        () => domain.conjunction(model, [[layer, [input]]])!
      );
    },
    /**
     * `model`'s projection keys and read-gated fields, equal gates shared so
     * a projection carries one member per distinct gate; `undefined` for
     * none.
     */
    projected(model: AnyModel): ProjectedFacts | undefined {
      const name = model["~"].names.ts!;
      const projected = memo(projectedBy, name, () => {
        const keys = new Map<string, DeclaredEvidence>();
        const gates = new Map<string, FieldGate>();
        for (const [layer, entry] of (
          domain.rows.rules?.get(name) ?? []
        ).entries()) {
          if (entry === undefined) continue;
          const { as, facts } = entry;
          const read = entry.shown ?? entry.read ?? ALL;
          // The names in an object's own-key order — an integer-like name
          // first — which is the order the shape made of them lists them in,
          // and so the order a document carried as an array holds them in.
          if (as !== undefined)
            keys.set(as, {
              layer,
              read,
              names: Object.entries(Object.fromEntries(facts!)),
            });
          for (const [field, input] of entry.reads ?? [])
            gates.set(field, [
              ...(gates.get(field) ?? []),
              [layer, read, input] as const,
            ]);
        }
        const known: FieldGate[] = [];
        for (const [field, gate] of gates) {
          const same = known.find(
            (other) =>
              other.length === gate.length &&
              other.every(
                ([layer, , input], index) =>
                  layer === gate[index]![0] && input === gate[index]![2]
              )
          );
          if (same === undefined) known.push(gate);
          gates.set(field, same ?? gate);
        }
        return keys.size === 0 && gates.size === 0 ? null : { keys, gates };
      });
      return projected ?? undefined;
    },
    /**
     * What this domain adds to one projection of `model` a caller reads (K5),
     * `undefined` where it declares neither key nor gate on the model: the
     * default projections it shares, its declared keys (`key`: whether `name`
     * is one, projected: `true` reports every declared name, a list the names
     * it gives, in declared order, one boolean per name), and each gate of a
     * scalar it reads (`field`, after the scalar: projected once), with the
     * shape that says which member decides each gated field, and which of
     * them the caller named.
     */
    preparing(model: AnyModel, select: unknown, path: string) {
      const projected = projection.projected(model);
      if (projected === undefined) return undefined;
      // The engine hands an admitted `select`, an object, or none, which no
      // entry is keyed by.
      const named = namedGatedFields.get(select as object);
      const gated: Record<string, GatedMember> = {};
      const gates = new Map<FieldGate, string>();
      return {
        defaults: defaultProjections,
        key: (
          name: string,
          selection: unknown,
          fields: Record<string, Shape | Leaf>,
          prepared: PreparedProjectionField[]
        ): boolean => {
          const evidence = projected.keys.get(name);
          if (evidence === undefined) return false;
          const names =
            selection === true
              ? evidence.names
              : evidence.names.filter(([held]) =>
                  // Admission left `true` or a list of the declared names.
                  (selection as readonly string[]).includes(held)
                );
          fields[name] = {
            kind: "object",
            nullable: false,
            fields: Object.fromEntries(
              names.map(([held]) => [held, BOOLEAN_LEAF])
            ),
          };
          prepared.push({ kind: "evidence", name, evidence, names });
          return true;
        },
        field(name: string, prepared: PreparedProjectionField[]): void {
          const gate = projected.gates.get(name);
          if (gate === undefined) return;
          let member = gates.get(gate);
          if (member === undefined) {
            member = gateResultKey(gates.size);
            gates.set(gate, member);
            prepared.push({ kind: "gate", name: member, gate });
          }
          gated[name] = named?.has(name)
            ? { gate: member, refused: `${path}select.${name}` }
            : { gate: member };
        },
        shape: () =>
          gates.size > 0 ? { gated, gates: [...gates.values()] } : undefined,
      };
    },
  };
  return projection;
};
