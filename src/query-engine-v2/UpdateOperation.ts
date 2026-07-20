// biome-ignore-all lint/style/useFilenamingConvention: UpdateOperation is the architecture name.
import {
  NestedWriteError,
  NotFoundError,
  QueryEngineError,
  ValidationError,
} from "@errors";
import type { Model } from "@schema/model";
import { parse, type VibSchema } from "@validation";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../query-engine/builders/correlation-utils";
import {
  type FkDirection,
  getFkDirection,
  type RelationMutation,
  separateData,
} from "../query-engine/builders/relation-data-builder";
import { getRelationMutationKinds } from "../query-engine/builders/relation-mutation-parser";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
} from "../query-engine/context/query-scope";
import { buildFindUnique, buildUpdate } from "../query-engine/operations";
import {
  assertPortablePrimaryKeyUpdateInput,
  getUpdatedPrimaryKeyWhere,
} from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { assertNullable } from "../query-engine/RelationProgramValues";
import { ResultParser } from "../query-engine/result/ResultParser";
import { classifyRelationKeyScalarUpdate } from "../query-engine/TargetConstraint";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  affectedRows,
  exactlyOneRow,
  nestedWriteFailure,
  notFoundFailure,
  presenceGuard,
  queryFailure,
} from "./fragment-builders";
import { relationTargetNotFound } from "./messages";
import {
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { OwnWritePreflight } from "./OwnWritePreflight";
import type { Part } from "./Part";
import { planningKey, planningOutputs } from "./Part";
import { buildJunctionParts } from "./RelationJunctionPart";
import { buildToManyLinkParts } from "./RelationLinkPart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
  plannedParentId,
} from "./RelationUpsertPart";
import {
  buildToManyDeleteManyParts,
  buildToManyDeleteParts,
  buildToManySetPart,
  buildToManyUpdateManyParts,
  buildToManyUpdateParts,
} from "./RelationWritePart";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/** A to-one (parent-held-FK) connect/disconnect folded into the root update SET. */
interface ToOneLink {
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  /** FK assignment merged into the parent SET clause. */
  readonly assignment: Record<string, unknown>;
  /** Present for `connect`: an existence probe + its batch guard id. */
  readonly connect?: {
    readonly probeId: string;
    readonly guardId: string;
    readonly probe: StatementStep;
  };
}

/**
 * The root `update` (PLAN P2a — generalized beyond the P1 upsert slice). It
 * locates a row by ANY unique `where`, applies scalar `data`, and composes any
 * mix of nested to-many `upsert`/`connect`/`disconnect` (child-held FK) plus
 * to-one `connect`/`disconnect` (parent-held FK, folded into the root SET). It
 * adds only local update semantics over the same executor, fragment vocabulary,
 * and Part composition proven in P1; every unsupported shape is a typed
 * {@link UnsupportedOperationError} raised before I/O (the routing signal).
 */
