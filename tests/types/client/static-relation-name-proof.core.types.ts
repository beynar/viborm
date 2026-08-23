/**
 * Static pairing names fail closed on the public client surface. Only an
 * omitted name or one literal label proves a partner; a widened string or a
 * multi-literal union keeps the nested foreign-key input and withholds the
 * disconnect capability. Runtime pairing still compares the values normally.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";

const broadPairName: string = "BroadPair";
declare const unionPairName: "UnionPairA" | "UnionPairB";

const broadParent = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  child: s.toOne(() => broadChild).name(broadPairName),
});
const broadChild = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  parentId: s.string().nullable(),
  value: s.string(),
  parent: s
    .toOne(() => broadParent)
    .name(broadPairName)
    .fields("tenantId", "parentId")
    .references("tenantId", "id"),
});

const unionParent = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  child: s.toOne(() => unionChild).name(unionPairName),
});
const unionChild = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  parentId: s.string().nullable(),
  value: s.string(),
  parent: s
    .toOne(() => unionParent)
    .name(unionPairName)
    .fields("tenantId", "parentId")
    .references("tenantId", "id"),
});

const literalParent = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  child: s.toOne(() => literalChild).name("LiteralPair"),
});
const literalChild = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  parentId: s.string().nullable(),
  value: s.string(),
  parent: s
    .toOne(() => literalParent)
    .name("LiteralPair")
    .fields("tenantId", "parentId")
    .references("tenantId", "id"),
});

const unnamedParent = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  child: s.toOne(() => unnamedChild),
});
const unnamedChild = s.model({
  id: s.string().id(),
  tenantId: s.string(),
  parentId: s.string().nullable(),
  value: s.string(),
  parent: s
    .toOne(() => unnamedParent)
    .fields("tenantId", "parentId")
    .references("tenantId", "id"),
});

const client = createClient({
  schema: {
    broadParent,
    broadChild,
    unionParent,
    unionChild,
    literalParent,
    literalChild,
    unnamedParent,
    unnamedChild,
  },
  driver: new PGliteDriver(),
});

const _broadNameRetainsTheNestedForeignKey = () =>
  client.broadParent.create({
    data: {
      id: "b1",
      tenantId: "tenant-1",
      child: {
        // @ts-expect-error - a broad name cannot prove that tenantId is parent-derived
        create: { id: "bc1", value: "broad" },
      },
    },
  });

const _unionNameRetainsTheNestedForeignKey = () =>
  client.unionParent.create({
    data: {
      id: "u1",
      tenantId: "tenant-1",
      child: {
        // @ts-expect-error - a name union cannot prove that tenantId is parent-derived
        create: { id: "uc1", value: "union" },
      },
    },
  });

const _broadNameWithholdsDisconnect = () =>
  client.broadParent.update({
    where: { id: "b1" },
    data: {
      child: {
        connect: { id: "bc1" },
        // @ts-expect-error - a broad name cannot prove clearable membership
        disconnect: false,
      },
    },
  });

const _unionNameWithholdsDisconnect = () =>
  client.unionParent.update({
    where: { id: "u1" },
    data: {
      child: {
        connect: { id: "uc1" },
        // @ts-expect-error - a name union cannot prove clearable membership
        disconnect: false,
      },
    },
  });

/** Literal and unnamed pairs recover the parent-derived omission. */
const _literalNameRecoversOmission = () =>
  client.literalParent.create({
    data: {
      id: "l1",
      tenantId: "tenant-1",
      child: { create: { id: "lc1", value: "literal" } },
    },
  });

const _unnamedPairRecoversOmission = () =>
  client.unnamedParent.create({
    data: {
      id: "n1",
      tenantId: "tenant-1",
      child: { create: { id: "nc1", value: "unnamed" } },
    },
  });

/** Their nullable compound memberships also retain the proven capability. */
const _provableNamesRecoverDisconnect = () => {
  client.literalParent.update({
    where: { id: "l1" },
    data: { child: { disconnect: true } },
  });
  client.unnamedParent.update({
    where: { id: "n1" },
    data: { child: { disconnect: true } },
  });
};
