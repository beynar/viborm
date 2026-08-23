// biome-ignore-all lint/style/useFilenamingConvention: File matches its primary class export.
import { getModelKeyCatalog, type Model } from "@schema/model";
import {
  type ChildHeldRelation,
  membershipReferencedFields,
  type ParentHeldRelation,
} from "./builders/relation-data-builder";
import type {
  RecordMutationData,
  RelationMutationEntry,
} from "./builders/relation-mutation-parser";
import { buildParsedRelationPrograms } from "./builders/relation-mutation-parser";
import type { OwnWriteFootprint, OwnWriteLedger } from "./OwnWriteLedger";
import type { OwnWriteRelation } from "./OwnWriteRelation";
import { relationWriteKeys } from "./relation-key-legality";
import {
  classifyRelationKeyScalarUpdate,
  classifyTargetConstraintOverlap,
  getCreatedWhereUniqueTarget,
  getFilterPredicateFields,
  getFilterTargetConstraint,
  getTargetConstraintPredicateFields,
  normalizeTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
  selectorConstraint,
  type TargetConstraint,
  unionPredicateFields,
  unknownConstraint,
  updateResultConstraints,
} from "./TargetConstraint";

export class OwnWriteSteps {
  private readonly relation: OwnWriteRelation;

  constructor(relation: OwnWriteRelation) {
    this.relation = relation;
  }

  processTree(entry: RelationMutationEntry): void {
    if (entry.kind === "create") {
      for (const createData of entry.items) {
        this.processCreateTree(this.relation, "create", createData);
      }
      return;
    }

    if (entry.kind === "createMany") {
      const childScope = this.relation.createChildScope();
      const checkpoint = this.relation.ledger.checkpoint();
      const membershipCheckpoint = this.relation.membershipLedger?.checkpoint();
      const deltas: OwnWriteFootprint[][] = [];
      const membershipDeltas: OwnWriteFootprint[][] = [];
      for (const createData of entry.rows) {
        // A relation-bearing createMany is executed as a left-to-right record
        // series. Each member plans after its predecessor has executed, so a
        // predecessor write is database state, not an own-write dependency inside
        // this member's plan. Analyze every member against the same pre-series
        // ledger, then publish all footprints for operations that follow the series.
        const memberLedger = this.relation.ledger.fork();
        const memberMembershipLedger = this.relation.membershipLedger?.fork();
        const memberRelation = this.relation.fork(
          memberLedger,
          memberMembershipLedger
        );
        if (
          relationWriteKeys(
            buildParsedRelationPrograms(
              childScope,
              createData.parsed,
              createData.source
            )
          ).length > 0
        ) {
          this.processCreateTree(memberRelation, "createMany", createData);
        } else {
          memberRelation.appendCreateSummary("createMany", createData.parsed);
        }
        deltas.push(memberLedger.deltaSince(checkpoint));
        membershipDeltas.push(
          getMembershipDelta(memberMembershipLedger, membershipCheckpoint)
        );
      }
      this.relation.ledger.mergeDeltas(...deltas);
      this.relation.membershipLedger?.mergeDeltas(...membershipDeltas);
      return;
    }

    if (entry.kind === "update") {
      this.processNestedUpdate(entry);
      return;
    }

    if (entry.kind === "updateMany") {
      const childScope = this.relation.createChildScope();
      const memberData = entry.items.flatMap((input) =>
        relationWriteKeys(
          buildParsedRelationPrograms(
            childScope,
            input.data.parsed,
            input.data.source
          )
        ).length > 0
          ? [input.data]
          : []
      );
      if (memberData.length === 0) {
        this.process(entry);
        return;
      }

      const checkpoint = this.relation.ledger.checkpoint();
      const membershipCheckpoint = this.relation.membershipLedger?.checkpoint();
      const deltas: OwnWriteFootprint[][] = [];
      const membershipDeltas: OwnWriteFootprint[][] = [];
      for (const data of memberData) {
        // A selected updateMany member plans after the series capture and in its own
        // operation. The relation-level unknown footprint describes the whole series
        // to later siblings; it is not a prior write inside any one member. Analyze
        // every member shape against the pre-series ledgers, then publish its outward
        // effects only after the outer footprint has been recorded.
        const memberLedger = this.relation.ledger.fork();
        const memberMembershipLedger = this.relation.membershipLedger?.fork();
        this.relation
          .fork(memberLedger, memberMembershipLedger)
          .analyzeUpdate(data, undefined);
        deltas.push(memberLedger.deltaSince(checkpoint));
        membershipDeltas.push(
          getMembershipDelta(memberMembershipLedger, membershipCheckpoint)
        );
      }

      this.process(entry);
      this.relation.ledger.mergeDeltas(...deltas);
      this.relation.membershipLedger?.mergeDeltas(...membershipDeltas);
      return;
    }

    if (processOwnWriteBranchEntry(this.relation, entry)) return;
    this.process(entry);
  }

