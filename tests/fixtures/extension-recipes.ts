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
 * writes may be left out of a create even where the schema requires it, and
 * may not be passed (owner ruling, plan v4 §7.5). `perModel` holds the one
 * cast, the same key-map cast as the soft-delete entry's `perModel`.
 */

import { defineExtension } from "@src/index";
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
  Object.fromEntries(models.map((model) => [model, build()])) as {
    readonly [Model in Models[number]]: T;
  };

export const tenancy = <const Models extends readonly string[]>(
  models: Models
) =>
  defineExtension({
    name: "tenancy",
    controls: { tenant: { schema: v.string(), required: true } },
    rows: {
      control: "scope", // still one mode control per rows member
      default: "tenant",
      models: perModel(models, () => ({
        tenant: {
          root: { tenantId: { control: "tenant" } },
          related: { tenantId: { control: "tenant" } },
        },
        all: {}, // an operator's view: the control is admitted, the filter is off
      })),
    },
    data: {
      models: perModel(models, () => ({
        create: { tenantId: { control: "tenant" } },
      })),
    },
  });

export const audit = <const Models extends readonly string[]>(models: Models) =>
  defineExtension({
    name: "audit",
    controls: { actor: { schema: v.string(), required: true, on: "writes" } },
    data: {
      models: perModel(models, () => ({
        create: { createdBy: { control: "actor" } },
        update: { updatedBy: { control: "actor" } },
      })),
    },
  });

export const optimisticLock = <const Models extends readonly string[]>(
  models: Models
) =>
  defineExtension({
    name: "optimisticLock",
    controls: {
      expectedVersion: { schema: v.number(), on: ["update", "delete"] },
    },
    rows: {
      control: "versionCheck",
      default: "checked",
      models: perModel(models, () => ({
        checked: { root: { version: { control: "expectedVersion" } } },
        unchecked: {},
      })),
    },
    data: {
      models: perModel(models, () => ({
        update: { version: { increment: 1 } },
      })),
    },
  });
