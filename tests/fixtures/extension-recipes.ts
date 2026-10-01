/**
 * The guide's extension recipes (extension-capabilities plan v4 §1, owner
 * decision §7.2: recipes, not package entries), written from public exports
 * only: `viborm` and `viborm/validation`. They compile here exactly as a
 * reader copies them from the guide: tenancy §1.1, audit §1.2 and the
 * optimistic lock §1.3, verbatim.
 *
 * A field an extension writes on create is declared nullable (or with a
 * default) in the schemas that use them: the call's data is checked before
 * the extension writes it (decision U2-1).
 */

import { defineExtension } from "@src/index";
import { v } from "@src/validation";

/** The same entry for each model named. */
export const perModel = <T>(models: readonly string[], build: () => T) =>
  Object.fromEntries(models.map((model) => [model, build()]));

export const tenancy = (models: readonly string[]) =>
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

export const audit = (models: readonly string[]) =>
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

export const optimisticLock = (models: readonly string[]) =>
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
