import { Sql } from "@sql";
import { validateFragment } from "@src/query-engine/write-engine/FragmentValidator";
import {
  type OperationFragment,
  type OperationStep,
  type OperationValueReference,
  ref,
  type StatementStep,
} from "@src/query-engine/write-engine/OperationFragment";
import { describe, expect, test } from "vitest";

function sqlWith(...refs: OperationValueReference[]): Sql {
  return new Sql(
    Array.from({ length: refs.length + 1 }, () => ""),
    refs
  );
}

describe("write engine fragment validator (ATOM §9)", () => {
  test("invariant 1: rejects duplicate step ids", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "dup",
          kind: "write",
          statement: sqlWith(),
          outputs: { id: { kind: "insertId" } },
        },
        {
          id: "dup",
          kind: "read",
          statement: sqlWith(),
          outputs: { rows: { kind: "rows" } },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow("is not unique");
  });

  test("invariant 2: rejects a reference that does not point backward", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "reader",
          kind: "read",
          statement: sqlWith(ref("writer", "id")),
          outputs: {},
        },
        {
          id: "writer",
          kind: "write",
          statement: sqlWith(),
          outputs: { id: { kind: "insertId" } },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow("does not point backward");
  });

  test("invariant 2: rejects a reference outside the fragment", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "reader",
          kind: "read",
          statement: sqlWith(ref("ghost", "id")),
          outputs: {},
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow("points outside");
  });

  test("invariant 2: rejects a reference to an undeclared output", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "writer",
          kind: "write",
          statement: sqlWith(),
          outputs: { id: { kind: "insertId" } },
        },
        {
          id: "reader",
          kind: "read",
          statement: sqlWith(ref("writer", "missing")),
          outputs: {},
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow("undeclared output");
  });

  test("invariant 2: scans guard premise statements for references", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "guard",
          kind: "guard",
          premise: { kind: "exists", statement: sqlWith(ref("ghost", "id")) },
          failure: {
            kind: "nestedWrite",
            message: "m",
            relation: "r",
            raceable: false,
          },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow("points outside");
  });

  test("invariant 2: scans consumed output references through the same boundary", () => {
    const outside: OperationFragment = {
      steps: [
        {
          id: "writer",
          kind: "write",
          statement: sqlWith(),
          outputs: {
            key: {
              kind: "consumedValue",
              source: { kind: "reference", reference: ref("ghost", "id") },
            },
          },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(outside)).toThrow("points outside");

    const forward: OperationFragment = {
      steps: [
        {
          id: "consumer",
          kind: "write",
          statement: sqlWith(),
          outputs: {
            key: {
              kind: "consumedValue",
              source: { kind: "reference", reference: ref("producer", "id") },
            },
          },
        },
        {
          id: "producer",
          kind: "write",
          statement: sqlWith(),
          outputs: { id: { kind: "insertId" } },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(forward)).toThrow("does not point backward");
  });

  test("a consumed-value reference must be present in its successful write", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "producer",
          kind: "read",
          statement: sqlWith(),
          outputs: { id: { kind: "firstRowField", field: "id" } },
        },
        {
          id: "publisher",
          kind: "write",
          statement: sqlWith(),
          outputs: {
            forwarded: {
              kind: "consumedValue",
              source: {
                kind: "reference",
                reference: ref("producer", "id"),
              },
            },
          },
        },
      ],
      outputs: {},
    };

    expect(() => validateFragment(fragment)).toThrow(
      "must publish a reference the successful write statement consumed"
    );
  });

  test("consumed output values use a canonical literal-or-reference shape", () => {
    const step = (value: unknown): OperationFragment => ({
      steps: [
        {
          id: "writer",
          kind: "write",
          statement: sqlWith(),
          outputs: {
            key: {
              kind: "consumedValue",
              source: { kind: "literal", value },
            },
          },
        },
      ],
      outputs: {},
    });
    expect(() => validateFragment(step(sqlWith()))).toThrow(
      "cannot forward SQL"
    );
    expect(() => validateFragment(step(ref("writer", "key")))).toThrow(
      "explicit reference arm"
    );
    expect(() => validateFragment(step("exact"))).not.toThrow();
  });

  test("a read cannot claim a value was consumed by a successful write", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "reader",
          kind: "read",
          statement: sqlWith(),
          outputs: {
            key: {
              kind: "consumedValue",
              source: { kind: "literal", value: "x" },
            },
          },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow(
      "must belong to a successful write step"
    );
  });

  test("invariant 4: rejects an unresolvable fragment output", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "writer",
          kind: "write",
          statement: sqlWith(),
          outputs: { id: { kind: "insertId" } },
        },
      ],
      outputs: { result: ref("writer", "missing") },
    };
    expect(() => validateFragment(fragment)).toThrow("does not resolve");
  });

  test("invariant 4: rejects an empty ordered output list", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "a",
          kind: "read",
          statement: sqlWith(),
          outputs: { rows: { kind: "rows" } },
        },
      ],
      outputs: { result: [] },
    };
    expect(() => validateFragment(fragment)).toThrow("names no produced value");
  });

  test("invariant 5: rejects a raceable exists guard", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "guard",
          kind: "guard",
          premise: { kind: "exists", statement: sqlWith() },
          failure: {
            kind: "nestedWrite",
            message: "m",
            relation: "r",
            raceable: true,
          },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow("must be raceable: false");
  });

  test("invariant 5: rejects a non-raceable notExists guard (the FATAL pin)", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "guard",
          kind: "guard",
          premise: { kind: "notExists", statement: sqlWith() },
          failure: {
            kind: "nestedWrite",
            message: "m",
            relation: "r",
            raceable: false,
          },
        },
      ],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).toThrow(
      "production-FATAL create-branch pin"
    );
  });

  test("progressive continuation ids share the fragment's one id namespace", () => {
    const continuation = (id: string) => ({
      id,
      kind: "guard" as const,
      premise: {
        kind: "exists" as const,
        statement: sqlWith(ref("owner", "id")),
      },
      failure: {
        kind: "query" as const,
        message: "changed",
        raceable: false,
      },
    });
    const series = {
      executionKind: "recordSeries" as const,
      capture: () => ({ steps: [] }),
      compileMembers: () => [],
      compileResultReads: () => [],
      parseSeries: () => undefined,
    };
    const collisionKinds: readonly {
      readonly step: OperationStep;
      readonly collisionId: string;
    }[] = [
      {
        collisionId: "owner",
        step: {
          id: "owner",
          kind: "write",
          statement: sqlWith(),
          outputs: { id: { kind: "insertId" } },
        },
      },
      {
        collisionId: "prior",
        step: {
          id: "prior",
          kind: "read",
          statement: sqlWith(),
          outputs: {},
        },
      },
      {
        collisionId: "ordinary-guard",
        step: {
          id: "ordinary-guard",
          kind: "guard",
          premise: { kind: "exists", statement: sqlWith() },
          failure: {
            kind: "query",
            message: "guard",
            raceable: false,
          },
        },
      },
      {
        collisionId: "series",
        step: {
          id: "series",
          kind: "recordSeries",
          series,
          progressive: {
            kind: "unsupported",
            reason: "not executed",
          },
        },
      },
      {
        collisionId: "series-continuation",
        step: {
          id: "guarded-series",
          kind: "recordSeries",
          series,
          progressive: {
            kind: "guarded",
            guard: {
              id: "series-continuation",
              kind: "guard",
              premise: { kind: "exists", statement: sqlWith() },
              failure: {
                kind: "query",
                message: "series changed",
                raceable: false,
              },
            },
          },
        },
      },
    ];
    for (const { step: collided, collisionId } of collisionKinds) {
      const owner: StatementStep = {
        id: "owner",
        kind: "write",
        statement: sqlWith(),
        outputs: { id: { kind: "insertId" } },
        progressiveContinuation: continuation(collisionId),
      };
      const steps: OperationStep[] =
        collided.id === "owner" ? [owner] : [collided, owner];
      expect(() => validateFragment({ steps, outputs: {} })).toThrow(
        "collides with a fragment step id"
      );
    }
  });

  test("a continuation can reference its owner's declared output only as a stable exists premise", () => {
    const owner: StatementStep = {
      id: "owner",
      kind: "write",
      statement: sqlWith(),
      outputs: { id: { kind: "firstRowField", field: "id" } },
      progressiveContinuation: {
        id: "owner.continuation",
        kind: "guard",
        premise: {
          kind: "exists",
          statement: sqlWith(ref("owner", "id")),
        },
        failure: { kind: "query", message: "changed", raceable: false },
      },
    };
    const fragment: OperationFragment = {
      steps: [owner],
      outputs: {},
    };
    expect(() => validateFragment(fragment)).not.toThrow();

    const unstable: OperationFragment = {
      ...fragment,
      steps: [
        {
          ...owner,
          progressiveContinuation: {
            id: "owner.continuation",
            kind: "guard",
            premise: { kind: "notExists", statement: sqlWith() },
            failure: { kind: "query", message: "changed", raceable: true },
          },
        },
      ],
    };
    expect(() => validateFragment(unstable)).toThrow(
      "must be an exists premise with raceable: false"
    );
  });

  test("a continuation rejects outside, forward, and undeclared references before execution", () => {
    const continuation = (reference: ReturnType<typeof ref>) => ({
      id: "owner.continuation",
      kind: "guard" as const,
      premise: {
        kind: "exists" as const,
        statement: sqlWith(reference),
      },
      failure: { kind: "query" as const, message: "changed", raceable: false },
    });
    const owner = {
      id: "owner",
      kind: "write" as const,
      statement: sqlWith(),
      outputs: { id: { kind: "firstRowField" as const, field: "id" } },
    };
    const later = {
      id: "later",
      kind: "read" as const,
      statement: sqlWith(),
      outputs: { id: { kind: "firstRowField" as const, field: "id" } },
    };

    expect(() =>
      validateFragment({
        steps: [
          {
            ...owner,
            progressiveContinuation: continuation(ref("outside", "id")),
          },
        ],
        outputs: {},
      })
    ).toThrow("points outside the fragment");
    expect(() =>
      validateFragment({
        steps: [
          {
            ...owner,
            progressiveContinuation: continuation(ref("later", "id")),
          },
          later,
        ],
        outputs: {},
      })
    ).toThrow("does not point backward");
    expect(() =>
      validateFragment({
        steps: [
          {
            ...owner,
            progressiveContinuation: continuation(ref("owner", "missing")),
          },
        ],
        outputs: {},
      })
    ).toThrow("points at an undeclared output");
  });

  test("accepts a well-formed fragment and ordered output list", () => {
    const fragment: OperationFragment = {
      steps: [
        {
          id: "writer",
          kind: "write",
          statement: sqlWith(),
          outputs: { id: { kind: "insertId" } },
        },
        {
          id: "reader",
          kind: "read",
          statement: sqlWith(ref("writer", "id")),
          outputs: { result: { kind: "rows" } },
        },
      ],
      outputs: { result: ref("reader", "result") },
    };
    expect(() => validateFragment(fragment)).not.toThrow();

    const listFragment: OperationFragment = {
      steps: [
        {
          id: "a",
          kind: "read",
          statement: sqlWith(),
          outputs: { rows: { kind: "rows" } },
        },
        {
          id: "b",
          kind: "read",
          statement: sqlWith(),
          outputs: { rows: { kind: "rows" } },
        },
      ],
      outputs: { result: [ref("a", "rows"), ref("b", "rows")] },
    };
    expect(() => validateFragment(listFragment)).not.toThrow();
  });
});
