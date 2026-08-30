#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashArtifactBytes,
  parseReleaseVersion,
  verifyArtifactIntegrity,
} from "./release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  "release",
  "viborm-release.json"
);
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GithubReleaseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "GithubReleaseError";
  }
}

function refuse(message, options) {
  throw new GithubReleaseError(message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    refuse(`${description} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value, description) {
  if (typeof value !== "boolean") {
    refuse(`${description} must be a boolean`);
  }
  return value;
}

function requireIdentifier(value, description) {
  if (
    !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
  ) {
    refuse(`${description} must be a positive safe integer`);
  }
  return value;
}

function requireCommit(value, description) {
  const commit = requireString(value, description).toLowerCase();
  if (!FULL_COMMIT_SHA_PATTERN.test(commit)) {
    refuse(`${description} must be a full Git commit SHA`);
  }
  return commit;
}

function readBytes(path, description) {
  try {
    return readFileSync(path);
  } catch (cause) {
    refuse(`Cannot read ${description} at ${path}`, { cause });
  }
}

function parseJson(bytes, path, description) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    refuse(`${description} at ${path} is not valid JSON`, { cause });
  }
}

function expectedAsset(name, path, bytes, contentType) {
  const hashes = hashArtifactBytes(bytes);
  return {
    contentType,
    integrity: hashes.integrity,
    name,
    path,
    sha256: hashes.sha256,
  };
}

export function readGithubReleaseIntent(manifestPath = DEFAULT_MANIFEST_PATH) {
  const absoluteManifestPath = resolve(manifestPath);
  const manifestBytes = readBytes(absoluteManifestPath, "release manifest");
  const manifest = parseJson(
    manifestBytes,
    absoluteManifestPath,
    "release manifest"
  );
  if (!isRecord(manifest) || manifest.schemaVersion !== 1) {
    refuse("Release manifest must use schemaVersion 1");
  }

  const version = requireString(manifest.version, "Manifest version");
  const releaseVersion = parseReleaseVersion(version);
  if (manifest.channel !== releaseVersion.channel) {
    refuse("Release manifest channel does not match its version");
  }
  if (manifest.package !== "viborm") {
    refuse("GitHub release manifest must describe the viborm package");
  }

  const commit = requireCommit(manifest.commit, "Manifest commit");
  const main = requireCommit(manifest.main, "Manifest main commit");
  if (commit !== main) {
    refuse("GitHub release manifest commit must match its main commit");
  }
  if (manifest.ref !== "refs/heads/main") {
    refuse("GitHub release manifest ref must be refs/heads/main");
  }
  const tarball = requireString(manifest.tarball, "Manifest tarball");
  if (basename(tarball) !== tarball || !tarball.endsWith(".tgz")) {
    refuse("Manifest tarball must be a .tgz basename");
  }
  const tarballPath = join(dirname(absoluteManifestPath), tarball);
  const tarballBytes = readBytes(tarballPath, "release tarball");
  verifyArtifactIntegrity(tarballBytes, manifest);

  const prerelease = releaseVersion.channel === "next";
  return {
    assets: [
      expectedAsset(tarball, tarballPath, tarballBytes, "application/gzip"),
      expectedAsset(
        "viborm-release.json",
        absoluteManifestPath,
        manifestBytes,
        "application/json"
      ),
    ],
    commit,
    latest: !prerelease,
    prerelease,
    tag: `v${version}`,
    title: `VibORM ${version}`,
    version,
  };
}

function validateReleaseMetadata(intent, release) {
  requireIdentifier(release.id, "GitHub release id");
  if (release.tag_name !== intent.tag) {
    refuse(
      `GitHub release tag ${JSON.stringify(release.tag_name)} does not match ${intent.tag}`
    );
  }
  if (release.name !== intent.title) {
    refuse(
      `GitHub release title ${JSON.stringify(release.name)} does not match ${intent.title}`
    );
  }
  if (
    requireBoolean(release.prerelease, "GitHub prerelease state") !==
    intent.prerelease
  ) {
    refuse(
      "GitHub release prerelease state does not match the release channel"
    );
  }
  const draft = requireBoolean(release.draft, "GitHub draft state");
  const immutable = requireBoolean(
    release.immutable,
    "GitHub release immutable state"
  );
  if (!(draft || immutable)) {
    refuse("Published GitHub release is not immutable");
  }
}

function validateObservedAssets(intent, release, observedAssets) {
  if (!Array.isArray(observedAssets)) {
    refuse("Observed GitHub assets must be an array");
  }
  const expectedByName = new Map(
    intent.assets.map((asset) => [asset.name, asset])
  );
  const observedNames = new Set();
  for (const observed of observedAssets) {
    if (!isRecord(observed)) {
      refuse("Observed GitHub asset must be a record");
    }
    const name = requireString(observed.name, "Observed GitHub asset name");
    if (observedNames.has(name)) {
      refuse(`GitHub release contains duplicate asset ${name}`);
    }
    observedNames.add(name);
    const expected = expectedByName.get(name);
    if (expected === undefined) {
      refuse(`GitHub release contains unexpected asset ${name}`);
    }
    if (observed.state !== "uploaded") {
      refuse(`GitHub release asset ${name} is not fully uploaded`);
    }
    if (observed.sha256 !== expected.sha256) {
      refuse(`GitHub release asset ${name} has different SHA-256 bytes`);
    }
    if (observed.integrity !== expected.integrity) {
      refuse(`GitHub release asset ${name} has different npm integrity bytes`);
    }
  }

  const missingAssets = intent.assets
    .filter((asset) => !observedNames.has(asset.name))
    .map((asset) => asset.name);
  if (!release.draft && missingAssets.length > 0) {
    refuse(
      `Published GitHub release is missing asset ${missingAssets.join(", ")}`
    );
  }
  return missingAssets;
}

export function resolveGithubReleaseState(intent, observed) {
  if (!(isRecord(intent) && Array.isArray(intent.assets))) {
    refuse("GitHub release intent must define its assets");
  }
  if (!isRecord(observed)) {
    refuse("Observed GitHub release state must be a record");
  }
  const tagCommit = requireCommit(observed.tagCommit, "GitHub tag commit");
  if (tagCommit !== intent.commit) {
    refuse(
      `GitHub tag ${intent.tag} resolves to ${tagCommit}, expected ${intent.commit}`
    );
  }

  if (observed.release === undefined) {
    return { action: "create-draft", missingAssets: [] };
  }
  if (!isRecord(observed.release)) {
    refuse("Observed GitHub release must be a record");
  }

  validateReleaseMetadata(intent, observed.release);
  const missingAssets = validateObservedAssets(
    intent,
    observed.release,
    observed.assets
  );
  if (observed.release.draft) {
    return { action: "complete-draft", missingAssets };
  }

  if (intent.latest && observed.latestReleaseId !== observed.release.id) {
    refuse(
      `Stable GitHub release ${intent.tag} is not the repository latest release`
    );
  }
  return { action: "verified", missingAssets: [] };
}

function runGh(args, options = {}) {
  const execution = spawnSync("gh", args, {
    cwd: REPOSITORY_ROOT,
    encoding: options.binary ? null : "utf8",
    input: options.input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (execution.error) {
    refuse("Could not execute the GitHub CLI", { cause: execution.error });
  }
  if (execution.status !== 0) {
    const stderr = Buffer.isBuffer(execution.stderr)
      ? execution.stderr.toString("utf8").trim()
      : execution.stderr.trim();
    refuse(
      `GitHub API command failed with exit code ${execution.status}${stderr.length > 0 ? `: ${stderr}` : ""}`
    );
  }
  return execution.stdout;
}

function runGhJson(args, input) {
  const source = runGh(args, { input });
  try {
    return JSON.parse(source);
  } catch (cause) {
    refuse("GitHub API returned invalid JSON", { cause });
  }
}

function apiJson(method, endpoint, body) {
  const args = ["api", "--method", method, endpoint];
  let input;
  if (body !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(body);
  }
  return runGhJson(args, input);
}

function listReleases(repository) {
  const pages = runGhJson([
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    `repos/${repository}/releases?per_page=100`,
  ]);
  if (!Array.isArray(pages)) {
    refuse("GitHub release listing must contain pages");
  }
  const releases = [];
  for (const page of pages) {
    if (!Array.isArray(page)) {
      refuse("GitHub release listing page must be an array");
    }
    releases.push(...page);
  }
  return releases;
}

function findRelease(repository, tag) {
  const matches = listReleases(repository).filter(
    (release) => isRecord(release) && release.tag_name === tag
  );
  if (matches.length > 1) {
    refuse(`GitHub contains multiple releases for tag ${tag}`);
  }
  return matches[0];
}

function readTagCommit(repository, tag) {
  const commit = apiJson("GET", `repos/${repository}/commits/${tag}`);
  if (!isRecord(commit)) {
    refuse(`GitHub tag ${tag} did not resolve to a commit`);
  }
  return requireCommit(commit.sha, `GitHub tag ${tag} commit`);
}

function downloadReleaseAssets(repository, release) {
  if (!Array.isArray(release.assets)) {
    refuse("GitHub release assets must be an array");
  }
  return release.assets.map((asset) => {
    if (!isRecord(asset)) {
      refuse("GitHub release asset must be a record");
    }
    const id = requireIdentifier(asset.id, "GitHub asset id");
    const name = requireString(asset.name, "GitHub asset name");
    const bytes = runGh(
      [
        "api",
        "--method",
        "GET",
        "--header",
        "Accept: application/octet-stream",
        `repos/${repository}/releases/assets/${id}`,
      ],
      { binary: true }
    );
    const hashes = hashArtifactBytes(bytes);
    return {
      integrity: hashes.integrity,
      name,
      sha256: hashes.sha256,
      state: asset.state,
    };
  });
}

function createDraft(repository, intent) {
  return apiJson("POST", `repos/${repository}/releases`, {
    draft: true,
    generate_release_notes: true,
    make_latest: "false",
    name: intent.title,
    prerelease: intent.prerelease,
    tag_name: intent.tag,
    target_commitish: intent.commit,
  });
}

function uploadAsset(repository, release, asset) {
  const id = requireIdentifier(release.id, "GitHub release id");
  runGh([
    "api",
    "--method",
    "POST",
    "--header",
    `Content-Type: ${asset.contentType}`,
    "--input",
    asset.path,
    `https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`,
  ]);
}

function publishDraft(repository, release, intent) {
  const id = requireIdentifier(release.id, "GitHub release id");
  return apiJson("PATCH", `repos/${repository}/releases/${id}`, {
    draft: false,
    make_latest: intent.latest ? "true" : "false",
    name: intent.title,
    prerelease: intent.prerelease,
    tag_name: intent.tag,
  });
}

function latestReleaseId(repository) {
  const release = apiJson("GET", `repos/${repository}/releases/latest`);
  if (!isRecord(release)) {
    refuse("GitHub latest release response must be a record");
  }
  return requireIdentifier(release.id, "GitHub latest release id");
}

function observeRelease(repository, intent, tagCommit, release) {
  return {
    assets:
      release === undefined ? [] : downloadReleaseAssets(repository, release),
    latestReleaseId:
      release !== undefined && !release.draft && intent.latest
        ? latestReleaseId(repository)
        : undefined,
    release,
    tagCommit,
  };
}

function findExpectedAsset(intent, name) {
  const asset = intent.assets.find((candidate) => candidate.name === name);
  if (asset === undefined) {
    refuse(`Cannot find expected GitHub asset ${name}`);
  }
  return asset;
}

export function publishGithubRelease({ manifestPath, repository }) {
  if (!REPOSITORY_PATTERN.test(repository)) {
    refuse("GitHub repository must use the owner/name spelling");
  }
  const intent = readGithubReleaseIntent(manifestPath);
  const tagCommit = readTagCommit(repository, intent.tag);
  let release = findRelease(repository, intent.tag);
  let state = resolveGithubReleaseState(
    intent,
    observeRelease(repository, intent, tagCommit, release)
  );

  if (state.action === "create-draft") {
    createDraft(repository, intent);
    release = findRelease(repository, intent.tag);
    if (release === undefined) {
      refuse(`Created GitHub draft ${intent.tag} was not observable`);
    }
    state = resolveGithubReleaseState(
      intent,
      observeRelease(repository, intent, tagCommit, release)
    );
  }

  if (state.action === "complete-draft") {
    if (release === undefined) {
      refuse("Cannot complete an absent GitHub release");
    }
    for (const name of state.missingAssets) {
      uploadAsset(repository, release, findExpectedAsset(intent, name));
    }
    release = findRelease(repository, intent.tag);
    if (release === undefined) {
      refuse(`GitHub draft ${intent.tag} disappeared before publication`);
    }
    state = resolveGithubReleaseState(
      intent,
      observeRelease(repository, intent, tagCommit, release)
    );
    if (state.action !== "complete-draft" || state.missingAssets.length > 0) {
      refuse(`GitHub draft ${intent.tag} was not ready for publication`);
    }
    publishDraft(repository, release, intent);
    release = findRelease(repository, intent.tag);
    if (release === undefined) {
      refuse(`Published GitHub release ${intent.tag} was not observable`);
    }
    state = resolveGithubReleaseState(
      intent,
      observeRelease(repository, intent, tagCommit, release)
    );
  }

  if (state.action !== "verified") {
    refuse(`GitHub release ${intent.tag} did not reach a verified state`);
  }
  return {
    status: "verified",
    tag: intent.tag,
    version: intent.version,
  };
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!(name === "--manifest" || name === "--repository")) {
      refuse(`Unexpected GitHub release option ${name}`);
    }
    if (value === undefined || value.startsWith("--")) {
      refuse(`GitHub release option ${name} requires a value`);
    }
    if (options.has(name)) {
      refuse(`GitHub release option ${name} was supplied more than once`);
    }
    options.set(name, value);
  }
  return options;
}

export function runGithubReleaseCli(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(
      "Usage: node scripts/github-release.mjs publish [--manifest <path>] [--repository <owner/name>]\n"
    );
    return;
  }
  if (command !== "publish") {
    refuse(`Unknown GitHub release command ${command}`);
  }
  const options = parseOptions(rest);
  const repository =
    options.get("--repository") ?? process.env.GITHUB_REPOSITORY;
  const release = publishGithubRelease({
    manifestPath: resolve(options.get("--manifest") ?? DEFAULT_MANIFEST_PATH),
    repository: requireString(repository, "GitHub repository"),
  });
  process.stdout.write(`${JSON.stringify(release)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runGithubReleaseCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown GitHub release failure";
    process.stderr.write(`github-release: ${message}\n`);
    process.exitCode = 1;
  }
}