  /** A relation-bearing createMany row is one complete create tree. Scalar
   * rows keep the earlier summary-only analysis used by the grouped leaf. */
  private processCreateTree(
    relation: OwnWriteRelation,
    operation: "create" | "createMany",
    createData: RecordMutationData
  ): void {
    const insertSummary = relation.getInsertSummary(
      operation,
      createData.parsed
    );
    relation.analyzeCreate(createData, operation, insertSummary);
    if (!insertSummary) {
      relation.appendCreateSummary(operation, createData.parsed, {
        appendTarget: false,
      });
    }
  }

  process(entry: RelationMutationEntry): void {
    switch (entry.kind) {
      case "create":
        for (const data of entry.items) {
          this.relation.appendCreateSummary("create", data.parsed);
        }
        return;
      case "createMany":
        for (const data of entry.rows) {
          this.relation.appendCreateSummary("createMany", data.parsed);
        }
        return;
      case "connect":
        this.processConnect(entry);
        return;
      case "connectOrCreate": {
        const entryLedger = this.relation.ledger.fork();
        const priorItems: ConnectOrCreateAnalysis[] = [];
        for (const {
          input,
          target,
          repeatedSelector,
        } of prepareConnectOrCreateItems(this.relation, entry.items)) {
          const selector = assertConnectOrCreateDecision(
            this.relation,
            entryLedger,
            priorItems,
            input,
            target,
            repeatedSelector
          );
          const checkpoint = this.relation.ledger.checkpoint();
          this.relation.appendCreateSummary(
            "connectOrCreate",
            input.create.parsed
          );
          this.relation.appendMembership("connectOrCreate", selector);
          priorItems.push({
            target,
            writes: this.relation.ledger.deltaSince(checkpoint),
          });
        }
        return;
      }
      case "disconnect":
        this.processDisconnect(entry);
        return;
      case "delete":
        this.processDelete(entry);
        return;
      case "set":
        this.processSet(entry);
        return;
      case "update":
        this.processUpdate(entry);
        return;
      case "upsert":
        for (const input of entry.items) {
          const decision = this.relation.assertUpsertDecision(
            input.target.kind === "unique" ? input.target.where : undefined
          );
          this.relation.appendUpsertUpdateSummary(input, decision);
          this.relation.appendCreateSummary("upsert", input.create.parsed);
          this.relation.appendMembership("upsert", decision);
        }
        return;
      case "updateMany": {
        const unknown = unknownConstraint(this.relation.target);
        this.relation.appendTarget("updateMany", unknown);
        this.relation.appendMembership("updateMany", unknown);
        return;
      }
      case "deleteMany":
        this.processDeleteMany(entry);
        return;
      default: {
        const exhaustive: never = entry;
        throw new TypeError(
          `Unsupported own-write step: ${String(exhaustive)}`
        );
      }
    }
  }

  private processNestedUpdate(
    entry: Extract<RelationMutationEntry, { kind: "update" }>
  ): void {
    this.process(entry);
    for (const input of entry.items) {
      this.relation.analyzeUpdate(
        input.data,
        input.target.kind === "unique" ? input.target.where : undefined
      );
    }
  }

  private processConnect(
    entry: Extract<RelationMutationEntry, { kind: "connect" }>
  ): void {
    for (const where of entry.targets) {
      const selector = selectorConstraint(this.relation.target, where);
      if (
        this.relation.family.kind === "update" &&
        this.relation.boundRelation.position === "parentHeld"
      ) {
        this.relation.ledger.assertTargetRead(
          this.relation.relationName,
          "connect",
          selector
        );
      }
      this.relation.appendMembership("connect", selector);
    }
  }

