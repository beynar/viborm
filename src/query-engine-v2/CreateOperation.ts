// biome-ignore-all lint/style/useFilenamingConvention: CreateOperation is the architecture name.
import { NestedWriteError, QueryEngineError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
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
import { buildInsert } from "../query-engine/builders/values-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  buildCreate,
  buildCreateManyPlan,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import { planNestedCreateIdentity } from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  exactlyOneRow,
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import { relationTargetNotFound } from "./messages";
import {
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { OwnWritePreflight } from "./OwnWritePreflight";
import type { Part, PlanningKnown } from "./Part";
import { planningKey, planningOutputs } from "./Part";
import { buildJunctionParts } from "./RelationJunctionPart";
import {
  buildConnectOrCreateParts,
  buildToManyUpsertParts,
  literalParentId,
  type ParentIdSource,
  refParentId,
} from "./RelationUpsertPart";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/**
 * A parent-held-FK to-one `connect` folded into a record's INSERT (WHY §4.2): the
 * target's referenced value becomes the parent row's own FK column, and its
 * existence is pinned by a planning probe (tx: found-at-compile) plus a batch
 * `exists` guard. This is the only parent-held (before-parent) shape V2 owns in a
 * create tree — to-one `create`/`connectOrCreate` (a child INSERT *before* the
 * parent, whose generated identity the parent references) is the deferred
 * before-parent-write ordering and routes to V1 (see the class doc).
 */
interface ToOneConnect {
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly guardId: string;
  readonly probeId: string;
  readonly probe: StatementStep;
  readonly guardProbe: Sql;
  /** FK column → the connect target's referenced value (a compile-time literal). */
  readonly fkAssign: Record<string, unknown>;
}

/** A child-held-FK nested `create` record spliced AFTER this record's INSERT. */
interface ChildCreate {
  readonly record: RecordPlan;
  /** The FK columns this child writes ← their referenced parent columns. */
  readonly inject: Record<string, unknown>;
}

/**
 * A child-held-FK nested `createMany` spliced AFTER this record's INSERT. The
 * rows are lowered to one-or-more INSERT write steps by `buildCreateManyPlan` —
 * one statement per same-shape group, so a heterogeneous batch (e.g. some rows
 * supplying an increment PK, some omitting it) becomes several contiguous
 * grouped INSERTs, exactly as the root `createMany` family (ATOM §8) and V1's
 * grouped execution do. The steps carry no output (the terminal read fetches the
 * created rows).
 */
interface CreateManyGroup {
  readonly steps: readonly StatementStep[];
}

/**
 * One create record in the tree (the root or any nested `create`). It knows its
 * own scalar INSERT, the parent-held connects folded before it, and the
 * child-held work (nested create/createMany + adopt-family/M2M Parts) spliced
 * after it. A record holds only its children and its own identity — never its
 * parent (WHY §4.2): a child edge is handed a resolved FK value, never the
 * parent object.
 */
interface RecordPlan {
  readonly model: Model<any>;
  readonly childScope: QueryScope;
  readonly scalarData: Record<string, unknown>;
  /** The single auto-increment PK captured from the INSERT, if any. */
  readonly generatedField: string | undefined;
  /** The known PK values (literals); the generated PK is absent here. */
  readonly identity: Record<string, unknown>;
  readonly writeStepId: string;
  readonly toOneConnects: readonly ToOneConnect[];
  readonly childCreates: readonly ChildCreate[];
  readonly createManyGroups: readonly CreateManyGroup[];
  readonly afterParts: readonly Part[];
}

/** The record identity a child edge resolves its FK value against. */
interface RecordIdentity {
  readonly writeStepId: string;
  readonly identity: Record<string, unknown>;
  readonly generatedField: string | undefined;
  readonly model: Model<any>;
}

/**
 * The root `create` (PLAN P6-prerequisite — the create family, generalized far
 * beyond the P1 nested-upsert proof slice). It INSERTs the parent (capturing a
 * generated auto-increment identity, or addressing a known one), composes any mix
 * of nested writes, and reads the created row back through the same executor,
 * fragment vocabulary, and Part composition the update/upsert families use.
 *
 * **Fresh-parent elision (ATOM §4) is the central technique.** A child of a
 * parent this operation just created cannot pre-exist against, orphan, or collide
 * with committed state — no correlated probe under it can match — so the adopt
 * family runs GLOBAL (connectOrCreate/upsert adopt any matched row), and a nested
 * `create` is an unconditional INSERT (no probe, no `notExists` guard — its unique
 * violation is a genuine error, never a raceable create-branch signal, because it
 * is not a probe's missing arm). racePins still ride the adopt family's create
 * arms (RelationUpsertPart) per the Pin Rule.
 *
 * Supported (constructs on V2):
 * - root scalars + defaults + generated/known PKs; select/include terminal; the
 *   statement-atomic fast path (one `INSERT … RETURNING select` on a returning
 *   driver with a scalar-only projection — no envelope, the PERF fast path);
 * - child-held-FK to-many: nested `create`/`createMany`/`connect`/
 *   `connectOrCreate`/`upsert` (fresh-parent global adopt), any depth;
 * - parent-held-FK to-one `connect` (fold the referenced value + existence pin);
 * - M2M `connect`/`create`/`connectOrCreate` through the junction.
 *
 * The child-held-FK one-to-many `upsert` is the deliberate P−1.2 Prisma SUPERSET
 * (global lookup, adopt-and-update); V1 rejects it at runtime, so it is the
 * oracle's extension-scenario class, not a V1-parity shape.
 *
 * Routed to V1 with a typed {@link UnsupportedOperationError} (the whole tree):
 * - parent-held-FK to-one `create`/`connectOrCreate` — a child INSERT *before*
 *   the parent whose (possibly generated) identity the parent references (the
 *   deferred before-parent-write ordering; the self-referential grandparent);
 * - a nested `update`/`delete`/`set`/… in a create payload (V1 rejects it too,
 *   with its own typed message — routing yields byte-identical behavior);
 * - M2M `upsert`/`disconnect`/`set`/`delete` under create (V1 rejects M2M upsert
 *   in parent create; the junction upsert needs a planned parent id a fresh
 *   parent cannot give);
 * - a to-one `connect` by a non-referenced unique (needs a lookup subquery);
 * - a nested `createMany skipDuplicates`, or a compound child edge.
 */
export class CreateOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly root: RecordPlan;
  private readonly parsedSelect: Record<string, unknown> | undefined;
  private readonly parsedInclude: Record<string, unknown> | undefined;
  private readonly terminalId: string;
  private readonly planningSteps: OperationStep[] = [];
  private readonly registeredParts = new Set<Part>();
  /** The single-step `INSERT … RETURNING select` fold, when eligible. */
  private readonly foldStep: StatementStep | undefined;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "create");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();

    assertCreateKeys(args);
    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    // V1's whole-args validation runs BEFORE any tree walk (validator.ts): an
    // unknown nested key, a type mismatch, or an omitted-FK violation is a
    // ValidationError with V1's byte-identical message and ordering, and the
    // parsed value carries every scalar default (ulid/cuid/now) materialized — so
    // a nested child's PK is a known literal, not a DB-side default.
    const parsedArgs = validateCreateArgs(parentSchemas.args.create, args);
    const data = requireRecord(parsedArgs.data, "create.data");

    const parent = createQueryScope(engine.adapter, model);
    // Own-write preflight (ATOM §4): reject any payload whose nested decision
    // reads depend on this operation's own writes, before planning.
    new OwnWritePreflight().assertCreate(parent, data);

    const hasSelect = isRecord(parsedArgs.select);
    this.parsedInclude = isRecord(parsedArgs.include)
      ? parsedArgs.include
      : undefined;
    // The projection: an explicit `select`, else the default scalar projection
    // (respecting `.omit()`, exactly as the update/upsert families do). `include`
    // rides alongside the default scalar projection.
    this.parsedSelect = hasSelect
      ? (parsedArgs.select as Record<string, unknown>)
      : this.parsedInclude
        ? undefined
        : defaultSelect(model);
    this.resultArgs = {
      ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
      ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
    };

    this.terminalId = this.scope.allocate(
      `${getStepModelName(model, "record")}.select`
    );

    this.root = this.buildRecord(parent, data, txMode);

    // The statement-atomic fast path (PERF): a pure scalar create — no nested
    // relation work — with a scalar-only projection on a RETURNING driver folds
    // into ONE `INSERT … RETURNING select`, the created row (incl. any generated
    // PK) coming straight back. Empty planning + one step + no ref/insertId → the
    // executor runs it directly with no transaction/batch envelope.
    const isPureScalar =
      this.root.toOneConnects.length === 0 &&
      this.root.childCreates.length === 0 &&
      this.root.createManyGroups.length === 0 &&
      this.root.afterParts.length === 0;
    this.foldStep =
      txMode &&
      isPureScalar &&
      this.projectionIsScalarOnly() &&
      engine.adapter.capabilities.supportsReturning
        ? {
            id: this.root.writeStepId,
            kind: "write",
            statement: buildCreate(parent, {
              data: this.root.scalarData,
              ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
            }),
            outputs: { result: { kind: "rows" } },
            expects: exactlyOneRow(terminalFailure()),
          }
        : undefined;
  }

  planning(): OperationFragment {
    if (this.foldStep) return { steps: [], outputs: {} };
    return {
      steps: this.planningSteps,
      outputs: planningOutputs(this.planningSteps),
    };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    if (this.foldStep) {
      return {
        steps: [this.foldStep],
        outputs: { result: ref(this.root.writeStepId, "result") },
      };
    }
    const guards: OperationStep[] = [];
    const writes: OperationStep[] = [];
    this.emitRecord(this.root, {}, known, guards, writes);
    return {
      steps: [...guards, ...writes, this.buildTerminal(this.root)],
      outputs: { result: ref(this.terminalId, "result") },
    };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 create did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>("create", outputs.result, this.resultArgs);
  }

  // -------------------------------------------------------------------------

  /**
   * Interpret one create record: separate its scalars from its relations,
   * allocate its INSERT step, and fold each relation into a before-parent connect,
   * a child-held create/createMany, or an after-parent adopt/M2M Part. Recurses on
   * nested `create` arms. Planning probes are registered on {@link planningSteps}.
   */
  private buildRecord(
    childScope: QueryScope,
    data: Record<string, unknown>,
    txMode: boolean
  ): RecordPlan {
    const model = childScope.model;
    const separated = separateData(childScope, data);
    const { identity, generatedField } = planNestedCreateIdentity(
      model,
      separated.scalarData
    );
    const scalarData = { ...separated.scalarData };
    if (generatedField) delete scalarData[generatedField];

    const recordName = getStepModelName(model, "record");
    const writeStepId = this.scope.allocate(`${recordName}.create`);
    const self: RecordIdentity = {
      writeStepId,
      identity,
      generatedField,
      model,
    };

    const toOneConnects: ToOneConnect[] = [];
    const childCreates: ChildCreate[] = [];
    const createManyGroups: CreateManyGroup[] = [];
    const afterParts: Part[] = [];

    for (const [relationName, mutation] of Object.entries(
      separated.relations
    )) {
      this.interpretRelation({
        childScope,
        self,
        relationName,
        mutation,
        relationInput: requireRecord(
          data[relationName],
          `data.${relationName}`
        ),
        txMode,
        toOneConnects,
        childCreates,
        createManyGroups,
        afterParts,
      });
    }

    this.registerPlanning(afterParts);

    return {
      model,
      childScope,
      scalarData,
      generatedField,
      identity,
      writeStepId,
      toOneConnects,
      childCreates,
      createManyGroups,
      afterParts,
    };
  }

  private interpretRelation(input: {
    childScope: QueryScope;
    self: RecordIdentity;
    relationName: string;
    mutation: RelationMutation;
    relationInput: Record<string, unknown>;
    txMode: boolean;
    toOneConnects: ToOneConnect[];
    childCreates: ChildCreate[];
    createManyGroups: CreateManyGroup[];
    afterParts: Part[];
  }): void {
    const { relationName, mutation, txMode, relationInput } = input;
    const relationInfo = mutation.relationInfo;
    const kinds = getRelationMutationKinds(mutation);

    if (relationInfo.type === "manyToMany") {
      // M2M is not special (WHY §4.3): the junction composes as ordinary Parts. A
      // fresh parent has no existing memberships, so connect/create/connectOrCreate
      // only add join rows (elision). create/connect/connectOrCreate are the
      // create-tree M2M surface; disconnect/set/delete/upsert route to V1 (its
      // rejection). M2M `upsert` under create is NOT the P−1.2 one-to-many
      // superset — V1 rejects it (`NestedWriteError: … not supported in parent
      // create`), so V2 declines it at construction and the whole tree routes to
      // V1 for that byte-identical rejection (the junction upsert Part needs a
      // *planned* parent id, which a fresh parent cannot supply — deferring the
      // decision to compile would hard-fail instead of routing).
      this.assertCreateTreeKinds(kinds, relationName);
      input.afterParts.push(
        ...buildJunctionParts({
          scope: this.scope,
          engine: this.engine,
          parentScope: input.childScope,
          relationName,
          relationInfo,
          mutation,
          parsedRelation: relationInput,
          parentId: this.edgeParentId(
            input.self,
            getPrimaryKeyFields(input.self.model),
            relationName
          ),
          txMode,
        })
      );
      return;
    }

    const fk = getFkDirection(input.childScope, relationInfo);
    if (fk.holdsFK) {
      this.interpretParentHeld(input, relationInfo, fk, kinds);
      return;
    }
    // A child-held relation this record is the referenced side of: to-many
    // (`oneToMany`) or a to-one inverse (`oneToOne`, the child holding the FK).
    // The create-tree mechanics are direction-based, not arity-based — a child
    // INSERTs AFTER the parent with `fk = parent`, riding the same already-certified
    // own-write machinery (a sibling reading a just-created child is still rejected
    // by the OwnWritePreflight). A to-one is the arity-1 case of that path; the
    // mixed-directions conformance scenario and the create-family oracle certify the
    // one-to-one `create`. Any OTHER type here is a schema impossibility (M2M and
    // parent-held were dispatched above) — kept as a defensive internal guard.
    if (relationInfo.type !== "oneToMany" && relationInfo.type !== "oneToOne") {
      throw new UnsupportedOperationError(
        `query-engine-v2 create supports only child-held one-to-many / one-to-one relations; relation '${relationName}' is '${relationInfo.type}'.`
      );
    }
    this.interpretChildHeld(input, relationInfo, fk, kinds);
  }

  /** A parent-held-FK to-one relation: only `connect` (fold + pin) is on V2. */
  private interpretParentHeld(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relationInfo: RelationInfo,
    fk: FkDirection,
    kinds: readonly string[]
  ): void {
    const { relationName, relationInput } = input;
    if (kinds.length !== 1 || kinds[0] !== "connect") {
      // to-one create / connectOrCreate is a child INSERT before the parent whose
      // (possibly generated) identity the parent references — the deferred
      // before-parent-write ordering. Route the whole tree to V1.
      throw new UnsupportedOperationError(
        `query-engine-v2 create supports only 'connect' on the to-one relation '${relationName}'; it has ${kinds.join(", ") || "none"}.`
      );
    }
    // Shared-primary-key connect: the FK the parent holds IS (part of) this
    // record's own primary key (a one-to-one shared-PK relation). The PK is then
    // supplied by the connect fold, not by scalar data, so the terminal read has
    // no known identity to address the created row by — route the tree to V1,
    // whose `getCreatedRowWhere` resolves the shared PK from the connect target.
    const recordPk = getPrimaryKeyFields(input.self.model);
    if (fk.fkFields.some((fkField) => recordPk.includes(fkField))) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create does not support a shared-primary-key connect on relation '${relationName}' (the foreign key '${fk.fkFields.join(", ")}' is this record's primary key).`
      );
    }
    const where = normalizeSingle(relationInput.connect, relationName);
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    const fkAssign: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      const referenced = fk.pkFields[index]!;
      if (!Object.hasOwn(where, referenced)) {
        // Connect by a non-referenced unique needs a lookup subquery — V1's
        // surface, out of the create fold's scope.
        throw new UnsupportedOperationError(
          `query-engine-v2 create to-one connect for relation '${relationName}' must reference '${referenced}' directly.`
        );
      }
      fkAssign[fk.fkFields[index]!] = referenceSql(
        this.engine,
        input.self.model,
        fk.fkFields[index]!,
        where[referenced]
      );
    }
    const childName = getStepModelName(relationInfo.targetModel, relationName);
    const probeId = this.scope.allocate(`${childName}.find`);
    const guardId = this.scope.allocate(`${childName}.guard.exists`);
    const pkSelect = Object.fromEntries(fk.pkFields.map((f) => [f, true]));
    input.toOneConnects.push({
      relationName,
      relationInfo,
      guardId,
      probeId,
      probe: {
        id: probeId,
        kind: "read",
        statement: buildFindUnique(childScope, {
          where,
          select: pkSelect,
          forUpdate: input.txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      },
      guardProbe: buildFindUnique(childScope, { where, select: pkSelect }),
      fkAssign,
    });
    this.planningSteps.push(input.toOneConnects.at(-1)!.probe);
  }

  /** A child-held-FK to-many relation: create/createMany/connect/adopt (after). */
  private interpretChildHeld(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    relationInfo: RelationInfo,
    fk: FkDirection,
    kinds: readonly string[]
  ): void {
    const { txMode, relationName, relationInput } = input;
    const childScope = createQueryScope(
      this.engine.adapter,
      relationInfo.targetModel
    );
    for (const kind of kinds) {
      switch (kind) {
        case "create":
          this.foldChildCreates(input, childScope, fk, relationInput.create);
          break;
        case "createMany":
          this.foldCreateMany(input, childScope, fk, relationInput.createMany);
          break;
        case "connect":
          input.afterParts.push(
            ...normalizeItems(relationInput.connect, relationName).map(
              (where) =>
                new ChildConnectPart(this.scope, {
                  engine: this.engine,
                  childScope,
                  childName: getStepModelName(
                    relationInfo.targetModel,
                    relationName
                  ),
                  relationName,
                  relationInfo,
                  where,
                  fkAssign: this.childFkAssign(
                    input.self,
                    fk,
                    childScope.model,
                    relationName
                  ),
                  txMode,
                })
            )
          );
          break;
        case "connectOrCreate":
          input.afterParts.push(
            ...buildConnectOrCreateParts(
              this.scope,
              input.childScope,
              this.engine,
              relationName,
              relationInfo,
              normalizeItems(relationInput.connectOrCreate, relationName),
              this.edgeParentId(input.self, fk.pkFields, relationName),
              txMode
            )
          );
          break;
        case "upsert":
          input.afterParts.push(
            ...buildToManyUpsertParts(
              this.scope,
              input.childScope,
              this.engine,
              relationName,
              relationInfo,
              normalizeItems(relationInput.upsert, relationName),
              this.edgeParentId(input.self, fk.pkFields, relationName),
              "global-adopt",
              txMode,
              "upsert"
            )
          );
          break;
        default:
          // create/connect/connectOrCreate/upsert are the create-tree child
          // surface; update/delete/set/… are V1's rejection (routed to V1).
          throw new UnsupportedOperationError(
            `query-engine-v2 create does not support nested '${kind}' on relation '${relationName}'.`
          );
      }
    }
  }

  /** Nested `create` items: each a full child record spliced after the parent. */
  private foldChildCreates(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    childScope: QueryScope,
    fk: FkDirection,
    createInput: unknown
  ): void {
    const inject = this.childFkAssign(
      input.self,
      fk,
      childScope.model,
      input.relationName
    );
    for (const item of normalizeItems(createInput, input.relationName)) {
      input.childCreates.push({
        record: this.buildRecord(childScope, item, input.txMode),
        inject,
      });
    }
  }

  /** Nested `createMany`: FK-injected rows spliced after the parent (one INSERT). */
  private foldCreateMany(
    input: Parameters<CreateOperation["interpretRelation"]>[0],
    childScope: QueryScope,
    fk: FkDirection,
    createManyInput: unknown
  ): void {
    const createMany = requireRecord(
      createManyInput,
      `${input.relationName}.createMany`
    );
    if (createMany.skipDuplicates === true) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create does not support nested createMany skipDuplicates on relation '${input.relationName}'.`
      );
    }
    const inject = this.childFkAssign(
      input.self,
      fk,
      childScope.model,
      input.relationName
    );
    const rows = normalizeItems(createMany.data, input.relationName).map(
      (row) => ({ ...row, ...inject })
    );
    if (rows.length === 0) return;
    // Lower to grouped INSERTs (buildCreateManyPlan): one statement per same-shape
    // group, so heterogeneous rows (some supplying a generated PK, some omitting
    // it) split into contiguous grouped INSERTs — full parity with V1's grouped
    // execution, never the single-VALUES "Heterogeneous insert rows" hard-fail.
    const plan = buildCreateManyPlan(childScope, { data: rows }, false);
    const base = getStepModelName(childScope.model, input.relationName);
    input.createManyGroups.push({
      steps: plan.statements.map((statement) => ({
        id: this.scope.allocate(`${base}.createMany`),
        kind: "write" as const,
        statement: statement.sql,
        outputs: {},
      })),
    });
  }

  private registerPlanning(parts: readonly Part[]): void {
    for (const part of parts) {
      if (this.registeredParts.has(part)) continue;
      this.registeredParts.add(part);
      this.planningSteps.push(...part.planning(this.scope));
    }
  }

  /** The FK columns a child edge writes ← its referenced parent columns. */
  private childFkAssign(
    self: RecordIdentity,
    fk: FkDirection,
    childModel: Model<any>,
    relationName: string
  ): Record<string, unknown> {
    const assign: Record<string, unknown> = {};
    for (let index = 0; index < fk.fkFields.length; index += 1) {
      assign[fk.fkFields[index]!] = referenceSql(
        this.engine,
        childModel,
        fk.fkFields[index]!,
        this.referencedValue(self, fk.pkFields[index]!, relationName)
      );
    }
    return assign;
  }

  /** The parent value a child FK references — a Ref to the captured generated id,
   *  or a known literal identity value. */
  private referencedValue(
    self: RecordIdentity,
    referencedField: string,
    relationName: string
  ): unknown {
    if (self.generatedField === referencedField) {
      return ref(self.writeStepId, "id");
    }
    if (Object.hasOwn(self.identity, referencedField)) {
      return self.identity[referencedField];
    }
    throw new UnsupportedOperationError(
      `query-engine-v2 create cannot resolve referenced field '${referencedField}' for relation '${relationName}'.`
    );
  }

  /** The {@link ParentIdSource} an after-parent adopt/M2M Part consumes (the
   *  existing Parts read a single referenced parent value). */
  private edgeParentId(
    self: RecordIdentity,
    referencedFields: readonly string[],
    relationName: string
  ): ParentIdSource {
    if (referencedFields.length !== 1) {
      throw new UnsupportedOperationError(
        `query-engine-v2 create does not support a compound child edge on relation '${relationName}'.`
      );
    }
    const referenced = referencedFields[0]!;
    if (self.generatedField === referenced) {
      return refParentId(self.writeStepId);
    }
    if (Object.hasOwn(self.identity, referenced)) {
      return literalParentId(self.identity[referenced]);
    }
    throw new UnsupportedOperationError(
      `query-engine-v2 create cannot resolve the parent id for relation '${relationName}'.`
    );
  }

  // -------------------------------------------------------------------------

  private emitRecord(
    plan: RecordPlan,
    inject: Record<string, unknown>,
    known: Readonly<Record<string, unknown>>,
    guards: OperationStep[],
    writes: OperationStep[]
  ): void {
    // 1. Before the INSERT: fold each to-one connect's FK value in, and pin the
    //    target's existence (tx: found-at-compile throw; batch: exists guard).
    const insertData: Record<string, unknown> = {
      ...plan.scalarData,
      ...inject,
    };
    for (const connect of plan.toOneConnects) {
      this.requireConnectFound(connect, known);
      Object.assign(insertData, connect.fkAssign);
      if (this.mode === "batch") {
        guards.push(
          presenceGuard(
            connect.guardId,
            connect.guardProbe,
            nestedWriteFailure(
              relationTargetNotFound(connect.relationInfo, "connect"),
              connect.relationName,
              false
            )
          )
        );
      }
    }

    // 2. The record's own INSERT.
    writes.push(this.buildInsertStep(plan, insertData));

    // 3. After the INSERT: child-held creates (recurse), createMany, and the
    //    adopt/M2M Parts — all correlated to this record's (fresh) identity.
    for (const child of plan.childCreates) {
      this.emitRecord(child.record, child.inject, known, guards, writes);
    }
    for (const group of plan.createManyGroups) {
      for (const step of group.steps) writes.push(step);
    }
    for (const part of plan.afterParts) {
      for (const step of part.compile(this.scope, known)) {
        (step.kind === "guard" ? guards : writes).push(step);
      }
    }
  }

  private requireConnectFound(
    connect: ToOneConnect,
    known: Readonly<Record<string, unknown>>
  ): void {
    const rows = known[planningKey(connect.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 create connect probe for relation '${connect.relationName}' did not expose rows.`,
        connect.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(connect.relationInfo, "connect"),
        connect.relationName
      );
    }
  }

  private buildInsertStep(
    plan: RecordPlan,
    insertData: Record<string, unknown>
  ): StatementStep {
    const { childScope, generatedField, writeStepId } = plan;
    const txMode = this.mode === "transaction";
    if (!generatedField) {
      return {
        id: writeStepId,
        kind: "write",
        statement: buildInsert(
          childScope,
          getTableName(childScope.model),
          insertData
        ),
        outputs: {},
      };
    }
    // Capture the generated auto-increment identity: `firstRowField` on a
    // returning driver in tx mode (INSERT … RETURNING pk), else the driver's
    // `insertId` (scratch-threaded in batch mode by the executor).
    const returning = this.engine.adapter.capabilities.supportsReturning;
    return {
      id: writeStepId,
      kind: "write",
      statement:
        txMode && returning
          ? buildCreate(childScope, {
              data: insertData,
              select: { [generatedField]: true },
            })
          : buildInsert(childScope, getTableName(childScope.model), insertData),
      outputs: {
        id:
          txMode && returning
            ? { kind: "firstRowField", field: generatedField }
            : { kind: "insertId" },
      },
    };
  }

  private buildTerminal(plan: RecordPlan): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    const where = plan.generatedField
      ? {
          [plan.generatedField]: referenceSql(
            this.engine,
            this.model,
            plan.generatedField,
            ref(plan.writeStepId, "id")
          ),
        }
      : buildPrimaryKeyWhereUnique(this.model, plan.identity);
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where,
        ...(this.parsedSelect ? { select: this.parsedSelect } : {}),
        ...(this.parsedInclude ? { include: this.parsedInclude } : {}),
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode ? { expects: exactlyOneRow(terminalFailure()) } : {}),
    };
  }

  private projectionIsScalarOnly(): boolean {
    if (this.parsedInclude) return false;
    if (!this.parsedSelect) return true;
    return !Object.keys(this.parsedSelect).some((field) =>
      this.model["~"].relationSet.has(field)
    );
  }

  private assertCreateTreeKinds(
    kinds: readonly string[],
    relationName: string
  ): void {
    // The M2M create-tree surface: create/connect/connectOrCreate only. `upsert`
    // (and disconnect/set/delete) route to V1 — V1 rejects M2M upsert-under-create
    // outright, so declining it here at construction yields V1's byte-identical
    // NestedWriteError, never a compile-time hard failure.
    for (const kind of kinds) {
      if (
        kind !== "create" &&
        kind !== "connect" &&
        kind !== "connectOrCreate"
      ) {
        throw new UnsupportedOperationError(
          `query-engine-v2 create does not support nested '${kind}' on the many-to-many relation '${relationName}'.`
        );
      }
    }
  }
}

