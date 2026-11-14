/**
 * One module defines the extensions and the client; another names the client
 * type from them (`cross-module.core.types.ts`). The extensions are written
 * apart from `$extends`, as an application or a library exports them.
 */

import {
  arg,
  args,
  defaults,
  extension,
  methods,
  omitted,
  parts,
  rule,
} from "@src/index";
import { v } from "@validation/primitives/v";
import { base, type schema } from "./extension-vocabulary.fixture";

const forSchema = parts<typeof schema>();

export const tenancy = forSchema.extension(
  "tenancy",
  args({ tenant: v.string() }),
  rule({ user: { read: { where: { tenantId: arg("tenant") } } } }),
  defaults({ post: { create: { tenantId: arg("tenant") } } })
);

export const ping = extension(
  "ping",
  methods(() => ({ $ping: () => "pong" as const }))
);

export const hidden = forSchema.extension(
  "hidden",
  defaults({ user: { fields: { passwordHash: omitted } } })
);

export const applicationExtensions = [tenancy, ping, hidden] as const;

export const application = base
  .$extends(tenancy)
  .$extends(ping)
  .$extends(hidden);