  private processDisconnect(
    entry: Extract<RelationMutationEntry, { kind: "disconnect" }>
  ): void {
    const constraints = (
      entry.target.kind === "selectors" ? entry.target.targets : []
    ).map((where) => selectorConstraint(this.relation.target, where));

    if (this.relation.boundRelation.position !== "junction") {
      for (const constraint of constraints) {
        this.relation.assertTargetAndMembershipRead("disconnect", constraint);
      }
    }

    if (entry.target.kind === "current") {
      this.relation.appendMembership(
        "disconnect",
        unknownConstraint(this.relation.target)
      );
      return;
    }
    for (const constraint of constraints) {
      this.relation.appendMembership("disconnect", constraint);
    }
  }

  private processDelete(
    entry: Extract<RelationMutationEntry, { kind: "delete" }>
  ): void {
    if (entry.target.kind === "current") {
      const unknown = unknownConstraint(this.relation.target);
      this.relation.appendMembership("delete", unknown);
      this.relation.appendTarget("delete", unknown);
      return;
    }

    const constraints = entry.target.targets.map((where) =>
      selectorConstraint(this.relation.target, where)
    );
    if (this.relation.boundRelation.position === "junction") {
      for (const constraint of constraints) {
        this.relation.ledger.assertTargetRead(
          this.relation.relationName,
          "delete",
          constraint
        );
        this.relation.appendMembership("delete", constraint);
        this.relation.appendTarget("delete", constraint);
      }
      return;
    }

    for (const constraint of constraints) {
      this.relation.assertTargetAndMembershipRead("delete", constraint);
    }
    for (const constraint of constraints) {
      this.relation.appendMembership("delete", constraint);
      this.relation.appendTarget("delete", constraint);
    }
  }

  private processSet(
    entry: Extract<RelationMutationEntry, { kind: "set" }>
  ): void {
    for (const where of entry.targets) {
      const constraint = selectorConstraint(this.relation.target, where);
      this.relation.ledger.assertTargetRead(
        this.relation.relationName,
        "set",
        constraint
      );
      if (this.relation.boundRelation.position !== "junction") {
        this.relation.assertMembershipRead("set", constraint);
      }
    }
    this.relation.appendMembership(
      "set",
      unknownConstraint(this.relation.target)
    );
  }

