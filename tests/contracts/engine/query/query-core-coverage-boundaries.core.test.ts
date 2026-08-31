import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createOfficialCacheScope } from "@cache/driver";
import { MemoryCache } from "@cache/drivers/memory";
import { createOfficialCacheNamespace } from "@cache/key";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { CacheConfigurationError } from "@errors";
import {
  appendResolvedExtension,
  type ResolvedExtensionChain,
} from "@extensions/chain";
import { TransactionWriteOutcomes } from "@extensions/query";
import { buildParsedRelationPrograms } from "@query-engine/builders/relation-mutation-parser";
import {
  prepareMutationCacheInput,
  prepareMutationCacheWriteOutcome,
} from "@query-engine/cache-flow";
import {
  createChildScope,
  createQueryScope,
  getCompoundIdConstraint,
  getDefaultScalarFieldNames,
  getPrimaryKeyFields,
  isNullableScalarField,
  isRelation,
  isScalarField,
} from "@query-engine/context";
import {
  analyzeOwnWriteTree,
  assertNoRelationsOwnWriteDependencies,
} from "@query-engine/OwnWriteAnalyzer";
import { OwnWriteLedger } from "@query-engine/OwnWriteLedger";
import {
  attachPendingCacheExecution,
  createPendingOperation,
  type PendingOperation,
} from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { snapshotQueryInput } from "@query-engine/query-inspection";
import type { RelationMembershipScope } from "@query-engine/RelationMembership";
import { relationMembershipScopesEqual } from "@query-engine/RelationMembership";
import {
  classifyRelationKeyScalarUpdate,
  classifyTargetConstraintOverlap,
  exactTargetConstraintKey,
  getFilterPredicateFields,
  normalizeTargetConstraint,
  normalizeWhereUniqueTargetConstraint,
} from "@query-engine/TargetConstraint";
import { readTransactionOperation } from "@query-engine/transaction-operation";
import { hydrateSchemaNames, s } from "@schema";
import { type Sql, sql } from "@sql";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test, vi } from "vitest";

const target = s.model({
  id: s.int().id(),
  enabled: s.boolean(),
  label: s.string(),
});

const coordinatorUser = s.model({
  id: s.int().id(),
  name: s.string(),
});
const coordinatorSchema = { coordinatorUser };
prepareSchema(coordinatorSchema);

const coordinatorCacheScope = createOfficialCacheScope(
  createOfficialCacheNamespace({
    version: "query-core-coverage",
    dialect: "postgresql",
    namespace: "public",
  })
);

class NonErrorFailingCache extends MemoryCache {
  protected override async clear(): Promise<void> {
    // biome-ignore lint/style/useThrowOnlyError: verifies non-Error boundary normalization.
    throw "cache offline";
  }
}

class ExecutingCoordinatorDriver extends PlanningDriver {
  constructor() {
    super("postgresql");
  }

  override async _execute<T = Record<string, unknown>>(
    _statement: Sql,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 1 };
  }
}

function coordinatorEngine(
  extensionChain?: ResolvedExtensionChain,
  transactionWriteOutcomes?: TransactionWriteOutcomes
) {
  return new QueryEngine(
    new ExecutingCoordinatorDriver(),
    createModelRegistry(
      coordinatorSchema,
      createSchemaRegistry(coordinatorSchema)
    ),
    undefined,
    undefined,
    extensionChain,
    transactionWriteOutcomes
  );
}

function wrapDeleteNotifications(
  first: () => Promise<void>,
  second: () => Promise<void>
): PendingOperation<number> {
  const source = coordinatorEngine().prepare<number>(
    coordinatorUser,
    "deleteMany",
    { where: { id: { gt: 0 } } }
  );
  const firstLayer = attachPendingCacheExecution(source, (execute) =>
    execute(undefined, first)
  );
  return attachPendingCacheExecution(firstLayer, (execute) =>
    execute(undefined, second)
  );
}

function targetConstraint(id: number) {
  return normalizeWhereUniqueTargetConstraint(target, { id });
}

const foreignKeyScope: RelationMembershipScope = {
  kind: "foreignKey",
  holder: target,
  referenced: target,
  fields: [{ foreignKey: "parentId", referencedKey: "id" }],
};

