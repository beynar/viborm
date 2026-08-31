import { compileBindBudgetChunks } from "@query-engine/bind-budget";
import { sql } from "@sql";
import { describe, expect, test, vi } from "vitest";

describe("compiled bind-budget partitioning", () => {
  test("keeps an individually oversized semantic item intact for final refusal", () => {
    const compile = vi.fn((start: number, end: number) =>
      sql.join(
        Array.from({ length: (end - start) * 2 }, (_, offset) =>
          sql`${start + offset}`
        ),
        ", "
      )
    );

    const chunks = compileBindBudgetChunks(2, 1, compile);

    expect(
      chunks.map(({ start, end, statement }) => ({
        start,
        end,
        bindCount: statement.values.length,
      }))
    ).toEqual([
      { start: 0, end: 1, bindCount: 2 },
      { start: 1, end: 2, bindCount: 2 },
    ]);
  });

  test("does not compile a statement for an empty semantic range", () => {
    const compile = vi.fn(() => sql`unused`);

    expect(compileBindBudgetChunks(0, 1, compile)).toEqual([]);
    expect(compile).not.toHaveBeenCalled();
  });
});
