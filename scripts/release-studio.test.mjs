import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditStudioPack,
  STUDIO_FILES,
  studioRegistryState,
  validateStudioPackage,
} from "./release-studio.mjs";

const WRONG_NAME = /must be named @viborm\/studio/;
const WRONG_VERSION = /is at 1\.5\.1; the release is 1\.6\.0/;
const WRONG_PEER = /must require viborm ~1\.6\.0/;
const NO_BIN = /viborm-studio executable/;
const NOT_STABLE = /stable SemVer/;
const WRONG_FILES = /packs/;
const OTHER_BYTES = /already on npm with other bytes/;

const studio = {
  name: "@viborm/studio",
  version: "1.6.0",
  peerDependencies: { viborm: "~1.6.0" },
  bin: { "viborm-studio": "dist/cli.mjs" },
};

test("the studio ships at the release's version and requires that viborm", () => {
  assert.deepEqual(validateStudioPackage(studio, "1.6.0"), {
    channel: "latest",
    version: "1.6.0",
  });
  assert.deepEqual(
    validateStudioPackage(
      {
        ...studio,
        version: "1.7.0-rc.1",
        peerDependencies: { viborm: "~1.7.0-rc.1" },
      },
      "1.7.0-rc.1"
    ).channel,
    "next"
  );
  for (const [broken, message] of [
    [{ ...studio, name: "viborm-studio" }, WRONG_NAME],
    [{ ...studio, version: "1.5.1" }, WRONG_VERSION],
    [{ ...studio, peerDependencies: { viborm: "^1.5.0" } }, WRONG_PEER],
    [{ ...studio, bin: {} }, NO_BIN],
  ]) {
    assert.throws(() => validateStudioPackage(broken, "1.6.0"), message);
  }
  assert.throws(() => validateStudioPackage(studio, "1.6"), NOT_STABLE);
});

test("the studio packs exactly its CLI, its app, its manifest and its notices", () => {
  const files = STUDIO_FILES.map((path) => ({ path }));
  assert.deepEqual(auditStudioPack({ files }), [...STUDIO_FILES]);
  assert.throws(
    () => auditStudioPack({ files: [...files, { path: "src/run.ts" }] }),
    WRONG_FILES
  );
  assert.throws(() => auditStudioPack({ files: files.slice(1) }), WRONG_FILES);
});

test("the registry is published to once, with the tested bytes", () => {
  const manifest = { version: "1.6.0", integrity: "sha512-a" };
  assert.deepEqual(studioRegistryState(manifest, undefined), { publish: true });
  assert.deepEqual(studioRegistryState(manifest, "sha512-a"), {
    publish: false,
  });
  assert.throws(() => studioRegistryState(manifest, "sha512-b"), OTHER_BYTES);
});
