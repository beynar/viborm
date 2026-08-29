import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { ResultParser } from "@query-engine/result/ResultParser";
import { getAggregateResultKey } from "@query-engine/result-aliases";
import { s } from "@schema";
import type { PolymorphicStorageColumn } from "@schema/relation";
import { parseCapturedRows } from "@src/query-engine/write-engine/series-result-read";
import { createSchemaRegistry } from "@validation";
import {
  materializePhysicalDecimal,
  materializePhysicalWidenedSum,
  toDecimal,
} from "@validation/primitives/decimal-codec";
import { describe, expect, test, vi } from "vitest";

const RESULT_COLUMN_MISMATCH_PATTERN =
  /does not match the requested result columns/i;

vi.mock("@validation/primitives/decimal-codec", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@validation/primitives/decimal-codec")
    >();
  return {
    ...actual,
    materializePhysicalDecimal: vi.fn(actual.materializePhysicalDecimal),
    materializePhysicalWidenedSum: vi.fn(actual.materializePhysicalWidenedSum),
    toDecimal: vi.fn(actual.toDecimal),
  };
});

class CaptureDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();

  constructor() {
    super("sqlite", "capture-materialization");
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // This fixture does not allocate an external client.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    run: (transaction: null) => Promise<T>
  ): Promise<T> {
    return run(null);
  }
}

const id = s.decimal({ precision: 12, scale: 2 }).id();
const amount = s.decimal({ precision: 12, scale: 2 });
const model = s.model({ id, amount });
const models = { record: model };

function context() {
  const driver = new CaptureDriver();
  const engine = new QueryEngine(
    driver,
    createModelRegistry(models, createSchemaRegistry(models))
  );
  return { engine, parser: new ResultParser(engine, model, driver) };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected captured-row parsing to fail.");
}

