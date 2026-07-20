// biome-ignore-all lint/style/useFilenamingConvention: UpsertOperation is the architecture name.
import { QueryEngineError, ValidationError } from "@errors";
import type { Model } from "@schema/model";
import { parse, type VibSchema } from "@validation";
import {
  buildPrimaryKeyWhereUnique,
  getPrimaryKeyFields,
} from "../query-engine/builders/correlation-utils";
import { separateData } from "../query-engine/builders/relation-data-builder";
import { buildInsert } from "../query-engine/builders/values-builder";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  createQueryScope,
  getDefaultScalarFieldNames,
  getTableName,
} from "../query-engine/context/query-scope";
import {
  buildFind,
  buildFindUnique,
  buildUpdate,
} from "../query-engine/operations";
import { getUpdatedPrimaryKeyWhere } from "../query-engine/operations/mutation-identity";
import type { QueryEngine } from "../query-engine/query-engine";
import { ResultParser } from "../query-engine/result/ResultParser";
import type { QueryScope } from "../query-engine/types";
import {
  absenceGuard,
  affectedRows,
  childRacePin,
  exactlyOneRow,
  notFoundFailure,
  presenceGuard,
  queryFailure,
  raceableQueryFailure,
} from "./fragment-builders";
import { upsertSkipPremiseChanged } from "./messages";
import {
  type OperationFragment,
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import { planningKey, planningOutputs } from "./Part";
import { StepScope } from "./StepScope";
import {
  getStepModelName,
  isRecord,
  selectExecutionMode,
  UnsupportedOperationError,
} from "./shared";

type ExecutionMode = "transaction" | "batch";

/** A validated conditional filter on the located row (`targetWhere`/`setWhere`). */
interface Conditional {
  readonly field: "setWhere" | "targetWhere";
  readonly where: Record<string, unknown>;
  readonly probeId: string;
  readonly guardId: string;
  readonly probe: StatementStep;
}

/**
 * The root (top-level) `upsert` (PLAN P2b), **probe-first per ATOM §2/§4** — the
 * `ON CONFLICT` narrow door is deliberately NOT taken (see the P2b report's
 * disposition): a locate read decides create-vs-update at planning, and every
 * premise is pinned to the vocabulary the update/delete family already uses. It
 * locates the row by any unique `where`; absent → the create arm (constraint +
 * `racePin`, never a guard); present → the update arm, unless a `targetWhere` /
 * `setWhere` conditional does not match, in which case V1's silent no-op skip
 * fires — pinned by the **retained `notExists`** guard (ATOM §2, `raceable:
 * true`). Scalar arms only; any nested relation mutation in an arm is a typed
 * {@link UnsupportedOperationError} that routes the whole tree to V1.
 */
export class UpsertOperation {
  readonly mode: ExecutionMode;

  private readonly engine: QueryEngine;
  private readonly model: Model<any>;
  private readonly scope: StepScope;
  private readonly resultArgs: Record<string, unknown>;
  private readonly parentWhere: Record<string, unknown>;
  private readonly parentPrimaryKeys: readonly string[];
  private readonly createData: Record<string, unknown>;
  private readonly updateData: Record<string, unknown>;
  private readonly conditionals: readonly Conditional[];
  private readonly locate: StatementStep;
  private readonly createId: string;
  private readonly updateId: string;
  private readonly terminalId: string;
  private readonly foundGuardId: string;

  constructor(
    engine: QueryEngine,
    model: Model<any>,
    args: Record<string, unknown>
  ) {
    this.engine = engine;
    this.model = model;
    this.mode = selectExecutionMode(engine, "upsert");
    const txMode = this.mode === "transaction";
    this.scope = new StepScope();
    const scope = this.scope;

    assertUpsertKeys(args);
    const where = requireRecord(args.where, "upsert.where");
    const create = requireRecord(args.create, "upsert.create");
    const update = requireRecord(args.update, "upsert.update");
    const parent = createQueryScope(engine.adapter, model);

    const parentPrimaryKeys = getPrimaryKeyFields(model);
    if (parentPrimaryKeys.length === 0) {
      throw new UnsupportedOperationError(
        "query-engine-v2 upsert requires a parent with a primary key."
      );
    }
    // Compound primary keys are supported: every probe/guard selects each PK
    // field; the create/update arms target the parsed compound where-unique, and
    // `childRacePin`/`getWhereUniqueEntries` already expand the compound key.
    this.parentPrimaryKeys = parentPrimaryKeys;

    // Scalar arms only. A nested relation mutation in either arm routes the whole
    // tree to V1 (P2b scope) — the create/update arms compose the same Parts the
    // update family uses, but that surface is deferred; recorded in the report.
    const createSep = separateData(parent, create);
    const updateSep = separateData(parent, update);
    if (
      Object.keys(createSep.relations).length > 0 ||
      Object.keys(updateSep.relations).length > 0
    ) {
      throw new UnsupportedOperationError(
        "query-engine-v2 upsert supports only scalar create/update arms; nested relation mutations route to V1."
      );
    }

    const parentSchemas = engine.schemaRegistry.getModelSchemas(model);
    this.parentWhere = parseRecord(
      parentSchemas.core.whereUnique,
      where,
      "where"
    );
    this.createData = parseRecord(
      parentSchemas.core.scalarCreate,
      createSep.scalarData,
      "create"
    );
    this.updateData = parseRecord(
      parentSchemas.core.scalarUpdate,
      updateSep.scalarData,
      "update"
    );
    const parsedSelect = isRecord(args.select)
      ? parseRecord(parentSchemas.core.select, args.select, "select")
      : defaultSelect(model);
    this.resultArgs = { select: parsedSelect };

    const parentName = getStepModelName(model, "parent");
    const locateId = scope.allocate(`${parentName}.locate`);
    this.createId = scope.allocate(`${parentName}.create`);
    this.updateId = scope.allocate(`${parentName}.update`);
    this.terminalId = scope.allocate(`${parentName}.select`);
    this.foundGuardId = scope.allocate(`${parentName}.guard.exists`);

    // The conditional filters (`targetWhere`/`setWhere`) each become one widened
    // planning probe: `where ∧ conditional`. compile evaluates them in JS (SQL
    // did the matching) and pins the taken outcome.
    this.conditionals = this.buildConditionals(parent, parentSchemas, {
      targetWhere: args.targetWhere,
      setWhere: args.setWhere,
    });

    // The locate read decides create-vs-update. It carries NO postcondition — a
    // missing row is the create arm, not a not-found error (upsert's contract).
    this.locate = {
      id: locateId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where: this.parentWhere,
        select: this.pkSelect(),
        forUpdate: txMode,
      }),
      outputs: { rows: { kind: "rows" } },
    };
  }

  planning(): OperationFragment {
    const steps: OperationStep[] = [this.locate];
    for (const conditional of this.conditionals) steps.push(conditional.probe);
    return { steps, outputs: planningOutputs(steps) };
  }

  compile(known: Readonly<Record<string, unknown>>): OperationFragment {
    const locateRows = known[planningKey(this.locate.id, "rows")];
    if (!Array.isArray(locateRows)) {
      throw new QueryEngineError(
        "query-engine-v2 upsert planning did not expose the locate rows."
      );
    }
    const steps =
      locateRows.length === 0
        ? this.compileCreateArm()
        : this.compileFoundArm(known, locateRows[0] as Record<string, unknown>);
    return { steps, outputs: { result: ref(this.terminalId, "result") } };
  }

  parse<T>(outputs: Readonly<Record<string, unknown>>): T {
    if (!Object.hasOwn(outputs, "result")) {
      throw new QueryEngineError(
        "query-engine-v2 upsert did not expose its result."
      );
    }
    return new ResultParser(
      this.engine.adapter,
      this.model,
      this.engine.driver
    ).parse<T>("upsert", outputs.result, this.resultArgs);
  }

  // -------------------------------------------------------------------------

  /** Absent → CREATE (constraint + `racePin`, never a guard) then terminal read. */
  private compileCreateArm(): OperationStep[] {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const create: StatementStep = {
      id: this.createId,
      kind: "write",
      statement: buildInsert(parent, getTableName(this.model), this.createData),
      outputs: {},
      // The missing premise is enforced by the unique constraint the `where`
      // targets; its violation is the raceable create-branch signal.
      racePin: childRacePin(parent, this.parentWhere),
    };
    // The created row is read back by its own primary key when the create data
    // carries it — the `where` may target a non-PK unique the create data does
    // not reproduce, so reading by `where` could miss the row it just inserted.
    return [create, this.buildTerminal(this.createArmTerminalWhere())];
  }

  /** Present → skip (conditional no-match) or update (all conditionals match). */
  private compileFoundArm(
    known: Readonly<Record<string, unknown>>,
    locatedRow: Record<string, unknown>
  ): OperationStep[] {
    const unmatched = this.conditionals.find(
      (conditional) => !this.conditionalMatched(conditional, known)
    );
    if (unmatched) return this.compileSkipArm(unmatched, locatedRow);
    return this.compileUpdateArm(locatedRow);
  }

  /**
   * A conditional did not match → silent no-op (V1's contract): no write, just
   * the terminal read of the unchanged row. Batch mode pins the skip premise with
   * the retained `notExists` guard (the row still does NOT match the conditional,
   * `raceable: true`); transaction mode's locked probe pins it, needing no guard.
   */
  private compileSkipArm(
    unmatched: Conditional,
    locatedRow: Record<string, unknown>
  ): OperationStep[] {
    const terminalWhere = this.locatedTerminalWhere(locatedRow);
    if (this.mode === "transaction") return [this.buildTerminal(terminalWhere)];
    return [
      absenceGuard(
        unmatched.guardId,
        unmatched.probe.statement,
        raceableQueryFailure(upsertSkipPremiseChanged(unmatched.field))
      ),
      this.buildTerminal(terminalWhere),
    ];
  }

  /** All conditionals match (or none present) → UPDATE the located row. */
  private compileUpdateArm(
    locatedRow: Record<string, unknown>
  ): OperationStep[] {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    const guards: OperationStep[] = [];
    if (!txMode) {
      // Batch pins the update premise inside the atomic unit. Each conditional's
      // match is pinned (exists, `raceable: false`); with none present a plain
      // found premise on `where` catches a concurrent delete (both fail closed —
      // the retry re-plans and converges).
      if (this.conditionals.length === 0) {
        guards.push(
          presenceGuard(
            this.foundGuardId,
            buildFindUnique(parent, {
              where: this.parentWhere,
              select: this.pkSelect(),
            }),
            notFoundFailure(this.locateMissMessage())
          )
        );
      } else {
        for (const conditional of this.conditionals) {
          guards.push(
            presenceGuard(
              conditional.guardId,
              conditional.probe.statement,
              queryFailure(
                `query-engine-v2 top-level upsert ${conditional.field} match premise changed before the atomic batch.`
              )
            )
          );
        }
      }
    }
    const update: StatementStep = {
      id: this.updateId,
      kind: "write",
      statement: buildUpdate(parent, {
        where: this.parentWhere,
        data: this.updateData,
        select: this.pkSelect(),
      }),
      outputs: {},
      // Exact-affected is a returning-driver check only (see UpdateOperation): on
      // a non-returning driver the locked locate already proved the row exists, so
      // a no-op UPDATE (0 rows changed) is V1's accepted contract, not a NotFound.
      ...(txMode && this.engine.adapter.capabilities.supportsReturning
        ? {
            expects: affectedRows(1, notFoundFailure(this.locateMissMessage())),
          }
        : {}),
    };
    // The update arm may rewrite the very field the `where` located the row by
    // (a non-PK unique) or the PK itself. The terminal read must therefore address
    // the row by its POST-update primary key, not the original `where`, exactly as
    // UpdateOperation does — otherwise a renamed row is invisible to its own read.
    return [
      ...guards,
      update,
      this.buildTerminal(this.updatedTerminalWhere(locatedRow)),
    ];
  }

  private buildTerminal(where: Record<string, unknown>): StatementStep {
    const parent = createQueryScope(this.engine.adapter, this.model);
    const txMode = this.mode === "transaction";
    return {
      id: this.terminalId,
      kind: "read",
      statement: buildFindUnique(parent, {
        where,
        select: this.resultArgs.select as Record<string, unknown>,
      }),
      outputs: { result: { kind: "rows" } },
      ...(txMode
        ? {
            expects: exactlyOneRow(
              queryFailure(
                "query-engine-v2 upsert terminal read expected exactly one row."
              )
            ),
          }
        : {}),
    };
  }

  /** The terminal where addressing the located (unchanged) row by its PK — the
   *  skip arm reads the row without mutating it. */
  private locatedTerminalWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, locatedRow[pk]])
      )
    );
  }

  /**
   * The terminal where addressing the located row by its POST-update primary
   * key: the update arm may rewrite a PK field (literal or portable arithmetic),
   * moving the identity the located pre-update row no longer answers to. Reuses
   * V1's `getUpdatedPrimaryKeyWhere` (unchanged located PK when the update leaves
   * it alone; the same typed refusal of an ambiguous PK operation).
   */
  private updatedTerminalWhere(
    locatedRow: Record<string, unknown>
  ): Record<string, unknown> {
    const parent = createQueryScope(this.engine.adapter, this.model);
    return getUpdatedPrimaryKeyWhere(
      parent,
      locatedRow,
      this.updateData,
      getStepModelName(this.model, "record")
    );
  }

  /**
   * The create arm's terminal where: the created row's primary key when the
   * create data carries every PK field (the common provided-PK case), else the
   * original `where` — the fallback for an auto-generated identity, whose created
   * row is addressable only by the unique `where` it was inserted to satisfy.
   */
  private createArmTerminalWhere(): Record<string, unknown> {
    const hasEveryPk = this.parentPrimaryKeys.every(
      (pk) => this.createData[pk] !== undefined
    );
    if (!hasEveryPk) return this.parentWhere;
    return buildPrimaryKeyWhereUnique(
      this.model,
      Object.fromEntries(
        this.parentPrimaryKeys.map((pk) => [pk, this.createData[pk]])
      )
    );
  }

  private pkSelect(): Record<string, boolean> {
    return Object.fromEntries(this.parentPrimaryKeys.map((pk) => [pk, true]));
  }

  private buildConditionals(
    parent: QueryScope,
    parentSchemas: ReturnType<QueryEngine["schemaRegistry"]["getModelSchemas"]>,
    inputs: { targetWhere: unknown; setWhere: unknown }
  ): readonly Conditional[] {
    const txMode = this.mode === "transaction";
    const parentName = getStepModelName(this.model, "parent");
    const uniqueFilters = getWhereUniqueEntries(parent, this.parentWhere).map(
      ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
    );
    const conditionals: Conditional[] = [];
    for (const field of ["targetWhere", "setWhere"] as const) {
      const raw = inputs[field];
      if (!(isRecord(raw) && Object.keys(raw).length > 0)) continue;
      const where = parseRecord(parentSchemas.core.where, raw, field);
      const probeId = this.scope.allocate(`${parentName}.${field}`);
      const guardId = this.scope.allocate(`${parentName}.guard.${field}`);
      conditionals.push({
        field,
        where,
        probeId,
        guardId,
        probe: {
          id: probeId,
          kind: "read",
          statement: buildFind(
            parent,
            {
              where: { AND: [...uniqueFilters, where] },
              select: this.pkSelect(),
              forUpdate: txMode,
            },
            { limit: 1 }
          ),
          outputs: { rows: { kind: "rows" } },
        },
      });
    }
    return conditionals;
  }

  private conditionalMatched(
    conditional: Conditional,
    known: Readonly<Record<string, unknown>>
  ): boolean {
    const rows = known[planningKey(conditional.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new QueryEngineError(
        `query-engine-v2 upsert ${conditional.field} probe did not expose rows.`
      );
    }
    return rows.length > 0;
  }

  private locateMissMessage(): string {
    return `query-engine-v2 upsert located no '${getStepModelName(this.model, "record")}' row for its unique where before the atomic batch.`;
  }
}

function defaultSelect(model: Model<any>): Record<string, unknown> {
  // V1's default projection is every scalar EXCEPT `.omit()`-ed fields (a model
  // with an omitted generated PK returns without it). Using the raw scalar names
  // would leak the omitted column — e.g. the captured generated PK on a
  // non-returning upsert create branch, which is internal, not public.
  return Object.fromEntries(
    getDefaultScalarFieldNames(model).map((field: string) => [field, true])
  );
}

function parseRecord(
  schema: VibSchema,
  value: unknown,
  path: string
): Record<string, unknown> {
  const result = parse(schema, value);
  if ("issues" in result && result.issues) {
    throw new ValidationError(
      "upsert",
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

function assertUpsertKeys(value: Record<string, unknown>): void {
  const required = ["where", "create", "update"] as const;
  const optional = new Set(["select", "targetWhere", "setWhere"]);
  const allowed = new Set<string>([...required, ...optional]);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length === 0 && missing.length === 0) return;
  throw new UnsupportedOperationError(
    `upsert arguments require ${required.join(", ")} (optional select, targetWhere, setWhere); received ${Object.keys(value).join(", ") || "none"}.`
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (isRecord(value)) return value;
  throw new UnsupportedOperationError(`'${label}' must be an object.`);
}