export class UpdateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly childParts: readonly Part[];
  private readonly toOneLinks: readonly ToOneLink[];
  private readonly locate: StatementStep;
  // Whether the non-fold path emits a parent-row UPDATE (a scalar SET ∪ to-one FK
  // folds). Built at compile so it can address the captured PK (V1's `WHERE id`);
  // `false` for a relation-only update (no parent row written) or the fold path.
  private readonly needsRootUpdate: boolean;
  // The returning-driver fast path (finding 4 / PERF.md P5): a simple update
  // (scalar `data`, no nested relation mutation, a scalar-only projection) on a
  // driver with `RETURNING` folds locate+mutate+terminal into ONE `UPDATE …
  // WHERE selector RETURNING select` — V1's `compileDirect`. Statement-atomic
  // (empty planning, exactly one step), so the executor runs it with no
  // transaction/batch envelope (isStatementAtomic → runLinearOn), enforcing the
  // affectedRows/notFound postcondition in JS after the single round-trip. The
  // fold is gated to `transaction` mode: a folded step carries a postcondition,
  // and the atomic-batch lowering (compileToEntries) does not yet enforce one, so
  // batch-only drivers keep the plan-then-execute path (whose batch guard checks
  // presence instead). `undefined` on non-returning drivers, batch mode, a
  // relation projection, or when nested relations make the mutation genuinely
  // multi-statement.
  private readonly directWrite?: StatementStep;
  private readonly updateId: string;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly parentWhere: Record<string, unknown>;
  private readonly parsedSelect: Record<string, unknown>;
  private readonly terminalId: string;
  private readonly rootGuardId: string;
  // The parent SET (scalar data ∪ to-one FK folds), retained so the terminal read
  // addresses the row by its POST-update primary key — a literal rename or a
  // portable arithmetic increment on a PK field moves the identity the located
  // (pre-update) row no longer answers to (the `DerivedValue` disposition, ATOM §3).
  private readonly parentUpdateData: Record<string, unknown>;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "update");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;

    // 1. Validate the argument shape. `where` locates by any unique; `data`
    //    mixes scalar assignments and nested relation mutations; `select` is
    //    optional and shapes the terminal read (Prisma's default is all scalars).
    assertUpdateKeys(args);
    const where = requireRecord(args.where, "update.where");
    const data = requireRecord(args.data, "update.data");
    // V1 runs this in its shared `validator` (validator.ts) for every operation;
    // V2's per-schema parse path bypasses it, so a top-level PK arithmetic that
    // is not portable (float/decimal), divides by zero, or stacks operations was
    // caught late (at the terminal read's `getUpdatedPrimaryKeyWhere`, after the
    // locate ran) with V1's OTHER message. Run it at construction, before any I/O.
    assertPortablePrimaryKeyUpdateInput(model, "update", args);
    const parent = createQueryScope(engine.adapter, model);
    const separated = separateData(parent, data);

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      throw new UnsupportedOperationError(
        "query-engine-v2 update requires a parent with a primary key."
      );
    }
    // Compound primary keys are supported: the locate reads and terminal read
    // carry every PK field, and the child FK edges reference them per-field.
    this.parentPrimaryKeys = parentPrimaryKeys;

    // V1's relation-key legality (RelationUpdates.assertRelationKeyUpdatesAre-
    // Compilable, ported verbatim): a relation-key field — the FK column when the
    // parent holds it, else the parent column a child FK references (a non-PK
    // unique like `code`) — cannot be rewritten by a non-literal arithmetic op
    // while that relation is mutated, because the DerivedValue would desync the
    // edge. Both substrates, before any effect. V2 previously only rejected the
    // holds-FK case by routing to-one update/upsert to V1; the child-holds-FK
    // referenced-field case (a supported one-to-many update) reached no check.
    assertRelationKeyUpdatesAreCompilable(
      parent,
      separated.scalarData,
      separated.relations
    );

    this.parentWhere = parseRecord(
      parentSchemas.core.whereUnique,
      where,
      "where"
    );
    this.parsedSelect = isRecord(args.select)
      ? parseRecord(parentSchemas.core.select, args.select, "select")
      : defaultSelect(model);
    this.resultArgs = { select: this.parsedSelect };

    // 2. Own-write preflight (ATOM §4): any decision read overlapping this
    //    operation's own writes is rejected here with V1's typed "split these
    //    operations" error, before planning — identically on both substrates.
    new OwnWritePreflight().assertUpdate(parent, data, where);

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    const updateId = scope.allocate(`${parentName}.update`);
    this.updateId = updateId;
    this.terminalId = scope.allocate(`${parentName}.select`);
    this.rootGuardId = scope.allocate(`${parentName}.guard.exists`);

    // 3. Interpret each nested relation into a to-many child Part or a to-one
    //    root-SET fold. The parent-id every child arm consumes is the located
    //    id — a planning value inlined at compile (the correlated disconnect
    //    probe additionally refs it in SQL: technique #1).
    const parentIdSource = plannedParentId(
      locateId,
      this.parentPrimaryKeys[0]!
    );
    const childParts: Part[] = [];
    const toOneLinks: ToOneLink[] = [];
    // Every parent column a child FK edge references must be exposed by the
    // locate read (a compound edge references several; a D4-style edge references
    // a non-PK unique). Collected here, unioned with the PK, and selected +
    // exposed as firstRowField outputs below so a per-field child part can read
    // each referenced value (compile literal) or ref it (planning correlation).
    const locateFields = new Set<string>(this.parentPrimaryKeys);
    for (const [relationName, mutation] of Object.entries(
      separated.relations
    )) {
      const relationSchemas = parentSchemas.relations[relationName];
      if (!relationSchemas) {
        throw new UnsupportedOperationError(
          `No validation schema exists for relation '${relationName}'.`
        );
      }
      const parsedRelation = parseRecord(
        relationSchemas.update,
        requireRecord(data[relationName], relationName),
        `data.${relationName}`
      );
      this.interpretRelation({
        scope,
        parent,
        relationName,
        mutation,
        parsedRelation,
        parentIdSource,
        txMode,
        childParts,
        toOneLinks,
        locateFields,
      });
    }
    this.childParts = childParts;
    this.toOneLinks = toOneLinks;

    // 4. The parent SET = validated scalar data ∪ to-one FK folds. Emitted only
    //    when non-empty (a relation-only update never writes the parent row;
    //    Prisma's `update({ data: { posts: { connect } } })`).
    const parentSet: Record<string, unknown> = {};
    if (Object.keys(separated.scalarData).length > 0) {
      Object.assign(
        parentSet,
        parseRecord(
          parentSchemas.core.scalarUpdate,
          separated.scalarData,
          "data"
        )
      );
    }
    for (const link of toOneLinks) Object.assign(parentSet, link.assignment);
    this.parentUpdateData = parentSet;

    // Fast path (finding 4): a simple update — no nested relation mutation
    // (no child Parts, no to-one FK folds) with a non-empty scalar SET and a
    // scalar-only projection — on a RETURNING driver is V1's `compileDirect`: one
    // `UPDATE … WHERE selector RETURNING select`, the updated row (incl. any PK
    // the SET rewrote) coming straight back. No locate, no terminal, no envelope.
    // Gated to a scalar-only `select`: for scalars `buildUpdate`'s RETURNING
    // projection and the terminal `buildFindUnique` projection are the same
    // columns, so the parsed result is byte-identical; a relation projection
    // (lateral joins vs RETURNING subqueries) keeps the proven terminal-read
    // path. Gated to `transaction` mode: the folded step's postcondition has no
    // atomic-batch lowering yet (compileToEntries), so batch-only drivers keep
    // plan-then-execute (their batch guard checks presence).
    const selectIsScalarOnly = !Object.keys(this.parsedSelect).some((field) =>
      model["~"].relationSet.has(field)
    );
    const canFold =
      txMode &&
      engine.adapter.capabilities.supportsReturning &&
      childParts.length === 0 &&
      toOneLinks.length === 0 &&
      selectIsScalarOnly &&
      Object.keys(parentSet).length > 0;
    this.directWrite = canFold
      ? {
          id: updateId,
          kind: "write",
          statement: buildUpdate(parent, {
            where: this.parentWhere,
            data: parentSet,
            select: this.parsedSelect,
          }),
          outputs: { result: { kind: "rows" } },
          expects: affectedRows(
            1,
            notFoundFailure(
              `query-engine-v2 update located no '${parentName}' row for its unique where.`
            )
          ),
        }
      : undefined;
    this.needsRootUpdate =
      !this.directWrite && Object.keys(parentSet).length > 0;

    // 5. The locate planning read. It carries the `notFound` postcondition on
    //    BOTH substrates (enforced by the executor during planning): a missing
    //    root aborts before any write AND before any correlated child probe can
    //    dereference a located id that does not exist (ATOM §8.1 note (a)/(b)).
    const locateSelectFields = [...locateFields];
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.parentWhere,
        select: Object.fromEntries(
          locateSelectFields.map((field) => [field, true])
        ),
        forUpdate: txMode,
      }),
      // Each PK field AND each child-FK-referenced field is a firstRowField
      // output so a per-field child FK edge can ref it (compound keys / D4-style
      // non-PK references — the census's multi-field produces).
      outputs: {
        rows: { kind: "rows" },
        ...Object.fromEntries(
          locateSelectFields.map((field) => [
            field,
            { kind: "firstRowField", field },
          ])
        ),
      },
      expects: exactlyOneRow(
        notFoundFailure(
          `query-engine-v2 update located no '${parentName}' row for its unique where.`
        )
      ),
    };
  }

  planning(): OperationFragment {
    // The RETURNING fold is a single self-contained statement — no planning read
    // (the located id it would carry is unused; the RETURNING clause returns the
    // mutated row directly). Empty planning is what makes it statement-atomic.
    if (this.directWrite) return { steps: [], outputs: {} };
    const steps: OperationStep[] = [this.locate];
    for (const link of this.toOneLinks) {
      if (link.connect) steps.push(link.connect.probe);
    }
    for (const part of this.childParts)
      steps.push(...part.planning(this.scope));
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    // The RETURNING fold compiles to its one write step regardless of `known`
    // (it consumes no planning value): the `UPDATE … WHERE selector RETURNING
    // select` locates, mutates, and returns the row in one statement, with the
    // affectedRows/notFound postcondition enforced by the executor after it runs.
    if (this.directWrite) {
      return {
        steps: [this.directWrite],
        outputs: { result: ref(this.updateId, "result") },
      };
    }
    // Defensive: the locate's postcondition already aborts a missing root at
    // planning; this keeps compile fail-closed if it is ever called directly.
    const locateRows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(locateRows)) {
      throw new QueryEngineError(
        "query-engine-v2 update planning did not expose the locate rows."
      );
    }
    if (locateRows.length === 0) {
      throw new NotFoundError(getStepModelName(this.model, "record"), "update");
    }
    const locatedRow = locateRows[0] as Record<string, unknown>;

    // Build-don't-select (P1.2): to-one connect checks + child arms construct
    // their taken steps; the shared root update and deep terminal read emit once.
    // Guards hoist ahead of every write (batch pins premises first).
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    // Batch mode pins the root's presence inside the atomic unit (ATOM §8.1 note
    // (b)): the affectedRows/notFound postcondition the tx path checks on the
    // root write, lowered to an adapter-owned exists assertion. It closes the
    // staleness window between the unlocked locate read and the batch; a
    // concurrent delete aborts the batch typed instead of a silent empty result.
    if (this.mode === "batch") {
      guards.push(this.buildRootPresenceGuard());
    }
    for (const link of this.toOneLinks) {
      guards.push(...this.compileToOneConnect(link, known));
    }
    for (const part of this.childParts) {
      for (const step of part.compile(this.scope, known)) {
        (step.kind === "guard" ? guards : writes).push(step);
      }
    }
    const steps: OperationStep[] = [...guards];
    if (this.needsRootUpdate) {
      steps.push(this.buildRootUpdate(locatedRow));
    }
    steps.push(...writes, this.buildTerminal(locatedRow));
    return { steps, outputs: { result: ref(this.terminalId, "result") } };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 update did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>("update", outputs.result, this.resultArgs);
  }

  // -------------------------------------------------------------------------

  private interpretRelation(input: {
    scope: StepScope;
    parent: QueryScope;
    relationName: string;
    mutation: RelationMutation;
    parsedRelation: Record<string, unknown>;
    parentIdSource: ReturnType<typeof plannedParentId>;
    txMode: boolean;
    childParts: Part[];
    toOneLinks: ToOneLink[];
    locateFields: Set<string>;
  }): void {
    const { relationName, mutation, parsedRelation } = input;
    const relationInfo = mutation.relationInfo;
    const kinds = getRelationMutationKinds(mutation);

    if (relationInfo.type === "manyToMany") {
      // Many-to-many is not special (WHY §4.3): junction as ordinary Parts. Each
      // membership kind is a leaf feeding the same step vocabulary; the whole
      // family lives in one file, never an `M2M*` subsystem.
      input.childParts.push(
        ...buildJunctionParts({
          scope: input.scope,
          engine: this.engine,
          parentScope: input.parent,
          relationName,
          relationInfo,
          mutation,
          parsedRelation,
          parentId: input.parentIdSource,
          txMode: input.txMode,
        })
      );
      return;
    }

    const fk = getFkDirection(input.parent, relationInfo);

    if (fk.holdsFK) {
      // A parent-held FK is a same-row change (folded into the root SET). Only a
      // single connect/disconnect is in P2a scope; anything else routes to V1.
      if (kinds.length !== 1) {
        throw new UnsupportedOperationError(
          `query-engine-v2 update supports one mutation kind on the to-one relation '${relationName}'; it has ${kinds.join(", ") || "none"}.`
        );
      }
      input.toOneLinks.push(
        this.interpretToOneLink(
          input.scope,
          relationName,
          relationInfo,
          fk,
          kinds[0]!,
          parsedRelation
        )
      );
      return;
    }

    if (relationInfo.type !== "oneToMany") {
      throw new UnsupportedOperationError(
        `query-engine-v2 update supports only one-to-many child-held relations; relation '${relationName}' is '${relationInfo.type}'.`
      );
    }
    // Compound foreign keys are per-field (ATOM §1): every referenced parent
    // column — the PK, a subset of it, or a non-PK unique (D4-style) — is added
    // to the locate read's select/outputs so a per-field child part reads or refs
    // each one. The whole family (link/adopt/write/set) generalizes together; no
    // shape routes to V1 on account of compound arity any longer.
    for (const field of fk.pkFields) input.locateFields.add(field);
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const childPrimaryKeys = getPrimaryKeyFields(childScope.model);
    if (childPrimaryKeys.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 update requires a child with one primary key for relation '${relationName}'.`
      );
    }
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const writeBase = {
      scope: input.scope,
      engine: this.engine,
      relationName,
      relationInfo,
      childName,
      childScope,
      fkFields: fk.fkFields,
      referencedFields: fk.pkFields,
      childPrimaryKey: childPrimaryKeys[0]!,
      parentId: input.parentIdSource,
      txMode: input.txMode,
    } as const;

    // Multiple mutation kinds may coexist on one to-many relation (V1's
    // `{ delete, deleteMany }`, `{ update, updateMany }`, …). Each present kind
    // contributes its own Part(s); they compose into the one linear fragment in
    // a stable, V1-mirroring order (link/adopt, then removals, then updates).
    for (const kind of kinds) {
      this.interpretToManyKind({
        kind,
        relationName,
        relationInfo,
        parsedRelation,
        childScope,
        childName,
        childPrimaryKey: childPrimaryKeys[0]!,
        fkFields: fk.fkFields,
        referencedFields: fk.pkFields,
        writeBase,
        input,
      });
    }
  }

  private interpretToManyKind(args: {
    kind: string;
    relationName: string;
    relationInfo: RelationInfo;
    parsedRelation: Record<string, unknown>;
    childScope: QueryScope;
    childName: string;
    childPrimaryKey: string;
    fkFields: readonly string[];
    referencedFields: readonly string[];
    writeBase: Parameters<typeof buildToManyUpdateParts>[0];
    input: {
      scope: StepScope;
      parent: QueryScope;
      parentIdSource: ReturnType<typeof plannedParentId>;
      txMode: boolean;
      childParts: Part[];
    };
  }): void {
    const {
      kind,
      relationName,
      relationInfo,
      parsedRelation,
      childScope,
      childName,
      childPrimaryKey,
      fkFields,
      referencedFields,
      writeBase,
      input,
    } = args;
    const push = (parts: readonly Part[]) => input.childParts.push(...parts);

    switch (kind) {
      case "upsert":
        push(
          buildToManyUpsertParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.upsert, relationName),
            input.parentIdSource,
            "correlated",
            input.txMode
          )
        );
        return;
      case "connectOrCreate":
        // Still a GLOBAL lookup-and-adopt under update (found → reparent, absent
        // → create), never correlated (PLAN P−1.2) — composed like the upsert part.
        push(
          buildConnectOrCreateParts(
            input.scope,
            input.parent,
            this.engine,
            relationName,
            relationInfo,
            normalizeItems(parsedRelation.connectOrCreate, relationName),
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      case "connect":
      case "disconnect":
        if (kind === "disconnect") {
          // A required child FK cannot be nulled — V1's verbatim typed rejection.
          assertNullable(
            relationInfo,
            getFkDirection(input.parent, relationInfo)
          );
        }
        push(
          buildToManyLinkParts(
            input.scope,
            this.engine,
            relationName,
            relationInfo,
            childName,
            childScope,
            fkFields,
            referencedFields,
            childPrimaryKey,
            kind,
            kind === "connect"
              ? parsedRelation.connect
              : parsedRelation.disconnect,
            input.parentIdSource,
            input.txMode
          )
        );
        return;
      case "update":
        push(buildToManyUpdateParts(writeBase, parsedRelation.update));
        return;
      case "updateMany":
        push(buildToManyUpdateManyParts(writeBase, parsedRelation.updateMany));
        return;
      case "delete":
        push(buildToManyDeleteParts(writeBase, parsedRelation.delete));
        return;
      case "deleteMany":
        push(buildToManyDeleteManyParts(writeBase, parsedRelation.deleteMany));
        return;
      case "set":
        input.childParts.push(
          buildToManySetPart(writeBase, parsedRelation.set)
        );
        return;
      default:
        // create / createMany nested under update are V1's surface, not P2c's.
        throw new UnsupportedOperationError(
          `query-engine-v2 update does not support nested '${kind}' on relation '${relationName}'.`
        );
    }
  }

  private interpretToOneLink(
    scope: StepScope,
    relationName: string,
    relationInfo: RelationInfo,
    fk: FkDirection,
    kind: string,
    parsedRelation: Record<string, unknown>
  ): ToOneLink {
    if (kind === "disconnect") {
      // V1-verbatim rejection when a required FK cannot be nulled.
      assertNullable(relationInfo, fk);
      return {
        relationName,
        relationInfo,
        assignment: Object.fromEntries(
          fk.fkFields.map((field) => [field, { set: null }])
        ),
      };
    }
    if (kind !== "connect") {
      throw new UnsupportedOperationError(
        `query-engine-v2 update does not support nested '${kind}' on to-one relation '${relationName}'.`
      );
    }
    const connect = normalizeSingle(
      parsedRelation.connect,
      relationName,
      "connect"
    );
    const assignment: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      const referencedField = fk.pkFields[index]!;
      if (!Object.hasOwn(connect, referencedField)) {
        // Connect by a non-referenced unique needs a lookup value; out of P2a
        // scope — route the whole tree to V1.
        throw new UnsupportedOperationError(
          `query-engine-v2 update to-one connect for relation '${relationName}' must reference '${referencedField}' directly.`
        );
      }
      assignment[fk.fkFields[index]!] = { set: connect[referencedField] };
    }
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = scope.allocate(`${childName}.find`);
    const guardId = scope.allocate(`${childName}.guard.exists`);
    const probe: StatementStep = {
      id: probeId,
      kind: "read",
      statement: buildFindUnique(childScope, {
        where: connect,
        select: Object.fromEntries(fk.pkFields.map((field) => [field, true])),
        forUpdate: this.mode === "transaction",
      }),
      outputs: { rows: { kind: "rows" } },
    };
    return {
      relationName,
      relationInfo,
      assignment,
      connect: { probeId, guardId, probe },
    };
  }

  private compileToOneConnect(
    link: ToOneLink,
    known: Readonly<Record<string, unknown>>
  ): OperationStep[] {
    if (!link.connect) return [];
    const rows = known[planningKey(link.connect.probeId, "rows")];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(link.relationInfo, "connect"),
        link.relationName
      );
    }
    if (this.mode === "transaction") return [];
    // Batch: pin the connect target's presence before the parent SET.
    return [
      presenceGuard(
        link.connect.guardId,
        link.connect.probe.statement,
        nestedWriteFailure(
          relationTargetNotFound(link.relationInfo, "connect"),
          link.relationName,
          false
        )
      ),
    ];
  }

  private buildRootUpdate(locatedRow: Record<string, unknown>): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    const parentName = getStepModelName(this.model, "parent");
    // The exact-affected postcondition is a returning-driver check only. On a
    // non-returning driver V1 uses `affectedRows: unrestricted` (its
    // `compileMutationRefetch`): the locked locate already proved existence, so a
    // MySQL-style no-op UPDATE (0 rows changed because the value is unchanged) is
    // accepted, not a spurious NotFound. The terminal read confirms the final row.
    const enforceAffected =
      txMode && this.engine.adapter.capabilities.supportsReturning;
    return {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(parent, {
        // Address the row by the PK captured at the (FOR UPDATE) locate — V1's
        // `WHERE id` mechanic (locate by an alternate unique, mutate by the
        // immutable captured PK). Transaction mode only; batch mode keeps the
        // original `where` so the write and its presence guard pin one row.
        where: this.writeWhere(locatedRow),
        data: this.parentUpdateData,
        select: this.pkSelect(),
      }),
      outputs: {},
      ...(enforceAffected
        ? {
            expects: affectedRows(
              1,
              notFoundFailure(
                `query-engine-v2 update located no '${parentName}' row for its unique where.`
              )
            ),
          }
        : {}),
    };
  }

  /** The row's post-locate address: the captured PK in transaction mode (V1's
   *  `WHERE id`), the original `where` in batch mode (guard/write pin one row). */
  private writeWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    if (this.mode !== "transaction") return this.parentWhere;
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  /** The batch-mode root-presence assertion (ATOM §8.1 note (b)). */
  private buildRootPresenceGuard(): OperationStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    return presenceGuard(
      this.rootGuardId,
      buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
      }),
      notFoundFailure(
        `query-engine-v2 update located no '${getStepModelName(this.model, "record")}' row for its unique where.`
      )
    );
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(this.parentPrimaryKeys.map((pk) => [pk, true]));
  }

  private buildTerminal(locatedRow: Record<string, unknown>): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        // Address the row by its POST-update primary key: a PK the update SET
        // rewrote (literal rename or portable arithmetic) moves the identity, so
        // the located pre-update PK would miss the row. `getUpdatedPrimaryKeyWhere`
        // returns the located PK unchanged when the update leaves it alone, and
        // wraps a compound PK into its where-unique shape. It reuses V1's exact
        // arithmetic (and its typed refusal of an ambiguous PK operation).
        where: getUpdatedPrimaryKeyWhere(
          parent,
          locatedRow,
          this.parentUpdateData,
          getStepModelName(this.model, "record")
        ),
        select: this.parsedSelect,
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode
        ? {
            expects: exactlyOneRow(
              queryFailure(
                "query-engine-v2 update terminal read expected exactly one row."
              )
            ),
          }
        : {}),
    };
  }
}

/**
 * V1's `RelationUpdates.assertRelationKeyUpdatesAreCompilable`, ported byte-for-
 * byte (including its message and `NestedWriteError` meta). For every non-M2M
 * relation being mutated, the relation-key fields (the FK when the parent holds
 * it, else the parent column the child FK references) may not be rewritten by a
 * non-literal operation: a `DerivedValue` on the referenced key would break the
 * correlation the nested write depends on.
 */
function assertRelationKeyUpdatesAreCompilable(
  parent: QueryScope,
  scalarData: Record<string, unknown>,
  relations: Record<string, RelationMutation>
): void {
  const primaryKeyFields = new Set(getPrimaryKeyFields(parent.model));
  for (const mutation of Object.values(relations)) {
    if (mutation.relationInfo.type === "manyToMany") continue;
    const fk = getFkDirection(parent, mutation.relationInfo);
    const relationKeyFields = fk.holdsFK ? fk.fkFields : fk.pkFields;
    for (const field of relationKeyFields) {
      if (scalarData[field] === undefined) continue;
      if (primaryKeyFields.has(field) && !fk.holdsFK) continue;
      if (classifyRelationKeyScalarUpdate(scalarData[field]).resolved) continue;
      throw new NestedWriteError(
        `Cannot update relation key field '${field}' with a non-literal operation while mutating relation '${mutation.relationInfo.name}'. Use a literal value or '{ set: ... }'.`,
        mutation.relationInfo.name,
        {
          meta: {
            operation: "update",
            field,
            relation: mutation.relationInfo.name,
          },
        }
      );
    }
  }
}

function normalizeItems(
  value: unknown,
  relation: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new QueryEngineError(
        `Relation '${relation}' upsert item must be an object.`
      );
    }
    return item;
  });
}

function normalizeSingle(
  value: unknown,
  relation: string,
  kind: string
): Record<string, unknown> {
  if (Array.isArray(value) && value.length !== 1) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update to-one ${kind} for relation '${relation}' does not support multiple targets.`
    );
  }
  const item = Array.isArray(value) ? value[0] : value;
  if (!isRecord(item)) {
    throw new UnsupportedOperationError(
      `query-engine-v2 update to-one ${kind} for relation '${relation}' requires a single unique where.`
    );
  }
  return item;
}

function parseRecord(
  schema: VibSchema,
  value: unknown,
  path: string
): Record<string, unknown> {
  const result = parse(schema, value);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "update",
      result.issues.map((issue) => ({
        path: [path, ...(issue.path?.map(String) ?? [])].join("."),
        message: issue.message,
      }))
    );
  }
  if (!isRecord(result.value)) {
    throw new QueryEngineError(`Validated '${path}' is not an object.`);
  }
  return result.value;
}

function assertUpdateKeys(value: Record<string, unknown>): void {
  const required = ["where", "data"] as const;
  const allowed = new Set<string>([...required, "select"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new UnsupportedOperationError(
    `update arguments require where, data (optional select); received ${Object.keys(value).join(", ") || "none"}.`
  );
}

function defaultSelect(model: Model<any>): Record<string, unknown> {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields — the raw
  // scalar names would leak an omitted column into the public result.
  return Object.fromEntries(
    getDefaultScalarFieldNames(model).map((field: string) => [field, true])
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}
