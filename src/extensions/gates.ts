/**
 * What a read of gated fields leaves to decoding: the fields a caller named,
 * marked at admission, and the document that leaves out or refuses what its
 * gates do not hold (K5). The engine decodes; `projection.ts` lowers.
 */
import { ValidationError } from "@errors";
import {
  BOOLEAN_LEAF,
  InvalidScalarResult,
  own,
  type ProjectionShape,
  providerDocument,
  providerJson,
  type Queries,
  type Reader,
  type ResultRefusal,
} from "@query-engine/raptor3/shared/query";
import type { Input } from "@query-engine/raptor3/shared/schema";
import type { Operation } from "@query-engine/types";

/**
 * The selections a caller wrote, and the read-gated fields each names (K5):
 * admission marks them by identity, as `omit` and `include` desugar every
 * node into a `select` naming every scalar. A field a selection does not mark
 * is projected where its gate holds and left out elsewhere.
 */
export const namedGatedFields = new WeakMap<object, ReadonlySet<string>>();
const UNREADABLE = "is not readable on a returned row";
/**
 * A row the read returned lacks the gate of a field the caller named (K5,
 * OD-5): raised while decoding, after the statement and before any result.
 */
export class GatedFieldRefusal extends Error implements ResultRefusal {
  readonly path: string;
  constructor(path: string) {
    super(`The selected field at '${path}' ${UNREADABLE}`);
    this.path = path;
  }
  /** The `ValidationError` of `operation`, at the path the caller named. */
  refusal(operation: Operation, model: string): ValidationError {
    return new ValidationError(
      operation,
      [{ path: this.path, message: UNREADABLE }],
      { meta: { model } }
    );
  }
}
/**
 * A document with read-gated members (K5), out of line from the plain
 * reader: its gates are read first, once per row, and each gated member is
 * written only where its gate holds; where it does not, a member the caller
 * named fails the read, and any other is left out (the row's shape
 * changes, so the document is always a new object).
 */
export function gatedDocument(
  q: Queries,
  carried: boolean,
  shape: Extract<ProjectionShape, { kind: "object" }>,
  fields: readonly string[],
  readers: readonly Reader[],
  columns?: readonly string[]
): Reader {
  // Its gates read as `q` reads a boolean.
  const readGate = q.compileReader(BOOLEAN_LEAF, false, carried);
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
    // Without columns a source row is a record, with them an array of cells.
    if (positions === undefined) return own(source as Input, key);
    // A column the statement does not carry is at -1, where no row has a cell.
    return (source as unknown[])[positions[index]!];
  };
  return (value) => {
    let source: unknown = value;
    // A positional row is an array: its driver asserted it. Only the count
    // carrier is never null, and it carries no gate.
    if (!positions) {
      source = providerDocument(providerJson(value));
      if (source === null) return null;
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
