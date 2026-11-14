// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { ordering, orderingKey } from "viborm/ordering";
import { s } from "viborm/schema";
import { base, column, db } from "./ordering-schema";

declare const id: string;
declare const otherId: string;
declare const doneId: string;
declare const columnId: string;
declare const neighbourId: string;
declare const above: { rank: string } | undefined;
declare const below: { rank: string } | undefined;
