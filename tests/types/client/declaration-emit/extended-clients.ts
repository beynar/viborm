/**
 * Exported clients extended by each official factory, and by all four
 * composed. `scripts/run-typecheck.mjs` emits this file's declaration after
 * the whole-estate program and holds each export to a budget: an inferred
 * extended client must stay a `VibORMClient<…>` reference, not its delegates
 * spelled out (one ordered model emitted 1.2 MB; soft delete failed TS7056 and
 * permissions TS4023).
 */
import { SQLite3Driver } from "@drivers/sqlite3";
import { createClient, s } from "@src/index";
import { on } from "@src/on";
import { ordering } from "@src/ordering";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";

const item = s.model({
  id: s.string().id(),
  rank: s.string(),
  tenant: s.string(),
  title: s.string(),
  deletedAt: s.dateTime().nullable(),
});
const policy = permissions({
  actor: v.object({ tenant: v.string() }),
  models: {
    item: {
      read: { tenant: { actor: "tenant" } },
      create: true,
      update: true,
      delete: true,
    },
  },
});
const tombstones = softDelete({
  models: { item: { deletedAt: "deletedAt" } },
});
const ranks = ordering({ models: { item: { key: "rank" } } });
const hooks = on({ item: { update: () => undefined } });

export const base = createClient({
  schema: { item },
  driver: new SQLite3Driver(),
});
export const ordered = base.$extends(ranks);
export const softDeleted = base.$extends(tombstones);
export const governed = base.$extends(policy);
export const governedAs = governed.$as({ tenant: "a" });
export const hooked = base.$extends(hooks);
export const composed = base
  .$extends(policy)
  .$extends(tombstones)
  .$extends(ranks)
  .$extends(hooks);
export const composedAs = composed.$as({ tenant: "a" });
