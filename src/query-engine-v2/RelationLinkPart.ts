// biome-ignore-all lint/style/useFilenamingConvention: RelationLinkPart is the architecture name.
import { NestedWriteError, QueryEngineError } from "@errors";
import type { Sql } from "@sql";
import { getWhereUniqueEntries } from "../query-engine/builders/where-unique-builder";
import {
  buildFind,
  buildFindUnique,
  buildUpdate,
  buildUpdateMany,
} from "../query-engine/operations";
import type { QueryEngine } from "../query-engine/query-engine";
import type { QueryScope, RelationInfo } from "../query-engine/types";
import {
  nestedWriteFailure,
  presenceGuard,
  referenceSql,
} from "./fragment-builders";
import { relationTargetNotFound } from "./messages";
import {
  type OperationStep,
  ref,
  type StatementStep,
} from "./OperationFragment";
import type { Part, PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import type { ParentIdSource } from "./RelationUpsertPart";
import type { StepScope } from "./StepScope";

export type LinkKind = "connect" | "disconnect";

export interface RelationLinkConfig {
  readonly engine: QueryEngine;
  readonly childScope: QueryScope;
  readonly childName: string;
  readonly relationName: string;
  readonly relationInfo: RelationInfo;
  readonly kind: LinkKind;
  /** The child unique locator (connect, or disconnect of one child). */
  readonly where?: Record<string, unknown>;
  /** `disconnect: true` — null every child currently connected to the parent. */
  readonly disconnectAll?: boolean;
  readonly childForeignKey: string;
  readonly childPrimaryKey: string;
  /**
   * Where the parent id the child FK points at comes from. In the update family
   * this is a **planned** value (the root locate read), inlined as a literal at
   * compile (a final-fragment step may not ref a planning step, ATOM §9 inv. 2).
   * The disconnect probe, however, IS a planning step, so it correlates by a SQL
   * `Ref` to that same locate read — technique #1's positive witness (ATOM §3).
   */
  readonly parentId: ParentIdSource;
  readonly txMode: boolean;
}

/**
 * The to-many (child-held-FK) connect/disconnect Part (PLAN P2a). A nested link
 * mutation is a root write plus an FK edge (WHY §4.2): connect sets the child's
 * FK to the parent, disconnect nulls it. It composes exactly like the upsert
 * Part — planning probe + compile-the-taken-arm — and adds no vocabulary.
 *
 * - **connect** plans an *uncorrelated* existence probe (the target exists
 *   globally); compile emits `UPDATE child SET fk = parent WHERE unique`, pinned
 *   in batch by an exists guard on the target. Absent target → V1's verbatim
 *   `Cannot connect …` error.
 * - **disconnect** plans a *correlated* existence probe — `WHERE unique AND
 *   fk = Ref(locate.id)` — the hard-correlation nested read ATOM §8.1 note (a)
 *   scheduled here: its probe SQL literally carries a `Ref` to the locate
 *   planning step, and it has no found-uncorrelated arm. Present → `UPDATE child
 *   SET fk = NULL WHERE unique`; absent → V1's verbatim `Cannot disconnect … for
 *   this parent` error.
 * - **disconnect: true** needs no probe: `UPDATE child SET fk = NULL WHERE
 *   fk = parent` nulls the whole set.
 *
 * To-one (parent-held-FK) connect/disconnect is not a child write — it changes
 * the parent row's own FK — so it is folded into the root update by
 * {@link UpdateOperation}, not represented here.
 */
export class RelationLinkPart implements Part {
  private readonly config: RelationLinkConfig;
  private readonly probeId: string;
  private readonly writeId: string;
  private readonly guardId: string;
  private readonly probe?: StatementStep;

  constructor(scope: StepScope, config: RelationLinkConfig) {
    this.config = config;
    this.probeId = scope.allocate(`${config.childName}.find`);
    this.writeId = scope.allocate(`${config.childName}.${config.kind}`);
    this.guardId = scope.allocate(`${config.childName}.guard.exists`);
    this.probe = this.buildProbe();
  }

  planning(): readonly OperationStep[] {
    return this.probe ? [this.probe] : [];
  }

  compile(_scope: StepScope, known: PlanningKnown): readonly OperationStep[] {
    if (this.config.kind === "connect") return this.compileConnect(known);
    return this.compileDisconnect(known);
  }

  /** The uncorrelated (connect) / correlated (disconnect) existence probe. */
  private buildProbe(): StatementStep | undefined {
    if (this.config.disconnectAll) return undefined;
    const { childScope, txMode, childPrimaryKey } = this.config;
    const where = this.requiredWhere();
    const select = { [childPrimaryKey]: true };
    if (this.config.kind === "connect") {
      return {
        id: this.probeId,
        kind: "read",
        statement: buildFindUnique(childScope, {
          where,
          select,
          forUpdate: txMode,
        }),
        outputs: { rows: { kind: "rows" } },
      };
    }
    // Disconnect: correlate the probe to the located parent by a SQL Ref — the
    // hard-correlation read that carries technique #1's positive witness.
    return {
      id: this.probeId,
      kind: "read",
      statement: buildFind(
        childScope,
        {
          where: {
            AND: [
              ...this.uniqueEqualityFilters(where),
              this.correlationFilter(),
            ],
          },
          select,
          forUpdate: txMode,
        },
        { limit: 1 }
      ),
      outputs: { rows: { kind: "rows" } },
    };
  }

  private compileConnect(known: PlanningKnown): readonly OperationStep[] {
    this.requireProbeFound(known, "connect");
    const { childScope } = this.config;
    const where = this.requiredWhere();
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      // Batch: pin the target's presence before the reparent write (atomicity
      // then makes the WHERE-unique update affect exactly one row).
      steps.push(
        presenceGuard(
          this.guardId,
          buildFindUnique(childScope, {
            where,
            select: { [this.config.childPrimaryKey]: true },
          }),
          this.connectFailure()
        )
      );
    }
    steps.push({
      id: this.writeId,
      kind: "write",
      statement: buildUpdate(childScope, {
        where,
        data: { [this.config.childForeignKey]: this.parentIdValue(known) },
        select: { [this.config.childPrimaryKey]: true },
      }),
      outputs: {},
    });
    return steps;
  }

  private compileDisconnect(known: PlanningKnown): readonly OperationStep[] {
    if (this.config.disconnectAll) return [this.buildDisconnectAll(known)];
    this.requireProbeFound(known, "disconnect");
    const { childScope } = this.config;
    const where = this.requiredWhere();
    const steps: OperationStep[] = [];
    if (!this.config.txMode) {
      // Batch: pin that the child is still connected to this parent.
      steps.push(
        presenceGuard(
          this.guardId,
          buildFind(
            childScope,
            {
              where: {
                AND: [
                  ...this.uniqueEqualityFilters(where),
                  {
                    [this.config.childForeignKey]: {
                      equals: this.parentLiteral(known),
                    },
                  },
                ],
              },
              select: { [this.config.childPrimaryKey]: true },
            },
            { limit: 1 }
          ),
          this.disconnectFailure()
        )
      );
    }
    steps.push({
      id: this.writeId,
      kind: "write",
      statement: buildUpdate(childScope, {
        where,
        data: { [this.config.childForeignKey]: { set: null } },
        select: { [this.config.childPrimaryKey]: true },
      }),
      outputs: {},
    });
    return steps;
  }

  private buildDisconnectAll(known: PlanningKnown): StatementStep {
    const { childScope, childForeignKey } = this.config;
    return {
      id: this.writeId,
      kind: "write",
      statement: buildUpdateMany(childScope, {
        where: { [childForeignKey]: { equals: this.parentLiteral(known) } },
        data: { [childForeignKey]: { set: null } },
      }),
      outputs: {},
    };
  }

  private requireProbeFound(known: PlanningKnown, kind: LinkKind): void {
    const rows = known[planningKey(this.probeId, "rows")];
    if (!Array.isArray(rows)) {
      throw new NestedWriteError(
        `query-engine-v2 ${kind} probe for relation '${this.config.relationName}' did not expose rows.`,
        this.config.relationName
      );
    }
    if (rows.length === 0) {
      throw new NestedWriteError(
        kind === "connect"
          ? relationTargetNotFound(this.config.relationInfo, "connect")
          : relationTargetNotFound(this.config.relationInfo, "disconnect"),
        this.config.relationName
      );
    }
  }

  private connectFailure() {
    return nestedWriteFailure(
      relationTargetNotFound(this.config.relationInfo, "connect"),
      this.config.relationName,
      false
    );
  }

  private disconnectFailure() {
    return nestedWriteFailure(
      relationTargetNotFound(this.config.relationInfo, "disconnect"),
      this.config.relationName,
      false
    );
  }

  /** The FK expression the connect write assigns — the located parent id. */
  private parentIdValue(known: PlanningKnown): Sql {
    return referenceSql(
      this.config.engine,
      this.config.childScope.model,
      this.config.childForeignKey,
      this.parentLiteral(known)
    );
  }

  /** The concrete located parent id (never a Ref — inlined at compile). */
  private parentLiteral(known: PlanningKnown): unknown {
    const source = this.config.parentId;
    if (source.kind === "literal") return source.value;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' requires a planned parent id.`
      );
    }
    const rows = known[planningKey(source.readStep, "rows")];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!(row && typeof row === "object")) {
      throw new NestedWriteError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' could not resolve its parent id.`,
        this.config.relationName
      );
    }
    return (row as Record<string, unknown>)[source.field];
  }

  /** The disconnect probe's `fk = Ref(locate)` clause — the technique #1 marker. */
  private correlationFilter(): Record<string, unknown> {
    const source = this.config.parentId;
    if (source.kind !== "planned") {
      throw new QueryEngineError(
        `query-engine-v2 disconnect for relation '${this.config.relationName}' requires a planned parent id to correlate its probe.`
      );
    }
    return {
      [this.config.childForeignKey]: {
        equals: ref(source.readStep, source.field),
      },
    };
  }

  private uniqueEqualityFilters(
    where: Record<string, unknown>
  ): Record<string, unknown>[] {
    return getWhereUniqueEntries(this.config.childScope, where).map(
      ({ fieldName, value }) => ({ [fieldName]: { equals: value } })
    );
  }

  private requiredWhere(): Record<string, unknown> {
    if (!this.config.where) {
      throw new QueryEngineError(
        `query-engine-v2 ${this.config.kind} for relation '${this.config.relationName}' requires a unique where.`
      );
    }
    return this.config.where;
  }
}

