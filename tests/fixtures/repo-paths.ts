import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../.."
);

export const SOURCE_ROOT = resolve(REPOSITORY_ROOT, "src");
