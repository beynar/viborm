import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes, ledRefs, lineRefs } from "./decimal-world";

/**
 * Third review (repair 3). Finding J asked for the shipped decimal
 * field-reference domain refusal. The repair added it in `prepareOperand`.
 * These probes attack the repair rather than restate it: the PRECISION half of
 * the rule, the operators and shapes that reach the owner by other routes, the
 * check ORDER against the two refusals that precede it, the verbs and scopes it
 * has to reach, and — the failure mode a new refusal introduces — every place
 * it must NOT fire.
 */
const agrees = (
  label: string,
  seen: { shipped: unknown; candidate: unknown }
): void => {
  assert.deepEqual(
    seen.candidate,
    seen.shipped,
    `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
  );
};

const SCALE_REFUSAL =
  "Field reference 'micros' cannot be compared with 'cents' on 'led': 'cents' is decimal(12,2) and 'micros' is decimal(12,4). Two decimals compare exactly only when they declare the same precision and scale.";
const PRECISION_REFUSAL =
  "Field reference 'wideCents' cannot be compared with 'cents' on 'led': 'cents' is decimal(12,2) and 'wideCents' is decimal(10,2). Two decimals compare exactly only when they declare the same precision and scale.";

describe("G4-01 repair 3 review — the decimal domain refusal fires where it must", () => {
  it("refuses a PRECISION-only difference, with the shipped sentence", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.wideCents } },
      select: { id: true },
    });
    agrees("precision-only difference", seen);
    assert.deepEqual(seen.candidate, { error: PRECISION_REFUSAL });
  });

  it("refuses a SCALE-only difference, with the shipped sentence", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.micros } },
      select: { id: true },
    });
    agrees("scale-only difference", seen);
    assert.deepEqual(seen.candidate, { error: SCALE_REFUSAL });
  });

  it("refuses the SHORTHAND form (no operator object)", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: ledRefs.micros },
      select: { id: true },
    });
    agrees("shorthand reference", seen);
    assert.deepEqual(seen.candidate, { error: SCALE_REFUSAL });
  });

  it("refuses under `not`", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { not: ledRefs.micros } },
      select: { id: true },
    });
    agrees("not-wrapped reference", seen);
    assert.deepEqual(seen.candidate, { error: SCALE_REFUSAL });
  });

  it("refuses under every ordering operator", async () => {
    for (const operator of ["lt", "lte", "gt", "gte"]) {
      const seen = await bothOutcomes("led", "findMany", {
        where: { cents: { [operator]: ledRefs.wideCents } },
        select: { id: true },
      });
      agrees(`${operator} reference`, seen);
      assert.deepEqual(seen.candidate, { error: PRECISION_REFUSAL });
    }
  });

  it("refuses inside NOT, OR and a doubled combinator", async () => {
    const shapes: [string, Record<string, unknown>][] = [
      ["NOT", { NOT: [{ cents: { equals: ledRefs.micros } }] }],
      [
        "OR beside a satisfiable arm",
        { OR: [{ tag: "x" }, { cents: { equals: ledRefs.micros } }] },
      ],
      [
        "AND inside NOT inside OR",
        {
          OR: [
            { NOT: [{ AND: [{ cents: { gte: ledRefs.micros } }] }] },
            { tag: "zzz" },
          ],
        },
      ],
    ];
    for (const [label, where] of shapes) {
      const seen = await bothOutcomes("led", "findMany", {
        where,
        select: { id: true },
      });
      agrees(label, seen);
      assert.ok(
        (seen.candidate as { error?: string }).error?.includes(
          "Two decimals compare exactly"
        ),
        `${label} should refuse, saw ${JSON.stringify(seen.candidate)}`
      );
    }
  });

  it("refuses on every read verb, not just findMany", async () => {
    const where = { cents: { equals: ledRefs.micros } };
    for (const [verb, args] of [
      ["findFirst", { where, select: { id: true } }],
      ["count", { where }],
      ["aggregate", { where, _count: true }],
      ["groupBy", { where, by: ["tag"], _count: true }],
    ] as [string, Record<string, unknown>][]) {
      const seen = await bothOutcomes("led", verb, args);
      agrees(`${verb} reference`, seen);
      assert.ok(
        (seen.candidate as { error?: string }).error?.includes(
          "Two decimals compare exactly"
        ),
        `${verb} should refuse, saw ${JSON.stringify(seen.candidate)}`
      );
    }
  });

  it("refuses inside a nested relation scope, naming the RELATED model", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { lines: { some: { fee: { equals: lineRefs.feeMicros } } } },
      select: { id: true },
    });
    agrees("relation-scoped reference", seen);
    assert.deepEqual(seen.candidate, {
      error:
        "Field reference 'feeMicros' cannot be compared with 'fee' on 'line': 'fee' is decimal(8,2) and 'feeMicros' is decimal(8,3). Two decimals compare exactly only when they declare the same precision and scale.",
    });
  });

  it("refuses inside a nested READ (a relation select's own where)", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      select: {
        id: true,
        lines: {
          where: { fee: { equals: lineRefs.feeMicros } },
          select: { id: true },
        },
      },
    });
    agrees("nested-read reference", seen);
    assert.ok(
      (seen.candidate as { error?: string }).error?.includes(
        "Two decimals compare exactly"
      ),
      `nested read should refuse, saw ${JSON.stringify(seen.candidate)}`
    );
  });

  it("refuses in a write's where clause the same way", async () => {
    for (const [verb, args] of [
      ["deleteMany", { where: { cents: { equals: ledRefs.micros } } }],
      [
        "updateMany",
        { where: { cents: { equals: ledRefs.micros } }, data: { count: 9 } },
      ],
    ] as [string, Record<string, unknown>][]) {
      const seen = await bothOutcomes("led", verb, args);
      agrees(`${verb} reference`, seen);
    }
  });
});

describe("G4-01 repair 3 review — and does NOT fire where it must not", () => {
  it("still answers a same-domain reference", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.alsoCents } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    agrees("same domain", seen);
    assert.deepEqual(seen.candidate, { ok: [{ id: 1 }] });
  });

  it("still answers a same-domain reference to a NULLABLE column", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.maybeCents } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    agrees("same domain, nullable operand", seen);
    assert.deepEqual(seen.candidate, { ok: [{ id: 1 }] });
  });

  it("still answers a same-domain reference under NOT and inside a relation", async () => {
    const one = await bothOutcomes("led", "findMany", {
      where: { NOT: [{ cents: { equals: ledRefs.alsoCents } }] },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    agrees("NOT of a same-domain reference", one);
    assert.deepEqual(one.candidate, { ok: [{ id: 2 }] });
    const two = await bothOutcomes("led", "findMany", {
      where: { lines: { some: { fee: { equals: lineRefs.fee } } } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    agrees("relation-scoped same-domain reference", two);
    assert.deepEqual(two.candidate, { ok: [{ id: 1 }, { id: 2 }] });
  });

  it("still answers a reference between two NON-decimal columns", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { count: { equals: ledRefs.id } },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    agrees("int reference", seen);
    assert.deepEqual(seen.candidate, { ok: [{ id: 1 }, { id: 2 }] });
  });

  it("leaves a cross-model reference to the SCOPE refusal, not the domain one", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: lineRefs.feeMicros } },
      select: { id: true },
    });
    agrees("cross-model reference of a different domain", seen);
    assert.ok(
      (seen.candidate as { error?: string }).error?.includes(
        "may only compare columns of the same model"
      ),
      `scope refusal must win, saw ${JSON.stringify(seen.candidate)}`
    );
  });

  it("agrees on a reference an operator does not open to references", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { in: [ledRefs.micros] } },
      select: { id: true },
    });
    agrees("in-list reference", seen);
  });

  it("agrees on a reference whose scalar TYPE does not match the operand", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.count } },
      select: { id: true },
    });
    agrees("type-mismatched reference", seen);
  });
});
