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
/**
 * A failure a PLAN knows how to build, not one it owns.
 *
 * Every one of these sentences is a pure function of construction-time facts —
 * the verb and the relation name — so the plan carries the recipe and the one
 * site that actually raises it builds it. Constructing them while nothing has
 * failed ran the whole `VibORMError` constructor (two stack captures, two
 * metadata sanitisations) on the success path of every nested write, which the
 * G4 cutover diagnosis measured (`g4/cutover/perf-diagnosis.md` §4.1, cause
 * 1b). The thunk is called EXACTLY where the old value was raised or handed to
 * an assertion, so the error a caller sees is byte-identical.
 */
export type DeferredFailure = () => Error;
export type SelectionSource =
  | {
      readonly kind: "query";
      readonly where?: Input;
      /**
       * `where` was admitted as a UNIQUE selector whose shipped counterpart is
       * `buildWhereUnique`, so its addressable entries name the row through the
       * constraint (`Queries.prepareSelector`). The root verbs' lookups state
       * it themselves; for a nested write's target the one owner of the answer
       * is {@link nestedTargetAddressesConstraint}. A bulk member's `where`
       * (`updateMany` / `deleteMany`) is a filter by contract and never asks.
       * Ignored when the caller prepares `selector` itself.
       */
      readonly unique?: boolean;
      readonly selector?: PreparedSelector;
      readonly membership?: BoundMembership;
    }
  | {
      readonly kind: "producer";
      readonly where?: Input;
      readonly unique?: boolean;
      readonly selector?: PreparedSelector;
      readonly producer: Assignments;
    };

/**
 * The nested verbs that address a single target row, spelled as the case labels
 * of `RelationBody.relation`'s own switch. The type is the wiring: a nested verb
 * added to the filter family that forgets to consult the predicate below is a
 * typecheck error at its call site, not a silent "discriminator" default.
 */
export type NestedTargetVerb =
  | "connect"
  | "connectOrCreate"
  | "delete"
  | "disconnect"
  | "set"
  | "update"
  | "upsert";

/**
 * Whether a nested write's unique target selector names its row through the
 * constraint. The shipped engine answers this from the EDGE's own compiler,
 * not from the verb alone:
 *
 * - a JUNCTION target is a discriminator in both phases. Its planning probe is
 *   `buildFindUnique` (`write-engine/RelationJunctionPart.ts:1509`, `:1629`,
 *   `:1663`) and its batch statement passes the selector as `whereUnique`
 *   (`:1698`, `:2146`, `:2259`), which `JunctionStatements.ts:322-323`
 *   compiles with `buildWhereUnique` — whichever verb addressed it.
 * - a REFERENCE-held target of `disconnect` / `delete` / `update` is the one
 *   family the shipped engine recombines as `{ field: { equals: value } }`
 *   through `uniqueSelectorConjuncts` (`write-engine/shared.ts:671`, reached
 *   from `RelationWritePart.ts:987`, `UpdateOperation.ts:469` and
 *   `RecordUpdateCompiler.ts:3722`) and hands to `buildWhere`, so it is a
 *   FILTER and keeps the engine's case-sensitivity contract.
 */
export function nestedTargetAddressesConstraint(
  edge: Membership,
  verb: NestedTargetVerb
): boolean {
  return (
    edge.kind === "junction" ||
    (verb !== "disconnect" && verb !== "delete" && verb !== "update")
  );
}

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
  retained?: DeferredFailure;
  membershipOnly?: boolean;

  constructor(
    private readonly execution: CommandExecution,
    readonly model: AnyModel,
    readonly source: SelectionSource,
    readonly required?: DeferredFailure,
    facts?: SelectorFacts
  ) {
    const queries = execution.context.queries;
    this.fields = new Assignments(model, "select");
    this.selector =
      source.selector ??
      queries.prepareSelector(model, source.where, source.unique === true);
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
