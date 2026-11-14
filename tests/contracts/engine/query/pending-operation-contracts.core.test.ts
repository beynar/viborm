import { PendingOperation as ClientPendingOperation } from "@client/exports";
import {
  InvalidTransactionInputError,
  PendingOperationError,
  QueryError,
  ValidationError,
} from "@errors";
import { ARRAYS } from "@extensions/coordination";
import {
  executePreparedQuery,
  type WriteOutcomeRegistration,
} from "@extensions/query";
import { PendingExecution } from "@query-engine/pending-execution";
import {
  PendingOperation,
  type PrepareWriteOutcomeRegistration,
} from "@query-engine/pending-operation";
import {
  readTransactionOperation,
  type TransactionOperationCapability,
  type TransactionOperationOwner,
} from "@query-engine/transaction-operation";
import { hydrateSchemaNames, s } from "@schema";
import {
  around,
  extension,
  PendingOperation as RootPendingOperation,
  unit,
} from "@src/index";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { appendExtension } from "@tests/fixtures/extension-chain";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import {
  readTestTransactionOperation,
  type TestTransactionOperationView,
} from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, it, vi } from "vitest";

const VALID_UPDATE_ARGS = {
  where: { id: "user-1" },
  data: { name: "Updated" },
};

const UNKNOWN_OPERATION_PATTERN = /Unknown operation 'missing'/;

/** A planning driver that answers every statement with no row, and counts them. */
class CountingDriver extends PlanningDriver {
  readonly executed = vi.fn();

  constructor() {
    super("postgresql");
  }

  protected override async execute<T>(): Promise<{
    rows: T[];
    rowCount: number;
  }> {
    this.executed();
    return { rows: [], rowCount: 0 };
  }
}

