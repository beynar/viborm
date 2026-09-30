/**
 * The guide's extension recipes (extension-capabilities plan v4 §1, owner
 * decision §7.2: recipes, not package entries), written from public exports
 * only: `viborm` and `viborm/validation`. They compile here exactly as a
 * reader copies them from the guide.
 *
 * Tenancy is §1.1 without its `data` member: the extension writing `tenantId`
 * on create is plan unit 2, so until then a create passes `tenantId` itself.
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
  });
