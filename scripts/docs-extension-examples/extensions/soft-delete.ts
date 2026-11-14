// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { defaultOmit } from "viborm/client";
import { permissions } from "viborm/permissions";
import { s } from "viborm/schema";
import { base, db, user } from "./soft-delete-schema";
import { softDelete } from "viborm/soft-delete";

const models = { post: { deletedAt: "deletedAt" } } as const;
declare const session: { userId: string };
type Session = typeof session;
declare const t: Date;
declare const since: Date;
declare const cutoff: Date;
declare const policy: Parameters<typeof permissions>[0];
