import { createClient } from "@src/drivers/sqlite3";
import { s } from "@src/index";
import { permissions } from "@src/permissions";
import { v } from "@src/validation";
import { expectTypeOf } from "vitest";

const actor = v.object({ userId: v.string() });

function sameShapeClient() {
  const alpha = s.model({ id: s.string().id(), name: s.string() });
  const beta = s.model({ id: s.string().id(), name: s.string() });
  return permissions({
    actor,
    models: {
      alpha: { actions: { read: [], archive: [] }, read: {}, archive: {} },
      beta: { actions: { read: [], publish: [] }, read: {}, publish: {} },
    },
  })(createClient({ schema: { alpha, beta }, dataDir: ":memory:" }));
}

export async function rootEvidenceNames() {
  const db = sameShapeClient().$as({ userId: "reader" });
  const alpha = await db.alpha.findMany({ include: { $access: true } });
  expectTypeOf(alpha[0]!.$access).toEqualTypeOf<{
    readonly read: boolean;
    readonly archive: boolean;
  }>();
  const beta = await db.beta.findMany({
    select: { id: true, $access: ["publish"] },
  });
  expectTypeOf(beta[0]!.$access).toEqualTypeOf<{ readonly publish: boolean }>();
  // @ts-expect-error - publish belongs to beta, even though both models have identical types
  db.alpha.findMany({ include: { $access: ["read", "publish"] } });
  // @ts-expect-error - archive belongs to alpha
  db.beta.findMany({ select: { id: true, $access: ["read", "archive"] } });
}

function linkedClient() {
  const alpha = s.model({ id: s.string().id(), name: s.string() });
  const beta = s.model({ id: s.string().id(), name: s.int() });
  const parent = s.model({
    id: s.string().id(),
    alphaId: s.string(),
    betaId: s.string(),
    alpha: s
      .toOne(() => alpha)
      .fields("alphaId")
      .references("id"),
    beta: s
      .toOne(() => beta)
      .fields("betaId")
      .references("id"),
  });
  return permissions({
    actor,
    models: {
      parent: { read: {} },
      alpha: { actions: { read: [], archive: [] }, read: {}, archive: {} },
      beta: { actions: { read: [], publish: [] }, read: {}, publish: {} },
    },
  })(createClient({ schema: { parent, alpha, beta }, dataDir: ":memory:" }));
}

export async function linkedEvidenceNames() {
  const db = linkedClient().$as({ userId: "reader" });
  const rows = await db.parent.findMany({
    include: {
      $access: true,
      alpha: { include: { $access: true } },
      beta: { select: { id: true, $access: ["publish"] } },
    },
  });
  expectTypeOf(rows[0]!.alpha!.$access).toEqualTypeOf<{
    readonly read: boolean;
    readonly archive: boolean;
  }>();
  expectTypeOf(rows[0]!.beta!.$access).toEqualTypeOf<{
    readonly publish: boolean;
  }>();
  db.parent.findMany({
    // @ts-expect-error - nested alpha keeps its own action names despite sharing beta's field-name surface
    include: { alpha: { select: { id: true, $access: ["read", "publish"] } } },
  });
  // One line, so the overload error has one place to land whatever program
  // checks this file: nested beta cannot project alpha's action.
  const betaWithAlphaAction = {
    beta: { include: { $access: ["read", "archive"] } },
  } as const;
  // @ts-expect-error - nested beta cannot project alpha's action
  db.parent.findMany({ include: betaWithAlphaAction });
}