  private processUpdate(
    entry: Extract<RelationMutationEntry, { kind: "update" }>
  ): void {
    // The junction exclusion is the semantics boundary, not a redundant guard:
    // `buildToOneUpdateFootprint` is typed for the two ROW-HELD arms, and a
    // SINGULAR junction membership — constructible since Package C, and WRITTEN
    // since Package D's collection family — updates through the member table,
    // not through a to-one footprint. The condition is unchanged; only the
    // parenthetical that called the shape unconstructible has stopped being true.
    if (
      this.relation.boundRelation.position !== "junction" &&
      this.relation.boundRelation.cardinality === "one"
    ) {
      const [input] = entry.items;
      if (!input) return;
      const footprint = buildToOneUpdateFootprint(
        this.relation.boundRelation,
        input.data.parsed,
        this.relation.family.kind === "update"
          ? this.relation.family.scalarData
          : undefined
      );
      const continuation = this.relation.composedContinuation;
      if (continuation?.kind === "membershipCapture") {
        // H3, producing half — the modify's locate is a record-series CAPTURE that runs
        // after the supplier's write, in the same execution scope. It is not a planning
        // read at all, so it has no premise an earlier sibling write could invalidate:
        // observing that write is the composition's whole point. Declaring a read here
        // would refuse the shape this package exists to execute, and declaring it as a
        // membership read would additionally name the pair's own sibling vacate as the
        // modify's premise. Its WRITES are still appended below, so a later sibling
        // still sees them.
      } else if (continuation) {
        // H3 — a modify composed with a `connect` reads the SUPPLIER's selector, not
        // membership: that is literally the locator the engine compiles for it. Asking
        // the membership question here would report the pair's own sibling vacate as
        // the modify's premise, which is a dependency the plan does not have.
        //
        // The wrapper's `where` does NOT go away when the selector arrives: the composed
        // probe and its batch guard splice the selector's conjuncts and the filter's
        // together ({@link RelationWritePart.correlatedProbeStatement} appends
        // `targetFilters()` unconditionally), so the read predicates on BOTH field sets
        // and must declare both. Declaring the selector alone would let a sibling write
        // to a filtered field pass `assertIndependent` unseen.
        const suppliedConstraint = selectorConstraint(
          this.relation.target,
          continuation.where
        );
        this.relation.ledger.assertTargetRead(
          this.relation.relationName,
          "update",
          suppliedConstraint,
          input.target.kind === "correlated" && input.target.filter
            ? unionPredicateFields(
                getTargetConstraintPredicateFields(suppliedConstraint),
                getFilterPredicateFields(
                  this.relation.target,
                  input.target.filter
                )
              )
            : undefined
        );
      } else if (input.target.kind === "correlated" && input.target.filter) {
        const filterConstraint = getFilterTargetConstraint(
          this.relation.target,
          input.target.filter
        );
        this.relation.assertTargetAndMembershipRead(
          "update",
          filterConstraint,
          getFilterPredicateFields(this.relation.target, input.target.filter)
        );
      } else {
        this.relation.assertMembershipRead("update", footprint.readConstraint);
      }
      for (const constraint of footprint.resultConstraints) {
        this.relation.ledger.appendTarget(
          "update",
          "targetPredicate",
          constraint,
          footprint.changedFields
        );
      }
      if (footprint.writesMembership) {
        this.relation.appendMembership("update", footprint.readConstraint);
      }
      return;
    }

    for (const input of entry.items) {
      if (input.target.kind !== "unique") continue;
      const selector = selectorConstraint(
        this.relation.target,
        input.target.where
      );
      this.relation.assertTargetAndMembershipRead("update", selector);
      const resultConstraints = updateResultConstraints(
        this.relation.target,
        selector,
        input.data.parsed,
        input.target.where
      );
      if (resultConstraints.length === 0) {
        this.relation.ledger.appendRelationTarget("update", selector);
      }
      for (const constraint of resultConstraints) {
        this.relation.appendTarget("update", constraint);
      }
    }
  }

  private processDeleteMany(
    entry: Extract<RelationMutationEntry, { kind: "deleteMany" }>
  ): void {
    const unknown = unknownConstraint(this.relation.target);
    if (this.relation.boundRelation.position === "junction") {
      for (const filter of entry.filters) {
        const constraint = getFilterTargetConstraint(
          this.relation.target,
          filter
        );
        this.relation.assertTargetAndMembershipRead(
          "deleteMany",
          constraint,
          getFilterPredicateFields(this.relation.target, filter)
        );
        this.relation.appendTarget("deleteMany", constraint);
        this.relation.appendMembership("deleteMany", constraint);
      }
      return;
    }
    this.relation.appendTarget("deleteMany", unknown);
    this.relation.appendMembership("deleteMany", unknown);
  }
}

function processOwnWriteBranchEntry(
  relation: OwnWriteRelation,
  entry: RelationMutationEntry
): boolean {
  if (entry.kind === "connectOrCreate") {
    processConnectOrCreateBranches(relation, entry);
    return true;
  }
  if (entry.kind === "upsert") {
    processUpsertBranches(relation, entry);
    return true;
  }
  return false;
}

function processConnectOrCreateBranches(
  relation: OwnWriteRelation,
  entry: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>
): void {
  const entryLedger = relation.ledger.fork();
  const priorItems: ConnectOrCreateAnalysis[] = [];
  for (const { input, target, repeatedSelector } of prepareConnectOrCreateItems(
    relation,
    entry.items
  )) {
    const selector = assertConnectOrCreateDecision(
      relation,
      entryLedger,
      priorItems,
      input,
      target,
      repeatedSelector
    );
    const checkpoint = relation.ledger.checkpoint();
    analyzeAlternativeBranches(relation, [
      (createBranch) => {
        const insertSummary = createBranch.getInsertSummary(
          "connectOrCreate",
          input.create.parsed
        );
        createBranch.analyzeCreate(
          input.create,
          "connectOrCreate",
          insertSummary
        );
        if (!insertSummary) {
          createBranch.appendCreateSummary(
            "connectOrCreate",
            input.create.parsed,
            { appendTarget: false }
          );
        }
      },
      (foundBranch) => {
        foundBranch.appendMembership("connectOrCreate", selector);
      },
    ]);
    priorItems.push({
      target,
      writes: relation.ledger.deltaSince(checkpoint),
    });
  }
}