function createOperation<T>(
  operation: "findMany" | "update" = "findMany",
  args: Record<string, unknown> = {},
  prepareWriteOutcome?: PrepareWriteOutcomeRegistration,
  driver: PlanningDriver = new PlanningDriver("postgresql")
): PendingOperation<T> {
  const user = s.model({ id: s.string().id(), name: s.string() });
  const schema = { user };
  hydrateSchemaNames(schema);
  const root = new TestQueryEngine(
    driver,
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  // A write outcome is registered only on a chain whose parts coordinate
  // outcomes (the cache's, `written`): that chain runs it.
  const engine =
    prepareWriteOutcome === undefined
      ? root
      : root.bind(root.driver, { extensions: [], coordination: ARRAYS });
  return engine.prepare<T>(
    user,
    operation,
    args,
    undefined,
    undefined,
    prepareWriteOutcome
  );
}

/** A read whose execution counts the statements its driver sends. */
function createControlledOperation(): {
  operation: PendingOperation<unknown>;
  execute: ReturnType<typeof vi.fn>;
  driver: CountingDriver;
} {
  const driver = new CountingDriver();
  return {
    operation: createOperation("findMany", {}, undefined, driver),
    execute: driver.executed,
    driver,
  };
}

function capability(operation: unknown): TestTransactionOperationView {
  const value = readTestTransactionOperation(operation);
  if (value === undefined) throw new Error("Expected pending operation");
  return value;
}

function ownerOf(
  operation: object
): TransactionOperationOwner<TransactionOperationCapability> {
  const owner = readTransactionOperation(operation);
  if (owner === undefined) throw new Error("Expected transaction owner");
  return owner;
}

describe("PendingOperation frozen public contract", () => {
  it("keeps construction and authority state behind the module factory", () => {
    const operation = createOperation<unknown>();
    const operationCapability = capability(operation);

    expect(Object.isFrozen(operation)).toBe(true);
    const prototype = Reflect.getPrototypeOf(operation);
    if (prototype === null) throw new Error("Expected operation prototype");
    expect(Object.isFrozen(prototype)).toBe(true);
    const originalThen = Reflect.get(prototype, "then");
    expect(typeof originalThen).toBe("function");
    expect(Reflect.defineProperty(prototype, "then", { value: vi.fn() })).toBe(
      false
    );
    expect(Reflect.get(prototype, "then")).toBe(originalThen);
    expect(Reflect.get(PendingOperation, "create")).toBeUndefined();
    for (const name of [
      "resolveArgs",
      "resolveWriteOutcomeRegistration",
      "resolveOperation",
      "statementOperation",
      "executor",
      "resolveSinglePlan",
      "getPromise",
      "observeLogicalOperation",
      "runExecution",
      "observationNotification",
      "runCoreExecution",
      "run",
      "wrapExecution",
    ]) {
      const helper = Reflect.get(operation, name);
      expect(helper).toBeUndefined();
      expect(() => {
        if (typeof helper !== "function") {
          throw new TypeError("Private helper is not callable");
        }
        Reflect.apply(helper, operation, []);
      }).toThrow(TypeError);
    }
    for (const key of [
      "engine",
      "model",
      "args",
      "modelName",
      "operation",
      "options",
      "execution",
      "operationExecutor",
      "context",
    ]) {
      expect(Reflect.set(operation, key, "forged")).toBe(false);
      expect(Reflect.defineProperty(operation, key, { value: "forged" })).toBe(
        false
      );
    }
    expect(capability(operation).clientId).toBe(operationCapability.clientId);
    expect(capability(operation).scopeId).toBe(operationCapability.scopeId);

    const reflectedConstructor = Reflect.get(operation, "constructor");
    if (typeof reflectedConstructor !== "function") {
      throw new Error("Expected PendingOperation constructor");
    }
    expect(() => Reflect.construct(reflectedConstructor, [])).toThrow(
      InvalidTransactionInputError
    );
  });

  it("preserves client identity and mints transaction scope identity", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const registry = createModelRegistry(schema, createSchemaRegistry(schema));
    const engine = new TestQueryEngine(
      new PlanningDriver("postgresql"),
      registry
    );
    const transactionDriver = new PlanningDriver("postgresql");
    const transactionEngine = engine.bind(transactionDriver);

    expect(transactionEngine.clientId).toBe(engine.clientId);
    expect(transactionEngine.scopeId).not.toBe(engine.scopeId);
    expect(transactionEngine.driver).toBe(transactionDriver);
    expect(transactionEngine.route).toBe(engine.route);
  });

  it("defers validation and execution until an execution or preparation method is used", async () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const engine = new TestQueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );

    let operation: PendingOperation<unknown> | undefined;
    expect(() => {
      // A schema-invalid payload (id must be a string): the engine constructs the
      // deferred operation without validating, so creation does not throw.
      operation = engine.prepare(user, "create", { data: { id: 123 } });
    }).not.toThrow();

    if (operation === undefined) throw new Error("Expected pending operation");
    expect(() => capability(operation).prepare()).toThrow(ValidationError);
    await expect(operation).rejects.toBeInstanceOf(ValidationError);
  });

  it("memoizes one execution across then, catch, finally, and execute", async () => {
    const { operation, execute } = createControlledOperation();
    const finalized = vi.fn();

    await expect(
      Promise.all([
        operation.then((value) => value),
        operation.catch(() => -1),
        operation.finally(finalized),
        Promise.resolve(operation),
      ])
    ).resolves.toEqual([[], [], [], []]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(finalized).toHaveBeenCalledTimes(1);
  });

  it("memoizes executeWith for the same driver", async () => {
    const { operation, execute, driver } = createControlledOperation();

    const first = capability(operation).executeWith(driver);
    const second = capability(operation).executeWith(driver);

    expect(second).toBe(first);
    await expect(first).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects default execution after driver-bound execution", () => {
    const { operation } = createControlledOperation();
    // The planning driver refuses the statement: only the claim is tested.
    capability(operation)
      .executeWith(new PlanningDriver("postgresql"))
      .catch(() => undefined);
    expect(() => operation.then((value) => value)).toThrow(
      PendingOperationError
    );
  });

  it("rejects driver-bound execution after default execution", () => {
    const { operation } = createControlledOperation();
    operation.then((value) => value);
    expect(() =>
      capability(operation).executeWith(new PlanningDriver("postgresql"))
    ).toThrow(PendingOperationError);
  });

  it("rejects a second, different driver", () => {
    const { operation } = createControlledOperation();
    // The planning driver refuses the statement: only the claim is tested.
    capability(operation)
      .executeWith(new PlanningDriver("postgresql"))
      .catch(() => undefined);
    expect(() =>
      capability(operation).executeWith(new PlanningDriver("postgresql"))
    ).toThrow(PendingOperationError);
  });

  it("prepares directly and as a bulk batch without executing", async () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const driver = new PlanningDriver("postgresql");
    const engine = new TestQueryEngine(
      driver,
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const direct = engine.prepare(user, "findMany", {});
    const bulk = engine.prepare(user, "createMany", {
      data: [{ id: "user-1", name: "Arnaud" }],
    });

    const directCapability = capability(direct);
    expect(directCapability.prepare(driver)).toMatchObject({
      sql: expect.any(String),
      params: expect.any(Array),
      context: directCapability.context,
    });
    await expect(capability(bulk).prepareBatch()).resolves.toMatchObject({
      queries: expect.any(Array),
      parseResult: expect.any(Function),
    });
  });

  it("preserves raw arguments, identity, attribution, and result parsing", () => {
    const args = { where: { id: "user-1" } };
    const operation = createOperation<Array<{ id: string; name: string }>>(
      "findMany",
      args
    );
    const raw = {
      rows: [{ id: "user-1", name: "Arnaud" }],
      rowCount: 1,
    };
    const operationCapability = capability(operation);

    expect(operation.getArgs()).toBe(args);
    expect(operationCapability.model).toBe("user");
    expect(operationCapability.operation).toBe("findMany");
    expect(typeof operationCapability.clientId).toBe("symbol");
    expect(typeof operationCapability.scopeId).toBe("symbol");
    expect(Object.isFrozen(operationCapability.context)).toBe(true);
    expect(operationCapability.context).toBe(capability(operation).context);
    expect(operationCapability.parseResult(raw)).toEqual(raw.rows);
  });

  it("publishes package registrations for every direct committed segment", async () => {
    const published: string[] = [];
    const registration = {
      extension: "package",
      listener: ({ certainty }: { certainty: string }) => {
        published.push(certainty);
      },
    };

    await expect(
      executePreparedQuery(
        undefined,
        undefined,
        async (notifications) => {
          await notifications?.committed();
          await notifications?.committed();
          return 42;
        },
        true,
        undefined,
        undefined,
        registration
      )
    ).resolves.toBe(42);
    expect(published).toEqual(["committed", "committed"]);
  });

  it("keeps PendingOperation as the root and client runtime export", () => {
    expect(RootPendingOperation).toBe(PendingOperation);
    expect(ClientPendingOperation).toBe(PendingOperation);
  });
});

