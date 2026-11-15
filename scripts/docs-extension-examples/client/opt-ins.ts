// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { permissions } from "viborm/permissions";
import { v } from "viborm/validation";
import { client as db } from "./opt-ins-schema";

const statements: { text: string; values: unknown[] }[] = [];
