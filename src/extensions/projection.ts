/**
 * What a read carries beside its rows and what it hides of them, for one
 * prepared domain: the verbs' projection keys (`evidence`) and read-gated
 * fields (`reads`). Made by what reads the verbs (`verbs.ts`), only for a
 * domain whose models may declare either.
 */
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
  type Shape,
} from "@query-engine/raptor3/shared/query";
import {
  type Arguments,
  type EngineSchema,
  type Input,
  memo,
} from "@query-engine/raptor3/shared/schema";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import type { Operation } from "@query-engine/types";
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

export class Projection {
  readonly #domain: PreparedDomain;
  readonly #facts = new Map<string, ProjectedFacts | null>();
  readonly #layered = new Map<string, Map<Input, PreparedSelector>>();
  /**
   * The default projections of the models this domain projects facts for:
   * theirs differ from the view's shared ones, which carry no gate.
   */
  readonly defaultProjections = new WeakMap<AnyModel, PreparedProjection>();
  constructor(domain: PreparedDomain) {
    this.#domain = domain;
  }
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
  }
  /** What a rule hides of a row read. */
  readonly gatedDocument = gatedDocument;
  readonly gating = gating;
  readonly guarded = guarded;
  /**
   * A call's arguments admitted with the projection keys this domain
   * declares kept beside the schema's.
   */
  admit(
    schema: EngineSchema,
    model: AnyModel,
    operation: Operation,
    raw: unknown,
    admit: (raw: unknown) => Arguments
  ): Arguments {
    return admitProjected(this, schema, model, operation, raw, admit);
  }
  refuseGatedRows(model: AnyModel): void {
    refuseGatedRows(this.projected(model), model["~"].names.ts!);
  }
  /** `input`, one of `model`'s predicates in `layer`, as that layer's node. */
  layered(model: AnyModel, layer: number, input: Input): PreparedSelector {
    const name = model["~"].names.ts!;
    const inputs = memo(this.#layered, `${name} ${layer}`, () => new Map());
    return memo(
      inputs,
      input,
      () => this.#domain.conjunction(model, [[layer, [input]]])!
    );
  }
  /** `model`'s projection keys and read-gated fields; `undefined` for none. */
  projected(model: AnyModel): ProjectedFacts | undefined {
    const name = model["~"].names.ts!;
    const facts = memo(this.#facts, name, () => {
      const keys = new Map<string, DeclaredEvidence>();
      const gates = new Map<string, FieldGate>();
      for (const [layer, verbs] of (
        this.#domain.rows.verbs?.get(name) ?? []
      ).entries()) {
        if (verbs === undefined) continue;
        const { evidence, read } = verbs;
        if (evidence)
          keys.set(
            evidence.as,
            freeze({
              layer,
              read,
              names: evidence.names,
              ordered: evidence.ordered,
            })
          );
        for (const [field, input] of verbs.reads)
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
    return facts ?? undefined;
  }
  /**
   * A declared projection key (K5): `true` reports every declared name, a
   * list the names it gives, in declared order. Admission refused any other
   * value. With `ordered`, the last name that holds, `null` where `read` does
   * not; else one boolean per name.
   */
  projectEvidence(
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
    fields[name] = evidence.ordered
      ? freeze({
          kind: "scalar",
          type: "enum",
          nullable: true,
          enumValues: new Set(names.map(([held]) => held)),
        })
      : freeze({
          kind: "object",
          nullable: false,
          fields: freeze(
            Object.fromEntries(names.map(([held]) => [held, BOOLEAN_LEAF]))
          ),
        });
    prepared.push(freeze({ kind: "evidence", name, evidence, names }));
  }
}
