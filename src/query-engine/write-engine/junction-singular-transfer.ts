import { QueryEngineError } from "@errors";
import { isSql } from "@sql";
import type { JunctionBoundRelation } from "../builders/relation-data-builder";
import type { JunctionStatements } from "../JunctionStatements";
import { affectedRows, raceableQueryFailure } from "./fragment-builders";
import { singularMembershipSlotRace } from "./messages";
import type {
  GuardStep,
  OperationStep,
  ReadStep,
  StatementStep,
  WriteStep,
} from "./OperationFragment";
import type { PlanningKnown } from "./Part";
import { planningKey } from "./Part";
import type { StepScope } from "./StepScope";
import { isRecord } from "./shared";

/** A complete target row key, keyed by the target side's referenced fields. */
export type JunctionRowValues = Readonly<Record<string, unknown>>;

/**
 * How this membership-add reached the transfer.
 *
 * `preserveExact` — the ordinary case. An already-exact `(desired, target)` row
 * is left alone: a reconnect is idempotent.
 *
 * `reinsertAfterOwnerClear` — the collection `set` case (§9.4 step 3). The
 * coordinator's relation-wide clear has ALREADY removed this owner's rows, so
 * the "it is already there" shortcut would lose the row it was meant to keep.
 */
export type JunctionTransferMode = "preserveExact" | "reinsertAfterOwnerClear";

/**
 * How the target is ADDRESSED at planning time, before any probe has run.
 *
 * `selector` — a complete `whereUnique` the capture lowers to scalar subqueries,
 * exactly as `junctionDelete`'s `targetWhere` already does. This is what lets the
 * capture be an ordinary planning read beside the target probe rather than a
 * read that waits on one.
 *
 * `values` — a complete literal target row key, already in hand.
 *
 * `fresh` — the target row is being CREATED by this same operation and its key
 * may not even exist yet (a produced identity). No membership can reference a row
 * that does not exist, so the slot is provably empty and no capture is emitted.
 * That is §1.6's "freshly created targets still pass through: their capture is
 * trivially empty" — proven structurally here instead of paid for with a read.
 */
export type JunctionTransferAddress =
  | { readonly kind: "selector"; readonly where: Record<string, unknown> }
  | { readonly kind: "values"; readonly values: JunctionRowValues }
  | { readonly kind: "fresh" };

/** What the compile step learns only once the enclosing plan has run. */
export interface JunctionTransferResolution {
  /** The complete target row key, resolved from the probe or the create data. */
  readonly targetKey: JunctionRowValues;
  /** The parent value the INSERT writes — literals, `Sql` refs, or a mix. */
  readonly desiredOwner: JunctionRowValues;
  /** The insert this transfer wraps, built by the calling Part. */
  readonly insert: () => WriteStep;
}

export interface JunctionSingularTransfer {
  readonly planning: readonly StatementStep[];
  compile(
    known: PlanningKnown,
    resolution: JunctionTransferResolution
  ): readonly OperationStep[];
}

interface TransferInput {
  readonly scope: StepScope;
  readonly statements: JunctionStatements;
  /** `cardinality` MUST be `"one"`; the plural path never reaches here. */
  readonly junction: JunctionBoundRelation;
  readonly stepPrefix: string;
  readonly address: JunctionTransferAddress;
  readonly mode: JunctionTransferMode;
  readonly txMode: boolean;
}

type CapturedOwner =
  | { readonly kind: "empty" }
  | { readonly kind: "exact" }
  | { readonly kind: "other"; readonly owner: Record<string, unknown> };

/**
 * THE SINGULAR MEMBER-JUNCTION TRANSFER (plan §1.6).
 *
 * A member whose `inverseCardinality` is `"one"` has a UNIQUE over its complete
 * target side, so at most one owner may hold a given target. Adding a membership
 * is therefore not an insert — it is a SLOT REPLACEMENT, and doing it as a bare
 * insert is the unpinned adoption §9.4 forbids: it either fails on a unique the
 * caller never asked about, or — with an UNTARGETED duplicate skip — silently
 * succeeds having changed nothing.
 *
 * ONE READ, then a 2x3 matrix. The read captures who holds the target; the WRITE
 * SEQUENCE is identical on both substrates, and only how the premises are
 * enforced differs:
 *
 *  - INTERACTIVE TRANSACTION: the capture is `forUpdate`, the row lock IS the
 *    premise (which is why the junction estate emits no guards in txMode), and
 *    the only enforcement is `affectedRows(1)` on the delete of a captured old
 *    row — raceable, so a concurrent vacate converges instead of reporting a
 *    false success.
 *  - NATIVE ATOMIC BATCH: **no `expects` at all** — the executor fails closed on
 *    a postcondition it cannot enforce in batch mode, and §9.4 adds no batch
 *    postcondition mechanism for this feature. The CAS is the in-batch
 *    exists/notExists premises below PLUS the membership PK and the target-side
 *    UNIQUE. That unique only bites once junction inserts TARGET their conflict,
 *    which is why §1.7 had to land before this did.
 *
 * The absence premise is necessarily `raceable: true` (fragment validation
 * refuses a non-raceable `notExists`), so the whole operation retries once and
 * RE-CAPTURES. That is the intended convergence, not a hole: a retry cannot
 * follow a different DESIRED owner, because the desired owner is the operation's
 * own input and is re-supplied identically.
 */
