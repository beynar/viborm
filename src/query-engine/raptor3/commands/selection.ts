import type { AnyModel } from "@schema/model";
import type { SelectorFacts } from "../shared/query";
import type { Input } from "../shared/schema";
import type { Membership } from "../shared/storage";
import { storedFields } from "../shared/storage";
import { Assignments, type Origin } from "./assignments";
import type { CommandExecution } from "./execution";

export interface BoundMembership {
  readonly edge: Membership;
  readonly parent: Assignments;
}
export type SelectionSource =
  | {
      readonly kind: "query";
      readonly where?: Input;
      readonly membership?: BoundMembership;
    }
  | {
      readonly kind: "producer";
      readonly where?: Input;
      readonly producer: Assignments;
    };

export function membershipFields(edge: Membership): string[] {
  return edge.kind === "reference"
    ? [
        ...edge.pairs.map((pair) => pair.source),
        ...(edge.discriminator?.side === "source"
          ? [edge.discriminator.field]
          : []),
      ]
    : edge.sourceSide.members.map((pair) => pair.referencedField);
}

/** A prepared row selection; observations and transport values belong to execution. */
export class Selection {
  readonly kind = "lookup";
  readonly fields: Assignments;
  readonly facts: SelectorFacts;
  origin?: Origin;
  retained?: Error;
  membershipOnly?: boolean;

  constructor(
    private readonly execution: CommandExecution,
    readonly model: AnyModel,
    readonly source: SelectionSource,
    readonly required?: Error,
    facts?: SelectorFacts
  ) {
    this.fields = new Assignments(model, "select");
    this.facts =
      facts ?? execution.context.queries.selectorFacts(model, source.where);
  }
  membership() {
    return this.source.kind === "query" ? this.source.membership : undefined;
  }
  private bindMembership(membership: BoundMembership | undefined) {
    return (
      membership && {
        edge: membership.edge,
        parent: this.execution.attempt.select(
          membership.parent,
          membershipFields(membership.edge)
        ),
      }
    );
  }
  private capturedWhere(condition: Selection): Input {
    return {
      AND: [condition.source.where ?? {}, this.execution.identity(this.fields)],
    };
  }
  private rowQuery(
    where: Input | undefined,
    membership: BoundMembership | undefined
  ) {
    const ctx = this.execution.context;
    return ctx.queries.select(
      this.model,
      {
        where,
        take: 1,
        select: Object.fromEntries(
          storedFields(ctx.schema, this.model).map((field) => [field, true])
        ),
      },
      this.bindMembership(membership),
      { forUpdate: !ctx.usesBatch }
    );
  }
  inspectMembership(membership: BoundMembership) {
    return this.rowQuery(this.capturedWhere(this), membership);
  }
  query() {
    const where =
      this.source.kind === "producer"
        ? {
            AND: [
              this.source.where ?? {},
              this.execution.identity(this.source.producer),
            ],
          }
        : this.source.where;
    return this.rowQuery(where, this.membership());
  }
  captured(
    condition: Selection = this,
    membership: BoundMembership | undefined = condition.membership(),
    take?: 1
  ) {
    const ctx = this.execution.context;
    return ctx.queries.select(
      this.model,
      {
        where: this.capturedWhere(condition),
        select: Object.fromEntries(
          ctx.schema.keys(this.model).map((field) => [field, true])
        ),
        take,
      },
      this.bindMembership(membership)
    );
  }
}