describe("own-write ledger decision boundaries", () => {
  test("keeps relation-local existence writes inside their node scope", () => {
    const ledger = new OwnWriteLedger();

    ledger.withNestedScope(() => {
      ledger.appendRelationTarget("create", targetConstraint(1));
      expect(() =>
        ledger.assertTargetRead("targets", "connect", targetConstraint(1))
      ).toThrow("depends on an earlier 'create' target write");
    });

    expect(() =>
      ledger.assertTargetRead("targets", "connect", targetConstraint(1))
    ).not.toThrow();
  });

  test("only predicate writes that name changed fields can invalidate a read", () => {
    const noFieldEvidence = new OwnWriteLedger();
    noFieldEvidence.appendTarget(
      "update",
      "targetPredicate",
      targetConstraint(1)
    );
    expect(() =>
      noFieldEvidence.assertTargetRead(
        "targets",
        "connectOrCreate",
        targetConstraint(1)
      )
    ).not.toThrow();

    const unknownFieldEvidence = new OwnWriteLedger();
    unknownFieldEvidence.appendTarget(
      "update",
      "targetPredicate",
      targetConstraint(1),
      "unknown"
    );
    expect(() =>
      unknownFieldEvidence.assertTargetRead(
        "targets",
        "connectOrCreate",
        targetConstraint(1)
      )
    ).not.toThrow();

    const concreteFieldEvidence = new OwnWriteLedger();
    concreteFieldEvidence.appendTarget(
      "update",
      "targetPredicate",
      targetConstraint(1),
      new Set(["enabled"])
    );
    expect(() =>
      concreteFieldEvidence.assertTargetRead(
        "targets",
        "connectOrCreate",
        targetConstraint(1),
        new Set(["label"])
      )
    ).not.toThrow();
    expect(() =>
      concreteFieldEvidence.assertTargetRead(
        "targets",
        "connectOrCreate",
        targetConstraint(1),
        new Set(["enabled"])
      )
    ).toThrow("depends on an earlier 'update' target write");
  });

  test("requires the complete physical membership scope to match", () => {
    const endpoints = {
      first: targetConstraint(1),
      second: targetConstraint(2),
    };
    const ledger = new OwnWriteLedger();
    ledger.appendMembership("connect", endpoints, foreignKeyScope);

    expect(() =>
      ledger.assertMembershipRead(
        "targets",
        "update",
        endpoints,
        { ...foreignKeyScope, fields: [] },
        "direct"
      )
    ).not.toThrow();
  });
});

