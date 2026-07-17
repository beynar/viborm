import { Sql } from "@sql";
import { describe, expect, test } from "vitest";
import {
  validateFragment,
  validateProbe,
} from "../../src/query-engine-v2/FragmentValidator";
import {
  type OperationFragment,
  type OperationValueReference,
  type Probe,
  ref,
  type StatementStep,
} from "../../src/query-engine-v2/OperationFragment";

function sqlWith(...refs: OperationValueReference[]): Sql {
  return new Sql(
    Array.from({ length: refs.length + 1 }, () => ""),
    refs
  );
}

const readProbe: StatementStep = {
  id: "probe.read",
  kind: "read",
  statement: sqlWith(),
  outputs: { rows: { kind: "rows" } },
};

describe("query-engine-v2 fragment validator (ATOM §9)", () => {
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

  test("probe: rejects a missing-pin notExists guard that is not raceable", () => {
    const probe: Probe = {
      read: readProbe,
      pin: {
        whenFound: "none",
        whenMissing: {
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
      },
    };
    expect(() => validateProbe(probe)).toThrow(
      "production-FATAL create-branch pin"
    );
  });

  test("probe: rejects a raceable found-pin exists guard", () => {
    const probe: Probe = {
      read: readProbe,
      pin: {
        whenFound: {
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
        whenMissing: "constraint",
      },
    };
    expect(() => validateProbe(probe)).toThrow("raceable: false");
  });

  test("probe: rejects a found-pin that is not an exists guard", () => {
    const probe: Probe = {
      read: readProbe,
      pin: {
        whenFound: {
          id: "guard",
          kind: "guard",
          premise: { kind: "notExists", statement: sqlWith() },
          failure: {
            kind: "nestedWrite",
            message: "m",
            relation: "r",
            raceable: true,
          },
        },
        whenMissing: "constraint",
      },
    };
    expect(() => validateProbe(probe)).toThrow("exists guard");
  });

  test("probe: rejects a non-read probe head", () => {
    const probe: Probe = {
      read: {
        id: "write.step",
        kind: "write",
        statement: sqlWith(),
        outputs: {},
      },
      pin: { whenFound: "none", whenMissing: "constraint" },
    };
    expect(() => validateProbe(probe)).toThrow("must be a read step");
  });

  test("accepts a well-formed fragment, probe, and ordered output list", () => {
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

    const probe: Probe = {
      read: readProbe,
      pin: {
        whenFound: {
          id: "guard",
          kind: "guard",
          premise: { kind: "exists", statement: sqlWith() },
          failure: {
            kind: "nestedWrite",
            message: "m",
            relation: "r",
            raceable: false,
          },
        },
        whenMissing: "constraint",
      },
    };
    expect(() => validateProbe(probe)).not.toThrow();

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
