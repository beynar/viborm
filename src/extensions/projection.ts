/**
 * What a read carries beside its rows and what it hides of them, for one
 * prepared domain: the verbs' projection keys (`evidence`) and read-gated
 * fields (`reads`). Brought by `gate` and `facts`: a program whose rules
 * neither gate nor report holds none of it.
 */
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { ClientInitializationError, UnsupportedOperationError } from "@errors";
import {
  BOOLEAN_LEAF,
  type DeclaredEvidence,
  type FieldGate,
  freeze,
  type Leaf,
  type PreparedProjection,
  type PreparedProjectionField,
  type PreparedSelector,
  type ProjectedFacts,
  type ProjectionShape,
  type Queries,
  type Reader,
  type Shape,
} from "@query-engine/raptor3/shared/query";
import type { ModelVerbs } from "@query-engine/raptor3/shared/row-scope";
import type { Operation as Admitted } from "@query-engine/raptor3/shared/schema";
import {
  type Arguments,
  type EngineSchema,
  type Input,
  memo,
} from "@query-engine/raptor3/shared/schema";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import type { Membership } from "@query-engine/raptor3/shared/storage";
import { listed } from "@query-engine/raptor3/shared/terms";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";
import {
  evidence,
  gatedDocument,
  gateHolds,
  gating,
  guarded,
  refuseGatedRows,
} from "./gates";
import { admitProjected } from "./projected";
import type { PreparedDomain } from "./row-domain";
import { ALL } from "./verbs";

/** Equal gates shared, so a projection carries one member per distinct gate. */
function sharedGate(gate: FieldGate, known: FieldGate[]): FieldGate {
  const same = known.find(
    (other) =>
      other.length === gate.length &&
      other.every(
        ([layer, , input], index) =>
          layer === gate[index]![0] && input === gate[index]![2]
      )
  );
  if (same) return same;
  known.push(gate);
  return gate;
}

/**
 * One model's projection keys across a chain's layers, brought by `facts`:
 * one key, one layer, since a second would hide the first, and never a
 * relation's link row's name.
 */
export function refuseSharedKeys(
  model: string,
  layers: readonly (ModelVerbs | undefined)[]
): void {
  const keys = new Set<string>();
  for (const layer of layers) {
    const key = layer?.as;
    if (key === undefined) continue;
    if (key === "$through" || keys.has(key))
      throw new ClientInitializationError(
        key === "$through"
          ? `rule.${model}.read.select "$through" is reserved for a relation's link row.`
          : `rule.${model}.read.select "${key}" is declared by two extensions of the chain.`,
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
   * A declared projection key (K5): `true` reports every declared name, a
   * list the names it gives, in declared order, one boolean per name.
   * Admission refused any other value.
   */
  function projectEvidence(
    evidence: DeclaredEvidence,
    name: string,
    selection: unknown,
    fields: Record<string, Shape | Leaf>,
    prepared: PreparedProjectionField[]
  ): void {
    const names =
      selection === true
        ? evidence.names
        : evidence.names.filter(([held]) =>
            (selection as readonly string[]).includes(held)
          );
    fields[name] = freeze({
      kind: "object",
      nullable: false,
      fields: freeze(
        Object.fromEntries(names.map(([held]) => [held, BOOLEAN_LEAF]))
      ),
    });
    prepared.push(freeze({ kind: "evidence", name, evidence, names }));
  }
  const projection = {
    /**
     * A projection key's value, or whether a gated field's row carries it, on
     * the row at `alias` (`taken`: a row the domain already took).
     */
    lower(
      q: SqlQueries,
      model: AnyModel,
      field: Extract<PreparedProjectionField, { kind: "evidence" | "gate" }>,
      alias: string | undefined,
      taken: boolean
    ): Sql {
      return field.kind === "evidence"
        ? evidence(q, model, field, alias, taken)
        : q.truth(gateHolds(q, model, field.gate, alias, taken));
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
      if (!projection.projected(model)?.gates.size) return undefined;
      const a = q.adapter;
      const inner = q.alias();
      return assembleAdapterSelect(a, {
        columns: listed(
          q.schema
            .storedFields(model)
            .map((field) =>
              a.identifiers.aliased(
                guarded(q, model, field, q.column(model, field, inner), inner),
                q.columnName(model, field)
              )
            )
        ),
        from: q.table(model, inner),
        where: q.lowerWhere(model, where, inner),
      });
    },
    /** What a rule hides of a row read: its gates read as `q` reads a boolean. */
    gatedDocument(
      q: Queries,
      carried: boolean,
      shape: Extract<ProjectionShape, { kind: "object" }>,
      fields: readonly string[],
      readers: readonly Reader[],
      columns?: readonly string[]
    ): Reader {
      return gatedDocument(
        q.compileReader(BOOLEAN_LEAF, false, carried),
        shape,
        fields,
        readers,
        columns
      );
    },
    guarded,
    /**
     * A call's arguments admitted with the projection keys this domain
     * declares kept beside the schema's.
     */
    admit(
      schema: EngineSchema,
      model: AnyModel,
      operation: Admitted,
      raw: unknown
    ): Arguments {
      return admitProjected(this, schema, model, operation, raw);
    },
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
      const gates = projection.projected(model)?.gates;
      const gated = gates && fields.find((field) => gates.has(field));
      const name = model["~"].names.ts;
      if (gated !== undefined)
        throw new UnsupportedOperationError(
          `Cannot ${use} $through.${gated} of relation '${edge.name}': this client gates that field of '${name}'. Read it through the '${name}' delegate.`
        );
    },
    refuseGatedRows(model: AnyModel): void {
      refuseGatedRows(projection.projected(model), model["~"].names.ts!);
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
    /** `model`'s projection keys and read-gated fields; `undefined` for none. */
    projected(model: AnyModel): ProjectedFacts | undefined {
      const name = model["~"].names.ts!;
      const projected = memo(projectedBy, name, () => {
        const keys = new Map<string, DeclaredEvidence>();
        const gates = new Map<string, FieldGate>();
        for (const [layer, verbs] of (
          domain.rows.verbs?.get(name) ?? []
        ).entries()) {
          if (verbs === undefined) continue;
          const { as, facts } = verbs;
          const read = verbs.shown ?? verbs.read ?? ALL;
          if (as !== undefined)
            keys.set(as, freeze({ layer, read, names: [...facts!] }));
          for (const [field, input] of verbs.reads ?? [])
            gates.set(field, [
              ...(gates.get(field) ?? []),
              freeze([layer, read, input] as const),
            ]);
        }
        const known: FieldGate[] = [];
        for (const [field, gate] of gates)
          gates.set(field, sharedGate(freeze(gate), known));
        return keys.size === 0 && gates.size === 0
          ? null
          : freeze({ keys, gates });
      });
      return projected ?? undefined;
    },
    /**
     * What this domain adds to one projection of `model` a caller reads (K5),
     * `undefined` where it declares neither key nor gate on the model: the
     * default projections it shares, its declared keys (`key`: whether `name`
     * is one, projected), and each gate of a scalar it reads (`field`, after
     * the scalar), with the shape that says which member decides each field.
     */
    preparing(model: AnyModel, select: unknown, path: string) {
      const projected = projection.projected(model);
      if (projected === undefined) return undefined;
      const gates = gating(projected, select, path);
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
          projectEvidence(evidence, name, selection, fields, prepared);
          return true;
        },
        field: gates.field,
        shape: gates.shape,
      };
    },
  };
  return projection;
};
