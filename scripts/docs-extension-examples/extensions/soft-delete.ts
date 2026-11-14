// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { defaultOmit } from "viborm/client";
import { permissions } from "viborm/permissions";
import { s } from "viborm/schema";
import { softDelete } from "viborm/soft-delete";
import { v } from "viborm/validation";
import { base, db, user } from "./soft-delete-schema";

const models = { post: { deletedAt: "deletedAt" } } as const;
declare const session: { userId: string };
type Session = typeof session;
declare const t: Date;
declare const since: Date;
declare const cutoff: Date;
const policy = {
  actor: v.object({ userId: v.string() }),
  models: { post: { read: true } },
} as const;
