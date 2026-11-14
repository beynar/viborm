// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
// biome-ignore-all lint/suspicious/noRedeclare: a section replaces the common preamble's names for its blocks.
// biome-ignore-all lint/correctness/noInvalidUseBeforeDeclaration: a section is read after the common preamble it replaces.
import { permissions } from "viborm/permissions";
import { s } from "viborm/schema";
import { v } from "viborm/validation";
import {
  accessGrant,
  base,
  document,
  member,
  organization,
  post,
  project,
  schema,
  team,
  teamMember,
  user,
} from "./permissions-schema";

declare const id: string;
declare const title: string;
declare const databaseUrl: string;
declare const session: { userId: string; admin: boolean };
declare function authenticate(request: Request): Promise<typeof session>;
declare const key: { userId: string; user: { admin: boolean } };
declare const pool: import("pg").Pool;
declare const liveMembership: { readonly userId: { readonly actor: "userId" } };

const policy = permissions({
  actor: v.object({ userId: v.string() }),
  models: { document: { read: { ownerId: { actor: "userId" } } } },
});

const db = base.$extends(
  permissions({
    actor: v.object({ userId: v.string(), admin: v.boolean() }),
    models: {
      post: {
        read: { published: true },
        update: { authorId: { actor: "userId" } },
        delete: { actor: { admin: true } },
        create: { authorId: { actor: "userId" } },
      },
      user: { read: true },
      project: {
        actions: { read: [], update: ["read"], full: ["update"] },
        operations: { delete: "full" },
        read: true,
        update: { ownerId: { actor: "userId" } },
        full: { actor: { admin: true } },
      },
      document: { read: true },
    },
  })
);
const call = db.$as({ userId: "u1", admin: false });

// @section service
const db = base.$extends(
  permissions({
    actor: v.object({
      kind: v.enum(["user", "service"]),
      principalId: v.string(),
      organizationId: v.string(),
    }),
    models: { post: { read: { published: true } } },
  })
);
declare function authenticateApiKey(request: Request): Promise<{
  scopes: readonly string[];
  serviceId: string;
  organizationId: string;
}>;
