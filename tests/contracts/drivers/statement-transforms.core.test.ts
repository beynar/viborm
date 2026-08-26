import { QueryError } from "@errors";
import type { ResolvedExtensionHandler } from "@extensions/chain";
import {
  applyStatementTransforms,
  type StatementContext,
  type StatementHandler,
} from "@extensions/statement";
import { isSql, sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

type StatementHandlerEntry = ResolvedExtensionHandler<StatementHandler>;

function captureQueryError(action: () => unknown): QueryError {
  try {
    action();
  } catch (error) {
    if (error instanceof QueryError) return error;
    throw error;
  }
  throw new Error("Expected a QueryError");
}

function transformReturning(
  extension: string,
  value: unknown
): StatementHandlerEntry {
  return {
    extension,
    // @ts-expect-error - hostile JavaScript can violate the public Sql return.
    handler() {
      return value;
    },
  };
}

describe("standalone statement transforms", () => {
  test("the empty path returns the exact statement without inspection", () => {
    const original = sql`SELECT ${1}`;
    const hostile = new Proxy(original, {
      get() {
        throw new Error("the empty path inspected the statement");
      },
      getPrototypeOf() {
        throw new Error("the empty path inspected statement identity");
      },
    });

    expect(
      applyStatementTransforms(hostile, "post", "findMany", undefined)
    ).toBe(hostile);
    expect(applyStatementTransforms(hostile, "post", "findMany", [])).toBe(
      hostile
    );
  });

  test("runs synchronous handlers once in application order", () => {
    const original = sql`SELECT ${1}`;
    const firstStatement = sql`SELECT ${2}`;
    const finalStatement = sql`SELECT ${3}`;
    const order: string[] = [];
    const first = vi.fn((context: StatementContext) => {
      order.push("first");
      expect(Object.isFrozen(context)).toBe(true);
      expect(context).toEqual({
        statement: original,
        model: "post",
        operation: "findMany",
      });
      return firstStatement;
    });
    const second = vi.fn((context: StatementContext) => {
      order.push("second");
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.statement).toBe(firstStatement);
      expect(context.model).toBe("post");
      expect(context.operation).toBe("findMany");
      return finalStatement;
    });
    const transforms: StatementHandlerEntry[] = [
      { extension: "first", handler: first },
      { extension: "second", handler: second },
    ];

    expect(
      applyStatementTransforms(original, "post", "findMany", transforms)
    ).toBe(finalStatement);
    expect(order).toEqual(["first", "second"]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });

  test("exposes exactly statement, model, and operation", () => {
    const original = sql`SELECT 1`;
    applyStatementTransforms(original, undefined, "$queryRaw", [
      {
        extension: "surface",
        handler(context) {
          expect(Object.isFrozen(context)).toBe(true);
          expect(Reflect.ownKeys(context)).toEqual([
            "statement",
            "model",
            "operation",
          ]);
          expect(context.statement).toBe(original);
          expect(context.model).toBeUndefined();
          expect(context.operation).toBe("$queryRaw");
          expect("driver" in context).toBe(false);
          expect("program" in context).toBe(false);
          expect("values" in context).toBe(false);
          return context.statement;
        },
      },
    ]);
  });

  test("validates an unchanged trusted statement", () => {
    const original = sql`SELECT ${1}`;
    const render = vi.spyOn(original, "toStatement");

    expect(
      applyStatementTransforms(original, "post", "findMany", [
        {
          extension: "identity",
          handler: ({ statement }) => statement,
        },
      ])
    ).toBe(original);
    expect(render).toHaveBeenCalledOnce();
    render.mockRestore();
  });

  test("rejects an unchanged statement made unreadable by its handler", () => {
    const original = sql`SELECT ${1}`;
    const rendererFailure = new Error("identity renderer failed");
    const error = captureQueryError(() =>
      applyStatementTransforms(original, "post", "findMany", [
        {
          extension: "mutated-identity",
          handler({ statement }) {
            vi.spyOn(statement, "toStatement").mockImplementation(() => {
              throw rendererFailure;
            });
            return statement;
          },
        },
      ])
    );

    expect(error.message).toContain('Extension "mutated-identity"');
    expect(error.message).toContain("returned an unreadable value");
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  test("accepts the duplicated-module structural identity owned by isSql", () => {
    class DuplicatedSql {
      readonly strings = ["SELECT ", ""];
      readonly values = [1];

      toStatement(): string {
        return "SELECT ?";
      }
    }

    const duplicated = new DuplicatedSql();
    expect(isSql(duplicated)).toBe(true);
    const transform: StatementHandlerEntry = {
      extension: "duplicated-module",
      // @ts-expect-error - runtime falsifier for the structural cross-module guard
      handler() {
        return duplicated;
      },
    };

    expect(
      applyStatementTransforms(sql`SELECT 1`, "post", "findMany", [transform])
    ).toBe(duplicated);
  });
});

describe("statement-transform failures", () => {
  test("attributes thrown Error and non-Error values to the extension", () => {
    const thrown = new Error("transform failed");
    const thrownError = captureQueryError(() =>
      applyStatementTransforms(sql`SELECT 1`, "post", "findMany", [
        {
          extension: "throwing",
          handler() {
            throw thrown;
          },
        },
      ])
    );
    expect(thrownError.message).toContain('Extension "throwing"');
    expect(thrownError.message).toContain("post.findMany");
    expect(thrownError.originalCause).toBeInstanceOf(Error);

    const nonError = captureQueryError(() =>
      applyStatementTransforms(sql`SELECT 1`, "post", "findMany", [
        {
          extension: "non-error",
          handler() {
            // biome-ignore lint/style/useThrowOnlyError: hostile JavaScript can throw any value.
            throw { toString: null };
          },
        },
      ])
    );
    expect(nonError.message).toContain('Extension "non-error"');
    expect(nonError.originalCause).toBeInstanceOf(Error);
  });

  test("a hostile Error proxy cannot escape the named statement boundary", () => {
    const hostileFailure = new Proxy(new Error("private statement failure"), {
      getPrototypeOf() {
        throw new Error("hostile statement prototype read");
      },
    });
    const error = captureQueryError(() =>
      applyStatementTransforms(sql`SELECT 1`, "post", "findMany", [
        {
          extension: "hostile-statement-error",
          handler() {
            throw hostileFailure;
          },
        },
      ])
    );

    expect(error.message).toContain('Extension "hostile-statement-error"');
    expect(error.message).toContain(
      "statement handler for post.findMany threw"
    );
    expect(error.originalCause).toBeInstanceOf(Error);
    expect(error.originalCause).not.toBe(hostileFailure);
  });

  test("rejects non-Sql and promise outputs synchronously", () => {
    const nonSql = captureQueryError(() =>
      applyStatementTransforms(sql`SELECT 1`, "post", "update", [
        {
          extension: "non-sql",
          handler() {
            return 1;
          },
        },
      ])
    );
    expect(nonSql.message).toContain('Extension "non-sql"');
    expect(nonSql.message).toContain("returned a non-Sql value");
    expect(nonSql.originalCause).toBeInstanceOf(Error);

    const promise = Promise.resolve(sql`SELECT 2`);
    const asyncOutput = captureQueryError(() =>
      applyStatementTransforms(sql`SELECT 1`, "post", "update", [
        {
          extension: "async",
          handler() {
            return promise;
          },
        },
      ])
    );
    expect(asyncOutput.message).toContain('Extension "async"');
    expect(asyncOutput.message).toContain("returned a promise or thenable");
    expect(asyncOutput.originalCause).toBeInstanceOf(Error);
  });

  test("normalizes hostile structural and thenable reads", () => {
    const structuralFailure = new Error("strings getter failed");
    const hostileStructure = new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "strings") throw structuralFailure;
          return undefined;
        },
      }
    );
    const structuralError = captureQueryError(() =>
      applyStatementTransforms(sql`SELECT 1`, "post", "findMany", [
        {
          extension: "hostile-structure",
          handler() {
            return hostileStructure;
          },
        },
      ])
    );
    expect(structuralError.message).toContain('Extension "hostile-structure"');
    expect(structuralError.message).toContain("returned an unreadable value");
    expect(structuralError.originalCause).toBeInstanceOf(Error);

    const thenFailure = new Error("then getter failed");
    const hostileThenable = Object.defineProperty({}, "then", {
      get() {
        throw thenFailure;
      },
    });
    const thenableError = captureQueryError(() =>
      applyStatementTransforms(sql`SELECT 1`, "post", "findMany", [
        {
          extension: "hostile-thenable",
          handler() {
            return hostileThenable;
          },
        },
      ])
    );
    expect(thenableError.message).toContain('Extension "hostile-thenable"');
    expect(thenableError.message).toContain("returned an unreadable value");
    expect(thenableError.originalCause).toBeInstanceOf(Error);
  });

  test("rejects structurally branded values without a usable renderer", () => {
    const rendererFailure = new Error("renderer failed");
    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      ["missing-renderer", { strings: ["SELECT 1"], values: [] }],
      [
        "non-callable-renderer",
        { strings: ["SELECT 1"], values: [], toStatement: 1 },
      ],
      [
        "unreadable-renderer",
        Object.defineProperty(
          { strings: ["SELECT 1"], values: [] },
          "toStatement",
          {
            get() {
              throw new Error("renderer accessor failed");
            },
          }
        ),
      ],
      [
        "throwing-renderer",
        {
          strings: ["SELECT 1"],
          values: [],
          toStatement() {
            throw rendererFailure;
          },
        },
      ],
    ];

    for (const [extension, value] of malformed) {
      expect(isSql(value)).toBe(true);
      const error = captureQueryError(() =>
        applyStatementTransforms(sql`SELECT 1`, "post", "findMany", [
          transformReturning(extension, value),
        ])
      );
      expect(error.message).toContain(`Extension "${extension}"`);
      expect(error.message).toContain("post.findMany");
      expect(error.message).toContain("returned an unreadable value");
      expect(error.originalCause).toBeInstanceOf(Error);
    }
  });
});
