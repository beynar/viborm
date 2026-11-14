// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
// The recipes themselves are the fixture the behaviour tests run, which the
// page carries verbatim (tests/package/extension-recipes-consumer-smoke.mjs).
import {
  audit,
  optimisticLock,
  perModel,
  tenancy,
} from "@tests/fixtures/extension-recipes";
import { base } from "./recipes-schema";
import {
  accepts,
  arg,
  args,
  defaults,
  extension,
  oneOf,
  rule,
  when,
  writes,
} from "viborm";
import { s } from "viborm/schema";
import { v } from "viborm/validation";

const tenant = arg("tenant");
const scope = arg("scope");
const actor = arg("actor");
const expectedVersion = arg("expectedVersion");
const versionCheck = arg("versionCheck");

declare const title: string;
declare const id: string;
declare const data: { title: string };
declare const session: { userId: string };