describe("pending execution ownership", () => {
  it("memoizes default and same-driver execution while excluding the other authority", async () => {
    const execution = new PendingExecution<number>("user", "findMany");
    const run = vi.fn(() => Promise.resolve(42));
    const first = execution.executeDefault(run);
    const second = execution.executeDefault(run);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
    expect(() =>
      execution.executeWith(new PlanningDriver("postgresql"), run)
    ).toThrow(PendingOperationError);
  });

  it("memoizes one driver and refuses a different driver or default execution", async () => {
    const driver = new PlanningDriver("postgresql");
    const execution = new PendingExecution<number>("user", "findMany");
    const run = vi.fn(() => Promise.resolve(42));
    const first = execution.executeWith(driver, run);
    const second = execution.executeWith(driver, run);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
    expect(() => execution.executeDefault(run)).toThrow(PendingOperationError);
    expect(() =>
      execution.executeWith(new PlanningDriver("postgresql"), run)
    ).toThrow(PendingOperationError);
  });

  it("reserves exactly one driver for an array coordinator and runs its child once", async () => {
    const driver = new PlanningDriver("postgresql");
    const execution = new PendingExecution<number>("user", "findMany");
    const run = vi.fn(() => Promise.resolve(42));
    execution.reserveWith(driver);

    const first = execution.executeReserved(run);
    const second = execution.executeReserved(run);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(42);
    expect(run).toHaveBeenCalledOnce();
    expect(() => execution.executeWith(driver, run)).toThrow(
      PendingOperationError
    );
  });

  it("refuses reservation after either execution authority was selected", () => {
    const driver = new PlanningDriver("postgresql");
    const defaultExecution = new PendingExecution<number>("user", "findMany");
    defaultExecution.executeDefault(() => Promise.resolve(1));
    expect(() => defaultExecution.reserveWith(driver)).toThrow(
      PendingOperationError
    );

    const driverExecution = new PendingExecution<number>("user", "findMany");
    driverExecution.executeWith(driver, () => Promise.resolve(1));
    expect(() => driverExecution.reserveWith(driver)).toThrow(
      PendingOperationError
    );
    expect(() =>
      driverExecution.reserveWith(new PlanningDriver("postgresql"))
    ).toThrow(PendingOperationError);
  });
});

