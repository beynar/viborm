// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
import { client } from "docs-examples/shared";
import { call, extension } from "viborm";
import type { AnyDriver } from "viborm/driver";

const base = client;
declare const replica: AnyDriver;
declare const tenant: string;
const policy = extension(
  "policy",
  call(() => undefined)
);
declare function beforeRead(facts: object): void;
declare function enqueueRefresh(facts: object): void;
declare function keepRows(rows: readonly object[]): void;
declare function publish(certainty: string): void;
declare function isRetryableError(error: unknown): boolean;
declare function record(...facts: unknown[]): void;