describe("capture-only decimal result decoding", () => {
  test("keeps canonical private values without public Decimal materialization", () => {
    const directMaterialize = vi.mocked(materializePhysicalDecimal);
    const materialize = vi.mocked(toDecimal);
    directMaterialize.mockClear();
    materialize.mockClear();
    const { engine, parser } = context();

    expect(parser.parseCapturedField(id, "1000", "findMany")).toBe("10");
    expect(
      parseCapturedRows(engine, model, [{ id: "1000", amount: "250" }], {
        id: true,
        amount: true,
      })
    ).toEqual([{ id: "10", amount: "2.5" }]);
    expect(directMaterialize).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
  });

  test("ordinary typed results materialize one Decimal per selected leaf", () => {
    const directMaterialize = vi.mocked(materializePhysicalDecimal);
    const materialize = vi.mocked(toDecimal);
    directMaterialize.mockClear();
    materialize.mockClear();
    const { parser } = context();

    const rows = parser.parse<{ id: { toString(): string } }[]>(
      "findMany",
      [{ id: "1000" }],
      { select: { id: true } }
    );

    expect(rows[0]?.id.toString()).toBe("10");
    expect(directMaterialize).toHaveBeenCalledTimes(1);
    expect(materialize).not.toHaveBeenCalled();
  });

  test("capture plus public materialization preserves both representations", () => {
    const directMaterialize = vi.mocked(materializePhysicalDecimal);
    const materialize = vi.mocked(toDecimal);
    directMaterialize.mockClear();
    materialize.mockClear();
    const { parser } = context();

    const [rows, rowKeys] = parser.parseRowsWithRowKeys<
      { id: { toString(): string } }[]
    >("findMany", [{ id: "1000" }], { select: { id: true } }, ["id"]);

    expect(rows[0]?.id.toString()).toBe("10");
    expect(rowKeys).toEqual([{ id: "10" }]);
    expect(directMaterialize).not.toHaveBeenCalled();
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  test("keeps widened sums private only for capture-only parsing", () => {
    const directMaterialize = vi.mocked(materializePhysicalWidenedSum);
    const materialize = vi.mocked(toDecimal);
    directMaterialize.mockClear();
    materialize.mockClear();
    const { parser } = context();
    const sumKey = getAggregateResultKey("_sum");
    const args = { _sum: { amount: true } };

    expect(
      parser.parseCapturedRows(
        "aggregate",
        [{ [sumKey]: { amount: "250" } }],
        args
      )
    ).toEqual({ _sum: { amount: "2.5" } });
    expect(directMaterialize).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();

    const result = parser.parse<{
      _sum: { amount: { toString(): string } };
    }>("aggregate", [{ [sumKey]: { amount: "250" } }], args);

    expect(result._sum.amount.toString()).toBe("2.5");
    expect(directMaterialize).toHaveBeenCalledTimes(1);
    expect(materialize).not.toHaveBeenCalled();
  });

  test.each([
    [
      "a revoked proxy",
      () => {
        const revocable = Proxy.revocable({ id: "1000", amount: "250" }, {});
        revocable.revoke();
        return revocable.proxy;
      },
    ],
    [
      "a throwing own-property trap",
      () =>
        new Proxy(
          { id: "1000", amount: "250" },
          {
            getOwnPropertyDescriptor() {
              throw new Error("hostile hasOwn trap");
            },
          }
        ),
    ],
  ] as const)("translates %s at the result boundary", (_name, hostileRow) => {
    const { engine } = context();
    const error = captureError(() =>
      parseCapturedRows(engine, model, [hostileRow()], {
        id: true,
        amount: true,
      })
    );

    expect(error).toMatchObject({
      name: "QueryEngineError",
      meta: { driver: "capture-materialization", operation: "findMany" },
    });
  });

  test("does not invoke a selected-value get trap", () => {
    const { engine } = context();
    let observedValues = 0;
    const row = new Proxy(
      { id: "1000", amount: "250" },
      {
        get(target, property, receiver) {
          if (property === "amount") {
            observedValues += 1;
            throw new Error("hostile selected-value trap");
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    expect(
      parseCapturedRows(engine, model, [row], { id: true, amount: true })
    ).toEqual([{ id: "10", amount: "2.5" }]);
    expect(observedValues).toBe(0);
  });

  test("does not invoke a private-column get trap", () => {
    const { engine } = context();
    let observedValues = 0;
    const privateColumn: PolymorphicStorageColumn = {
      name: "private_amount",
      scalar: amount,
      nullable: false,
    };
    const row = new Proxy(
      { id: "1000", private_amount: "250" },
      {
        get(target, property, receiver) {
          if (property === "private_amount") {
            observedValues += 1;
            throw new Error("hostile private-column trap");
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    expect(
      parseCapturedRows(engine, model, [row], { id: true }, [privateColumn])
    ).toEqual([{ id: "10", private_amount: "2.5" }]);
    expect(observedValues).toBe(0);
  });

  test("does not relabel downstream parser failures as row inspection", () => {
    const { engine } = context();
    const downstreamFailure = new Error("downstream parser failure");
    vi.spyOn(
      ResultParser.prototype,
      "parseCapturedRows"
    ).mockImplementationOnce(() => {
      throw downstreamFailure;
    });

    expect(() =>
      parseCapturedRows(engine, model, [{ id: "1000" }], { id: true })
    ).toThrow(downstreamFailure);
  });

  test("validates every captured row before reading the first row's values", () => {
    const { engine } = context();
    let observedValues = 0;
    const first = new Proxy(
      { id: "1000", amount: "250" },
      {
        get(target, property, receiver) {
          if (property === "id" || property === "amount") {
            observedValues += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );

    expect(() =>
      parseCapturedRows(engine, model, [first, { id: "2000" }], {
        id: true,
        amount: true,
      })
    ).toThrow(RESULT_COLUMN_MISMATCH_PATTERN);
    expect(observedValues).toBe(0);
  });
});