describe("pending operation transaction coordination", () => {
  it("publishes the exact operation authority through the registered owner", async () => {
    const read = createOperation<unknown>();
    const write = createOperation<unknown>("update", VALID_UPDATE_ARGS);
    const readOwner = ownerOf(read);
    const writeOwner = ownerOf(write);

    expect(readOwner.clientId(read)).toBe(capability(read).clientId);
    expect(readOwner.scopeId(read)).toBe(capability(read).scopeId);
    expect(readOwner.model(read)).toBe("user");
    expect(readOwner.operation(read)).toBe("findMany");
    expect(readOwner.context(read)).toBe(capability(read).context);
    expect(readOwner.interception(read)).toEqual({
      context: undefined,
      handlers: undefined,
      write: false,
      registration: undefined,
    });
    expect(writeOwner.interception(write).write).toBe(true);
    // The member's operation unit, as its array observes it.
    expect(readOwner.unit(read)).toMatchObject({
      kind: "operation",
      model: "user",
      operation: "findMany",
    });
  });

  it("resolves request preparation once and rethrows the same preparation failure", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const engine = new TestQueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const prepareInput = vi.fn(() => ({ where: { id: "user-1" } }));
    const prepared = engine.prepare(
      user,
      "findMany",
      {},
      undefined,
      prepareInput
    );
    const preparedOwner = ownerOf(prepared);

    preparedOwner.prepareAdmission(prepared);
    preparedOwner.prepareAdmission(prepared);
    expect(prepareInput).toHaveBeenCalledOnce();

    const failure = new Error("request preparation failed");
    const failInput = vi.fn(() => {
      throw failure;
    });
    const failed = engine.prepare(user, "findMany", {}, undefined, failInput);
    const failedOwner = ownerOf(failed);
    expect(() => failedOwner.prepareAdmission(failed)).toThrow(failure);
    expect(() => failedOwner.prepareAdmission(failed)).toThrow(failure);
    expect(failInput).toHaveBeenCalledOnce();
  });

  it("resolves one package listener for an array member's interception", () => {
    const listener = vi.fn();
    const registration: WriteOutcomeRegistration = Object.freeze({
      extension: "package-listener",
      failurePolicy: "boundary-owned",
      listener,
    });
    const prepareRegistration = vi.fn(() => registration);
    const operation = createOperation<unknown>(
      "update",
      VALID_UPDATE_ARGS,
      prepareRegistration
    );
    const owner = ownerOf(operation);

    owner.prepareAdmission(operation);
    expect(owner.interception(operation).registration).toBe(registration);
    expect(owner.interception(operation)).toMatchObject({
      write: true,
      registration,
    });
    expect(prepareRegistration).toHaveBeenCalledOnce();
  });

  it("runs query interception and observation through the owner without provider work", async () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const aroundCalls = vi.fn();
    const observer = vi.fn((_unit: unknown, next: () => Promise<unknown>) =>
      next()
    );
    const chain = appendExtension(
      appendExtension(
        undefined,
        extension(
          "query-owner",
          around(() => (run) => {
            aroundCalls();
            return run();
          })
        ),
        schema
      ),
      extension("observer-owner", unit(observer)),
      schema
    );
    const engine = new TestQueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema)),
      undefined,
      undefined,
      chain
    );
    // The first moments run where the client runs them, at the operation's
    // preparation, over the one call object both moments are handed.
    const request = chain.request;
    const firstMoments = request?.handlers("user", "findMany");
    if (request === undefined || firstMoments === undefined)
      throw new Error("an around part places a first moment");
    const source = engine.prepare<unknown>(
      user,
      "findMany",
      {},
      undefined,
      (args, controls, call) =>
        request.apply(
          "findMany",
          args,
          firstMoments,
          call,
          "user",
          chain.controls,
          controls
        )
    );
    const operation = source;
    const owner = ownerOf(operation);

    owner.prepareAdmission(operation);
    const { context, handlers } = owner.interception(operation);
    expect(context).toMatchObject({
      mode: "array",
      kind: "model",
      model: "user",
      operation: "findMany",
    });
    await expect(
      executePreparedQuery(
        context,
        handlers,
        () => Promise.resolve("intercepted"),
        false
      )
    ).resolves.toBe("intercepted");
    expect(aroundCalls).toHaveBeenCalledOnce();
    // Run on the driver handed over, through the observation: the planning
    // driver refuses the statement it is sent, inside its operation unit.
    await expect(
      owner.executeWith(operation, new PlanningDriver("postgresql"))
    ).rejects.toThrow(QueryError);
    expect(
      observer.mock.calls.map(([unit]) => (unit as { kind: string }).kind)
    ).toEqual(["operation", "statement"]);
  });

  it("normalizes OrThrow operation identity and refuses unknown routed names", () => {
    const user = s.model({ id: s.string().id(), name: s.string() });
    const schema = { user };
    hydrateSchemaNames(schema);
    const engine = new TestQueryEngine(
      new PlanningDriver("postgresql"),
      createModelRegistry(schema, createSchemaRegistry(schema))
    );
    const orThrow = engine.prepare(user, "findFirstOrThrow", {});

    expect(ownerOf(orThrow).operation(orThrow)).toBe("findFirst");
    expect(() =>
      Reflect.apply(engine.prepare, engine, [
        user,
        "missing",
        {},
      ]).buildStatement()
    ).toThrow(UNKNOWN_OPERATION_PATTERN);
  });
});
