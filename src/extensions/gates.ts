/**
 * Read gates and evidence: a field a rule hides reads NULL where its row does
 * not carry it, a declared key says which rules hold of a row, and a document
 * leaves out or refuses what its gates do not hold. Declared by an extension's
 * `reads` and `evidence`; the engine lowers the predicates and decodes the rest.
 */
import { UnsupportedOperationError, ValidationError } from "@errors";
import {
  type FieldGate,
  freeze,
  type GatedMember,
  InvalidScalarResult,
  own,
  type PreparedProjectionField,
  type ProjectedFacts,
  type ProjectionShape,
  providerDocument,
  providerJson,
  type Reader,
  type ResultRefusal,
} from "@query-engine/raptor3/shared/query";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
import { gateResultKey } from "@query-engine/result-aliases";
import type { Operation } from "@query-engine/types";
import type { AnyModel } from "@schema/model";
import type { Sql } from "@sql";

/**
 * Where `input`, one of `model`'s predicates in `layer`, holds on the row
 * at `alias`, as that layer's node: R5 and R6 judge it as they judge the
 * layer's filter. `undefined` where the call drops it (it holds).
 */
function layerHolds(
  q: SqlQueries,
  model: AnyModel,
  layer: number,
  input: Input,
  alias?: string
): Sql | undefined {
  return q.lowerSelector(q.domain!.layered(model, layer, input), alias);
}
/** Where a read-gated field's row carries it: every gating layer's `read` and predicate. */
export function gateHolds(
  q: SqlQueries,
  model: AnyModel,
  gate: FieldGate,
  alias: string | undefined,
  visible: boolean
): Sql | undefined {
  const held: Sql[] = [];
  // A gate masks a value: neither a positive nor a negative test, so no
  // set it reads is bounded ({@link setBound}) and it holds where it would.
  q.unbounded(() => {
    for (const [layer, read, input] of gate) {
      const tested = input === read ? [read] : [read, input];
      for (const where of visible ? tested.slice(1) : tested) {
        const lowered = layerHolds(q, model, layer, where, alias);
        if (lowered !== undefined) held.push(lowered);
      }
    }
  });
  return held.length === 0 ? undefined : q.adapter.operators.and(...held);
}
/**
 * `column`, `model`'s `field` at `alias`, as an operand the caller wrote
 * (K5): NULL on a row that does not carry a read-gated field. Every row a
 * caller's operand is read on is one the domain takes, so `read` holds there:
 * the gate's own predicate decides.
 */
export function guarded(
  q: SqlQueries,
  model: AnyModel,
  field: string,
  column: Sql,
  alias?: string
): Sql {
  const gate = q.domain!.projected(model)?.gates.get(field);
  const holds = gate && gateHolds(q, model, gate, alias, true);
  const a = q.adapter;
  return holds === undefined
    ? column
    : a.expressions.caseWhen(
        [{ when: holds, then: column }],
        a.literals.null()
      );
}
/**
 * The selections a caller wrote, and the read-gated fields each names (K5):
 * admission marks them by identity, as `omit` and `include` desugar every
 * node into a `select` naming every scalar. A field a selection does not mark
 * is projected where its gate holds and left out elsewhere.
 */
export const namedGatedFields = new WeakMap<object, ReadonlySet<string>>();
/**
 * What read gates add to one projection of a model (K5): each gate of a
 * scalar it reads is projected once, and the shape says which member decides
 * each gated field, and which of them the caller named.
 */
export function gating(
  projected: ProjectedFacts,
  select: unknown,
  path: string
) {
  const named =
    select === undefined ? undefined : namedGatedFields.get(select as object);
  const gated: Record<string, GatedMember> = {};
  const gates = new Map<FieldGate, string>();
  return {
    field(name: string, prepared: PreparedProjectionField[]): void {
      const gate = projected.gates.get(name);
      if (gate === undefined) return;
      let member = gates.get(gate);
      if (member === undefined) {
        member = gateResultKey(gates.size);
        gates.set(gate, member);
        prepared.push(freeze({ kind: "gate", name: member, gate }));
      }
      gated[name] = named?.has(name)
        ? freeze({ gate: member, refused: `${path}select.${name}` })
        : freeze({ gate: member });
    },
    shape: () =>
      gates.size > 0
        ? { gated: freeze(gated), gates: freeze([...gates.values()]) }
        : undefined,
  };
}
/**
 * A row the read returned lacks the gate of a field the caller named (K5,
 * OD-5): raised while decoding, after the statement and before any result.
 */