/**
 * Fold one to-many connect/disconnect relation mutation into link Parts — one
 * per unique target (arrays fold to several), plus the `disconnect: true` /
 * `connect`-single spellings. The FK must be child-held; a parent-held FK is a
 * same-row change and is handled in {@link UpdateOperation}.
 */
export function buildToManyLinkParts(
  scope: StepScope,
  engine: QueryEngine,
  relationName: string,
  relationInfo: RelationInfo,
  childName: string,
  childScope: QueryScope,
  childForeignKey: string,
  childPrimaryKey: string,
  kind: LinkKind,
  input: unknown,
  parentId: ParentIdSource,
  txMode: boolean
): RelationLinkPart[] {
  const base = {
    engine,
    childScope,
    childName,
    relationName,
    relationInfo,
    kind,
    childForeignKey,
    childPrimaryKey,
    parentId,
    txMode,
  } as const;
  if (kind === "disconnect" && input === true) {
    return [new RelationLinkPart(scope, { ...base, disconnectAll: true })];
  }
  return normalizeWhereItems(input, relationName, kind).map(
    (where) => new RelationLinkPart(scope, { ...base, where })
  );
}

function normalizeWhereItems(
  value: unknown,
  relation: string,
  kind: LinkKind
): Record<string, unknown>[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (!(item && typeof item === "object")) {
      throw new QueryEngineError(
        `query-engine-v2 ${kind} for relation '${relation}' requires a unique where object.`
      );
    }
    return item as Record<string, unknown>;
  });
}