describe("own-write relation operation summaries", () => {
  const child = s.model({
    id: s.int().id(),
    parentId: s.int().nullable(),
    enabled: s.boolean(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id"),
  });
  const parent = s.model({
    id: s.int().id(),
    children: s.toMany(() => child),
  });
  const schema = { parent, child };
  prepareSchema(schema);

  function analyzeChildren(input: Record<string, unknown>) {
    const ctx = scopeFor(new PostgresAdapter(), parent);
    const parsed = buildParsedRelationPrograms(ctx, { children: input });
    return analyzeOwnWriteTree(ctx, parsed.relations, {
      kind: "update",
      scalarData: {},
      selector: { id: 1 },
    }).deltaSince(0);
  }

  test("publishes the membership and target effects of destructive relation verbs", () => {
    const operations = [
      analyzeChildren({ disconnect: { id: 2 } }),
      analyzeChildren({ delete: { id: 2 } }),
      analyzeChildren({ set: [{ id: 2 }] }),
      analyzeChildren({ deleteMany: { enabled: { equals: false } } }),
    ].flatMap((footprints) =>
      footprints.map((footprint) => footprint.operation)
    );

    expect(operations).toEqual(
      expect.arrayContaining(["disconnect", "delete", "set", "deleteMany"])
    );
  });

  test("tracks a filtered to-one update as a target and membership read", () => {
    const ctx = scopeFor(new PostgresAdapter(), child);
    const parsed = buildParsedRelationPrograms(ctx, {
      parent: {
        update: {
          where: { id: { gt: 0 } },
          data: { id: 2 },
        },
      },
    });

    expect(() =>
      assertNoRelationsOwnWriteDependencies(ctx, parsed.relations, {
        kind: "update",
        scalarData: {},
        selector: { id: 1 },
      })
    ).not.toThrow();
  });
});

describe("target-constraint value boundaries", () => {
  test("compares exact numeric and null identities and leaves SQL expressions unknown", () => {
    const numeric = normalizeTargetConstraint(target, ["id"], { id: 1 });
    const numericAgain = normalizeTargetConstraint(target, ["id"], { id: 1 });
    const nullable = normalizeTargetConstraint(target, ["id"], { id: null });
    const expression = normalizeTargetConstraint(target, ["id"], {
      id: sql`1 + ${1}`,
    });

    expect(classifyTargetConstraintOverlap(numeric, numericAgain)).toBe(
      "equal"
    );
    expect(exactTargetConstraintKey(nullable)).toContain("null");
    expect(expression.certainty).toBe("unknown");
    expect(exactTargetConstraintKey(expression)).toBeUndefined();
  });

  test("does not invent exact identity for executable values", () => {
    const executable = normalizeTargetConstraint(target, ["id"], {
      id: () => 1,
    });

    expect(executable.certainty).toBe("unknown");
  });

  test("compares exact null identities for nullable relation keys", () => {
    const values = s.model({
      id: s.int().id(),
      externalId: s.int().nullable().unique(),
    });
    prepareSchema({ values });

    const left = normalizeTargetConstraint(values, ["externalId"], {
      externalId: null,
    });
    const right = normalizeTargetConstraint(values, ["externalId"], {
      externalId: null,
    });

    expect(classifyTargetConstraintOverlap(left, right)).toBe("equal");
    expect(exactTargetConstraintKey(left)).toBeTypeOf("string");
  });

  test("marks uninspectable filter graphs unknown and accepts null-prototype set envelopes", () => {
    expect(getFilterPredicateFields(target, null)).toBe("unknown");
    expect(
      getFilterPredicateFields(target, {
        AND: [{ id: { equals: 1 } }, null],
      })
    ).toBe("unknown");

    const update: Record<string, unknown> = Object.create(null);
    Object.defineProperty(update, "set", {
      enumerable: true,
      value: 7,
    });
    expect(classifyRelationKeyScalarUpdate(update)).toEqual({
      resolved: true,
      value: 7,
    });
  });
});

describe("pending operation write-publication coordination", () => {
  test("uses the factory executor and memoizes its single-statement plan", () => {
    const operation = createPendingOperation(
      coordinatorEngine(),
      coordinatorUser,
      "findMany",
      {}
    );
    const owner = readTransactionOperation(operation);
    if (owner === undefined) throw new Error("Expected a transaction owner.");

    const first = owner.prepare(operation);
    const second = owner.prepare(operation);

    expect(first).toEqual(second);
    expect(first).toMatchObject({ sql: expect.any(String) });
  });

  test("publishes both nested write notifications in registration order", async () => {
    const order: string[] = [];
    const first = vi.fn(async () => {
      order.push("first");
    });
    const second = vi.fn(async () => {
      order.push("second");
    });

    await expect(wrapDeleteNotifications(first, second)).resolves.toEqual({
      count: 1,
    });
    expect(order).toEqual(["first", "second"]);
  });

  test("retains both nested notification failures", async () => {
    const firstFailure = new Error("first publication failed");
    const secondFailure = new Error("second publication failed");
    const first = vi.fn(async () => {
      throw firstFailure;
    });
    const second = vi.fn(async () => {
      throw secondFailure;
    });

    await expect(wrapDeleteNotifications(first, second)).rejects.toMatchObject({
      name: "AggregateError",
      cause: firstFailure,
      errors: [firstFailure, secondFailure],
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  test("does not hide either single nested notification failure", async () => {
    const firstFailure = new Error("first publication failed");
    const secondFailure = new Error("second publication failed");

    await expect(
      wrapDeleteNotifications(
        async () => {
          throw firstFailure;
        },
        async () => undefined
      )
    ).rejects.toBe(firstFailure);
    await expect(
      wrapDeleteNotifications(
        async () => undefined,
        async () => {
          throw secondFailure;
        }
      )
    ).rejects.toBe(secondFailure);
  });

  test("executes a direct query handler with the validated input snapshot", async () => {
    const queryHandler = vi.fn(
      async (context: {
        readonly input: Readonly<Record<string, unknown>>;
        proceed(): Promise<unknown>;
      }) => {
        expect(context.input).toEqual({ where: { id: { gt: 0 } } });
        return context.proceed();
      }
    );
    const chain = appendResolvedExtension(
      undefined,
      { name: "coordinator-query", query: queryHandler },
      coordinatorSchema
    );
    const operation = coordinatorEngine(chain).prepare<number>(
      coordinatorUser,
      "deleteMany",
      { where: { id: { gt: 0 } } }
    );

    await expect(operation).resolves.toEqual({ count: 1 });
    expect(queryHandler).toHaveBeenCalledOnce();
  });

  test("identifies query interception inside a transaction-owned outcome scope", async () => {
    const queryHandler = vi.fn(
      async (context: {
        readonly mode: string;
        proceed(): Promise<unknown>;
      }) => {
        expect(context.mode).toBe("transaction");
        return context.proceed();
      }
    );
    const chain = appendResolvedExtension(
      undefined,
      { name: "transaction-query", query: queryHandler },
      coordinatorSchema
    );
    const operation = coordinatorEngine(
      chain,
      new TransactionWriteOutcomes()
    ).prepare<number>(coordinatorUser, "deleteMany", {
      where: { id: { gt: 0 } },
    });

    await expect(operation).resolves.toEqual({ count: 1 });
    expect(queryHandler).toHaveBeenCalledOnce();
  });

  test("reports committed completion to a direct operation observer", async () => {
    const observer = vi.fn((_unit: unknown, proceed: () => Promise<unknown>) =>
      proceed()
    );
    const chain = appendResolvedExtension(
      undefined,
      { name: "coordinator-observer", observe: observer },
      coordinatorSchema
    );
    const operation = coordinatorEngine(chain).prepare<number>(
      coordinatorUser,
      "deleteMany",
      { where: { id: { gt: 0 } } }
    );

    await expect(operation).resolves.toEqual({ count: 1 });
    expect(observer).toHaveBeenCalled();
  });

  test("resolves a conditional package listener once before direct execution", async () => {
    const prepareListener = vi.fn(() => undefined);
    const operation = coordinatorEngine().prepare<number>(
      coordinatorUser,
      "deleteMany",
      { where: { id: { gt: 0 } } },
      undefined,
      undefined,
      prepareListener
    );

    await expect(operation).resolves.toEqual({ count: 1 });
    expect(prepareListener).toHaveBeenCalledOnce();
  });

  test("rejects invalid input before a query handler can inspect it", async () => {
    const queryHandler = vi.fn(async () => undefined);
    const chain = appendResolvedExtension(
      undefined,
      { name: "coordinator-query", query: queryHandler },
      coordinatorSchema
    );
    const operation = coordinatorEngine(chain).prepare(
      coordinatorUser,
      "deleteMany",
      { where: { id: { gt: "invalid" } } }
    );

    await expect(operation).rejects.toThrow();
    expect(queryHandler).not.toHaveBeenCalled();
  });
});

describe("mutation cache coordinator boundaries", () => {
  test("freezes an explicit cache policy without an invalidate list", () => {
    const prepared = prepareMutationCacheInput("update", {
      where: { id: 1 },
      data: { name: "next" },
      cache: { autoInvalidate: false },
    });

    expect(prepared.options).toEqual({ autoInvalidate: false });
    expect(Object.isFrozen(prepared.options)).toBe(true);
  });

  test("keeps non-Error cache invalidation failures as boundary causes", async () => {
    const registration = prepareMutationCacheWriteOutcome(
      new NonErrorFailingCache(),
      "coordinatorUser",
      "update",
      () => ({ autoInvalidate: true }),
      { model: "coordinatorUser", operation: "update" },
      coordinatorCacheScope
    );
    if (registration === undefined) {
      throw new Error("Expected a mutation cache registration.");
    }

    await expect(
      registration.listener({ certainty: "committed" })
    ).rejects.toBeInstanceOf(CacheConfigurationError);
  });

  test("normalizes non-Error reflection failures at the mutation boundary", () => {
    const input = new Proxy(
      {},
      {
        ownKeys() {
          // biome-ignore lint/style/useThrowOnlyError: verifies hostile reflection normalization.
          throw "reflection unavailable";
        },
      }
    );

    expect(() => prepareMutationCacheInput("update", input)).toThrow(
      CacheConfigurationError
    );
  });
});

describe("query-scope derived model facts", () => {
  test("shares topology and alias allocation with children", () => {
    const account = s
      .model({
        tenantId: s.int(),
        accountId: s.int(),
        displayName: s.string().nullable(),
        secret: s.string(),
        sessions: s.toMany(() => session),
      })
      .id(["tenantId", "accountId"], { name: "account_key" })
      .omit({ secret: true });
    const session = s.model({
      id: s.int().id(),
      accountTenantId: s.int().nullable(),
      accountId: s.int().nullable(),
      account: s
        .toOne(() => account)
        .fields("accountTenantId", "accountId")
        .references("tenantId", "accountId"),
    });
    const schema = { account, session };
    const relations = prepareSchema(schema);
    const scope = createQueryScope(
      { adapter: new PostgresAdapter(), relations },
      account
    );
    const child = createChildScope(scope, session, scope.nextAlias());

    expect(scope.rootAlias).toBe("t0");
    expect(child.rootAlias).toBe("t1");
    expect(child.nextAlias()).toBe("t2");
    expect(child.relations).toBe(scope.relations);
    expect(getCompoundIdConstraint(account)).toEqual({
      name: "account_key",
      fields: ["tenantId", "accountId"],
    });
    expect(getPrimaryKeyFields(account)).toEqual(["tenantId", "accountId"]);
    expect(getDefaultScalarFieldNames(account)).toEqual([
      "tenantId",
      "accountId",
      "displayName",
    ]);
    expect(isNullableScalarField(account, "displayName")).toBe(true);
    expect(isNullableScalarField(account, "secret")).toBe(false);
    expect(isScalarField(account, "tenantId")).toBe(true);
    expect(isRelation(account, "sessions")).toBe(true);
  });

  test("uses the stable id fallback for an unkeyed model", () => {
    const unkeyed = s.model({ label: s.string() });
    hydrateSchemaNames({ unkeyed });

    expect(getPrimaryKeyFields(unkeyed)).toEqual(["id"]);
    expect(getCompoundIdConstraint(unkeyed)).toBeUndefined();
    expect(getDefaultScalarFieldNames(unkeyed)).toEqual(["label"]);
  });
});

describe("relation membership scope equality", () => {
  test("compares every foreign-key member in its canonical position", () => {
    expect(
      relationMembershipScopesEqual(foreignKeyScope, foreignKeyScope)
    ).toBe(true);
    expect(
      relationMembershipScopesEqual(foreignKeyScope, {
        ...foreignKeyScope,
        fields: [{ foreignKey: "parentId", referencedKey: "alternateId" }],
      })
    ).toBe(false);
  });
});

describe("query inspection accessors", () => {
  test("snapshots an enumerable root accessor without invoking it", () => {
    let reads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return "private";
      },
    });

    const snapshot = snapshotQueryInput(input);
    const secret = snapshot.secret;
    if (typeof secret !== "object" || secret === null) {
      throw new Error("Expected an opaque accessor snapshot.");
    }

    expect(reads).toBe(0);
    expect(Reflect.get(secret, "opaque")).toBe("accessor");
  });

  test("omits non-enumerable members and preserves sparse array accessors as opaque", () => {
    const members: unknown[] = [];
    members.length = 3;
    Object.defineProperty(members, 1, {
      enumerable: true,
      get() {
        throw new Error("must not run");
      },
    });
    Object.defineProperty(members, "private", {
      enumerable: false,
      value: "hidden",
    });
    const input: Record<string, unknown> = { members };
    Object.defineProperty(input, "private", {
      enumerable: false,
      value: "hidden",
    });

    const snapshot = snapshotQueryInput(input);
    const detached = snapshot.members;
    if (!Array.isArray(detached))
      throw new Error("Expected an array snapshot.");

    expect(detached).toHaveLength(3);
    expect(0 in detached).toBe(false);
    const accessor = detached[1];
    if (typeof accessor !== "object" || accessor === null) {
      throw new Error("Expected an opaque array accessor snapshot.");
    }
    expect(Reflect.get(accessor, "opaque")).toBe("accessor");
    expect(Reflect.has(detached, "private")).toBe(false);
    expect(Reflect.has(snapshot, "private")).toBe(false);
  });

  test("discloses hostile reflection as one opaque inspection fact", () => {
    const input = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("inspection denied");
        },
      }
    );

    expect(Reflect.get(snapshotQueryInput(input), "opaque")).toBe(
      "unsupported"
    );
  });
});

describe("coverage low value", () => {
  test("treats unsupported executable target values as unknown", () => {
    const unsupported = normalizeTargetConstraint(target, ["id"], {
      id: Symbol("id"),
    });
    expect(unsupported.certainty).toBe("unknown");
  });

  test("memoizes prepared input when an untyped operation name cannot route", async () => {
    const queryHandler = vi.fn(async () => undefined);
    const chain = appendResolvedExtension(
      undefined,
      { name: "untyped-query", query: queryHandler },
      coordinatorSchema
    );
    const engine = coordinatorEngine(chain);
    const prepareInput = vi.fn(() => ({}));
    const operation = Reflect.apply(engine.prepare, engine, [
      coordinatorUser,
      "missing",
      {},
      undefined,
      prepareInput,
    ]);

    await expect(operation).rejects.toThrow("Unknown operation 'missing'");
    expect(() => operation.buildStatement()).toThrow(
      "Unknown operation 'missing'"
    );
    expect(prepareInput).toHaveBeenCalledOnce();
    expect(queryHandler).not.toHaveBeenCalled();
  });
});
