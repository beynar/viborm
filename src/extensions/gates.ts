/**
 * Read gates and evidence: a field a rule hides reads NULL where its row does
 * not carry it, a declared key says which rules hold of a row, and a document
 * leaves out or refuses what its gates do not hold. Declared by an extension's
 * `reads` and `evidence`; the engine lowers the predicates and decodes the rest.
 */
import {
  type FieldGate,
  GatedFieldRefusal,
  InvalidScalarResult,
  own,
  type PreparedProjectionField,
  type ProjectionShape,
  providerDocument,
  providerJson,
  type Reader,
} from "@query-engine/raptor3/shared/query";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { SqlQueries } from "@query-engine/raptor3/shared/sql-queries";
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