function processUpsertBranches(
  relation: OwnWriteRelation,
  entry: Extract<RelationMutationEntry, { kind: "upsert" }>
): void {
  for (const input of entry.items) {
    const selector =
      input.target.kind === "unique" ? input.target.where : undefined;
    const decision = relation.assertUpsertDecision(selector);
    analyzeAlternativeBranches(relation, [
      (updateBranch) => {
        updateBranch.analyzeUpdate(input.update, selector, "upsert");
      },
      (createBranch) => {
        const insertSummary = createBranch.getInsertSummary(
          "upsert",
          input.create.parsed
        );
        createBranch.analyzeCreate(input.create, "upsert", insertSummary);
        if (!insertSummary) {
          createBranch.appendCreateSummary("upsert", input.create.parsed, {
            appendTarget: false,
          });
        }
      },
    ]);
    relation.appendMembership("upsert", decision);
  }
}

function analyzeAlternativeBranches(
  relation: OwnWriteRelation,
  branches: readonly ((branch: OwnWriteRelation) => void)[]
): void {
  const checkpoint = relation.ledger.checkpoint();
  const membershipCheckpoint = relation.membershipLedger?.checkpoint();
  const deltas = branches.map((analyzeBranch) => {
    const branchLedger = relation.ledger.fork();
    const branchMembershipLedger = relation.membershipLedger?.fork();
    analyzeBranch(relation.fork(branchLedger, branchMembershipLedger));
    return {
      memberships: getMembershipDelta(
        branchMembershipLedger,
        membershipCheckpoint
      ),
      writes: branchLedger.deltaSince(checkpoint),
    };
  });

  relation.ledger.mergeDeltas(...deltas.map((delta) => delta.writes));
  relation.membershipLedger?.mergeDeltas(
    ...deltas.map((delta) => delta.memberships)
  );
}

function getMembershipDelta(
  ledger: OwnWriteRelation["membershipLedger"],
  checkpoint: number | undefined
): OwnWriteFootprint[] {
  if (!ledger || checkpoint === undefined) return [];
  return ledger.deltaSince(checkpoint);
}

interface ToOneUpdateFootprint {
  readonly readConstraint: TargetConstraint;
  readonly changedFields: ReadonlySet<string>;
  readonly resultConstraints: readonly TargetConstraint[];
  readonly writesMembership: boolean;
}

/**
 * The caller is inside the to-one arm, and a junction row set is always to-many,
 * so the parameter type is what excludes a junction here.
 */
function buildToOneUpdateFootprint(
  relation: ParentHeldRelation | ChildHeldRelation,
  updateData: Readonly<Record<string, unknown>>,
  rootScalarData: Readonly<Record<string, unknown>> | undefined
): ToOneUpdateFootprint {
  const { relationRef } = relation;
  const target = relationRef.targetModel;
  const scalarData = getScalarData(target, updateData);
  const changedFields = new Set(Object.keys(scalarData));
  const readConstraint =
    relation.position === "parentHeld" && rootScalarData
      ? buildReboundTargetConstraint(target, relation, rootScalarData)
      : unknownConstraint(target);
  const resultConstraints: TargetConstraint[] = [];

  if (changedFields.size > 0) {
    resultConstraints.push(readConstraint);
    const identityFields = getModelKeyCatalog(target).uniqueOverlapFields;
    if (identityFields.some((field) => changedFields.has(field))) {
      resultConstraints.push(
        normalizeTargetConstraint(target, identityFields, scalarData)
      );
    }
  }

  // POSITION, not holder identity: a self-relation's holder and referenced are the
  // same model, and the branch below is exactly that case.
  const referencedFields = membershipReferencedFields(relation.membership);
  const membershipFields = new Set(
    relation.position === "parentHeld"
      ? referencedFields
      : relation.membership.foreignFields
  );
  if (
    relation.sourceModel === target &&
    relation.relationRef.targetModel === target
  ) {
    for (const field of [
      ...relation.membership.foreignFields,
      ...referencedFields,
    ]) {
      membershipFields.add(field);
    }
  }
  return {
    readConstraint,
    changedFields,
    resultConstraints,
    writesMembership: [...membershipFields].some((field) =>
      changedFields.has(field)
    ),
  };
}

