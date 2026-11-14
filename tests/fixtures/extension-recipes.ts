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

// Each argument is read through a word written apart from the rule: the
// recipe applies to any client, so its names are checked where it is applied.
const tenant = arg("tenant");
const scope = arg("scope");
const actor = arg("actor");
const expectedVersion = arg("expectedVersion");
const versionCheck = arg("versionCheck");

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
        root: when(scope, "tenant", { tenantId: tenant }),
        related: when(scope, "tenant", { tenantId: tenant }),
      }))
    ),
    defaults(perModel(models, () => ({ create: { tenantId: tenant } })))
  );

export const audit = <const Models extends readonly string[]>(models: Models) =>
  extension(
    "audit",
    args({ actor: accepts(v.string()).on(writes).required(models) }),
    defaults(
      perModel(models, () => ({
        create: { createdBy: actor },
        update: { updatedBy: actor },
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
        root: when(versionCheck, "checked", {
          version: expectedVersion,
        }),
      }))
    ),
    defaults(
      perModel(models, () => ({ update: { version: { increment: 1 } } }))
    )
  );
