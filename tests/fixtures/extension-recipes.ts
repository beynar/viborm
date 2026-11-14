/**
 * The guide's extension recipes (extension-capabilities plan v4 §1, owner
 * decision §7.2: recipes, not package entries), written from public exports
 * only: `viborm` and `viborm/validation`. They compile here exactly as a
 * reader copies them from the guide: tenancy §1.1, audit §1.2 and the
 * optimistic lock §1.3, verbatim.
 *
 * Each recipe keeps the model names it is given (a `const` type parameter,
 * so the reader writes no `as const`), and `perModel` keys its map by them:
 * the client types then know which models a recipe writes, so a field it
 * writes may be left out of a create even where the schema requires it
 * (owner ruling, plan v4 §7.5), and a value the caller writes is the
 * caller's (owner ruling 2026-10-02, plan v4 §7.1). `perModel` holds the one
 * cast, the same key-map cast as the soft-delete entry's `perModel`.
 */

import {
  accepts,
  arg,
  args,
  defaults,
  extension,
  oneOf,
  rule,
  when,
  writes,
} from "@src/index";
import { v } from "@src/validation";

/**
 * The same entry for each model named. `Object.fromEntries` forgets the
 * names, so the cast gives them back: the types then know which models a
 * recipe writes.
 */
export const perModel = <Models extends readonly string[], T>(
  models: Models,
  build: () => T
) =>
  Object.fromEntries(models.map((model) => [model, build()])) as Readonly<
    Record<string, T>
  >;

export const tenancy = <const Models extends readonly string[]>(
  models: Models
) =>
  extension(
    "tenancy",
    args({
      tenant: accepts(v.string()).required(models),
      scope: oneOf("tenant", "all").default("tenant"),
    }),
    rule(
      perModel(models, () => ({
        root: when(arg("scope"), "tenant", { tenantId: arg("tenant") }),
        related: when(arg("scope"), "tenant", { tenantId: arg("tenant") }),
      }))
    ),
    defaults(perModel(models, () => ({ create: { tenantId: arg("tenant") } })))
  );

export const audit = <const Models extends readonly string[]>(models: Models) =>
  extension(
    "audit",
    args({ actor: accepts(v.string()).on(writes).required(models) }),
    defaults(
      perModel(models, () => ({
        create: { createdBy: arg("actor") },
        update: { updatedBy: arg("actor") },
      }))
    )
  );

export const optimisticLock = <const Models extends readonly string[]>(
  models: Models
) =>
  extension(
    "optimisticLock",
    args({
      expectedVersion: accepts(v.number()).on(["update", "delete"]),
      versionCheck: oneOf("checked", "unchecked").default("checked"),
    }),
    rule(
      perModel(models, () => ({
        root: when(arg("versionCheck"), "checked", {
          version: arg("expectedVersion"),
        }),
      }))
    ),
    defaults(
      perModel(models, () => ({ update: { version: { increment: 1 } } }))
    )
  );
