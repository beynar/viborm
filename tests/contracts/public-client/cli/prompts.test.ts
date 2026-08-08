/**
 * prompts.ts — rename-detection / resolution DECISION logic.
 *
 * These functions are pure branch logic over @clack/prompts. We drive the
 * prompt answers through the shared harness's clack mock (queueAnswers / CANCEL)
 * and assert the DECISION each function reaches — which resolution method it
 * invokes, what mapping it builds, what it displays — not the tty.
 *
 * `process.exit` is stubbed per-test (the harness only stubs it inside
 * invokeCLI, and these tests call the module functions directly).
 */

import * as p from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmApplyChanges,
  displayOperations,
  displaySQL,
  interactiveResolve,
  interactiveResolver,
} from "@src/cli/prompts";
import type {
  AmbiguousChange,
  AmbiguousResolveChange,
  ColumnDef,
  DestructiveResolveChange,
  DiffOperation,
  EnumValueRemovalChange,
} from "@src/migrations/types";
// Importing the harness installs the hoisted vi.mock("@clack/prompts") and
// exports the answer-queue controls.
import { CANCEL, queueAnswers } from "@tests/contracts/public-client/cli/_harness";

// ---------------------------------------------------------------------------
// process.exit capture (module functions call it directly on cancel)
// ---------------------------------------------------------------------------

class ExitError extends Error {
  constructor(public code: number) {
    super(`exit(${code})`);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: process.exit spy type is awkward
let exitSpy: any;

beforeEach(() => {
  queueAnswers([]);
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitError(code ?? 0);
  }) as never);
});

