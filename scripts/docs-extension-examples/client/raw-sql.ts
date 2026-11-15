// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.

import { sql } from "viborm";
import { permissions } from "viborm/permissions";
import { v } from "viborm/validation";
import { client } from "./general-schema";

const db = client.$extends(
  permissions({
    actor: v.object({ userId: v.string() }),
    models: { page: { read: { ownerId: { actor: "userId" } } } },
  })
);
declare const req: { query: { name: string } };
declare const cutoff: Date;
declare const minimumAge: number;
declare const onlyActive: boolean;
declare const column: string;
declare const tenantId: string;
declare const query: string;
declare const actor: { userId: string };
