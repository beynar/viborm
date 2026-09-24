import {
  NestedWriteError,
  NotFoundError,
  TransactionError,
  UnsupportedOperationError,
} from "@errors";
import type { AnyModel } from "@schema/model";
import { assertInvariant } from "../shared/invariant";
import type { OperationContext } from "../shared/operation-context";
import {
  type PreparedSelector,
  returningSafeProjection,
  type SelectorFacts,
  wholeValue,
} from "../shared/query";
import { type Arguments, entries, type Input, record } from "../shared/schema";
import { type Membership, physicalField } from "../shared/storage";
import {
  Assignments,
  type FieldValue,
  type MembershipContribution,
  type Origin,
} from "./assignments";
import { CommandExecution } from "./execution";
import { RelationBody } from "./relation-body";
import {
  type BoundMembership,
  type DeferredFailure,
  membershipFields,
  Selection,
  type SelectionSource,
} from "./selection";

export { Selection } from "./selection";

/** One operation's constructed physical form, and whether it may be one statement. */
export interface PhysicalPlan {
  /**
   * May this form reduce to ONE physical statement? It is an ADMISSIBILITY, not
   * a count: a form whose shape rules a single statement out (a locate-then-
   * mutate route, a per-row recoverable skip, a re-read after a non-RETURNING
   * write) answers `false` and opens its envelope immediately. Every other form
   * answers `true` and lets the construction itself state the count, at the one
   * place every provider round trip crosses (`OperationContext.dispatch`): a
   * second statement raises the envelope sentinel before any provider work and
   * the body is constructed again inside the region.
   */
  readonly single: boolean;
  run(): Promise<unknown>;
}

/** A bulk verb publishes rows only when the caller selected a shape. */
function bulkProjection(
  context: OperationContext,
  model: AnyModel,
  args: Arguments
) {
  return args.select
    ? context.queries.prepareProjection(model, { select: args.select })
    : undefined;
}

type Reference = Extract<Membership, { kind: "reference" }>;
type Junction = Extract<Membership, { kind: "junction" }>;

export interface RecordCommand {
  kind: "record";
  model: AnyModel;
  fields: Assignments;
  body: CommandOccurrence[];
  transitions: Reference[];
  located?: Selection;
  requirement?: MembershipRequirement;
  operation?: string;
  origin?: Origin;
  suppression?: { readonly kind: "skipDuplicate" };
}
export interface RecordSeriesCommand {
  readonly kind: "series";
  readonly records: CommandOccurrence<RecordCommand>[];
  readonly select?: Input;
}
export interface MembershipRequirement {
  readonly selection: Selection;
  readonly membership: BoundMembership;
  readonly failure: DeferredFailure;
}
export interface JunctionCapture {
  readonly kind: "junction";
  readonly edge: Junction;
  /**
   * The located row this capture waits for. A capture whose junction values are
   * the member's OWN spelled key waits for nothing: it addresses the slot
   * directly, which is the shipped transfer's `values` address
   * (`write-engine/junction-singular-transfer.ts`, `JunctionTransferAddress`).
   */
  readonly address?: Selection;
  readonly values: Record<string, FieldValue>;
  readonly final: Assignments;
}
export interface AbsenceRequirement {
  readonly kind: "absent";
  readonly model: AnyModel;
  readonly membership: BoundMembership;
  readonly excluding: Assignments[];
  readonly failure: DeferredFailure;
}
export interface Condition {
  readonly lookup: Selection;
  readonly match: Error;
  readonly skip: Error;
}
export interface Choose {
  kind: "choose";
  model: AnyModel;
  fields: Assignments;
  lookup: Selection;
  foundRequirement?: MembershipRequirement;
  operation?: string;
  missing?: CommandOccurrence<RecordCommand>;
  found?: CommandOccurrence<RecordCommand>;
  conditions?: {
    probes: Condition[];
    missingRow: Error;
    /**
     * The failure the found arm's ONE confirmation raises when it answers no
     * row (`CommandExecution.confirmFound`). That confirmation proves the
     * CONJUNCTION of the probes that matched, so what it loses is that single
     * premise: where several conditions were conjoined the sentence says a
     * MATCHED REQUIREMENT changed and names them as a SET, because a
     * conjunction has no first term to blame. With ONE condition the premise
     * IS that condition, and so is this ({@link Condition.match}).
     */
    matched: Error;
  };
}
export interface Link {
  kind: "link";
  edge: Junction;
  values: Record<string, FieldValue>;
  captured?: JunctionCapture;
  removals?: (Removal & { edge: Junction })[];
  /** The mutation this link is an effect of (its placement's origin, kept). */
  origin?: Origin;
}
export interface Removal {
  kind: "remove";
  edge: Membership;
  source?: Assignments;
  target?: Assignments;
  keep: Assignments[];
  /** The mutation this removal is an effect of (its placement's origin, kept). */
  origin?: Origin;
}
export interface Deletion {
  kind: "delete";
  located: Selection;
  origin: Origin;
}
/**
 * The one sentence for a membership the plan observed and a race changed
 * (Arnaud's D-32): a member added to, or removed from, a captured set after
 * the plan-time read. Raceable — the unit aborts at the premise, which is
 * asserted where the observation was taken, before any write of the unit,
 * and the operation re-plans once from the admitted values against the set
 * the race produced.
 */
export function membershipRaceFailure(
  verb: string,
  edge: string,
  change: "added" | "removed"
): NestedWriteError {
  const failure = new NestedWriteError(
    `Cannot ${verb} relation '${edge}': a member was ${change} after the plan-time read; retry to converge.`,
    edge
  );
  failure.meta.raceable = true;
  return failure;
}
/**
 * A nested set mutation: the ONE correlated statement a nested
 * `updateMany`/`deleteMany` needs when its physical form expresses the whole
 * operation. The membership and the member filter are both predicates the
 * provider evaluates at this statement's own position in the body, so there is
 * no planning read to go stale, nothing to capture, and nothing for the
 * dependency analyser to refuse. It is a WRITE like any other, with the
 * unknown row-set footprint the shipped `appendTarget("updateMany", unknown)`
 * registered, so a LATER read on the same model is still analysed against it.
 */
export interface SetMutation {
  readonly kind: "set";
  readonly edge: Membership;
  readonly parent: Assignments;
  readonly model: AnyModel;
  readonly selector: PreparedSelector;
  /** The admitted scalar assignments; absent names a `deleteMany`. */
  readonly values?: Input;
  readonly operation: "updateMany" | "deleteMany";
  readonly origin: Origin;
}
export interface SelectedSeries {
  readonly selection: Selection;
  readonly analysis: RecordCommand | Deletion;
  readonly limit?: number;
  /**
   * A delete series carries the ORIGIN of the mutation that spelled it: the
   * member `captureSeries` builds for each captured row is a {@link Deletion},
   * whose origin is required, and the type says here what the one construction
   * site (`RelationBody`'s `deleteMany` arm) already supplies.
   */
  readonly mutation:
    | { readonly kind: "update"; readonly raw: Input }
    | { readonly kind: "delete"; readonly origin: Origin };
}
export type SelectedSeriesMember = RecordCommand | Deletion;
export interface SeriesOccurrence {
  readonly kind: "selectedSeries";
  readonly series: SelectedSeries;
  readonly template: CommandOccurrence<RecordCommand | Deletion>;
}
export interface SeriesCapture {
  readonly kind: "captureSeries";
  readonly target: CommandOccurrence<SeriesOccurrence>;
}
export interface MembershipMutation {
  readonly kind: "membership";
}
export type Placement = "root" | "before" | "capture" | "after";
export interface CommandOccurrence<C extends Command = Command> {
  readonly kind: "occurrence";
  readonly command: C;
  /** Mutable for one reason: a dependent read moves to its execution point (N1). */
  placement: Placement;
  children: CommandOccurrence[];
  role?: "found" | "missing" | "template" | "member";
  captureTarget?: CommandOccurrence<SeriesOccurrence>;
  parent?: CommandOccurrence;
  dependencyRead?: DependencyRead;
  refusal?: Error;
}
export interface MembershipPublication {
  readonly carrier: Assignments;
  readonly identity?: SelectorFacts;
  readonly contribution: MembershipContribution;
}
export interface DependencyRead {
  readonly occurrence: CommandOccurrence;
  readonly lookup: Selection;
  readonly owner: CommandOccurrence<RecordCommand>;
  readonly membership?: BoundMembership;
  readonly target: boolean;
}
interface DependencyWrite {
  readonly occurrence: CommandOccurrence;
  readonly command?: RecordCommand | Deletion | Link | Removal | SetMutation;
  readonly membership?: MembershipPublication;
}
interface BranchPath {
  readonly parent?: BranchPath;
  readonly choice: CommandOccurrence;
  readonly arm: "found" | "missing";
}
interface ReadVisit {
  readonly read: DependencyRead;
  readonly branch?: BranchPath;
}
interface WriteVisit {
  readonly write: DependencyWrite;
  readonly branch?: BranchPath;
}
interface SeriesRefusal {
  readonly error: Error;
  readonly member: SelectedSeriesMember;
}
export type Command = (
  | RecordCommand
  | Selection
  | JunctionCapture
  | AbsenceRequirement
  | Choose
  | Link
  | Removal
  | Deletion
  | SetMutation
  | RecordSeriesCommand
  | SeriesCapture
  | SeriesOccurrence
  | MembershipMutation
) & { membershipPublications?: MembershipPublication[] };