export function transferSingularJunctionMembership(
  input: TransferInput
): JunctionSingularTransfer {
  if (input.junction.cardinality !== "one") {
    throw new QueryEngineError(
      `query-engine-v2 internal: the singular junction transfer was asked for plural member table '${input.junction.membership.table}'.`
    );
  }
  const relationName = input.junction.relationInfo.name;
  const capture = buildCapture(input);
  const deleteId = input.scope.allocate(`${input.stepPrefix}.vacate`);
  const slotGuardId = input.scope.allocate(`${input.stepPrefix}.guard.slot`);
  const heldGuardId = input.scope.allocate(`${input.stepPrefix}.guard.held`);

  return {
    planning: capture ? [capture.step] : [],
    compile(known, resolution) {
      const captured = capture
        ? classifyCapturedOwner(
            known[planningKey(capture.step.id, "rows")],
            input,
            resolution,
            relationName
          )
        : { kind: "empty" as const };
      const guards = input.txMode
        ? []
        : batchPremises(input, captured, resolution, {
            slotGuardId,
            heldGuardId,
            relationName,
          });
      if (captured.kind === "exact" && input.mode === "preserveExact") {
        // IDEMPOTENT RECONNECT. The row the payload asks for is already there and
        // this owner is the one holding it, so there is nothing to write — the
        // premises above are the whole answer.
        return guards;
      }
      const writes: OperationStep[] = [];
      if (captured.kind === "other") {
        // Emitted in BOTH modes: a relation-wide clear removes only THIS owner's
        // rows, so the other owner's row is still there either way.
        writes.push(
          vacate(input, deleteId, captured.owner, resolution, relationName)
        );
      }
      writes.push(resolution.insert());
      return [...guards, ...writes];
    },
  };
}

function buildCapture(
  input: TransferInput
):
  | { readonly step: ReadStep; readonly args: Record<string, unknown> }
  | undefined {
  if (input.address.kind === "fresh") return undefined;
  const args =
    input.address.kind === "selector"
      ? { targetWhere: input.address.where }
      : { targetValue: input.address.values };
  return {
    args,
    step: {
      id: input.scope.allocate(`${input.stepPrefix}.owners`),
      kind: "read",
      statement: input.statements.materialize(
        input.junction,
        "membershipOwners",
        { ...args, ...(input.txMode ? { lock: "transaction" } : {}) }
      ),
      outputs: { rows: { kind: "rows" } },
    },
  };
}

function vacate(
  input: TransferInput,
  id: string,
  owner: Record<string, unknown>,
  resolution: JunctionTransferResolution,
  relationName: string
): WriteStep {
  const step: WriteStep = {
    id,
    kind: "write",
    statement: input.statements.materialize(
      input.junction,
      "junctionDeleteExact",
      { parentValue: owner, targetValue: resolution.targetKey }
    ),
    outputs: {},
  };
  // Gated on `txMode` exactly as every other junction postcondition is: the
  // executor refuses a batch step carrying an unenforceable postcondition, and
  // attaching one unconditionally would take this family off the batch substrate.
  return input.txMode
    ? {
        ...step,
        expects: affectedRows(
          1,
          raceableQueryFailure(
            singularMembershipSlotRace(relationName, "vacated")
          )
        ),
      }
    : step;
}

/**
 * The in-batch CAS. Every premise is a statement the atomic unit evaluates
 * BEFORE any write in it (the root's bucketing), which is what makes the
 * classification above a compare-and-swap rather than a guess.
 */
