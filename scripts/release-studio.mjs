// @viborm/studio's half of a release: one tarball built from the release
// commit, smoke-tested against the exact `viborm` tarball the same run built,
// published after `viborm` through npm trusted publishing, then verified on
// the registry. The studio ships at the release's version: it bundles VibORM's
// schema internals, so its version follows `viborm`'s.
//
//   node scripts/release-studio.mjs artifact --version X --viborm-manifest release/viborm-release.json
//   node scripts/release-studio.mjs registry-state --manifest release-studio/studio-release.json --github-output FILE
//   node scripts/release-studio.mjs verify-registry --manifest release-studio/studio-release.json

import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashArtifactBytes,
  parseReleaseVersion,
  ReleaseContractError,
  verifyArtifactIntegrity,
} from "./release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const PACKAGE_DIRECTORY = join(REPOSITORY_ROOT, "packages/studio");
const OUTPUT_DIRECTORY = join(REPOSITORY_ROOT, "release-studio");
export const STUDIO_PACKAGE = "@viborm/studio";
/** Every file the studio's tarball may hold, and must. */
export const STUDIO_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "dist/cli.mjs",
  "dist/studio.html",
  "package.json",
]);

function refuse(message, options) {
  throw new ReleaseContractError(message, options);
}

/**
 * The studio's manifest agrees with the release: its name, its version, and a
 * `viborm` peer range that admits the release's own version (`~X.Y.Z`).
 */
export function validateStudioPackage(packageJson, version) {
  const release = parseReleaseVersion(version);
  if (packageJson?.name !== STUDIO_PACKAGE) {
    refuse(`packages/studio/package.json must be named ${STUDIO_PACKAGE}`);
  }
  if (packageJson.version !== release.version) {
    refuse(
      `${STUDIO_PACKAGE} is at ${packageJson.version}; the release is ${release.version}`
    );
  }
  const peer = packageJson.peerDependencies?.viborm;
  if (peer !== `~${release.version}`) {
    refuse(
      `${STUDIO_PACKAGE} must require viborm ~${release.version}, not ${JSON.stringify(peer)}`
    );
  }
  if (packageJson.bin?.["viborm-studio"] !== "dist/cli.mjs") {
    refuse(`${STUDIO_PACKAGE} must expose the viborm-studio executable`);
  }
  return release;
}

/** The packed files are exactly the studio's own: its CLI, its app, its manifest and notices. */
export function auditStudioPack(packReport) {
  const files = (packReport?.files ?? []).map((file) => file.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(STUDIO_FILES)) {
    refuse(
      `${STUDIO_PACKAGE} packs ${JSON.stringify(files)}, not ${JSON.stringify(STUDIO_FILES)}`
    );
  }
  return files;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    env: options.env ?? process.env,
  });
  if (result.error)
    refuse(`${command} failed to start`, { cause: result.error });
  if (result.status !== 0) {
    refuse(
      `${command} ${args.join(" ")} exited with ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ""}`
    );
  }
  return result.stdout ?? "";
}

function options(argv, allowed) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!allowed.includes(name) || argv[index + 1] === undefined) {
      refuse(`Unknown or incomplete option ${JSON.stringify(name)}`);
    }
    parsed.set(name, argv[index + 1]);
  }
  return parsed;
}

const SMOKE_SCHEMA = `import { s } from "viborm";
export const note = s.model({ id: s.int().id(), text: s.string() });
export const schema = { note };
`;
const SMOKE_CONFIG = `import { defineConfig } from "viborm/config";
import { createClient } from "viborm/pglite";
import { schema } from "./schema";
export const client = createClient({ schema });
export default defineConfig({ client });
`;
const SERVING = /http:\/\/127\.0\.0\.1:\d+/;

/**
 * Install both tarballs into a clean project with a PGlite config, start the
 * studio the way a user does, and read its app and its schema.
 */