export function isRecordOccurrence(
  occurrence: CommandOccurrence
): occurrence is CommandOccurrence<RecordCommand> {
  return occurrence.command.kind === "record";
}
export function isSeriesOccurrence(
  occurrence: CommandOccurrence
): occurrence is CommandOccurrence<SeriesOccurrence> {
  return occurrence.command.kind === "selectedSeries";
}

/** Construction owns branch order; every storage consumer names exact produced fields. */
export class Commands {
  private nextMutation = 0;
  readonly execution: CommandExecution;
  constructor(readonly context: OperationContext) {
    this.execution = new CommandExecution(this);
  }

  create(
    model: AnyModel,
    admitted: Input,
    raw: Input = admitted,
    incoming?: { edge: Reference; source: Assignments },
    operation = "create",
    deferred = false
  ): RecordCommand {
    const command: RecordCommand = {
      kind: "record",
      model,
      operation,
      body: [],
      transitions: [],
      fields: new Assignments(
        model,
        "create",
        this.context.schema.scalars(model, admitted),
        raw,
        undefined,
        [],
        deferred
      ),
    };
    if (incoming)
      this.assignMembership(incoming.edge, command.fields, incoming.source);
    this.relations(command, admitted, raw);
    return command;
  }
  update(
    located: Selection,
    admitted: Input,
    raw: Input,
    deferred = false
  ): RecordCommand {
    const model = located.model;
    const command: RecordCommand = {
      kind: "record",
      model,
      located,
      body: [],
      transitions: [],
      fields: new Assignments(
        model,
        "update",
        this.context.schema.scalars(model, admitted),
        raw,
        located.fields,
        undefined,
        deferred
      ),
    };
    for (const field of this.context.schema.keys(model))
      located.fields.field(field);
    this.relations(command, admitted, raw);
    return command;
  }
  private relations(parent: RecordCommand, admitted: Input, raw: Input): void {
    for (const name of parent.model["~"].relationNames) {
      if (admitted[name] === undefined) continue;
      new RelationBody(
        this,
        parent,
        this.context.schema.index.get(parent.model)!.get(name)!,
        record(admitted[name]),
        record(raw[name])
      ).expand();
    }
  }
  createOrigin(relation: string, operation: string, slot = relation): Origin {
    return { relation, operation, slot, order: this.nextMutation++ };
  }
  occurrence<C extends Command>(
    command: C,
    placement: Placement = "root"
  ): CommandOccurrence<C> {
    const occurrence: CommandOccurrence<C> = {
      kind: "occurrence",
      command,
      placement,
      children: [],
    };
    return occurrence;
  }
  place<C extends Command>(
    parent: RecordCommand,
    command: C,
    placement: Exclude<Placement, "root">,
    origin = this.origin(command)
  ): CommandOccurrence<C> {
    const occurrence = this.occurrence(command, placement);
    const semanticOrder = origin?.order ?? -1;
    const placementOrder = (value: Placement) =>
      value === "before" ? 0 : value === "capture" ? 1 : 2;
    const following = parent.body.findIndex((candidate) => {
      const candidateOrder = this.origin(candidate.command)?.order ?? -1;
      return (
        candidateOrder > semanticOrder ||
        (candidateOrder === semanticOrder &&
          placementOrder(candidate.placement) > placementOrder(placement))
      );
    });
    parent.body.splice(
      following < 0 ? parent.body.length : following,
      0,
      occurrence
    );
    return occurrence;
  }
  private recipeChildren(command: Command): readonly CommandOccurrence[] {
    if (command.kind === "record") return command.body;
    if (command.kind === "choose")
      return [command.found, command.missing].filter(
        (arm): arm is CommandOccurrence<RecordCommand> => arm !== undefined
      );
    if (command.kind === "series") return command.records;
    if (command.kind === "selectedSeries") return [command.template];
    return [];
  }
  private materializePlacement(occurrence: CommandOccurrence): void {
    const role = (
      parent: Command,
      child: CommandOccurrence
    ): CommandOccurrence["role"] => {
      if (parent.kind === "choose")
        return child === parent.found ? "found" : "missing";
      if (parent.kind === "selectedSeries") return "template";
      return undefined;
    };
    const sources = this.recipeChildren(occurrence.command);
    const replacements = new Map<CommandOccurrence, CommandOccurrence>();
    occurrence.children = sources.map((source) => {
      const replacement = this.occurrence(source.command, source.placement);
      replacement.role = role(occurrence.command, source);
      replacements.set(source, replacement);
      return replacement;
    });
    for (const [source, replacement] of replacements) {
      if (source.command.kind === "captureSeries") {
        const resolved = replacements.get(source.command.target);
        // Established upstream: `requireSeriesCapture` places a capture in the
        // SAME body as the series it names, so the target is one of this
        // parent's recipe children and has a replacement here; and a
        // replacement carries its source's COMMAND, so it keeps the kind
        // `SeriesCapture.target` already states.
        assertInvariant(
          resolved && isSeriesOccurrence(resolved),
          "a series capture's target is a sibling of the capture in the same body"
        );
        replacement.captureTarget = resolved;
      }
    }
    for (const child of occurrence.children) this.materializePlacement(child);
  }
  private origin(command: Command): Origin | undefined {
    if (command.kind === "choose") return command.lookup.origin;
    if (command.kind === "captureSeries")
      return command.target.command.series.selection.origin;
    if (command.kind === "selectedSeries")
      return command.series.selection.origin;
    if (command.kind === "junction") return command.address?.origin;
    if (
      command.kind === "record" ||
      command.kind === "delete" ||
      command.kind === "set" ||
      command.kind === "lookup" ||
      command.kind === "link" ||
      command.kind === "remove"
    )
      return command.origin;
    return undefined;
  }
  /**
   * Where a membership's value is BOUND into the row that carries it, as the
   * two things that row can do with it.
   *
   * It REQUESTS the value when its own statement must point it at the target:
   * a fresh or rebound row, and a correlated choice's missing arm, which
   * creates a row only that statement can point this one at.
   *
   * It HOLDS the value when it rides on `carried`, the arm's own write: a
   * CORRELATED arm's target is the row this row's membership names, so a
   * write of the referenced key moves this row with it (`ON UPDATE CASCADE`)
   * before this row's own statement runs ({@link Assignments.hold}). A
   * SUPPLIER earlier in the same body — `connect` and its kin run before
   * `update` and `upsert` — names a different row, and then it is this row's
   * own statement that moves it and the key it was located by that addresses
   * it.
   */
  assignMembership(
    edge: Reference,
    destination: Assignments,
    producer: Assignments,
    binding: {
      readonly carried?: Assignments;
      readonly requested?: boolean;
    } = {}
  ): void {
    for (const pair of edge.pairs) {
      const field = edge.owner === "source" ? pair.source : pair.target;
      const referenced = edge.owner === "source" ? pair.target : pair.source;
      // What the consumer needs is that the producer's create SUPPLIES this
      // referenced field, not that its value is a construction-time literal.
      // A sibling `connect` on the producer supplies it from the row it
      // locates, and `known` is undefined there BY CONTRACT — the located
      // bytes are what the column holds, never the selector's literal, which
      // a case-insensitive collation can differ from — so a knowability test
      // spelled as `known` refuses a shape whose value is fixed before the
      // consumer's INSERT: the consumer reads it from the producer at its own
      // execution point, behind the lookup and behind the producer's write.
      // An explicit NULL supplies nothing, and a field the payload never
      // writes is the shape the sentence names.
      const known = producer.known(referenced);
      if (
        producer.operation === "create" &&
        (!producer.writesField(referenced) ||
          (known?.kind === "literal" && known.value === null))
      ) {
        const scalar = physicalField(
          this.context.schema,
          producer.model,
          referenced
        ).scalar["~"].state;
        if (!scalar.autoGenerate)
          destination.reject(
            new UnsupportedOperationError(
              `query-engine-v2 create cannot resolve the parent id for relation '${edge.name}': referenced field '${referenced}' is neither this record's primary key nor a knowable value in its own create data.`
            )
          );
      }
      // The one place the resolved edge is read, so the one place that can
      // say what this written component has to be able to REPRESENT: the
      // relation travels with the value, and the requirement is asked where
      // the value is known ({@link CommandExecution.stored}).
      const value: FieldValue = {
        ...producer.field(referenced),
        relation: edge.name,
      };
      if (
        binding.carried?.writesField(referenced) &&
        !destination.writesField(field)
      )
        destination.hold(field, value, binding.carried);
      if (binding.requested !== false)
        destination.contribute(
          field,
          value,
          `query-engine-v2 ${destination.operation} has conflicting final assignments for column '${this.context.queries.columnName(destination.model, field)}' on relation '${edge.name}'.`
        );
    }
    if (edge.discriminator && binding.requested !== false)
      destination.contribute(
        edge.discriminator.field,
        { kind: "literal", value: edge.discriminator.value },
        `Conflicting stored discriminator for relation '${edge.name}'.`
      );
  }
  publishMembership(
    owner: CommandOccurrence,
    carrier: Assignments,
    contribution: MembershipContribution
  ): void {
    (owner.command.membershipPublications ??= []).push({
      carrier,
      identity: contribution.identity,
      contribution,
    });
  }
  analyze<C extends RecordCommand | SeriesOccurrence | Choose>(
    command: C
  ): CommandOccurrence<C> {
    const occurrence = this.occurrence(command);
    this.materializePlacement(occurrence);
    this.bindTree(occurrence);
    this.analyzeOccurrence(occurrence);
    return occurrence;
  }
  analyzeSeries(series: SelectedSeries): CommandOccurrence<SeriesOccurrence> {
    return this.analyze(this.selectedSeries(series));
  }
  selectedSeries(series: SelectedSeries): SeriesOccurrence {
    return {
      kind: "selectedSeries",
      series,
      template: this.occurrence(series.analysis),
    };
  }
  childrenOf(occurrence: CommandOccurrence): readonly CommandOccurrence[] {
    return occurrence.children;
  }
  membershipPublications(
    occurrence: CommandOccurrence
  ): readonly MembershipPublication[] {
    return occurrence.command.membershipPublications ?? [];
  }
  choiceArm(
    occurrence: CommandOccurrence,
    arm: "found" | "missing"
  ): CommandOccurrence<RecordCommand> | undefined {
    if (occurrence.command.kind !== "choose") return undefined;
    const child = occurrence.children.find(
      (candidate) => candidate.role === arm
    );
    return child && isRecordOccurrence(child) ? child : undefined;
  }
  seriesMembers(
    occurrence: CommandOccurrence<SeriesOccurrence>
  ): CommandOccurrence<RecordCommand | Deletion>[] {
    return occurrence.children.filter(
      (child): child is CommandOccurrence<RecordCommand | Deletion> =>
        child.role === "member" &&
        (child.command.kind === "record" || child.command.kind === "delete")
    );
  }
  seriesCaptureTarget(
    occurrence: CommandOccurrence
  ): CommandOccurrence<SeriesOccurrence> {
    // Two facts an earlier owner established: the kind, by the one caller's
    // `case "captureSeries"` arm (`CommandExecution.run`), and the target, by
    // `materializePlacement`, which resolves every capture's target before
    // `analyze`/`analyzeSeries` returns the tree this reads.
    assertInvariant(
      occurrence.command.kind === "captureSeries",
      "a series capture target is read only from a capture occurrence"
    );
    const target = occurrence.captureTarget;
    assertInvariant(target, "materialization resolved this capture's target");
    return target;
  }
  private readMembership(write: DependencyWrite, read: DependencyRead): void {
    const { lookup, owner } = read;
    const membership = read.membership ?? lookup.membership();
    if (!(lookup.origin && membership)) return;
    // A membership is read through fields — the member side's foreign key,
    // the parent side's referenced key — and a record write of either, on the
    // member model or by the parent itself (a key transition, a self-held
    // foreign key), changes what the read observes: an ordered observation
    // (N1). The selector overlap `readTarget` computes does not see these
    // fields, because a membership is not part of the selector. A CREATE whose
    // known literal for a member-side field cannot be this parent's key —
    // another parent's key, or null — makes no member of this parent and is
    // disjoint; an UPDATE of a member-side key may take a member OUT of the
    // membership, so it is observed whatever it writes.
    const command = write.command;
    if (
      command?.kind === "record" &&
      (command.fields.operation === "create" ||
        command.fields.writtenFields().length > 0)
    ) {
      const edge = membership.edge;
      const parentKey = (field: string): unknown => {
        const stated = membership.parent.known(field);
        if (stated?.kind === "literal") return stated.value;
        return membership.parent === owner.command.fields
          ? owner.command.located?.facts.equals.get(field)
          : undefined;
      };
      const literal = (field: string) => {
        const stated = this.literalOf(command, field, write.occurrence);
        return stated;
      };
      let touchesMember = false;
      let disjoint = false;
      if (edge.kind === "reference" && edge.owner === "target") {
        for (const pair of edge.pairs) {
          if (!command.fields.writesField(pair.target)) continue;
          touchesMember = true;
          if (command.fields.operation !== "create") continue;
          const value = literal(pair.target);
          const key = parentKey(pair.source);
          if (
            value !== undefined &&
            (value.value === null ||
              (key !== undefined && !Object.is(value.value, key)))
          )
            disjoint = true;
        }
        const discriminator = edge.discriminator;
        if (
          discriminator?.side === "target" &&
          command.fields.writesField(discriminator.field)
        ) {
          touchesMember = true;
          if (command.fields.operation === "create") {
            const value = literal(discriminator.field);
            if (value !== undefined && value.value !== discriminator.value)
              disjoint = true;
          }
        }
      }
      const written =
        (command.model === edge.target && touchesMember && !disjoint) ||
        (command.fields === membership.parent &&
          membershipFields(edge).some((field) =>
            command.fields.writesField(field)
          ));
      if (written) {
        const origin = lookup.origin;
        const earlier = command.origin?.operation ?? command.fields.operation;
        this.depend(
          write,
          read,
          () =>
            new NestedWriteError(
              `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier '${earlier}' membership write in the same nested write. Split these operations into separate queries.`,
              origin.relation,
              {
                meta: {
                  operation: origin.operation,
                  conflictsWith: earlier,
                  dependency: "membership",
                  overlap: "unknown",
                },
              }
            )
        );
        return;
      }
    }
    if (membership.edge.kind === "junction") {
      // A junction membership changes under any link, removal or member set
      // of the same junction table, whichever side or parent wrote it (a
      // self-referential inverse is the same rows): the read is an ordered
      // observation of it (N1). The overlap is not computed finer than the
      // table — an observation costs a placement, not a refusal.
      const command = write.command;
      const table = membership.edge.table;
      const touches =
        (command?.kind === "link" ||
          command?.kind === "remove" ||
          command?.kind === "set") &&
        command.edge.kind === "junction" &&
        command.edge.table === table;
      if (!touches) return;
      const origin = lookup.origin;
      this.depend(
        write,
        read,
        () =>
          new NestedWriteError(
            `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier membership write in the same nested write. Split these operations into separate queries.`,
            origin.relation,
            {
              meta: {
                operation: origin.operation,
                dependency: "membership",
                overlap: "unknown",
              },
            }
          )
      );
      return;
    }
    const edge = membership.edge;
    const carrier = edge.owner === "source" ? edge.source : edge.target;
    const observed =
      edge.owner === "source" ? owner.command.located?.facts : lookup.facts;
    const publication = write.membership;
    if (!publication) return;
    const relation = lookup.origin.slot ?? lookup.origin.relation;
    const operation = lookup.origin.operation;
    const dependency = (earlier: string) =>
      new NestedWriteError(
        `Nested operation '${operation}' on relation '${relation}' depends on an earlier '${earlier}' membership write in the same nested write. Split these operations into separate queries.`,
        relation,
        { meta: { operation, conflictsWith: earlier, relation } }
      );
    // The same read, and the other side of it: a membership read THROUGH a
    // field an earlier arm already MOVED on this parent — the arm's target
    // update carried this row's own foreign key with it, so the key the read
    // was planned with names no member at all ({@link Assignments.hold}). The
    // record-write case above says this for a parent that WRITES the field
    // itself; a correlated arm's parent does not write it, the provider does.
    if (
      publication.carrier === membership.parent &&
      membershipFields(edge).some((field) =>
        publication.carrier.movesField(field)
      )
    ) {
      this.depend(write, read, () =>
        dependency(publication.contribution.origin.operation)
      );
      return;
    }
    if (publication.carrier.model !== carrier) return;
    const contribution = publication.contribution;
    const ownerDiffers = write.occurrence.command !== lookup;
    if (!ownerDiffers) return;
    const sameEdge = contribution.scope.edge === edge.scope.edge;
    if (!sameEdge) return;
    const sameMember =
      contribution.scope.member === undefined ||
      contribution.scope.member === edge.scope.member;
    if (!sameMember) return;
    const identity = publication.identity;
    let disjoint = false;
    if (observed && identity)
      for (const [key, value] of observed.equals) {
        const conflicts =
          !publication.carrier.writesField(key) &&
          identity.equals.has(key) &&
          !Object.is(identity.equals.get(key), value);
        if (conflicts) {
          disjoint = true;
          break;
        }
      }
    if (disjoint) return;
    this.depend(write, read, () => dependency(contribution.origin.operation));
  }
  private readTarget(write: DependencyWrite, read: DependencyRead): void {
    const { lookup } = read;
    if (
      !lookup.origin ||
      lookup.membershipOnly ||
      lookup.source.kind === "producer"
    )
      return;
    const scopes = [
      {
        model: lookup.model,
        path: [],
        fields: lookup.facts.fields,
        equals: lookup.facts.equals,
        exact: lookup.facts.exact,
      },
      ...lookup.facts.reads,
    ];
    const mutation = write.command;
    if (!mutation) return;
    for (const scope of scopes) {
      if (mutation.kind === "link" || mutation.kind === "remove") {
        const observed = scope.path.at(-1);
        const sameEdge =
          observed !== undefined &&
          observed.scope.edge === mutation.edge.scope.edge;
        if (!sameEdge) continue;
        const origin = lookup.origin;
        this.depend(
          write,
          read,
          () =>
            new NestedWriteError(
              `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier membership write in the same nested write. Split these operations into separate queries.`,
              origin.relation,
              {
                meta: {
                  operation: origin.operation,
                  conflictsWith:
                    mutation.kind === "link" ? "connect" : "disconnect",
                  dependency: "membership",
                  overlap: "unknown",
                },
              }
            )
        );
        return;
      }
      const model =
        mutation.kind === "delete" ? mutation.located.model : mutation.model;
      if (model !== scope.model) continue;
      // A set mutation names no row it wrote — the shipped footprint is
      // `unknownConstraint` (`OwnWriteSteps.ts:186-191`) — so it has no located
      // row to prove a later read of the same model disjoint from it.
      const located = mutation.kind === "set" ? undefined : mutation.located;
      if (
        mutation.kind === "record" &&
        mutation.fields.operation !== "create" &&
        !mutation.located?.membership()?.edge.many
      ) {
        let hasWrittenOverlap = false;
        for (const field of mutation.fields.writtenFields()) {
          hasWrittenOverlap = scope.fields.has(field);
          if (hasWrittenOverlap) break;
        }
        if (!hasWrittenOverlap) continue;
      }
      let matched = 0;
      let disjoint = false;
      for (const [field, expected] of scope.equals) {
        const value =
          mutation.kind === "record" && mutation.fields.operation === "create"
            ? mutation.fields.known(field)
            : undefined;
        const selected =
          located?.facts.exact &&
          !(mutation.kind === "record" && mutation.fields.writesField(field))
            ? located
            : undefined;
        const known =
          value?.kind === "literal"
            ? value.value
            : selected?.facts.equals.get(field);
        const hasKnown =
          value?.kind === "literal" || selected?.facts.equals.has(field);
        if (!(hasKnown && scope.exact)) continue;
        const equal = Object.is(known, expected);
        if (!equal) {
          disjoint = true;
          break;
        }
        matched++;
      }
      if (disjoint) continue;
      const origin = lookup.origin;
      const operation =
        mutation.kind === "set"
          ? mutation.operation
          : (mutation.origin?.operation ??
            (mutation.kind === "delete"
              ? "delete"
              : mutation.fields.operation));
      this.depend(
        write,
        read,
        () =>
          new NestedWriteError(
            `Nested operation '${origin.operation}' on relation '${origin.relation}' depends on an earlier '${operation}' target write in the same nested write. Split these operations into separate queries.`,
            origin.relation,
            {
              meta: {
                operation: origin.operation,
                conflictsWith: operation,
                dependency: "targetExistence",
                overlap:
                  scope.exact && matched > 0 && matched === scope.fields.size
                    ? "equal"
                    : "unknown",
              },
            }
          )
      );
      return;
    }
  }
  /**
   * A read whose answer an earlier write of this operation can change is an
   * ORDERED OBSERVATION (N1, the nesting plan §1): it is taken at its execution
   * point, after that write. The dependency pass keeps computing the overlap
   * fact and spends it on placement, not on a refusal.
   *
   * The write's and the read's execution points are the two children of their
   * nearest common ancestor on each path (the ancestor's OWN write when the
   * write is the ancestor's, or a membership the ancestor's fields carry), in
   * the run order of {@link CommandExecution.run}: the `before` children, the
   * ancestor's write, the captures, the `after` children, each in body order.
   * A read that already follows its write is only marked {@link Selection.dependent}
   * (the batch route reads it through the barrier). A read that would run first
   * — a `before` lookup, a capture, a parent-held choice whose subtree reads
   * what the parent's own write changes — moves to the `after` phase, to its
   * consumer's execution point: behind the write, ahead of its own mutation's
   * first effect. The one shape no order satisfies is a read the ancestor's
   * own write CONSUMES (a parent-held target's key), which keeps the inherited
   * refusal — the sentence names exactly that: an earlier write the read cannot
   * follow. The other limit is the ancestor's own EXECUTION POSITION: a
   * placement IS a position in `ancestor.children`, so it may change only
   * while that ancestor has not begun dispatching them
   * ({@link CommandExecution.started}). A series expands its members from the
   * admitted payload WHILE the operation runs (`expandSeries`), and each
   * member is a FRESH subtree whose ancestor has not started: its observations
   * are placed like any other (FC-01 — the operation-global "once members are
   * expanded nothing moves" veto refused under `updateMany` what `update`
   * executes). The limit covers the pairs an expansion makes against the
   * tree AROUND the series: the per-member analysis walks past the series to
   * the enclosing record's own write and to the siblings ahead of it, and the
   * second pass pairs a member's writes with the reads FOLLOWING the series —
   * in either the consumer may sit in a phase the enclosing record has
   * already run. In the shipped shapes that pair was already judged
   * against the template's identical write at `analyze` time, so the reader
   * moved before anything ran and this limit is not reached; it holds the
   * line if a member ever carries a write the template does not, because
   * re-placing a child of a record that is dispatching its children would
   * reorder a schedule that is already being consumed.
   */
  private depend(
    write: DependencyWrite,
    read: DependencyRead,
    refusal: () => NestedWriteError
  ): void {
    const owner = read.owner;
    // A mutation's own effects are placed behind its read by construction: a
    // junction delete's link removal, a set's clear. They are not what the
    // read depends on.
    const writeOrigin = write.command
      ? this.origin(write.command)
      : write.membership?.contribution.origin;
    if (
      writeOrigin !== undefined &&
      writeOrigin.order === read.lookup.origin?.order
    )
      return;
    const readPath = new Map<
      CommandOccurrence,
      CommandOccurrence | undefined
    >();
    for (
      let node: CommandOccurrence | undefined = this.reader(read),
        child: CommandOccurrence | undefined;
      node;
      child = node, node = node.parent
    )
      readPath.set(node, child);
    // A membership contribution executes with the record whose own write
    // carries it, wherever its publisher stands (a parent-held choice
    // publishes the parent's key for the parent's UPDATE).
    let writeAt = write.occurrence;
    if (write.membership)
      for (
        let node: CommandOccurrence | undefined = write.occurrence;
        node;
        node = node.parent
      )
        if (
          isRecordOccurrence(node) &&
          node.command.fields === write.membership.carrier
        ) {
          writeAt = node;
          break;
        }
    let ancestor: CommandOccurrence | undefined = writeAt;
    let producer: CommandOccurrence | undefined;
    while (ancestor && !readPath.has(ancestor)) {
      producer = ancestor;
      ancestor = ancestor.parent;
    }
    // `bindTree` hangs every occurrence from the operation's one root, which
    // `reader` put on the read's path, so the walk meets the path at the root
    // at the latest (N4: an invariant of the tree, not a refusal).
    assertInvariant(
      ancestor,
      "a dependency's read and write share the operation's tree"
    );
    const consumer = readPath.get(ancestor);
    // The pairing walk (`visitPrecedingWrites`) hands `depend` only a write
    // that PRECEDES the read — an ancestor's own write, or one in a sibling
    // ahead of the read's occurrence — never one inside the read's own
    // occurrence, and the early lookup or capture `reader` may stand on is a
    // leaf; so the meeting point is a proper ancestor of the reader and the
    // path records the child it came through.
    assertInvariant(consumer, "a dependency's write precedes its read");
    const follows = producer
      ? this.runsBefore(producer, consumer, ancestor)
      : consumer.placement !== "before";
    if (!follows) {
      const consumed =
        isRecordOccurrence(ancestor) &&
        (ancestor.command.fields.consumes(read.lookup.fields) ||
          (consumer.command.kind === "choose" &&
            ancestor.command.fields.consumes(consumer.command.fields)));
      if (consumed || this.execution.started(ancestor)) {
        owner.refusal ??= refusal();
        return;
      }
      // At its consumer's execution point: behind the write (behind the
      // ancestor's own write when that is the write), ahead of the first
      // `after` effect of its own or a later mutation — every effect carries
      // its mutation's origin, so the reader lands behind the whole mutation
      // of the write it depends on and ahead of the first effect that may
      // consume it.
      const children = ancestor.children;
      children.splice(children.indexOf(consumer), 1);
      consumer.placement = "after";
      const own = this.origin(consumer.command)?.order;
      const producerIndex = producer ? children.indexOf(producer) : -1;
      const landing = children.findIndex((candidate, index) => {
        if (index <= producerIndex || candidate.placement !== "after")
          return false;
        const order = this.origin(candidate.command)?.order;
        return own !== undefined && order !== undefined && order >= own;
      });
      children.splice(
        landing < 0
          ? producer
            ? producerIndex + 1
            : children.length
          : landing,
        0,
        consumer
      );
    }
    read.lookup.dependent = true;
  }
  /**
   * The literal a record write states for `field`, following a value taken
   * from another record's field (a nested create's foreign key from its
   * parent) to that record's known or located identity in the tree.
   */
  private literalOf(
    command: RecordCommand,
    field: string,
    occurrence: CommandOccurrence
  ): { readonly value: unknown } | undefined {
    const stated = command.fields.known(field);
    if (stated?.kind === "literal") return { value: stated.value };
    const assignment = command.fields.stated(field);
    if (assignment?.kind !== "field") return undefined;
    for (
      let node: CommandOccurrence | undefined = occurrence;
      node;
      node = node.parent
    ) {
      if (
        !isRecordOccurrence(node) ||
        node.command.fields !== assignment.producer
      )
        continue;
      const known = node.command.fields.known(assignment.field);
      if (known?.kind === "literal") return { value: known.value };
      const located = node.command.located?.facts;
      if (located?.exact && located.equals.has(assignment.field))
        return { value: located.equals.get(assignment.field) };
      return undefined;
    }
    return undefined;
  }
  /** The occurrence that RUNS a dependency read: its early lookup or capture when one is placed, else the read's own. */
  private reader(read: DependencyRead): CommandOccurrence {
    const owner = read.owner;
    const early = owner.children.find(
      (child) =>
        child.command === read.lookup || child.captureTarget === read.occurrence
    );
    return early ?? read.occurrence;
  }
  private runsBefore(
    first: CommandOccurrence,
    second: CommandOccurrence,
    parent: CommandOccurrence
  ): boolean {
    const phase = (occurrence: CommandOccurrence) =>
      occurrence.placement === "before"
        ? 0
        : occurrence.placement === "capture"
          ? 1
          : 2;
    return (
      phase(first) < phase(second) ||
      (phase(first) === phase(second) &&
        parent.children.indexOf(first) < parent.children.indexOf(second))
    );
  }
  private bindTree(
    occurrence: CommandOccurrence,
    parent?: CommandOccurrence
  ): void {
    occurrence.parent = parent;
    occurrence.dependencyRead ??= this.dependencyRead(occurrence);
    for (const child of occurrence.children) this.bindTree(child, occurrence);
  }
  private dependencyRead(
    occurrence: CommandOccurrence
  ): DependencyRead | undefined {
    const command = occurrence.command;
    const owner = isSeriesOccurrence(occurrence)
      ? this.seriesOwner(occurrence)
      : this.recordOwner(occurrence);
    if (!owner) return undefined;
    if (command.kind === "choose")
      return {
        occurrence,
        lookup: command.lookup,
        owner,
        membership: command.foundRequirement?.membership,
        target: true,
      };
    if (command.kind === "delete")
      return {
        occurrence,
        lookup: command.located,
        owner,
        target: true,
      };
    if (command.kind === "selectedSeries")
      return {
        occurrence,
        lookup: command.series.selection,
        owner,
        target: true,
      };
    return undefined;
  }
  private recordOwner(
    occurrence: CommandOccurrence
  ): CommandOccurrence<RecordCommand> | undefined {
    let candidate = occurrence.parent;
    while (candidate) {
      if (isRecordOccurrence(candidate)) return candidate;
      candidate = candidate.parent;
    }
    return undefined;
  }
  private seriesOwner(
    occurrence: CommandOccurrence<SeriesOccurrence>
  ): CommandOccurrence<RecordCommand> | undefined {
    const owner = this.recordOwner(occurrence);
    if (owner) return owner;
    const template = occurrence.children.find(
      (child) => child.role === "template"
    );
    return template && isRecordOccurrence(template) ? template : undefined;
  }
  private compatible(left?: BranchPath, right?: BranchPath): boolean {
    for (let a = left; a; a = a.parent)
      for (let b = right; b; b = b.parent)
        if (a.choice === b.choice && a.arm !== b.arm) return false;
    return true;
  }
  private visitDirectWrites(
    occurrence: CommandOccurrence,
    visit: (write: WriteVisit) => void,
    branch?: BranchPath
  ): void {
    const command = occurrence.command;
    if (
      (command.kind === "record" &&
        (command.fields.operation === "create" ||
          command.fields.writtenFields().length)) ||
      command.kind === "delete" ||
      command.kind === "set" ||
      command.kind === "link" ||
      command.kind === "remove"
    ) {
      const write = { occurrence, command };
      visit({ write, branch });
    }
    for (const membership of this.membershipPublications(occurrence)) {
      const write = { occurrence, membership };
      visit({ write, branch });
    }
  }
  private childBranch(
    parent: CommandOccurrence,
    child: CommandOccurrence,
    branch: BranchPath | undefined
  ): BranchPath | undefined {
    return parent.command.kind === "choose"
      ? {
          parent: branch,
          choice: parent,
          arm: child.role === "found" ? "found" : "missing",
        }
      : branch;
  }
  private visitWrites(
    occurrence: CommandOccurrence,
    visit: (write: WriteVisit) => void,
    branch: BranchPath | undefined
  ): void {
    this.visitDirectWrites(occurrence, visit, branch);
    for (const child of occurrence.children)
      this.visitWrites(
        child,
        visit,
        this.childBranch(occurrence, child, branch)
      );
  }
  private visitReads(
    occurrence: CommandOccurrence,
    visit: (read: ReadVisit) => "stop" | void,
    branch: BranchPath | undefined
  ): boolean {
    const read = occurrence.dependencyRead;
    if (read) {
      const readVisit = { read, branch };
      if (visit(readVisit) === "stop") return true;
    }
    for (const child of occurrence.children)
      if (
        this.visitReads(
          child,
          visit,
          this.childBranch(occurrence, child, branch)
        )
      )
        return true;
    return false;
  }
  private visitPrecedingWrites(
    target: CommandOccurrence,
    visit: (write: WriteVisit) => void,
    branch: BranchPath | undefined
  ): void {
    const parent = target.parent;
    if (!parent) return;
    const parentBranch =
      parent.command.kind === "choose" ? branch?.parent : branch;
    this.visitPrecedingWrites(parent, visit, parentBranch);
    this.visitDirectWrites(parent, visit, parentBranch);
    if (parent.command.kind === "choose") return;
    if (this.isSeriesMember(parent, target)) return;
    for (const sibling of parent.children) {
      if (sibling === target) return;
      this.visitWrites(sibling, visit, parentBranch);
    }
    // `bindTree` sets `parent` while walking that parent's own `children`, so
    // a target with a parent is one of them and the loop returned above.
    assertInvariant(false, "an occurrence's parent lists that occurrence");
  }
  private analyzeRead(occurrence: CommandOccurrence): void {
    const read = occurrence.dependencyRead;
    if (!read) return;
    const branch = this.branchOf(occurrence);
    const readVisit = { read, branch };
    let publishedParent: CommandOccurrence<RecordCommand> | undefined;
    for (
      let child: CommandOccurrence | undefined = occurrence;
      child?.parent;
      child = child.parent
    ) {
      const parent = child.parent;
      if (!isSeriesOccurrence(parent) || child.role !== "member") continue;
      if (parent.command.series.selection.membership())
        publishedParent = this.seriesOwner(parent);
      break;
    }
    this.visitPrecedingWrites(
      occurrence,
      (write) => {
        if (write.write.occurrence === publishedParent) return;
        this.checkPair(write, readVisit);
      },
      branch
    );
  }
  private checkPair(write: WriteVisit, read: ReadVisit): void {
    if (!this.compatible(write.branch, read.branch)) return;
    this.readMembership(write.write, read.read);
    if (read.read.target) this.readTarget(write.write, read.read);
  }
  private activeRefusal(read: ReadVisit): Error | undefined {
    for (let branch = read.branch; branch; branch = branch.parent) {
      if (branch.arm === "missing") return undefined;
      const choice = branch.choice.command;
      if (
        choice.kind !== "choose" ||
        !this.execution.attempt.rows.has(choice.lookup)
      )
        return undefined;
    }
    return read.read.owner.refusal;
  }
  private analyzeOccurrence(occurrence: CommandOccurrence): void {
    this.analyzeRead(occurrence);
    const command = occurrence.command;
    if (command.kind === "record") {
      // A snapshot: `depend` moves a dependent child within this array while
      // the walk is on it, and a sibling that shifts into the vacated slot
      // must still be analysed (N1).
      this.analyzeChildren(occurrence);
      for (const child of occurrence.children) {
        const childCommand = child.command;
        if (childCommand.kind === "record")
          occurrence.refusal ??= child.refusal;
        else if (childCommand.kind === "choose") {
          const found = this.choiceArm(child, "found");
          const missing = this.choiceArm(child, "missing");
          if (found && !missing) occurrence.refusal ??= found.refusal;
        } else if (childCommand.kind === "series")
          for (const record of child.children)
            occurrence.refusal ??= record.refusal;
        else if (childCommand.kind === "selectedSeries") {
          const template = child.children.find(
            (candidate) => candidate.role === "template"
          );
          if (template && isRecordOccurrence(template))
            occurrence.refusal ??= template.refusal;
        }
      }
      return;
    }
    if (command.kind === "choose" || command.kind === "series") {
      this.analyzeChildren(occurrence);
      return;
    }
    if (command.kind === "selectedSeries") {
      const template = occurrence.children.find(
        (child) => child.role === "template"
      );
      if (template) this.analyzeOccurrence(template);
    }
  }
  /** Recurse over a stable sibling snapshot while dependency moves may occur. */
  private analyzeChildren(occurrence: CommandOccurrence): void {
    for (const child of [...occurrence.children]) this.analyzeOccurrence(child);
  }
  private branchOf(occurrence: CommandOccurrence): BranchPath | undefined {
    const parent = occurrence.parent;
    if (!parent) return undefined;
    return this.childBranch(parent, occurrence, this.branchOf(parent));
  }
  private isSeriesMember(
    parent: CommandOccurrence,
    child: CommandOccurrence
  ): boolean {
    return (
      parent.command.kind === "series" ||
      (isSeriesOccurrence(parent) && child.role === "member")
    );
  }
  private visitFollowingReads(
    target: CommandOccurrence,
    visit: (read: ReadVisit) => "stop" | void,
    branch: BranchPath | undefined
  ): boolean {
    let current = target;
    while (current.parent) {
      const parent = current.parent;
      const parentBranch =
        parent.command.kind === "choose" ? branch?.parent : branch;
      let follows = false;
      if (!this.isSeriesMember(parent, current)) {
        for (const sibling of parent.children) {
          if (follows) {
            const stopped = this.visitReads(
              sibling,
              visit,
              this.childBranch(parent, sibling, parentBranch)
            );
            if (stopped) return true;
          } else if (sibling === current) follows = true;
        }
      }
      current = parent;
      branch = parentBranch;
    }
    return false;
  }
  expandSeries(
    occurrence: CommandOccurrence<SeriesOccurrence>,
    members: readonly SelectedSeriesMember[]
  ): SeriesRefusal | undefined {
    // A series is either placed in a record's body (a nested `updateMany` /
    // `deleteMany`) or is the root series whose template IS the update record
    // (`plan`), so `seriesOwner` resolves for every series that reaches here.
    assertInvariant(
      this.seriesOwner(occurrence),
      "a selected series is enclosed by a record analysis"
    );
    // Expanded once per occurrence: `captureSeries` returns early once the
    // attempt holds this capture, and a recovery re-plans onto a NEW command
    // tree (`commands/index.ts`), never re-entering this occurrence.
    assertInvariant(
      this.seriesMembers(occurrence).length === 0,
      "a selected series occurrence is expanded once"
    );
    occurrence.children = members.map((member) => {
      const child = this.occurrence(member);
      child.role = "member";
      this.materializePlacement(child);
      return child;
    });
    const memberOccurrences = this.seriesMembers(occurrence);
    const seriesBranch = this.branchOf(occurrence);
    for (const member of memberOccurrences) this.bindTree(member, occurrence);
    for (const member of memberOccurrences) {
      this.analyzeOccurrence(member);
    }
    for (const [index, occurrenceMember] of memberOccurrences.entries()) {
      const member = members[index];
      if (!member) continue;
      if (occurrenceMember.command.kind === "record") {
        const refusal = occurrenceMember.refusal;
        if (refusal) return { error: refusal, member };
      }
      let refusal: Error | undefined;
      this.visitWrites(
        occurrenceMember,
        (write) => {
          if (
            this.visitFollowingReads(
              occurrence,
              (read) => {
                this.checkPair(write, read);
                refusal ??= this.activeRefusal(read);
                return refusal ? "stop" : undefined;
              },
              seriesBranch
            )
          )
            return;
        },
        seriesBranch
      );
      if (refusal) return { error: refusal, member };
    }
    return undefined;
  }
  lookup(
    model: AnyModel,
    source: SelectionSource,
    required?: DeferredFailure,
    facts?: SelectorFacts
  ): Selection {
    return new Selection(this.execution, model, source, required, facts);
  }
  capture(selection: Selection, row: Input): Selection {
    return this.lookup(
      selection.model,
      {
        kind: "query",
        selector: this.context.queries.identitySelector(
          selection.model,
          this.context.schema.identity(selection.model, row)
        ),
      },
      selection.required
    );
  }
  /**
   * A root `create`/`update` that writes no relation and publishes no relation
   * is the set-oriented mutation owner plus ONE cardinality decision — the same
   * statement, the same prepared projection and the same decoder a bulk verb
   * uses, so no second single-row physical path exists. It is also the shipped
   * fold gate (`UpdateOperation` `canFold`, `DeleteOperation.ts:206-212`): a
   * relation projection must read other rows, which no RETURNING can carry, and
   * a provider without RETURNING keeps the located/mutated/re-read route.
   */
  /**
   * A root `update` that writes no relation and publishes no relation is the
   * set-oriented mutation owner plus ONE cardinality decision — the same
   * statement, the same prepared projection and the same decoder a bulk verb
   * uses, so no second single-row physical path exists. It is also the shipped
   * fold gate (`UpdateOperation` `canFold`): a relation projection must read
   * other rows, which no RETURNING can carry, and a provider without RETURNING
   * keeps the located/mutated/re-read route.
   *
   * Root `create` folds under the same three conditions, through the set-oriented
   * INSERT owner ({@link rootCreate}).
   */
  private rootUpdate(
    model: AnyModel,
    args: Arguments
  ): (() => Promise<unknown>) | undefined {
    const ctx = this.context;
    if (ctx.schema.namesRelation(model, args.data)) return undefined;
    if (!ctx.driver.adapter.capabilities.supportsReturning) return undefined;
    const projection = ctx.queries.prepareProjection(model, args);
    if (!returningSafeProjection(projection)) return undefined;
    const values = ctx.schema.scalars(model, args.data);
    const selector = ctx.queries.prepareSelector(model, args.where, true);
    return () =>
      ctx.updateMany(
        model,
        selector,
        values,
        undefined,
        projection,
        () => new NotFoundError(model["~"].names.ts!, "update")
      );
  }
  /**
   * A root `create` that writes no relation and publishes no relation is the
   * set-oriented INSERT owner plus ONE cardinality decision, exactly as
   * {@link rootUpdate} is for `update`: one `INSERT … RETURNING <projection>`,
   * the same prepared projection and the same decoder a bulk create uses. It is
   * the shipped classification too — `canExecuteDirectly` runs this shape
   * through `runStatementAtomic` with no transaction, measured.
   *
   * The gate is the fold's own reachability: a relation in `data` needs the
   * record route's dependency machinery, a projection that reads other rows has
   * no RETURNING spelling, and a provider without RETURNING must re-read.
   */
  /**
   * The array route's upsert. That route prepares a package and issues no
   * read of its own, so the conditional form (a locate, two arms and their
   * premises, then a terminal read) cannot be built there at all. The shipped
   * engine served it with its two top-level upsert paths, restated here at
   * this owner (D-46): (1) "an eligible `ON CONFLICT` fold has no planning
   * read" — one targeted conflict statement, under the shipped fold's
   * conjuncts (`write-engine/UpsertOperation.ts` `buildOnConflictFold`): a
   * targeted-upsert adapter, no conditional filter, a `where` naming one
   * constraint and nothing else, the create spelling every column of that
   * constraint with the primitive value the `where` names, a set-only update;
   * (2) otherwise the probe-first path — the locate read runs at preparation
   * ({@link OperationContext.read}) and the selected scalar arm rides the
   * owner's batch as ONE statement with RETURNING, the existing owners of a
   * folded root write (`createMany`, `updateMany` with its packaged presence
   * premise). Both need scalar arms, a non-empty update naming no key of the
   * model and a RETURNING-safe projection on a RETURNING adapter; everything
   * else keeps the conditional form and, on this route, its existing answer.
   * The shipped fold also served the live route; keeping both paths to the
   * array route leaves every live-route pin in place — widening them is a
   * physical-plan decision for Arnaud.
   */
  private rootUpsert(
    model: AnyModel,
    args: Arguments
  ): PhysicalPlan | undefined {
    const ctx = this.context;
    const capabilities = ctx.driver.adapter.capabilities;
    if (!ctx.preparesBatch) return undefined;
    if (args.targetWhere || args.setWhere) return undefined;
    if (!capabilities.supportsReturning) return undefined;
    if (
      ctx.schema.namesRelation(model, args.create!) ||
      ctx.schema.namesRelation(model, args.update!)
    )
      return undefined;
    const updates = ctx.schema.scalars(model, args.update!);
    const fields = Object.keys(updates);
    if (fields.length === 0) return undefined;
    if (ctx.schema.keys(model).some((key) => updates[key] !== undefined))
      return undefined;
    const projection = ctx.queries.prepareProjection(model, args);
    if (!returningSafeProjection(projection)) return undefined;
    const values = ctx.schema.scalars(model, args.create!);
    const missing = () =>
      ctx.createMany(model, [values], projection, false, () => {
        throw new TypeError("INSERT did not produce the required record");
      });
    const lookup = this.lookup(model, {
      kind: "query",
      where: args.where,
      unique: true,
    });
    // The arm this probe chooses INSERTS the key it just looked for, so the
    // probe does not lock the absence it may find (`Selection.insertsWhenAbsent`).
    lookup.insertsWhenAbsent = true;
    const key = lookup.selector.uniqueKey;
    const spelled =
      capabilities.supportsTargetedUpsert &&
      key !== undefined &&
      lookup.selector.uniqueValues !== undefined &&
      fields.every((field) => wholeValue(updates[field])) &&
      key.fields.every((field) => {
        const value = values[field];
        return (
          (value === null ||
            (typeof value !== "object" && typeof value !== "function")) &&
          Object.is(value, lookup.selector.uniqueValues!.get(field))
        );
      });
    if (spelled)
      return {
        single: true,
        run: () =>
          ctx.upsertOne(model, values, updates, key!.fields, projection, () => {
            throw new TypeError(
              "INSERT … ON CONFLICT did not produce the required record"
            );
          }),
      };
    // The locate read precedes the arm, so this form is never one statement.
    return {
      single: false,
      run: async () => {
        const rows = await ctx.planningLocate(lookup.query(), model);
        const captured = rows[0];
        if (!captured) return missing();
        const selector = ctx.queries.prepareSelector(
          model,
          ctx.schema.identity(model, captured),
          true
        );
        return ctx.updateMany(
          model,
          selector,
          updates,
          undefined,
          projection,
          () => new NotFoundError(model["~"].names.ts!, "upsert")
        );
      },
    };
  }
  private rootCreate(
    model: AnyModel,
    args: Arguments
  ): (() => Promise<unknown>) | undefined {
    const ctx = this.context;
    if (ctx.schema.namesRelation(model, args.data)) return undefined;
    if (!ctx.driver.adapter.capabilities.supportsReturning) return undefined;
    const projection = ctx.queries.prepareProjection(model, args);
    if (!returningSafeProjection(projection)) return undefined;
    const values = ctx.schema.scalars(model, args.data);
    return () =>
      ctx.createMany(model, [values], projection, false, () => {
        throw new TypeError("INSERT did not produce the required record");
      });
  }
  /**
   * Construct this operation's physical form and answer whether that form MAY
   * be one statement ({@link PhysicalPlan.single}). Construction reaches no
   * provider, so the envelope owner can ask before it decides
   * (`OperationContext.run`). The envelope RULE itself lives in one place, the
   * context: a form admitted here is only confirmed single by reaching its
   * terminal statement having issued no other.
   */
  plan(model: AnyModel, args: Arguments, raw: Arguments): PhysicalPlan {
    const ctx = this.context;
    const adapter = ctx.driver.adapter;
    const returning = adapter.capabilities.supportsReturning;
    if (ctx.operation === "createMany") {
      const rows = entries(args.data);
      const relationBearing = rows.some((row) =>
        model["~"].relationNames.some((name) => row[name] !== undefined)
      );
      if (relationBearing) {
        const rawRows = entries(raw.data);
        const records = rows.map((row, index) => {
          const record = this.create(model, row, rawRows[index]!);
          if (args.skipDuplicates)
            record.suppression = { kind: "skipDuplicate" };
          return record;
        });
        const occurrences = records.map((record) => {
          for (const field of ctx.schema.keys(model))
            record.fields.field(field);
          return this.analyze(record);
        });
        const series: RecordSeriesCommand = {
          kind: "series",
          records: occurrences,
          select: args.select,
        };
        return {
          single: false,
          run: () =>
            this.execution.records(series.records, series.select, series),
        };
      }
      const projection = bulkProjection(ctx, model, args);
      const values = rows.map((row) => ctx.schema.scalars(model, row));
      const recoverableSkip =
        args.skipDuplicates === true &&
        adapter.mutations.skipDuplicatesStrategy === "recoverableUniqueError";
      // `single` is the envelope owner's OPTIMISTIC question — "may this form
      // reduce to one statement?" — never a per-verb count. A relation-free
      // `createMany` writes one grouped, bind-budgeted INSERT per column set, so
      // the answer is a row-count-independent fact: a recoverable skip is
      // per-row by construction, and a projection without RETURNING re-reads.
      // How many statements the construction actually produces is the
      // construction's own answer, enforced at `OperationContext.dispatch`.
      return {
        single:
          values.length === 0 ||
          (!recoverableSkip && (!projection || returning)),
        run: () =>
          ctx.createMany(model, values, projection, args.skipDuplicates),
      };
    }
    if (ctx.operation === "deleteMany") {
      const projection = bulkProjection(ctx, model, args);
      if (args.limit === 0)
        return {
          single: true,
          run: async () => ctx.emptyBulkResult(projection),
        };
      const selector = ctx.queries.prepareSelector(model, args.where);
      return {
        single:
          !projection || (returning && returningSafeProjection(projection)),
        run: () => ctx.deleteMany(model, selector, args.limit, projection),
      };
    }
    // Root delete is the selected-row removal owner plus ONE cardinality: locate
    // by the extended-unique selector, publish the removed row's prepared
    // projection (RETURNING where the adapter carries it, the locked capture
    // where it does not), and own the missing-row identity.
    if (ctx.operation === "delete") {
      const projection = ctx.queries.prepareProjection(model, args);
      const selector = ctx.queries.prepareSelector(model, args.where, true);
      return {
        single: returning && returningSafeProjection(projection),
        run: () =>
          ctx.deleteMany(
            model,
            selector,
            undefined,
            projection,
            () => new NotFoundError(model["~"].names.ts!, "delete")
          ),
      };
    }
    if (ctx.operation === "upsert") {
      const folded = this.rootUpsert(model, args);
      if (folded) return folded;
      const missing = this.create(model, args.create!, raw.create!);
      missing.operation = "upsert";
      const lookup = this.lookup(model, {
        kind: "query",
        where: args.where,
        unique: true,
      });
      // As above: the missing arm below inserts this very key
      // (`Selection.insertsWhenAbsent`).
      lookup.insertsWhenAbsent = true;
      const queries = this.context.queries;
      const probes: Condition[] = [];
      const conditioned: string[] = [];
      // One builder for every premise sentence this operation owns; the subject
      // is the premise that no longer holds.
      const premiseChanged = (subject: string) =>
        new TransactionError(
          `query-engine-v2 top-level upsert ${subject} changed before the atomic batch.`,
          { meta: { model: model["~"].names.ts!, operation: "upsert" } }
        );
      for (const field of ["targetWhere", "setWhere"] as const) {
        const where = args[field];
        if (!where) continue;
        const conditionSelector = queries.prepareSelector(model, where);
        const skip = premiseChanged(`${field} skip premise`);
        skip.meta.raceable = true;
        const probe = this.lookup(model, {
          kind: "query",
          selector: queries.andSelectors(model, [
            lookup.selector,
            conditionSelector,
          ]),
        });
        // This probe runs before either arm is chosen and its selector is the
        // locator's own, narrowed by the condition — so it names the key the
        // missing arm inserts, and a miss here must not lock that absence
        // either (`Selection.insertsWhenAbsent`). `targetWhere` / `setWhere`
        // are public arguments and `rootUpsert` declines them, so on MySQL
        // this is the only spelling of the shape that reaches the provider.
        probe.insertsWhenAbsent = true;
        conditioned.push(field);
        probes.push({
          lookup: probe,
          match: premiseChanged(`${field} match premise`),
          skip,
        });
      }
      const [firstProbe] = probes;
      const found = this.occurrence(
        this.update(lookup, args.update!, raw.update!, true)
      );
      // The shipped engine's THIRD key owner, raised where it raises it: at
      // analysis, before either arm exists, so a missing row is refused too and
      // nothing is written (`EngineSchema.keyTransitionRefusal`). Both facts it
      // needs are read off structures that already exist — the update arm's own
      // recorded key transitions, and the locator's DISCRIMINATOR pins — so the
      // refusal restates neither the relation walk nor the selector.
      const transition = ctx.schema.keyTransitionRefusal(
        model,
        args.update!,
        lookup.selector.facts.keys,
        found.command.transitions
      );
      if (transition) throw transition;
      const choice: Choose = {
        kind: "choose",
        model,
        lookup,
        operation: "upsert",
        missing: this.occurrence(missing),
        // A conditions record exists where a condition does. Its `matched`
        // failure is decided HERE, where the premises are built, so the one
        // place that raises it states no diagnosis of its own (repair prompt 2
        // §2).
        conditions: firstProbe && {
          probes,
          missingRow: new NotFoundError(model["~"].names.ts!, "upsert"),
          matched:
            probes.length === 1
              ? firstProbe.match
              : premiseChanged(`matched premise (${conditioned.join(", ")})`),
        },
        fields: new Assignments(model, "select", {}, {}, undefined, [
          missing.fields,
        ]),
        found,
      };
      found.command.operation = "upsert";
      choice.fields.forward(found.command.fields);
      for (const field of ctx.schema.keys(model)) choice.fields.field(field);
      const occurrence = this.analyze(choice);
      // The row key's portability contract, carried where the shipped engine
      // carries it for an upsert: on the FOUND arm (`UpsertOperation.compileFoundArm`
      // runs `updateLegality` only once that arm is selected, so a create still
      // writes its row) and only when the update payload names relations
      // (`updateHasRelations ? … : undefined`). It outranks a nested-write
      // refusal on the same arm, as the shipped legality order does.
      const foundArm = this.choiceArm(occurrence, "found");
      if (foundArm && ctx.schema.namesRelation(model, args.update!))
        foundArm.refusal =
          ctx.schema.keyPortabilityRefusal(model, args.update) ??
          foundArm.refusal;
      return {
        single: false,
        run: () => this.execution.complete(occurrence, args),
      };
    }
    if (ctx.operation === "create" || ctx.operation === "update") {
      const folded =
        ctx.operation === "update"
          ? this.rootUpdate(model, args)
          : this.rootCreate(model, args);
      if (folded) return { single: true, run: folded };
      const root =
        ctx.operation === "create"
          ? this.create(model, args.data, raw.data)
          : this.update(
              this.lookup(
                model,
                { kind: "query", where: args.where!, unique: true },
                () => new NotFoundError(model["~"].names.ts!, "update")
              ),
              args.data,
              raw.data
            );
      for (const field of ctx.schema.keys(model)) root.fields.field(field);
      const occurrence = this.analyze(root);
      return {
        single: false,
        run: () => this.execution.complete(occurrence, args),
      };
    }
    const updateData = args.data;
    const relationBearing = ctx.schema.namesRelation(model, updateData);
    const projection = bulkProjection(ctx, model, args);
    if (args.limit === 0)
      return { single: true, run: async () => ctx.emptyBulkResult(projection) };
    if (!relationBearing) {
      const selector = ctx.queries.prepareSelector(model, args.where);
      const values = ctx.schema.scalars(model, updateData);
      return {
        single: !projection || returning,
        run: () =>
          ctx.updateMany(model, selector, values, args.limit, projection),
      };
    }
    const selection = this.lookup(
      model,
      { kind: "query", where: args.where },
      () => new NotFoundError(model["~"].names.ts!, "update")
    );
    const analysis = this.update(selection, updateData, raw.data, true);
    const series: SelectedSeries = {
      selection,
      analysis,
      limit: args.limit,
      mutation: { kind: "update", raw: raw.data },
    };
    const occurrence = this.analyzeSeries(series);
    return {
      single: false,
      run: async () => {
        if (args.select)
          return this.execution.series(
            occurrence,
            series.selection,
            args.select
          );
        return { count: await this.execution.series(occurrence) };
      },
    };
  }
}