afterEach(() => {
  exitSpy.mockRestore();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Change builders — plain objects matching the interpreter's shapes, with the
// resolution methods spied so we can assert WHICH decision the prompt reaches.
// ---------------------------------------------------------------------------

function destructiveChange(): DestructiveResolveChange {
  const change = {
    type: "destructive",
    operation: "dropColumn",
    table: "user",
    column: "age",
    description: "Drop column user.age",
    proceed: vi.fn(() => "proceed" as const),
    reject: vi.fn(() => "reject" as const),
  };
  return change as unknown as DestructiveResolveChange;
}

function ambiguousChange(
  operation: "renameTable" | "renameColumn"
): AmbiguousResolveChange {
  const change = {
    type: "ambiguous",
    operation,
    table: "user",
    oldName: operation === "renameTable" ? "users_old" : "email_old",
    newName: operation === "renameTable" ? "users_new" : "email_new",
    description:
      operation === "renameTable"
        ? "Table users_old → users_new"
        : "Column email_old → email_new",
    rename: vi.fn(() => "rename" as const),
    addAndDrop: vi.fn(() => "addAndDrop" as const),
    reject: vi.fn(() => "reject" as const),
  };
  return change as unknown as AmbiguousResolveChange;
}

function enumChange(isNullable: boolean): EnumValueRemovalChange {
  const captured: { mapped?: Record<string, string | null> } = {};
  const change = {
    type: "enumValueRemoval",
    enumName: "Role",
    tableName: "user",
    columnName: "role",
    isNullable,
    removedValues: ["GUEST", "TEMP"],
    availableValues: ["ADMIN", "USER"],
    description: "Removing enum values",
    mapValues: vi.fn((replacements: Record<string, string | null>) => {
      captured.mapped = replacements;
      return "enumMapped" as const;
    }),
    useNull: vi.fn(() => "enumMapped" as const),
    reject: vi.fn(() => "reject" as const),
    _captured: captured,
  };
  return change as unknown as EnumValueRemovalChange & {
    _captured: typeof captured;
  };
}

// =============================================================================
// interactiveResolve — destructive
// =============================================================================

describe("interactiveResolve — destructive", () => {
  it("answer YES → proceed()", async () => {
    const change = destructiveChange();
    queueAnswers([true]);
    const result = await interactiveResolve(change);
    expect(change.proceed).toHaveBeenCalledOnce();
    expect(change.reject).not.toHaveBeenCalled();
    expect(result).toBe("proceed");
  });

  it("answer NO → reject()", async () => {
    const change = destructiveChange();
    queueAnswers([false]);
    const result = await interactiveResolve(change);
    expect(change.reject).toHaveBeenCalledOnce();
    expect(change.proceed).not.toHaveBeenCalled();
    expect(result).toBe("reject");
  });

  it("cancel → p.cancel + exit(0), no decision made", async () => {
    const change = destructiveChange();
    queueAnswers([CANCEL]);
    await expect(interactiveResolve(change)).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(change.proceed).not.toHaveBeenCalled();
    expect(change.reject).not.toHaveBeenCalled();
  });
});

// =============================================================================
// interactiveResolve — enumValueRemoval
// =============================================================================

describe("interactiveResolve — enumValueRemoval", () => {
  it("nullable + 'set all to NULL' YES → useNull()", async () => {
    const change = enumChange(true);
    queueAnswers([true]); // first confirm: set all to NULL?
    const result = await interactiveResolve(change);
    expect(change.useNull).toHaveBeenCalledOnce();
    expect(change.mapValues).not.toHaveBeenCalled();
    expect(result).toBe("enumMapped");
  });

  it("nullable + NULL prompt NO → per-value mapping; __NULL__ selection maps to null", async () => {
    const change = enumChange(true);
    // confirm NO, then per-value selects: GUEST → __NULL__, TEMP → "ADMIN"
    queueAnswers([false, "__NULL__", "ADMIN"]);
    const result = await interactiveResolve(change);
    expect(change.useNull).not.toHaveBeenCalled();
    expect(change.mapValues).toHaveBeenCalledOnce();
    expect(change.mapValues).toHaveBeenCalledWith({
      GUEST: null,
      TEMP: "ADMIN",
    });
    expect(result).toBe("enumMapped");
  });

  it("non-nullable → per-value mapValues, no NULL option offered", async () => {
    const change = enumChange(false);
    let sawNullOption = false;
    const selectSpy = vi.spyOn(p, "select").mockImplementation((async (opts: {
      options?: { value: unknown }[];
      message?: string;
    }) => {
      if (opts.options?.some((o) => o.value === "__NULL__")) {
        sawNullOption = true;
      }
      // choose the first real available value for every removed value
      return "ADMIN";
    }) as never);

    const result = await interactiveResolve(change);
    expect(sawNullOption).toBe(false);
    expect(change.mapValues).toHaveBeenCalledWith({
      GUEST: "ADMIN",
      TEMP: "ADMIN",
    });
    expect(result).toBe("enumMapped");
    selectSpy.mockRestore();
  });

  it("cancel at the nullable confirm → exit(0)", async () => {
    const change = enumChange(true);
    queueAnswers([CANCEL]);
    await expect(interactiveResolve(change)).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(change.useNull).not.toHaveBeenCalled();
    expect(change.mapValues).not.toHaveBeenCalled();
  });

  it("cancel at a per-value select → exit(0)", async () => {
    const change = enumChange(false); // no NULL confirm, straight to per-value
    queueAnswers([CANCEL]);
    await expect(interactiveResolve(change)).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(change.mapValues).not.toHaveBeenCalled();
  });
});

// =============================================================================
// interactiveResolve — ambiguous rename (default branch)
// =============================================================================

describe("interactiveResolve — ambiguous rename", () => {
  it("renameTable select 'rename' → rename()", async () => {
    const change = ambiguousChange("renameTable");
    queueAnswers(["rename"]);
    const result = await interactiveResolve(change);
    expect(change.rename).toHaveBeenCalledOnce();
    expect(change.addAndDrop).not.toHaveBeenCalled();
    expect(result).toBe("rename");
  });

  it("renameTable select 'addAndDrop' → addAndDrop()", async () => {
    const change = ambiguousChange("renameTable");
    queueAnswers(["addAndDrop"]);
    const result = await interactiveResolve(change);
    expect(change.addAndDrop).toHaveBeenCalledOnce();
    expect(change.rename).not.toHaveBeenCalled();
    expect(result).toBe("addAndDrop");
  });

  it("column rename (non-table) 'rename' → rename()", async () => {
    const change = ambiguousChange("renameColumn");
    queueAnswers(["rename"]);
    const result = await interactiveResolve(change);
    expect(change.rename).toHaveBeenCalledOnce();
    expect(result).toBe("rename");
  });

  it("column rename offers a column-worded add+drop option (not table wording)", async () => {
    const change = ambiguousChange("renameColumn");
    let addDropLabel = "";
    let addDropHint = "";
    const selectSpy = vi.spyOn(p, "select").mockImplementation((async (opts: {
      options?: { value: unknown; label: string; hint?: string }[];
    }) => {
      const addDrop = opts.options?.find((o) => o.value === "addAndDrop");
      addDropLabel = addDrop?.label ?? "";
      addDropHint = addDrop?.hint ?? "";
      return "rename";
    }) as never);
    const result = await interactiveResolve(change);
    // Outer assertions: fail if the select path was skipped or the decision
    // never executed (guards against interactiveResolve becoming a no-op).
    expect(selectSpy).toHaveBeenCalledOnce();
    expect(change.rename).toHaveBeenCalledOnce();
    expect(change.addAndDrop).not.toHaveBeenCalled();
    expect(result).toBe("rename");
    // Column-worded (not table-worded) add+drop option.
    expect(addDropLabel).toContain("column");
    expect(addDropHint).toContain("old column");
    selectSpy.mockRestore();
  });

  it("cancel → exit(0)", async () => {
    const change = ambiguousChange("renameTable");
    queueAnswers([CANCEL]);
    await expect(interactiveResolve(change)).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(change.rename).not.toHaveBeenCalled();
    expect(change.addAndDrop).not.toHaveBeenCalled();
  });
});

// =============================================================================
// interactiveResolver (legacy Resolver)
// =============================================================================

function column(name: string): ColumnDef {
  return { name, type: "text", nullable: false };
}

const tableChange: AmbiguousChange = {
  type: "ambiguousTable",
  droppedTable: "users_old",
  addedTable: "users_new",
};

const columnChange: AmbiguousChange = {
  type: "ambiguousColumn",
  tableName: "account",
  droppedColumn: column("email_old"),
  addedColumn: column("email_new"),
};

describe("interactiveResolver (legacy)", () => {
  it("table change: rename choice → {type:'rename'}", async () => {
    queueAnswers(["rename"]);
    const map = await interactiveResolver([tableChange]);
    expect(map.get(tableChange)).toEqual({ type: "rename" });
  });

  it("table change: add+drop choice → {type:'addAndDrop'}", async () => {
    queueAnswers(["addAndDrop"]);
    const map = await interactiveResolver([tableChange]);
    expect(map.get(tableChange)).toEqual({ type: "addAndDrop" });
  });

  it("column change: resolution recorded, prompt carries table-name hint", async () => {
    let message = "";
    const selectSpy = vi.spyOn(p, "select").mockImplementation((async (opts: {
      message?: string;
    }) => {
      message = opts.message ?? "";
      return "rename";
    }) as never);
    const map = await interactiveResolver([columnChange]);
    expect(map.get(columnChange)).toEqual({ type: "rename" });
    // Column prompt wording includes the containing table name.
    expect(message).toContain('in table "account"');
    expect(message).toContain("email_old");
    expect(message).toContain("email_new");
    selectSpy.mockRestore();
  });

  it("cancel mid-loop → exit(0), partial map not returned", async () => {
    // first change resolves, second cancels
    queueAnswers(["rename", CANCEL]);
    await expect(
      interactiveResolver([tableChange, columnChange])
    ).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("empty change list → empty map", async () => {
    const map = await interactiveResolver([]);
    expect(map.size).toBe(0);
  });
});

// =============================================================================
// confirmApplyChanges
// =============================================================================

describe("confirmApplyChanges", () => {
  it("returns true when confirmed", async () => {
    queueAnswers([true]);
    expect(await confirmApplyChanges()).toBe(true);
  });

  it("returns false when declined", async () => {
    queueAnswers([false]);
    expect(await confirmApplyChanges()).toBe(false);
  });

  it("cancel → exit(0)", async () => {
    queueAnswers([CANCEL]);
    await expect(confirmApplyChanges()).rejects.toBeInstanceOf(ExitError);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

// =============================================================================
// displayOperations
// =============================================================================

// Minimal DiffOperation builders (only the fields formatOp/getTableName read).
const op = (o: Record<string, unknown>): DiffOperation => o as DiffOperation;

function captureNotes() {
  const calls: { title: string; body: string }[] = [];
  vi.spyOn(p, "note").mockImplementation(((body: string, title?: string) => {
    calls.push({ title: title ?? "", body });
  }) as never);
  const first = () => {
    const c = calls[0];
    if (!c) {
      throw new Error("expected at least one p.note call");
    }
    return c;
  };
  return { calls, first };
}

describe("displayOperations", () => {
  it("empty ops → 'up to date' note", () => {
    const notes = captureNotes();
    displayOperations([]);
    expect(notes.calls).toHaveLength(1);
    expect(notes.first().body).toContain("up to date");
  });

  it("groups enum / table / per-table column ops into distinct sections", () => {
    const notes = captureNotes();
    displayOperations([
      op({ type: "createEnum", enumDef: { name: "Role" } }),
      op({ type: "createTable", table: { name: "post" } }),
      op({
        type: "addColumn",
        tableName: "user",
        column: { name: "age", type: "int" },
      }),
    ]);
    const body = notes.first().body;
    expect(body).toContain("Enums:");
    expect(body).toContain("Tables:");
    expect(body).toContain("Table: user"); // per-table column section
    expect(body).toContain('Create enum "Role"');
    expect(body).toContain('Create table "post"');
    expect(body).toContain("Add column: age");
  });

  it("column-level ops route under their table, table/enum ops do not (getTableName)", () => {
    const notes = captureNotes();
    // A dropTable is a table-level op (getTableName null) → 'Tables:' section,
    // while dropColumn on the same name would nest under 'Table: <name>'.
    displayOperations([
      op({ type: "dropTable", tableName: "user" }),
      op({ type: "dropColumn", tableName: "user", columnName: "age" }),
    ]);
    const body = notes.first().body;
    expect(body).toContain("Tables:");
    expect(body).toContain('Drop table "user"');
    expect(body).toContain("Table: user");
    expect(body).toContain("Drop column: age");
  });
});

// =============================================================================
// formatOp (exercised through displayOperations' note body)
// =============================================================================

function renderOps(ops: DiffOperation[]): string {
  const notes = captureNotes();
  displayOperations(ops);
  return notes.first().body;
}

describe("formatOp labels", () => {
  it("table ops: create / drop / rename", () => {
    const body = renderOps([
      op({ type: "createTable", table: { name: "t1" } }),
      op({ type: "dropTable", tableName: "t2" }),
      op({ type: "renameTable", from: "old", to: "new" }),
    ]);
    expect(body).toContain('✓ Create table "t1"');
    expect(body).toContain('✗ Drop table "t2"');
    expect(body).toContain("~ Rename table: old → new");
  });

  it("column ops: add / drop / rename / alter", () => {
    const body = renderOps([
      op({
        type: "addColumn",
        tableName: "t",
        column: { name: "a", type: "int" },
      }),
      op({ type: "dropColumn", tableName: "t", columnName: "b" }),
      op({ type: "renameColumn", tableName: "t", from: "c", to: "d" }),
      op({ type: "alterColumn", tableName: "t", columnName: "e" }),
    ]);
    expect(body).toContain("+ Add column: a (int)");
    expect(body).toContain("- Drop column: b");
    expect(body).toContain("~ Rename column: c → d");
    expect(body).toContain("~ Alter column: e");
  });

  it("createIndex op renders its label", () => {
    // NOTE: dropIndex is absent from getTableName's switch, so displayOperations
    // silently drops it before formatOp — its label is unreachable via this
    // seam (reported as a limitation). createIndex IS routed, so assert it.
    const body = renderOps([
      op({ type: "createIndex", tableName: "t", index: { name: "idx_a" } }),
    ]);
    expect(body).toContain("+ Add index: idx_a");
  });

  it("constraint / key ops: fk, unique, primary key add/drop", () => {
    const body = renderOps([
      op({ type: "addForeignKey", tableName: "t", fk: { name: "fk_a" } }),
      op({ type: "dropForeignKey", tableName: "t", fkName: "fk_b" }),
      op({
        type: "addUniqueConstraint",
        tableName: "t",
        constraint: { name: "uq_a" },
      }),
      op({
        type: "dropUniqueConstraint",
        tableName: "t",
        constraintName: "uq_b",
      }),
      op({ type: "addPrimaryKey", tableName: "t" }),
      op({ type: "dropPrimaryKey", tableName: "t", constraintName: "pk_a" }),
    ]);
    expect(body).toContain("+ Add foreign key: fk_a");
    expect(body).toContain("- Drop foreign key: fk_b");
    expect(body).toContain("+ Add unique constraint: uq_a");
    expect(body).toContain("- Drop unique constraint: uq_b");
    expect(body).toContain("+ Add primary key");
    expect(body).toContain("- Drop primary key: pk_a");
  });

  it("enum ops: create / drop / alter (add + remove parts)", () => {
    const body = renderOps([
      op({ type: "createEnum", enumDef: { name: "E1" } }),
      op({ type: "dropEnum", enumName: "E2" }),
      op({
        type: "alterEnum",
        enumName: "E3",
        addValues: ["X", "Y"],
        removeValues: ["Z"],
      }),
    ]);
    expect(body).toContain('✓ Create enum "E1"');
    expect(body).toContain('✗ Drop enum "E2"');
    expect(body).toContain('~ Alter enum "E3": +X, Y -Z');
  });

  // NOTE: formatOp's `default → "Unknown operation"` arm is unreachable through
  // displayOperations: the table/enum sections only push recognised types, and
  // getTableName returns null for anything else (so it is dropped before
  // formatOp sees it). formatOp is not exported, so there is no honest seam to
  // exercise that arm. Reported as a coverage limitation, not faked here.
});

// =============================================================================
// displaySQL
// =============================================================================

describe("displaySQL", () => {
  it("empty array → emits no note", () => {
    const notes = captureNotes();
    displaySQL([]);
    expect(notes.calls).toHaveLength(0);
  });

  it("non-empty → single 'SQL to execute' note with ;-terminated statements", () => {
    const notes = captureNotes();
    displaySQL(["CREATE TABLE user (id text)", "CREATE INDEX i ON user(id)"]);
    expect(notes.calls).toHaveLength(1);
    expect(notes.first().title).toBe("SQL to execute");
    expect(notes.first().body).toContain("CREATE TABLE user (id text);");
    expect(notes.first().body).toContain("CREATE INDEX i ON user(id);");
  });
});