export class GatedFieldRefusal extends Error implements ResultRefusal {
  readonly path: string;
  constructor(path: string) {
    super(`The selected field at '${path}' is not readable on a returned row`);
    this.path = path;
  }
  /** The `ValidationError` of `operation`, at the path the caller named. */
  refusal(operation: Operation, model: string): ValidationError {
    return new ValidationError(
      operation,
      [{ path: this.path, message: "is not readable on a returned row" }],
      { meta: { model } }
    );
  }
}
/** `$rows()` hands a caller the table's columns as they are: refused where a field of them is read-gated. */
export function refuseGatedRows(
  projected: ProjectedFacts | undefined,
  model: string
): void {
  if (projected !== undefined && projected.gates.size > 0)
    throw new UnsupportedOperationError(
      `${model}.$rows() refuses read-gated fields: ${[...projected.gates.keys()]}`
    );
}
/**
 * A declared projection key's value on the row at `alias` (K5): the
 * layer's `read` once, around one test per name. Ordered, the last name
 * that holds; else a document of one boolean per name.
 */
export function evidence(
  q: SqlQueries,
  model: AnyModel,
  field: Extract<PreparedProjectionField, { kind: "evidence" }>,
  alias: string | undefined,
  taken: boolean
): Sql {
  const a = q.adapter;
  const { layer, read, ordered } = field.evidence;
  const visible = taken ? undefined : layerHolds(q, model, layer, read, alias);
  const test = (input: Input) =>
    input === read ? undefined : layerHolds(q, model, layer, input, alias);
  if (ordered) {
    const highest = a.expressions.caseWhen(
      [...field.names].reverse().map(([name, input]) => ({
        when: test(input) ?? a.literals.true(),
        then: a.expressions.cast(q.value(name), "text"),
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
    field.names.map(([name, input]) => [name, q.truth(test(input))])
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
 * A document with read-gated members (K5), out of line from the plain
 * reader: its gates are read first, once per row, and each gated member is
 * written only where its gate holds; where it does not, a member the caller
 * named fails the read, and any other is left out (the row's shape
 * changes, so the document is always a new object).
 */
export function gatedDocument(
  readGate: Reader,
  shape: Extract<ProjectionShape, { kind: "object" }>,
  fields: readonly string[],
  readers: readonly Reader[],
  columns?: readonly string[]
): Reader {
  const gates = shape.gates!;
  const gated = fields.map((field) => shape.gated![field]);
  const gateIndex = gated.map((member) =>
    member === undefined ? -1 : gates.indexOf(member.gate)
  );
  const positions = columns && [
    ...fields.map((field) => columns.lastIndexOf(field)),
    ...gates.map((gate) => columns.lastIndexOf(gate)),
  ];
  const cell = (source: unknown, index: number, key: string): unknown => {
    if (positions === undefined) return own(source as Input, key);
    const position = positions[index]!;
    return position < 0 ? undefined : (source as unknown[])[position];
  };
  return (value) => {
    let source: unknown = value;
    if (positions) {
      if (!Array.isArray(value))
        throw new InvalidScalarResult(
          "row",
          "a positional row is not an array"
        );
    } else {
      source = providerDocument(providerJson(value));
      if (source === null) {
        if (shape.nullable === false)
          throw new InvalidScalarResult(
            "row",
            "a document the statement always builds is null"
          );
        return null;
      }
      if (source === undefined)
        throw new InvalidScalarResult(
          "row",
          "a requested document is not a provider row"
        );
    }
    const held = gates.map((gate, index) =>
      readGate(cell(source, fields.length + index, gate))
    );
    const document: Input = {};
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index]!;
      const gate = gateIndex[index]!;
      if (gate >= 0 && held[gate] !== true) {
        const refused = gated[index]!.refused;
        if (refused !== undefined) throw new GatedFieldRefusal(refused);
        continue;
      }
      document[field] = readers[index]!(cell(source, index, field));
    }
    return document;
  };
}
