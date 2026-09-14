import { NestedWriteError, UnsupportedOperationError } from "@errors";
import type { AnyModel } from "@schema/model";
import { Sql } from "@sql";
import type { SelectorFacts } from "../shared/query";
import { type Input, record } from "../shared/schema";
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

function scalarAssignment(value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    !(value instanceof Sql) &&
    "set" in value
    ? record(value).set
    : value;
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
      this.writes.set(field, literal(scalarAssignment(value)));
      if (explicit[field] !== undefined) this.requested.add(field);
    }
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
    return assignment;
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
    const value = this.writes.get(field);
    if (
      !value ||
      value.kind === "field" ||
      value.value === null ||
      typeof value.value !== "object"
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
    const a = left.kind === "literal" ? left : left.producer.known(left.field);
    const b =
      right.kind === "literal" ? right : right.producer.known(right.field);
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