async function smokeTest(studioTarball, vibormTarball) {
  const project = mkdtempSync(join(tmpdir(), "viborm-studio-smoke-"));
  try {
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "studio-smoke", private: true, type: "module" })}\n`
    );
    mkdirSync(join(project, "db"));
    writeFileSync(join(project, "db/schema.ts"), SMOKE_SCHEMA);
    writeFileSync(join(project, "db/viborm.config.ts"), SMOKE_CONFIG);
    const pglite = JSON.parse(
      readFileSync(join(REPOSITORY_ROOT, "package.json"), "utf8")
    ).devDependencies["@electric-sql/pglite"];
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        vibormTarball,
        studioTarball,
        `@electric-sql/pglite@${pglite}`,
      ],
      { cwd: project, stdio: "inherit" }
    );
    const studio = spawn(
      process.execPath,
      [
        join(project, "node_modules/@viborm/studio/dist/cli.mjs"),
        "--no-open",
        "--no-watch",
        "--port",
        "0",
      ],
      { cwd: project, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    studio.stdout.on("data", (chunk) => (output += chunk));
    studio.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise((resolveExit) => studio.on("exit", resolveExit));
    try {
      const started = Date.now();
      while (!SERVING.test(output)) {
        if (studio.exitCode !== null || Date.now() - started > 60_000) {
          refuse(`viborm-studio did not start:\n${output}`);
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      if (!output.includes("Config: db/viborm.config.ts")) {
        refuse(`viborm-studio did not find the config by itself:\n${output}`);
      }
      const url = SERVING.exec(output)[0];
      const page = await (await fetch(url)).text();
      if (!page.includes("<title>VibORM Studio</title>")) {
        refuse("viborm-studio did not serve its app");
      }
      const schema = await (await fetch(`${url}/api/schema`)).json();
      if (
        schema.dialect !== "postgresql" ||
        schema.models.map((model) => model.name).join() !== "note"
      ) {
        refuse(
          `viborm-studio served the wrong schema: ${JSON.stringify(schema)}`
        );
      }
    } finally {
      studio.kill("SIGINT");
      await exited;
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

async function createArtifact(argv) {
  const parsed = options(argv, ["--version", "--viborm-manifest"]);
  const version = parsed.get("--version");
  const vibormManifestPath = resolve(parsed.get("--viborm-manifest") ?? "");
  const packageJson = JSON.parse(
    readFileSync(join(PACKAGE_DIRECTORY, "package.json"), "utf8")
  );
  const release = validateStudioPackage(packageJson, version);
  const vibormManifest = JSON.parse(readFileSync(vibormManifestPath, "utf8"));
  if (vibormManifest.version !== release.version) {
    refuse(
      `The viborm tarball is ${vibormManifest.version}; the release is ${release.version}`
    );
  }
  const vibormTarball = join(
    dirname(vibormManifestPath),
    vibormManifest.tarball
  );
  verifyArtifactIntegrity(readFileSync(vibormTarball), vibormManifest);

  rmSync(OUTPUT_DIRECTORY, { force: true, recursive: true });
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  run("pnpm", ["--filter", STUDIO_PACKAGE, "build"], { stdio: "inherit" });
  const pack = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        OUTPUT_DIRECTORY,
      ],
      { cwd: PACKAGE_DIRECTORY }
    )
  )[0];
  auditStudioPack(pack);
  const tarball = pack.filename;
  if (basename(tarball) !== tarball || !tarball.endsWith(".tgz")) {
    refuse("npm pack returned an unsafe tarball filename");
  }
  const tarballPath = join(OUTPUT_DIRECTORY, tarball);
  const hashes = hashArtifactBytes(readFileSync(tarballPath));
  if (pack.integrity !== hashes.integrity) {
    refuse("npm pack reported integrity does not match the studio tarball");
  }
  await smokeTest(tarballPath, vibormTarball);
  const manifest = {
    schemaVersion: 1,
    package: STUDIO_PACKAGE,
    version: release.version,
    channel: release.channel,
    tarball,
    integrity: hashes.integrity,
    sha256: hashes.sha256,
    size: pack.size,
    unpackedSize: pack.unpackedSize,
  };
  writeFileSync(
    join(OUTPUT_DIRECTORY, "studio-release.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** What the registry holds for this version: nothing, these bytes, or other bytes (refused). */
export function studioRegistryState(manifest, registryIntegrity) {
  if (registryIntegrity === undefined) return { publish: true };
  if (registryIntegrity !== manifest.integrity) {
    refuse(
      `${STUDIO_PACKAGE}@${manifest.version} is already on npm with other bytes`
    );
  }
  return { publish: false };
}

function registryIntegrity(manifest) {
  const result = spawnSync(
    "npm",
    ["view", `${STUDIO_PACKAGE}@${manifest.version}`, "dist.integrity"],
    { encoding: "utf8" }
  );
  const integrity = result.status === 0 ? result.stdout.trim() : "";
  return integrity === "" ? undefined : integrity;
}

function readManifest(argv) {
  const parsed = options(argv, ["--manifest", "--github-output"]);
  const path = resolve(parsed.get("--manifest") ?? "");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  verifyArtifactIntegrity(
    readFileSync(join(dirname(path), manifest.tarball)),
    manifest
  );
  return { manifest, githubOutput: parsed.get("--github-output") };
}

function registryState(argv) {
  const { manifest, githubOutput } = readManifest(argv);
  const state = studioRegistryState(manifest, registryIntegrity(manifest));
  if (githubOutput) {
    appendFileSync(
      githubOutput,
      `publish=${state.publish}\ntarball=${manifest.tarball}\nchannel=${manifest.channel}\n`
    );
  }
  process.stdout.write(`${JSON.stringify(state)}\n`);
}

async function verifyRegistry(argv) {
  const { manifest } = readManifest(argv);
  // npm serves a fresh version after asynchronous processing: the same ladder
  // as `viborm`'s (about eight minutes).
  const delays = [
    0, 1000, 2000, 4000, 8000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000,
    60_000, 60_000, 60_000,
  ];
  for (const delay of delays) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    const integrity = registryIntegrity(manifest);
    if (integrity !== undefined) {
      studioRegistryState(manifest, integrity);
      process.stdout.write(
        `${STUDIO_PACKAGE}@${manifest.version} is on npm with the tested bytes\n`
      );
      return;
    }
  }
  refuse(`${STUDIO_PACKAGE}@${manifest.version} did not appear on npm`);
}

export async function runStudioReleaseCli(argv) {
  const [command, ...rest] = argv;
  if (command === "artifact") return createArtifact(rest);
  if (command === "registry-state") return registryState(rest);
  if (command === "verify-registry") return verifyRegistry(rest);
  refuse(
    "Usage: release-studio.mjs artifact | registry-state | verify-registry"
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await runStudioReleaseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `release-studio: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
