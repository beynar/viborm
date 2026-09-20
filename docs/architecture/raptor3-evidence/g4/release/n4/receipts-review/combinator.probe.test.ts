/**
 * REVIEW PROBE (lens B): is storage.ts:248 (#48) reachable by an admitted payload?
 *
 * `getWhereSchema` (src/validation/model/core/where.ts:65-74) and
 * `getHavingSchema` (src/validation/model/args/aggregate.ts:678-689) build the
 * AND/OR/NOT combinator entries first and `.extend(...)` the model's SCALAR
 * entries over them, so a scalar literally named `AND` wins the key and
 * validation admits `where: { AND: <that scalar's filter> }`. The engine
 * (`prepareWhere`, query.ts:1334) tests the combinator names FIRST, re-reads
 * the admitted scalar filter as a nested `where`, and asks
 * `physicalField(model, "gt")`.
 */
import type { Operations } from "@client/types";
import { EngineInvariantError } from "@query-engine/raptor3/shared/invariant";
import { s } from "@schema";
import {
  createWitnessWorld,
  type WitnessWorld,
} from "@tests/raptor3/g4/witness-world";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const world = () => {
  const row: any = s
    .model({
      id: s.int().id(),
      AND: s.int(),
      title: s.string(),
    })
    .map("n4rc_rows");
  return { row };
};

describe("N4 review — a scalar named AND reaches #48", () => {
  let live: WitnessWorld;
  beforeAll(async () => {
    live = await createWitnessWorld(world() as never, { foreignKeys: false });
  });
  afterAll(async () => {
    await live?.close();
  });

  const call = async (operation: string, args: unknown) => {
    try {
      const value = await live.candidate.execute(
        "row",
        operation as Operations,
        args
      );
      return { ok: true as const, value };
    } catch (failure) {
      return { ok: false as const, failure };
    }
  };

  it("the schema declares a scalar named AND", async () => {
    const created = await call("create", {
      data: { id: 1, AND: 5, title: "x" },
    });
    // eslint-disable-next-line no-console
    console.log("CREATE:", JSON.stringify(created.ok ? created.value : String(created.failure)));
    expect(created.ok).toBe(true);
  });

  it("findMany({ where: { AND: { gt: 1 } } }) is admitted and reaches the assertion", async () => {
    const answer = await call("findMany", { where: { AND: { gt: 1 } } });
    const failure = answer.ok ? undefined : answer.failure;
    // eslint-disable-next-line no-console
    console.log(
      "WHERE-AND:",
      answer.ok
        ? `OK ${JSON.stringify(answer.value)}`
        : `${(failure as Error).name}: ${(failure as Error).message}`
    );
    expect(failure).toBeInstanceOf(EngineInvariantError);
  });

  it("the shipped client answers the same payload", async () => {
    let shipped: unknown;
    try {
      shipped = await live.shipped.row!.findMany!({ where: { AND: { gt: 1 } } });
    } catch (failure) {
      shipped = `${(failure as Error).name}: ${(failure as Error).message}`;
    }
    // eslint-disable-next-line no-console
    console.log("SHIPPED:", JSON.stringify(shipped));
    expect(true).toBe(true);
  });
});
