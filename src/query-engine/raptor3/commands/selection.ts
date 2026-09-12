import type { AnyModel } from "@schema/model";
import type {
  PreparedProjection,
  PreparedSelector,
  SelectorFacts,
} from "../shared/query";
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
      readonly selector?: PreparedSelector;
      readonly membership?: BoundMembership;
    }
  | {
      readonly kind: "producer";
      readonly where?: Input;
      readonly selector?: PreparedSelector;
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
  readonly selector: PreparedSelector;
  private readonly rowProjection: PreparedProjection;
  private readonly identityProjection: PreparedProjection;
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
    const queries = execution.context.queries;
    this.fields = new Assignments(model, "select");
    this.selector =
      source.selector ?? queries.prepareSelector(model, source.where);
    this.facts = facts ?? queries.selectorFacts(this.selector);
    this.rowProjection = queries.prepareProjection(model, {
      select: Object.fromEntries(
        storedFields(execution.context.schema, model).map((field) => [
          field,
          true,
        ]),
      ),
    });
    this.identityProjection = queries.prepareProjection(model, {
      select: Object.fromEntries(
        execution.context.schema.keys(model).map((field) => [field, true]),
      ),
    });
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
  private rowQuery(
    selector: PreparedSelector,
    membership: BoundMembership | undefined,
    identity?: Input,
  ) {
    const ctx = this.execution.context;
    return ctx.queries.select(
      this.model,
      {
        take: 1,
      },
      this.bindMembership(membership),
      {
        forUpdate: !ctx.usesBatch,
        identity,
        projection: this.rowProjection,
        selector,
      },
    );
  }
  inspectMembership(membership: BoundMembership) {
    return this.rowQuery(
      this.selector,
      membership,
      this.execution.identity(this.fields),
    );
  }
  query() {
    const identity =
      this.source.kind === "producer"
        ? this.execution.identity(this.source.producer)
        : undefined;
    return this.rowQuery(this.selector, this.membership(), identity);
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
        take,
      },
      this.bindMembership(membership),
      {
        identity: this.execution.identity(this.fields),
        projection: this.identityProjection,
        selector: condition.selector,
      },
    );
  }
}