function batchPremises(
  input: TransferInput,
  captured: CapturedOwner,
  resolution: JunctionTransferResolution,
  ids: {
    readonly slotGuardId: string;
    readonly heldGuardId: string;
    readonly relationName: string;
  }
): GuardStep[] {
  const ownersOf = (owner: JunctionRowValues) =>
    input.statements.materialize(input.junction, "membershipRead", {
      parentValue: owner,
      take: 1,
      select: Object.fromEntries(
        input.junction.membership.target.members.map((member) => [
          member.referencedField,
          true,
        ])
      ),
      where: {
        AND: input.junction.membership.target.members.map((member) => ({
          [member.referencedField]: {
            equals: resolution.targetKey[member.referencedField],
          },
        })),
      },
    });

  if (captured.kind === "empty") {
    // "No owner holds this target." An ABSENCE premise, and the only one this
    // arm can state: nothing was captured, so nothing can be re-asserted.
    return [
      {
        id: ids.slotGuardId,
        kind: "guard",
        premise: {
          kind: "notExists",
          statement: input.statements.materialize(
            input.junction,
            "membershipOwners",
            { targetValue: resolution.targetKey }
          ),
        },
        failure: {
          kind: "nestedWrite",
          message: singularMembershipSlotRace(ids.relationName, "slot"),
          relation: ids.relationName,
          raceable: true,
        },
      },
    ];
  }
  // "The membership this plan captured is still there." An EXISTING-ROW premise,
  // `raceable: false` by the Pin Rule: a row that was there and is gone is a
  // genuine replacement, not something a retry can win.
  return [
    {
      id: ids.heldGuardId,
      kind: "guard",
      premise: {
        kind: "exists",
        statement: ownersOf(
          captured.kind === "other" ? captured.owner : resolution.desiredOwner
        ),
      },
      failure: {
        kind: "nestedWrite",
        message: singularMembershipSlotRace(ids.relationName, "captured"),
        relation: ids.relationName,
        raceable: false,
      },
    },
  ];
}

/**
 * Classify the captured owner into the matrix's three live cases.
 *
 * TWO rows is the malformed state a singular member must never reach — the
 * member table holding more than one owner for one target — and the `LIMIT 2`
 * capture exists to detect it rather than silently pick a winner.
 */
function classifyCapturedOwner(
  rows: unknown,
  input: TransferInput,
  resolution: JunctionTransferResolution,
  relationName: string
): CapturedOwner {
  if (!Array.isArray(rows)) {
    throw new QueryEngineError(
      `query-engine-v2 internal: the singular junction transfer for relation '${relationName}' did not observe its owner capture.`
    );
  }
  if (rows.length === 0) return { kind: "empty" };
  if (rows.length > 1) {
    throw new QueryEngineError(
      `Member table '${input.junction.membership.table}' holds more than one owner for a singular polymorphic member of relation '${relationName}'.`
    );
  }
  const row = rows[0];
  if (!isRecord(row)) {
    throw new QueryEngineError(
      `query-engine-v2 internal: the singular junction transfer for relation '${relationName}' captured a malformed owner row.`
    );
  }
  const owner = capturedOwnerValues(input, row, relationName);
  return sameOwner(owner, input, resolution)
    ? { kind: "exact" }
    : { kind: "other", owner };
}

/** The capture selects the member table's own SOURCE columns, one per member. */
function capturedOwnerValues(
  input: TransferInput,
  row: Record<string, unknown>,
  relationName: string
): Record<string, unknown> {
  const owner: Record<string, unknown> = {};
  for (const member of input.junction.membership.source.members) {
    const value = row[member.junctionField];
    if (value === undefined) {
      throw new QueryEngineError(
        `query-engine-v2 internal: the singular junction transfer for relation '${relationName}' captured no '${member.junctionField}' owner column.`
      );
    }
    owner[member.referencedField] = value;
  }
  return owner;
}

/**
 * Is the captured owner the one the payload is asking for?
 *
 * A desired owner carrying an `Sql` reference is a row this very statement is
 * still producing — a fresh create root. A row that does not exist yet cannot
 * already own anything, so "not comparable" IS "not equal": the transfer takes
 * its `other` arm and vacates, which is the correct answer and not a fallback.
 *
 * Values are compared through a normalizing key rather than by `===`, because
 * the two sides come from different worlds: one is a provider-decoded column, the
 * other a caller-supplied literal, and drivers legitimately differ on `bigint`
 * vs `number` vs `string` for one stored key.
 */
function sameOwner(
  captured: Record<string, unknown>,
  input: TransferInput,
  resolution: JunctionTransferResolution
): boolean {
  return input.junction.membership.source.members.every((member) => {
    const desired = resolution.desiredOwner[member.referencedField];
    const held = captured[member.referencedField];
    if (desired === undefined || held === undefined || isSql(desired)) {
      return false;
    }
    return ownerKey(desired) === ownerKey(held);
  });
}

function ownerKey(value: unknown): string {
  if (value === null) return " null";
  if (value instanceof Date) return ` d:${value.toISOString()}`;
  if (typeof value === "object") return ` o:${JSON.stringify(value)}`;
  return String(value);
}
