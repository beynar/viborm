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

function variantClient() {
  const alpha = s.model({ id: s.string().id(), secret: s.string() });
  const beta = s.model({ id: s.string().id(), seconds: s.int() });
  const holder = s.model({
    id: s.string().id(),
    subject: s.toOne({ alpha: () => alpha, beta: () => beta }),
    items: s.toMany({ alpha: () => alpha, beta: () => beta }),
  });
  return createClient({
    schema: { holder, alpha, beta },
    dataDir: ":memory:",
  }).$extends(
    permissions({
      actor,
      models: {
        holder: { read: true },
        alpha: {
          actions: { read: [], archive: [] },
          read: true,
          archive: true,
          fields: { secret: { read: "archive" } },
        },
        beta: { actions: { read: [], publish: [] }, read: true, publish: true },
      },
    })
  );
}

export async function variantEvidenceNames() {
  const db = variantClient().$as({ userId: "reader" });
  const rows = await db.holder.findMany({
    include: {
      subject: {
        alpha: { select: { $access: ["archive"] } },
        beta: { include: { $access: true } },
      },
      items: {
        variants: {
          alpha: { select: { id: true, $access: ["read", "archive"] } },
          beta: { include: { $access: ["publish"] } },
        },
      },
    },
  });
  const subject = rows[0]!.subject;
  if (subject?.type === "alpha")
    expectTypeOf(subject.data).toEqualTypeOf<{
      readonly $access: { readonly archive: boolean };
    }>();
  if (subject?.type === "beta")
    expectTypeOf(subject.data.$access).toEqualTypeOf<{
      readonly read: boolean;
      readonly publish: boolean;
    }>();
  const item = rows[0]!.items[0]!;
  if (item.type === "alpha")
    expectTypeOf(item.data.$access).toEqualTypeOf<{
      readonly read: boolean;
      readonly archive: boolean;
    }>();
  if (item.type === "beta")
    expectTypeOf(item.data.$access).toEqualTypeOf<{
      readonly publish: boolean;
    }>();
  db.holder.findMany({
    // @ts-expect-error - a singular variant keeps its target's permission names
    include: { subject: { alpha: { select: { $access: ["publish"] } } } },
  });
  db.holder.findMany({
    include: {
      // @ts-expect-error - a collection variant keeps its target's permission names
      items: { variants: { beta: { include: { $access: ["archive"] } } } },
    },
  });
}

// Structurally identical targets have ambiguous schema links. A fixed relation
// must admit only their common permission names, never a union of grants.
function ambiguousLinkedClient() {
  const alpha = s.model({ id: s.string().id(), name: s.string() });
  const beta = s.model({ id: s.string().id(), name: s.string() });
  const parent = s.model({
    id: s.string().id(),
    alphaId: s.string(),
    alpha: s
      .toOne(() => alpha)
      .fields("alphaId")
      .references("id"),
  });
  return createClient({
    schema: { parent, alpha, beta },
    dataDir: ":memory:",
  }).$extends(
    permissions({
      actor,
      models: {
        parent: { read: true },
        alpha: {
          actions: { read: [], archive: [] },
          read: true,
          archive: true,
        },
        beta: { actions: { read: [], publish: [] }, read: true, publish: true },
      },
    })
  );
}

export async function ambiguousLinkedEvidenceNames() {
  const db = ambiguousLinkedClient().$as({ userId: "reader" });
  const rows = await db.parent.findMany({
    include: { alpha: { select: { $access: ["read"] } } },
  });
  expectTypeOf(rows[0]!.alpha!.$access).toEqualTypeOf<{
    readonly read: boolean;
  }>();
  db.parent.findMany({
    // @ts-expect-error - ambiguous same-shaped targets admit only shared names
    include: { alpha: { select: { $access: ["publish"] } } },
  });
  db.parent.findMany({
    // @ts-expect-error - neither target-specific action is statically safe
    include: { alpha: { select: { $access: ["archive"] } } },
  });
}
