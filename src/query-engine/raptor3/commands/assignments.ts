import { NestedWriteError, UnsupportedOperationError } from "@errors";
import type { AnyModel } from "@schema/model";
import { type SelectorFacts, wholeValue } from "../shared/query";
import type { Input } from "../shared/schema";
import type { Membership } from "../shared/storage";

export type Origin = {
  relation: string;
  operation: string;
  order: number;
  slot?: string;
};
export type MembershipContribution = {
  origin: Origin;
  scope: Membership["scope"];
  identity?: SelectorFacts;
};
export type FieldValue = (
  | { kind: "literal"; value: unknown }
  | { kind: "field"; producer: Assignments; field: string }
) & { membership?: MembershipContribution };

function literal(value: unknown): FieldValue {
  return { kind: "literal", value };
}

/** One row's requested final fields and exact symbolic consumers. */
export class Assignments {
  readonly demands = new Set<string>();
  private readonly writes = new Map<string, FieldValue>();
  private readonly requested = new Set<string>();
  private refusal?: Error;
  constructor(
    readonly model: AnyModel,
    readonly operation: "create" | "update" | "select",
    values: Input = {},
    explicit: Input = values,
    readonly captured?: Assignments,
    private readonly forwarded: Assignments[] = [],
    readonly deferred = false
  ) {
    for (const [field, value] of Object.entries(values)) {
      this.writes.set(field, literal(value));
      if (explicit[field] !== undefined) this.requested.add(field);
    }
  }
  /**
   * The VALUE a stored payload names, or `undefined` when it names an
   * OPERATION instead (`{ increment: 2 }`).
   *
   * `Assignments` stores the ADMITTED payload verbatim — that payload is what
   * the row's own write submits, and `Queries.prepareUpdate` is its ONE
   * interpreter. Reading the value out of the update envelope is a question
   * only the key-reconciliation readers ask ("which value will this key
   * hold?"), so the answer is computed HERE, lazily, and never written back:
   * unwrapping at storage time made `prepareUpdate` interpret a second time,
   * which is `Unknown update operation: z` for a JSON document and a silent
   * rewrite for a document that carries its own `set` key.
   *
   * The envelope exists only in the UPDATE language. A create's payload is
   * already the value, so a created document spelled `{ set: … }` is that
   * document and nothing is unwrapped.
   */
  private named(assignment: FieldValue): FieldValue | undefined {
    if (assignment.kind !== "literal" || this.operation !== "update")
      return assignment;
    const whole = wholeValue(assignment.value);
    return whole ? { ...assignment, value: whole.value } : undefined;
  }
  /**
   * What this field will hold, as far as the payload states it: the named
   * value when there is one, and otherwise the payload itself — an operator's
   * result is not knowable before the provider computes it, and the reader
   * that consumes this one keeps the shipped behaviour for that shape.
   */
  stated(field: string): FieldValue | undefined {
    const assignment = this.writes.get(field);
    if (assignment === undefined) return undefined;
    return this.named(assignment) ?? assignment;
  }
  field(field: string): FieldValue {
    this.demands.add(field);
    for (const producer of this.forwarded) producer.field(field);
    return { kind: "field", producer: this, field };
  }
  forward(producer: Assignments): void {
    this.forwarded.push(producer);
    for (const field of this.demands) producer.field(field);
  }
  known(field: string): FieldValue | undefined {
    const assignment = this.writes.get(field);
    if (assignment?.kind === "field")
      return assignment.producer.known(assignment.field);
    return assignment && this.named(assignment);
  }
  writesField(field: string): boolean {
    return this.writes.has(field);
  }
  contribute(
    field: string,
    value: FieldValue,
    failure: string,
    membership?: MembershipContribution
  ): void {
    const previous = this.writes.get(field);
    if (previous && this.requested.has(field) && !this.equal(previous, value))
      this.reject(new UnsupportedOperationError(failure));
    this.writes.set(field, { ...value, membership });
    this.requested.add(field);
  }
  requireLiteral(field: string, relation: string): void {
    const assignment = this.writes.get(field);
    if (!assignment || assignment.kind === "field") return;
    // The relation key must be given a VALUE. `{ set: 'x' }` names one and is
    // legal (the sentence says so); `{ increment: 1 }` names an operation the
    // relation write cannot reconcile, and a whole object is not a key.
    const value = this.named(assignment);
    if (
      value?.kind === "literal" &&
      (value.value === null || typeof value.value !== "object")
    )
      return;
    this.reject(
      new NestedWriteError(
        `Cannot update relation key field '${field}' with a non-literal operation while mutating relation '${relation}'. Use a literal value or '{ set: ... }'.`,
        relation,
        { meta: { operation: "update", field, relation } }
      )
    );
  }
  reject(failure: Error): void {
    if (!this.deferred) throw failure;
    this.refusal ??= failure;
  }
  activate(): void {
    if (this.refusal) throw this.refusal;
  }
  absorb(
    field: string,
    source: Assignments,
    referenced: string,
    failure: string
  ): void {
    const previous = this.writes.get(field);
    if (!previous) return;
    const known = source.known(referenced);
    if (
      !known ||
      known.kind !== "literal" ||
      known.value === null ||
      !this.equal(known, previous)
    )
      this.reject(new UnsupportedOperationError(failure));
    this.writes.delete(field);
    this.requested.delete(field);
  }
  writtenFields(): readonly string[] {
    return [...this.writes.keys()];
  }
  contributions(): ReadonlyMap<string, FieldValue> {
    return this.writes;
  }
  private equal(left: FieldValue, right: FieldValue): boolean {
    if (
      left.kind === "field" &&
      right.kind === "field" &&
      left.producer === right.producer &&
      left.field === right.field
    )
      return true;
    const a =
      left.kind === "literal"
        ? this.named(left)
        : left.producer.known(left.field);
    const b =
      right.kind === "literal"
        ? this.named(right)
        : right.producer.known(right.field);
    return (
      a?.kind === "literal" &&
      b?.kind === "literal" &&
      Object.is(a.value, b.value)
    );
  }
  select(fields: readonly string[]): Record<string, FieldValue> {
    return Object.fromEntries(
      fields.map((field) => [field, this.field(field)])
    );
  }
}