/**
 * A child-held-FK `connect` under a create tree: adopt an existing global row by
 * setting its FK to the freshly-created parent. A fresh parent means the target
 * cannot already be correlated, so this is a pure global reparent (ATOM §4): plan
 * an uncorrelated existence probe, compile `UPDATE child SET fk = parent WHERE
 * unique`, pinned in batch by an `exists` guard. Absent → V1's verbatim
 * `Cannot connect …`. The parent value arrives as a ready {@link referenceSql}
 * assignment (Ref or literal), so it serves both a generated and a known parent id.
 */
interface ChildConnectConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly where: Record<string, unknown>;
  readonly fkAssign: Record<string, unknown>;
  readonly txMode: boolean;
}

class ChildConnectPart implements Part {
  private readonly config: ChildConnectConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardId: string;
  private readonly probe: StatementStep;

  constructor(scope: StepScope, config: ChildConnectConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.connect`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    this.probe = {
      id: this.probeId,
      kind: "read",
      statement: buildFindUnique(config.childScope, {
        where: config.where,
        select: this.pkSelect(),
        forUpdate: config.txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };
  }

  planning(): readonly OperationStep[] {
    return [this.probe];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new NestedWriteError(
        relationTargetNotFound(this.config.relationInfo, "connect"),
        this.config.relationName
      );
    }
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      steps.push(
        presenceGuard(
          this.guardId,
          buildFindUnique(this.config.childScope, {
            where: this.config.where,
            select: this.pkSelect(),
          }),
          nestedWriteFailure(
            relationTargetNotFound(this.config.relationInfo, "connect"),
            this.config.relationName,
            false
          )
        )
      );
    }
    steps.push({
      id: this.writeId,
      kind: "write",
      statement: buildUpdate(this.config.childScope, {
        where: this.config.where,
        data: this.config.fkAssign,
        select: this.pkSelect(),
      }),
      outputs: {},
    });
    return steps;
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(
      getPrimaryKeyFields(this.config.childScope.model).map((f) => [f, true])
    );
  }
}

// ---------------------------------------------------------------------------

function terminalFailure() {
  return {
    kind: "query" as const,
    message: "query-engine-v2 create terminal read expected exactly one row.",
    raceable: false,
  };
}

function defaultSelect(model: Model<any>): Record<string, unknown> | undefined {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields — the raw
  // scalar names would leak an omitted column into the public result. When EVERY
  // scalar is `.omit()`-ed the projection is empty; an explicit `select: {}` is
  // invalid SQL ("needs at least one truthy value"), so we return undefined and
  // let the terminal read + ResultParser produce the empty public object `{}`
  // exactly as `ReadOperation`/`findUnique` does with no select (the read builder
  // already excludes omitted columns).
  const fields = getDefaultScalarFieldNames(model);
  if (fields.length === 0) return undefined;
  return Object.fromEntries(fields.map((field: string) => [field, true]));
}

function assertCreateKeys(value: Record<string, unknown>): void {
  const allowed = new Set(["data", "select", "include"]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (!Object.hasOwn(value, "data") || unexpected.length > 0) {
    throw new UnsupportedOperationError(
      `create arguments require data (optional select, include); received ${Object.keys(value).join(", ") || "none"}.`
    );
  }
}

function validateCreateArgs(
  schema: VibSchema,
  args: unknown
): Record<string, unknown> {
  const result = parse(schema, args);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "create",
      result.issues.map((issue) => ({
        path: issue.path?.map(String).join(".") || "root",
        message: issue.message,
      }))
    );
  }
  if (!isRecord(result.value)) {
    throw new QueryEngineError("Validated create arguments are not an object.");
  }
  return result.value;
}

function normalizeSingle(
  value: unknown,
  relationName: string
): Record<string, unknown> {
  const item = Array.isArray(value) ? value[0] : value;
  if (!isRecord(item)) {
    throw new UnsupportedOperationError(
      `query-engine-v2 create to-one connect for relation '${relationName}' requires a single unique where.`
    );
  }
  return item;
}

function normalizeItems(
  value: unknown,
  relationName: string
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!isRecord(item)) {
      throw new QueryEngineError(
        `Relation '${relationName}' create item must be an object.`
      );
    }
    return item;
  });
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}