/**
 * A repeated connectOrCreate selector is suppressed only after an earlier
 * create is proven to satisfy it. Otherwise both planning decisions and both
 * create subtrees remain visible to OwnWrite analysis.
 */
function prepareConnectOrCreateItems(
  relation: OwnWriteRelation,
  items: Extract<RelationMutationEntry, { kind: "connectOrCreate" }>["items"]
): readonly {
  readonly input: (typeof items)[number];
  readonly target: TargetConstraint;
  readonly repeatedSelector: boolean;
}[] {
  const uniqueItems: {
    readonly input: (typeof items)[number];
    readonly target: TargetConstraint;
    readonly repeatedSelector: boolean;
  }[] = [];
  const seenTargets: TargetConstraint[] = [];
  const createdTargets: TargetConstraint[] = [];
  for (const item of items) {
    const target = normalizeWhereUniqueTargetConstraint(
      relation.target,
      item.where
    );
    const isDuplicate = createdTargets.some(
      (createdTarget) =>
        classifyTargetConstraintOverlap(createdTarget, target) === "equal"
    );
    if (isDuplicate) continue;
    const repeatedSelector = seenTargets.some(
      (seenTarget) =>
        classifyTargetConstraintOverlap(seenTarget, target) === "equal"
    );
    uniqueItems.push({
      input: item,
      target,
      repeatedSelector,
    });
    seenTargets.push(target);
    const createdTarget = getCreatedWhereUniqueTarget(
      relation.target,
      item.where,
      item.create.parsed
    );
    if (createdTarget) createdTargets.push(createdTarget);
  }
  return uniqueItems;
}

interface ConnectOrCreateAnalysis {
  readonly target: TargetConstraint;
  readonly writes: OwnWriteFootprint[];
}

function assertConnectOrCreateDecision(
  relation: OwnWriteRelation,
  entryLedger: OwnWriteLedger,
  priorItems: readonly ConnectOrCreateAnalysis[],
  input: Extract<
    RelationMutationEntry,
    { kind: "connectOrCreate" }
  >["items"][number],
  target: TargetConstraint,
  repeatedSelector: boolean
): TargetConstraint {
  if (!repeatedSelector) {
    return relation.assertConnectOrCreateDecision(input.where);
  }

  // A repeated probe shares the entry's pre-write premise with its exact
  // selector lineage. Keep every intervening alternate-selector write: those
  // may still create the row this probe names and must retain the refusal.
  const decisionLedger = entryLedger.fork();
  for (const prior of priorItems) {
    if (classifyTargetConstraintOverlap(prior.target, target) === "equal") {
      continue;
    }
    decisionLedger.mergeDeltas(prior.writes);
  }
  return relation
    .fork(decisionLedger, relation.membershipLedger?.fork())
    .assertConnectOrCreateDecision(input.where);
}

function buildReboundTargetConstraint(
  target: Model<any>,
  relation: ParentHeldRelation,
  rootScalarData: Readonly<Record<string, unknown>>
): TargetConstraint {
  const values: Record<string, unknown> = {};
  const { members, referencedFields } = relation.membership;
  for (const { foreignField, referencedField } of members) {
    if (!Object.hasOwn(rootScalarData, foreignField)) continue;
    const update = classifyRelationKeyScalarUpdate(
      rootScalarData[foreignField]
    );
    if (update.resolved && update.value !== null) {
      values[referencedField] = update.value;
    }
  }
  return normalizeTargetConstraint(target, referencedFields, values);
}

function getScalarData(
  model: Model<any>,
  data: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const scalars: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined && Object.hasOwn(model["~"].state.scalars, field)) {
      scalars[field] = value;
    }
  }
  return scalars;
}
