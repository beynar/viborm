#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_CONTRACT_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "release-package-contract.json"
);
const DEFAULT_OUTPUT_DIRECTORY = join(REPOSITORY_ROOT, "release");
const DEFAULT_MANIFEST_PATH = join(
  DEFAULT_OUTPUT_DIRECTORY,
  "viborm-release.json"
);
const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const CANONICAL_BASE64_PATTERN =
  /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/;
const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const GITHUB_ACTIONS_BUILD_TYPE =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const GITHUB_HOSTED_BUILDER = "https://github.com/actions/runner/github-hosted";
const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
const SUPPORTED_SIGSTORE_BUNDLE_MEDIA_TYPES = new Set([
  "application/vnd.dev.sigstore.bundle+json;version=0.2",
  "application/vnd.dev.sigstore.bundle.v0.3+json",
]);
const COMMAND_OPTIONS = new Map([
  ["artifact", new Set(["--main-sha", "--ref", "--version"])],
  ["contract", new Set(["--main-sha", "--ref", "--version"])],
  ["verify-artifact", new Set(["--manifest"])],
  ["verify-artifact-consumer", new Set(["--manifest"])],
  ["verify-consumer", new Set(["--manifest"])],
  [
    "verify-registry",
    new Set(["--github-output", "--manifest", "--require-present"]),
  ],
]);

export class ReleaseContractError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ReleaseContractError";
  }
}

function refuse(message, options) {
  throw new ReleaseContractError(message, options);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path, description) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (cause) {
    refuse(`Cannot read ${description} at ${path}`, { cause });
  }

  try {
    return JSON.parse(source);
  } catch (cause) {
    refuse(`${description} at ${path} is not valid JSON`, { cause });
  }
}

function requireString(value, description) {
  if (typeof value !== "string" || value.length === 0) {
    refuse(`${description} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value, description) {
  if (!Number.isSafeInteger(value) || value < 0) {
    refuse(`${description} must be a non-negative safe integer`);
  }
  return value;
}

function requireStringArray(value, description) {
  if (!Array.isArray(value) || value.length === 0) {
    refuse(`${description} must be a non-empty string array`);
  }
  const strings = [];
  for (const entry of value) {
    strings.push(requireString(entry, `${description} entry`));
  }
  return strings;
}

export function parseReleaseVersion(version) {
  const spelling = requireString(version, "Release version");
  const match = RELEASE_VERSION_PATTERN.exec(spelling);
  if (!match) {
    refuse(
      `Release version ${JSON.stringify(spelling)} must be stable SemVer or an rc.N prerelease`
    );
  }
  if (match[4] === "0") {
    refuse("Release candidate numbers start at 1");
  }
  return {
    channel: match[4] === undefined ? "latest" : "next",
    version: spelling,
  };
}

function releaseVersionParts(version) {
  const release = parseReleaseVersion(version);
  const match = RELEASE_VERSION_PATTERN.exec(release.version);
  if (match === null) {
    refuse(`Cannot compare release version ${release.version}`);
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    rc: match[4] === undefined ? undefined : BigInt(match[4]),
  };
}

export function compareReleaseVersions(left, right) {
  const leftParts = releaseVersionParts(left);
  const rightParts = releaseVersionParts(right);
  for (const key of ["major", "minor", "patch"]) {
    if (leftParts[key] < rightParts[key]) return -1;
    if (leftParts[key] > rightParts[key]) return 1;
  }
  if (leftParts.rc === undefined) {
    return rightParts.rc === undefined ? 0 : 1;
  }
  if (rightParts.rc === undefined) return -1;
  if (leftParts.rc < rightParts.rc) return -1;
  if (leftParts.rc > rightParts.rc) return 1;
  return 0;
}

export function readReleasePackageContract(
  contractPath = DEFAULT_CONTRACT_PATH
) {
  const contract = readJson(contractPath, "release package contract");
  if (!isRecord(contract) || contract.schemaVersion !== 1) {
    refuse("Release package contract must use schemaVersion 1");
  }
  if (!(isRecord(contract.package) && isRecord(contract.artifact))) {
    refuse("Release package contract must define package and artifact records");
  }

  return {
    artifact: {
      allowedDistSuffixes: requireStringArray(
        contract.artifact.allowedDistSuffixes,
        "artifact.allowedDistSuffixes"
      ),
      allowedRootFiles: requireStringArray(
        contract.artifact.allowedRootFiles,
        "artifact.allowedRootFiles"
      ),
      forbiddenPrefixes: requireStringArray(
        contract.artifact.forbiddenPrefixes,
        "artifact.forbiddenPrefixes"
      ),
      maximumCompressedBytes: requireInteger(
        contract.artifact.maximumCompressedBytes,
        "artifact.maximumCompressedBytes"
      ),
      maximumFileCount: requireInteger(
        contract.artifact.maximumFileCount,
        "artifact.maximumFileCount"
      ),
      maximumUnpackedBytes: requireInteger(
        contract.artifact.maximumUnpackedBytes,
        "artifact.maximumUnpackedBytes"
      ),
      requiredFiles: requireStringArray(
        contract.artifact.requiredFiles,
        "artifact.requiredFiles"
      ),
    },
    package: {
      bin: requireString(contract.package.bin, "package.bin"),
      bugs: requireString(contract.package.bugs, "package.bugs"),
      homepage: requireString(contract.package.homepage, "package.homepage"),
      name: requireString(contract.package.name, "package.name"),
      license: requireString(contract.package.license, "package.license"),
      node: requireString(contract.package.node, "package.node"),
      packageManager: requireString(
        contract.package.packageManager,
        "package.packageManager"
      ),
      publishAccess: requireString(
        contract.package.publishAccess,
        "package.publishAccess"
      ),
      repository: requireString(
        contract.package.repository,
        "package.repository"
      ),
    },
    schemaVersion: 1,
  };
}

function repositoryUrl(packageJson) {
  if (typeof packageJson.repository === "string") {
    return packageJson.repository;
  }
  if (
    isRecord(packageJson.repository) &&
    packageJson.repository.type === "git" &&
    typeof packageJson.repository.url === "string"
  ) {
    return packageJson.repository.url;
  }
  refuse(
    "package.json repository must be a Git URL or a { type: 'git', url } record"
  );
}

function bugsUrl(packageJson) {
  if (typeof packageJson.bugs === "string") {
    return packageJson.bugs;
  }
  if (isRecord(packageJson.bugs) && typeof packageJson.bugs.url === "string") {
    return packageJson.bugs.url;
  }
  refuse("package.json bugs must be a URL or a { url } record");
}

export function validatePackageMetadata(packageJson, contract) {
  if (!isRecord(packageJson)) {
    refuse("package.json must contain an object");
  }
  if (packageJson.name !== contract.package.name) {
    refuse(
      `Package name must be ${contract.package.name}, found ${JSON.stringify(packageJson.name)}`
    );
  }
  if (
    !isRecord(packageJson.bin) ||
    Object.keys(packageJson.bin).length !== 1 ||
    packageJson.bin[contract.package.name] !== contract.package.bin
  ) {
    refuse(
      `Package CLI must map ${contract.package.name} to ${contract.package.bin}`
    );
  }
  if (repositoryUrl(packageJson) !== contract.package.repository) {
    refuse(
      `Package repository must be ${contract.package.repository} with exact case`
    );
  }
  if (packageJson.homepage !== contract.package.homepage) {
    refuse(`Package homepage must be ${contract.package.homepage}`);
  }
  if (bugsUrl(packageJson) !== contract.package.bugs) {
    refuse(`Package bugs URL must be ${contract.package.bugs}`);
  }
  if (packageJson.license !== contract.package.license) {
    refuse(`Package license must be ${contract.package.license}`);
  }
  if (packageJson.packageManager !== contract.package.packageManager) {
    refuse(`Package manager must be ${contract.package.packageManager}`);
  }
  if (
    !isRecord(packageJson.engines) ||
    packageJson.engines.node !== contract.package.node
  ) {
    refuse(`Package Node engine must be ${contract.package.node}`);
  }
  if (
    !isRecord(packageJson.publishConfig) ||
    packageJson.publishConfig.access !== contract.package.publishAccess
  ) {
    refuse(`Package publish access must be ${contract.package.publishAccess}`);
  }
  return packageJson;
}

function validateCommitSha(sha, description) {
  const spelling = requireString(sha, description);
  if (!FULL_COMMIT_SHA_PATTERN.test(spelling)) {
    refuse(`${description} must be a full 40-character Git commit SHA`);
  }
  return spelling.toLowerCase();
}

export function validateReleaseContract({
  commitSha,
  contract,
  mainSha,
  packageJson,
  ref,
  requestedVersion,
}) {
  validatePackageMetadata(packageJson, contract);
  const release = parseReleaseVersion(requestedVersion);
  if (packageJson.version !== release.version) {
    refuse(
      `Requested version ${release.version} does not match package.json version ${JSON.stringify(packageJson.version)}`
    );
  }

  const commit = validateCommitSha(commitSha, "Release commit");
  const main = validateCommitSha(mainSha, "Main commit");
  const releaseRef = requireString(ref, "Release ref");
  if (releaseRef !== "refs/heads/main") {
    refuse("A release must execute from refs/heads/main");
  }
  if (commit !== main) {
    refuse("A release must execute at the exact supplied main commit");
  }

  return {
    channel: release.channel,
    commit,
    main,
    package: contract.package.name,
    ref: releaseRef,
    version: release.version,
  };
}

function isSafePackedPath(path) {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.startsWith("../") &&
    !path.includes("/../") &&
    !path.includes("\\")
  );
}

function isAllowedPackedPath(path, artifactContract) {
  if (artifactContract.allowedRootFiles.includes(path)) {
    return true;
  }
  if (!path.startsWith("dist/")) {
    return false;
  }
  return artifactContract.allowedDistSuffixes.some((suffix) =>
    path.endsWith(suffix)
  );
}

function collectManifestPaths(value, paths) {
  if (typeof value === "string") {
    if (value.startsWith("./")) {
      paths.add(value.slice(2));
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const nested of Object.values(value)) {
    collectManifestPaths(nested, paths);
  }
}

function requiredManifestPaths(packageJson) {
  const paths = new Set();
  collectManifestPaths(packageJson.main, paths);
  collectManifestPaths(packageJson.module, paths);
  collectManifestPaths(packageJson.types, paths);
  collectManifestPaths(packageJson.exports, paths);
  collectManifestPaths(packageJson.bin, paths);
  return paths;
}

export function auditPackedPackage(packReport, packageJson, contract) {
  if (!(isRecord(packReport) && Array.isArray(packReport.files))) {
    refuse("npm pack must return one report with a files array");
  }
  const size = requireInteger(packReport.size, "Packed compressed size");
  const unpackedSize = requireInteger(
    packReport.unpackedSize,
    "Packed unpacked size"
  );
  const artifactContract = contract.artifact;
  if (size > artifactContract.maximumCompressedBytes) {
    refuse(
      `Packed artifact is ${size} bytes; budget is ${artifactContract.maximumCompressedBytes}`
    );
  }
  if (unpackedSize > artifactContract.maximumUnpackedBytes) {
    refuse(
      `Unpacked artifact is ${unpackedSize} bytes; budget is ${artifactContract.maximumUnpackedBytes}`
    );
  }
  if (packReport.files.length > artifactContract.maximumFileCount) {
    refuse(
      `Packed artifact has ${packReport.files.length} files; budget is ${artifactContract.maximumFileCount}`
    );
  }

  const paths = new Set();
  for (const file of packReport.files) {
    if (!isRecord(file)) {
      refuse("Every npm pack file entry must be an object");
    }
    const path = requireString(file.path, "Packed file path");
    if (!isSafePackedPath(path)) {
      refuse(`Packed file path ${JSON.stringify(path)} is unsafe`);
    }
    if (paths.has(path)) {
      refuse(`Packed artifact contains duplicate path ${path}`);
    }
    paths.add(path);
    const forbidden = artifactContract.forbiddenPrefixes.find(
      (prefix) => path === prefix || path.startsWith(prefix)
    );
    if (forbidden !== undefined) {
      refuse(`Packed artifact contains forbidden path ${path}`);
    }
    if (!isAllowedPackedPath(path, artifactContract)) {
      refuse(`Packed artifact contains path outside the allowlist: ${path}`);
    }
  }

  for (const required of artifactContract.requiredFiles) {
    if (!paths.has(required)) {
      refuse(`Packed artifact is missing required file ${required}`);
    }
  }
  for (const required of requiredManifestPaths(packageJson)) {
    if (!paths.has(required)) {
      refuse(`Packed artifact is missing package entry ${required}`);
    }
  }

  return {
    fileCount: paths.size,
    files: [...paths].sort(),
    size,
    unpackedSize,
  };
}

export function hashArtifactBytes(bytes) {
  return {
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function verifyArtifactIntegrity(bytes, manifest) {
  if (!isRecord(manifest)) {
    refuse("Release manifest must contain an object");
  }
  const expectedSha256 = requireString(manifest.sha256, "Manifest sha256");
  const expectedIntegrity = requireString(
    manifest.integrity,
    "Manifest integrity"
  );
  const hashes = hashArtifactBytes(bytes);
  if (hashes.sha256 !== expectedSha256) {
    refuse("Release tarball SHA-256 does not match the manifest");
  }
  if (hashes.integrity !== expectedIntegrity) {
    refuse("Release tarball npm integrity does not match the manifest");
  }
  return hashes;
}

export function resolveRegistryState(
  manifest,
  registryIntegrity,
  { registryChannelVersion, requirePresent = false } = {}
) {
  if (!isRecord(manifest)) {
    refuse("Release manifest must contain an object");
  }
  const expectedIntegrity = requireString(
    manifest.integrity,
    "Manifest integrity"
  );
  if (registryIntegrity === undefined) {
    if (requirePresent) {
      refuse(
        `Registry does not contain ${manifest.package}@${manifest.version} after publication`
      );
    }
    if (
      registryChannelVersion !== undefined &&
      compareReleaseVersions(manifest.version, registryChannelVersion) <= 0
    ) {
      refuse(
        `Refusing to move dist-tag ${manifest.channel} backward from ${registryChannelVersion} to ${manifest.version}`
      );
    }
    return { publish: true, status: "publish-required" };
  }
  if (registryIntegrity !== expectedIntegrity) {
    refuse(
      `Registry ${manifest.package}@${manifest.version} exists with different integrity`
    );
  }
  if (registryChannelVersion !== manifest.version) {
    refuse(
      `Registry dist-tag ${manifest.channel} points to ${JSON.stringify(registryChannelVersion)}, expected ${manifest.version}`
    );
  }
  return {
    publish: false,
    status: requirePresent ? "verified" : "already-published",
  };
}

function registryAttestationUrl(packageName, version) {
  const packageSpecifier = `${packageName}@${version}`.replaceAll("/", "%2f");
  return `${NPM_REGISTRY_ORIGIN}/-/npm/v1/attestations/${packageSpecifier}`;
}

function readRegistryAttestationUrl(registryAttestations, manifest) {
  if (!isRecord(registryAttestations)) {
    refuse("Registry dist.attestations must contain an object");
  }
  const url = requireString(
    registryAttestations.url,
    "Registry dist.attestations.url"
  );
  const expectedUrl = registryAttestationUrl(
    requireString(manifest.package, "Manifest package"),
    requireString(manifest.version, "Manifest version")
  );
  if (url !== expectedUrl) {
    refuse(
      "Registry dist.attestations.url must use the canonical npm registry URL"
    );
  }
  if (
    !isRecord(registryAttestations.provenance) ||
    registryAttestations.provenance.predicateType !== SLSA_PROVENANCE_V1
  ) {
    refuse("Registry dist.attestations must declare SLSA v1 provenance");
  }
  return url;
}

function decodeBase64Json(source, description) {
  const encoded = requireString(source, description);
  if (encoded.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(encoded)) {
    refuse(`${description} must be canonical base64`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    refuse(`${description} must be canonical base64`);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    refuse(`${description} must encode UTF-8 JSON`, { cause });
  }
}

function integritySha512Hex(integrity) {
  const spelling = requireString(integrity, "Manifest integrity");
  if (!spelling.startsWith("sha512-")) {
    refuse("Manifest integrity must use SHA-512");
  }
  const encoded = spelling.slice("sha512-".length);
  if (encoded.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(encoded)) {
    refuse("Manifest SHA-512 integrity must be canonical base64");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    refuse("Manifest SHA-512 integrity must contain exactly 64 bytes");
  }
  return bytes.toString("hex");
}

function requireRecord(value, description) {
  if (!isRecord(value)) {
    refuse(`${description} must contain an object`);
  }
  return value;
}

function requireSingleRecord(value, description) {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) {
    refuse(`${description} must contain exactly one object`);
  }
  return value[0];
}

export function verifyRegistryProvenance({
  attestationResponse,
  manifest,
  registryAttestations,
  repository,
}) {
  if (!isRecord(manifest)) {
    refuse("Release manifest must contain an object");
  }
  readRegistryAttestationUrl(registryAttestations, manifest);
  const response = requireRecord(
    attestationResponse,
    "Registry attestation response"
  );
  if (!Array.isArray(response.attestations)) {
    refuse("Registry attestation response must contain an attestations array");
  }
  const provenanceEntries = response.attestations.filter(
    (entry) => isRecord(entry) && entry.predicateType === SLSA_PROVENANCE_V1
  );
  if (provenanceEntries.length !== 1) {
    refuse("Registry must publish exactly one SLSA v1 provenance attestation");
  }

  // npm verifies Sigstore, transparency-log inclusion, certificate claims, and
  // public-repository visibility before it publishes dist.attestations. Bind
  // that signed statement to this release here; the consumer leg also runs
  // npm's independent signature audit over the installed package.
  const provenance = provenanceEntries[0];
  const bundle = requireRecord(provenance.bundle, "SLSA provenance bundle");
  if (!SUPPORTED_SIGSTORE_BUNDLE_MEDIA_TYPES.has(bundle.mediaType)) {
    refuse("SLSA provenance bundle uses an unsupported Sigstore media type");
  }
  const verificationMaterial = requireRecord(
    bundle.verificationMaterial,
    "SLSA provenance verification material"
  );
  const certificate = requireRecord(
    verificationMaterial.certificate,
    "SLSA provenance signing certificate"
  );
  requireString(certificate.rawBytes, "SLSA provenance signing certificate");
  if (
    !Array.isArray(verificationMaterial.tlogEntries) ||
    verificationMaterial.tlogEntries.length === 0 ||
    verificationMaterial.tlogEntries.some((entry) => !isRecord(entry))
  ) {
    refuse("SLSA provenance must include transparency-log evidence");
  }

  const envelope = requireRecord(
    bundle.dsseEnvelope,
    "SLSA provenance DSSE envelope"
  );
  if (envelope.payloadType !== "application/vnd.in-toto+json") {
    refuse("SLSA provenance DSSE payload must use the in-toto JSON media type");
  }
  if (
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0 ||
    envelope.signatures.some(
      (signature) =>
        !isRecord(signature) ||
        typeof signature.sig !== "string" ||
        signature.sig.length === 0
    )
  ) {
    refuse("SLSA provenance DSSE envelope must contain a signature");
  }

  const statement = requireRecord(
    decodeBase64Json(envelope.payload, "SLSA provenance DSSE payload"),
    "SLSA provenance statement"
  );
  if (
    statement._type !== IN_TOTO_STATEMENT_V1 ||
    statement.predicateType !== SLSA_PROVENANCE_V1
  ) {
    refuse("SLSA provenance statement must be an in-toto v1 statement");
  }

  const packageName = requireString(manifest.package, "Manifest package");
  const version = requireString(manifest.version, "Manifest version");
  const subject = requireSingleRecord(
    statement.subject,
    "SLSA provenance subject"
  );
  if (subject.name !== `pkg:npm/${packageName}@${version}`) {
    refuse("SLSA provenance subject does not identify the released package");
  }
  const digest = requireRecord(
    subject.digest,
    "SLSA provenance subject digest"
  );
  if (digest.sha512 !== integritySha512Hex(manifest.integrity)) {
    refuse(
      "SLSA provenance tarball digest does not match the release manifest"
    );
  }

  const predicate = requireRecord(
    statement.predicate,
    "SLSA provenance predicate"
  );
  const buildDefinition = requireRecord(
    predicate.buildDefinition,
    "SLSA provenance build definition"
  );
  if (buildDefinition.buildType !== GITHUB_ACTIONS_BUILD_TYPE) {
    refuse("SLSA provenance must use the GitHub Actions workflow build type");
  }
  const externalParameters = requireRecord(
    buildDefinition.externalParameters,
    "SLSA provenance external parameters"
  );
  const workflow = requireRecord(
    externalParameters.workflow,
    "SLSA provenance workflow"
  );
  const expectedRepository = requireString(
    repository,
    "Expected GitHub repository"
  );
  if (workflow.repository !== expectedRepository) {
    refuse("SLSA provenance repository does not match package.json");
  }
  if (workflow.path !== RELEASE_WORKFLOW_PATH) {
    refuse("SLSA provenance workflow path does not identify release.yml");
  }
  const releaseRef = requireString(manifest.ref, "Manifest ref");
  if (workflow.ref !== releaseRef) {
    refuse("SLSA provenance workflow ref does not match the release manifest");
  }

  const internalParameters = requireRecord(
    buildDefinition.internalParameters,
    "SLSA provenance internal parameters"
  );
  const github = requireRecord(
    internalParameters.github,
    "SLSA provenance GitHub parameters"
  );
  if (github.event_name !== "workflow_dispatch") {
    refuse("SLSA provenance must identify a workflow_dispatch release");
  }

  if (!Array.isArray(buildDefinition.resolvedDependencies)) {
    refuse("SLSA provenance must contain resolved dependencies");
  }
  const expectedDependencyUri = `git+${expectedRepository}@${releaseRef}`;
  const sourceDependencies = buildDefinition.resolvedDependencies.filter(
    (dependency) =>
      isRecord(dependency) && dependency.uri === expectedDependencyUri
  );
  const sourceDependency = requireSingleRecord(
    sourceDependencies,
    "SLSA provenance source dependency"
  );
  const sourceDigest = requireRecord(
    sourceDependency.digest,
    "SLSA provenance source digest"
  );
  const commit = validateCommitSha(manifest.commit, "Manifest commit");
  if (sourceDigest.gitCommit !== commit) {
    refuse("SLSA provenance commit does not match the release manifest");
  }

  const runDetails = requireRecord(
    predicate.runDetails,
    "SLSA provenance run details"
  );
  const builder = requireRecord(runDetails.builder, "SLSA provenance builder");
  if (builder.id !== GITHUB_HOSTED_BUILDER) {
    refuse("SLSA provenance must identify a GitHub-hosted runner");
  }
  const metadata = requireRecord(
    runDetails.metadata,
    "SLSA provenance run metadata"
  );
  const invocationId = requireString(
    metadata.invocationId,
    "SLSA provenance invocation ID"
  );
  if (
    !(
      invocationId.startsWith(`${expectedRepository}/actions/runs/`) &&
      invocationId.includes("/attempts/")
    )
  ) {
    refuse(
      "SLSA provenance invocation does not identify the release repository"
    );
  }

  return {
    commit,
    repository: expectedRepository,
    workflow: RELEASE_WORKFLOW_PATH,
  };
}

function run(command, args, options = {}) {
  const execution = spawnSync(command, args, {
    cwd: options.cwd ?? REPOSITORY_ROOT,
    encoding: options.encoding ?? "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
  });
  if (execution.error) {
    refuse(`Could not execute ${command}`, { cause: execution.error });
  }
  if (execution.status !== 0) {
    const stderr = typeof execution.stderr === "string" ? execution.stderr : "";
    refuse(
      `${command} ${args.join(" ")} failed with exit code ${execution.status}${stderr.length > 0 ? `: ${stderr.trim()}` : ""}`
    );
  }
  return typeof execution.stdout === "string" ? execution.stdout : "";
}

function git(...args) {
  return run("git", args).trim();
}

function validateGitEstate() {
  const status = git("status", "--porcelain", "--untracked-files=all");
  if (status.length > 0) {
    refuse("Release artifact must be built from a clean Git worktree");
  }
}

function parseOptions(args, allowedOptions) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!option.startsWith("--")) {
      refuse(`Unexpected release argument ${option}`);
    }
    if (!allowedOptions.has(option)) {
      refuse(`Unexpected release option ${option}`);
    }
    if (options.has(option)) {
      refuse(`Release option ${option} was supplied more than once`);
    }
    if (option === "--require-present") {
      options.set(option, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      refuse(`Release option ${option} requires a value`);
    }
    options.set(option, value);
    index += 1;
  }
  return options;
}

function requireOption(options, name) {
  if (!options.has(name)) {
    refuse(`Missing required release option ${name}`);
  }
  return requireString(options.get(name), `Release option ${name}`);
}

function loadCliRelease(options) {
  const contract = readReleasePackageContract();
  const packageJson = readJson(
    join(REPOSITORY_ROOT, "package.json"),
    "package.json"
  );
  const commitSha = git("rev-parse", "HEAD");
  const release = validateReleaseContract({
    commitSha,
    contract,
    mainSha: requireOption(options, "--main-sha"),
    packageJson,
    ref: requireOption(options, "--ref"),
    requestedVersion: requireOption(options, "--version"),
  });
  const originMain = validateCommitSha(
    git("rev-parse", "refs/remotes/origin/main"),
    "Fetched origin/main commit"
  );
  if (originMain !== release.main) {
    refuse(
      "Supplied main commit does not match the fetched origin/main commit"
    );
  }
  validateGitEstate();
  return { contract, packageJson, release };
}

function parsePackReport(stdout) {
  let reports;
  try {
    reports = JSON.parse(stdout);
  } catch (cause) {
    refuse("npm pack did not return valid JSON", { cause });
  }
  if (!Array.isArray(reports) || reports.length !== 1) {
    refuse("npm pack must produce exactly one package report");
  }
  return reports[0];
}

function verifyNpmPublishNormalization(tarballPath) {
  const inspectionRoot = mkdtempSync(
    join(tmpdir(), "viborm-publish-normalization-")
  );
  try {
    run("tar", ["-xzf", tarballPath, "-C", inspectionRoot]);
    const packageRoot = join(inspectionRoot, "package");
    const packagePath = join(packageRoot, "package.json");
    const before = readJson(packagePath, "packed package.json");
    run("npm", ["pkg", "fix"], { cwd: packageRoot });
    const after = readJson(packagePath, "npm-normalized package.json");
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      refuse("npm publish would normalize the packed package metadata");
    }
  } finally {
    rmSync(inspectionRoot, { force: true, recursive: true });
  }
}

function createArtifact(options) {
  const { contract, packageJson, release } = loadCliRelease(options);
  const outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  rmSync(outputDirectory, { force: true, recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  rmSync(join(REPOSITORY_ROOT, "dist"), { force: true, recursive: true });

  run("pnpm", ["package:build"], { stdio: "inherit" });
  run("pnpm", ["size"], { stdio: "inherit" });
  const packStdout = run("npm", [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    outputDirectory,
  ]);
  const packReport = parsePackReport(packStdout);
  const packed = auditPackedPackage(packReport, packageJson, contract);
  const tarball = requireString(packReport.filename, "npm pack filename");
  if (basename(tarball) !== tarball || !tarball.endsWith(".tgz")) {
    refuse("npm pack returned an unsafe tarball filename");
  }
  const tarballPath = join(outputDirectory, tarball);
  verifyNpmPublishNormalization(tarballPath);
  const bytes = readFileSync(tarballPath);
  const hashes = hashArtifactBytes(bytes);
  if (packReport.integrity !== hashes.integrity) {
    refuse("npm pack reported integrity does not match the generated tarball");
  }

  run("pnpm", ["exec", "publint", "run", tarballPath, "--strict"], {
    stdio: "inherit",
  });
  run("pnpm", ["exec", "attw", tarballPath, "--profile", "esm-only"], {
    stdio: "inherit",
  });

  run(
    process.execPath,
    [
      "scripts/run-vitest-safe.mjs",
      "run",
      "--workspace",
      "vitest.workspace.ts",
      "--project=package",
    ],
    {
      env: {
        ...process.env,
        VIBORM_PACKAGE_TARBALL: tarballPath,
      },
      stdio: "inherit",
    }
  );

  const manifestPath = join(outputDirectory, "viborm-release.json");
  const manifest = {
    channel: release.channel,
    commit: release.commit,
    fileCount: packed.fileCount,
    integrity: hashes.integrity,
    main: release.main,
    package: release.package,
    ref: release.ref,
    schemaVersion: 1,
    sha256: hashes.sha256,
    size: packed.size,
    tarball,
    tarballPath: relative(REPOSITORY_ROOT, tarballPath),
    unpackedSize: packed.unpackedSize,
    version: release.version,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath };
}

function validateManifestShape(manifest) {
  if (!isRecord(manifest) || manifest.schemaVersion !== 1) {
    refuse("Release manifest must use schemaVersion 1");
  }
  const release = parseReleaseVersion(manifest.version);
  if (manifest.channel !== release.channel) {
    refuse("Release manifest channel does not match its version");
  }
  requireString(manifest.package, "Manifest package");
  requireString(manifest.tarball, "Manifest tarball");
  requireString(manifest.tarballPath, "Manifest tarballPath");
  requireString(manifest.sha256, "Manifest sha256");
  requireString(manifest.integrity, "Manifest integrity");
  const commit = validateCommitSha(manifest.commit, "Manifest commit");
  const main = validateCommitSha(manifest.main, "Manifest main commit");
  if (commit !== main) {
    refuse("Release manifest commit must match its main commit");
  }
  if (manifest.ref !== "refs/heads/main") {
    refuse("Release manifest ref must be refs/heads/main");
  }
  if (basename(manifest.tarball) !== manifest.tarball) {
    refuse("Manifest tarball must be a basename");
  }
  return manifest;
}

function readManifest(path) {
  return validateManifestShape(readJson(path, "release manifest"));
}

function readPackedPackageJson(tarballPath) {
  const source = run("tar", ["-xOf", tarballPath, "package/package.json"]);
  try {
    return JSON.parse(source);
  } catch (cause) {
    refuse("Packed package.json is not valid JSON", { cause });
  }
}

function verifyArtifact(manifestPath) {
  const manifest = readManifest(manifestPath);
  const tarballPath = join(dirname(manifestPath), manifest.tarball);
  const expectedPath = resolve(REPOSITORY_ROOT, manifest.tarballPath);
  if (resolve(tarballPath) !== expectedPath) {
    refuse("Manifest tarball and tarballPath do not identify the same file");
  }
  const bytes = readFileSync(tarballPath);
  verifyArtifactIntegrity(bytes, manifest);
  const contract = readReleasePackageContract();
  const packageJson = readPackedPackageJson(tarballPath);
  validatePackageMetadata(packageJson, contract);
  if (packageJson.version !== manifest.version) {
    refuse("Packed package version does not match the release manifest");
  }
  if (packageJson.name !== manifest.package) {
    refuse("Packed package name does not match the release manifest");
  }
  return { manifest, packageJson, tarballPath };
}

function provenanceRepositoryUrl(packageJson) {
  const repository = repositoryUrl(packageJson);
  const prefix = "git+https://github.com/";
  const suffix = ".git";
  if (!(repository.startsWith(prefix) && repository.endsWith(suffix))) {
    refuse("Package repository must identify a public GitHub repository");
  }
  return `https://github.com/${repository.slice(prefix.length, -suffix.length)}`;
}

function queryRegistryChannelVersion(packageName, channel) {
  const tagsSource = run("npm", ["view", packageName, "dist-tags", "--json"]);
  let tags;
  try {
    tags = JSON.parse(tagsSource);
  } catch (cause) {
    refuse("npm registry returned invalid dist-tag JSON", { cause });
  }
  if (!isRecord(tags)) {
    refuse("npm registry returned a non-object dist-tag response");
  }
  const channelVersion = tags[channel];
  return channelVersion === undefined
    ? undefined
    : requireString(channelVersion, `Registry dist-tag ${channel}`);
}

function queryRegistryState(packageName, version, channel) {
  const execution = spawnSync(
    "npm",
    ["view", `${packageName}@${version}`, "dist", "--json"],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  if (execution.error) {
    refuse("Could not query the npm registry", { cause: execution.error });
  }
  if (execution.status === 0) {
    let dist;
    try {
      dist = JSON.parse(execution.stdout);
    } catch (cause) {
      refuse("npm registry returned invalid dist JSON", { cause });
    }
    if (!isRecord(dist)) {
      refuse("npm registry returned a non-object dist response");
    }
    return {
      attestations: dist.attestations,
      channelVersion: queryRegistryChannelVersion(packageName, channel),
      integrity: requireString(dist.integrity, "Registry integrity"),
    };
  }

  let npmError;
  let parseFailure;
  try {
    npmError = JSON.parse(execution.stdout);
  } catch (cause) {
    npmError = undefined;
    parseFailure = cause;
  }
  if (
    isRecord(npmError) &&
    isRecord(npmError.error) &&
    npmError.error.code === "E404"
  ) {
    return {
      attestations: undefined,
      channelVersion: queryRegistryChannelVersion(packageName, channel),
      integrity: undefined,
    };
  }
  const stderr =
    typeof execution.stderr === "string" ? execution.stderr.trim() : "";
  refuse(
    `npm registry query failed with exit code ${execution.status}${stderr.length > 0 ? `: ${stderr}` : ""}`,
    parseFailure === undefined ? undefined : { cause: parseFailure }
  );
}

async function queryRegistryStateWithRetry(
  packageName,
  version,
  channel,
  requirePresent
) {
  let registry = queryRegistryState(packageName, version, channel);
  if (
    !requirePresent ||
    (registry.integrity !== undefined &&
      registry.channelVersion === version &&
      registry.attestations !== undefined)
  ) {
    return registry;
  }

  const retryDelays = [1000, 2000, 4000, 8000, 15_000, 30_000];
  for (const delay of retryDelays) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    registry = queryRegistryState(packageName, version, channel);
    if (
      registry.integrity !== undefined &&
      registry.channelVersion === version &&
      registry.attestations !== undefined
    ) {
      return registry;
    }
  }
  return registry;
}

async function queryRegistryAttestationResponse(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch (cause) {
    refuse("Could not query npm registry attestations", { cause });
  }
  if (!response.ok) {
    refuse(
      `npm registry attestation query failed with status ${response.status}`
    );
  }
  try {
    return await response.json();
  } catch (cause) {
    refuse("npm registry returned invalid attestation JSON", { cause });
  }
}

export function verifyNpmSignatureAuditReport(audit) {
  if (
    !(
      isRecord(audit) &&
      Array.isArray(audit.invalid) &&
      Array.isArray(audit.missing)
    )
  ) {
    refuse("npm signature audit must return invalid and missing arrays");
  }
  if (audit.invalid.length > 0) {
    refuse("npm signature audit found an invalid package signature");
  }
  if (audit.missing.length > 0) {
    refuse(
      "npm signature audit found a package without a verifiable signature"
    );
  }
}

function verifyNpmSignatureAudit(consumerRoot) {
  const source = run("npm", ["audit", "signatures", "--json"], {
    cwd: consumerRoot,
  });
  let audit;
  try {
    audit = JSON.parse(source);
  } catch (cause) {
    refuse("npm signature audit returned invalid JSON", { cause });
  }
  verifyNpmSignatureAuditReport(audit);
}

function writeGithubOutput(path, state, manifest) {
  appendFileSync(
    path,
    [
      `publish=${state.publish ? "true" : "false"}`,
      `version=${manifest.version}`,
      `channel=${manifest.channel}`,
      `tarball=${manifest.tarball}`,
      "",
    ].join("\n")
  );
}

function verifyConsumer(manifestPath, source) {
  const verified = verifyArtifact(manifestPath);
  const isRegistrySource = source === "registry";
  const consumerRoot = mkdtempSync(
    join(
      tmpdir(),
      isRegistrySource ? "viborm-registry-release-" : "viborm-artifact-release-"
    )
  );
  try {
    writeFileSync(
      join(consumerRoot, "package.json"),
      `${JSON.stringify({ name: "viborm-release-consumer", private: true, type: "module" })}\n`
    );
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--omit=optional",
        isRegistrySource
          ? `${verified.manifest.package}@${verified.manifest.version}`
          : verified.tarballPath,
      ],
      { cwd: consumerRoot }
    );
    if (isRegistrySource) {
      verifyNpmSignatureAudit(consumerRoot);
    }

    const probePath = join(consumerRoot, "probe.mjs");
    writeFileSync(
      probePath,
      `import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const expectedVersion = ${JSON.stringify(verified.manifest.version)};
const expectedPackage = ${JSON.stringify(verified.manifest.package)};
const rootEntry = fileURLToPath(import.meta.resolve(expectedPackage));
const packageRoot = resolve(dirname(rootEntry), "..");
const installed = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
if (installed.name !== expectedPackage || installed.version !== expectedVersion) {
  throw new Error(\`Installed \${installed.name}@\${installed.version}; expected \${expectedPackage}@\${expectedVersion}\`);
}
for (const subpath of Object.keys(installed.exports)) {
  const specifier = subpath === "." ? expectedPackage : \`\${expectedPackage}\${subpath.slice(1)}\`;
  import.meta.resolve(specifier);
}
for (const specifier of [expectedPackage, \`\${expectedPackage}/schema\`, \`\${expectedPackage}/client\`, \`\${expectedPackage}/validation\`, \`\${expectedPackage}/sql\`]) {
  await import(specifier);
}
`
    );
    run(process.execPath, [probePath], { cwd: consumerRoot });
    const cliPath = join(
      consumerRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "viborm.cmd" : "viborm"
    );
    const help = run(cliPath, ["--help"], { cwd: consumerRoot });
    if (!help.includes("viborm")) {
      refuse("Installed VibORM CLI help did not identify the command");
    }
    return verified.manifest;
  } finally {
    rmSync(consumerRoot, { force: true, recursive: true });
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function usage() {
  return [
    "Usage:",
    "  node scripts/release.mjs contract --version <version> --ref <git-ref> --main-sha <sha>",
    "  node scripts/release.mjs artifact --version <version> --ref <git-ref> --main-sha <sha>",
    "  node scripts/release.mjs verify-artifact [--manifest <path>]",
    "  node scripts/release.mjs verify-artifact-consumer [--manifest <path>]",
    "  node scripts/release.mjs verify-registry [--manifest <path>] [--require-present] [--github-output <path>]",
    "  node scripts/release.mjs verify-consumer [--manifest <path>]",
  ].join("\n");
}

export async function runReleaseCli(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const allowedOptions = COMMAND_OPTIONS.get(command);
  if (allowedOptions === undefined) {
    refuse(`Unknown release command ${command}`);
  }
  const options = parseOptions(rest, allowedOptions);

  if (command === "contract") {
    const { release } = loadCliRelease(options);
    printJson(release);
    return;
  }
  if (command === "artifact") {
    const artifact = createArtifact(options);
    printJson({
      manifest: relative(REPOSITORY_ROOT, artifact.manifestPath),
      ...artifact.manifest,
    });
    return;
  }
  if (command === "verify-artifact") {
    const manifestPath = resolve(
      options.get("--manifest") ?? DEFAULT_MANIFEST_PATH
    );
    const verified = verifyArtifact(manifestPath);
    printJson({
      status: "verified",
      tarball: verified.manifest.tarball,
      version: verified.manifest.version,
    });
    return;
  }
  if (command === "verify-artifact-consumer") {
    const manifestPath = resolve(
      options.get("--manifest") ?? DEFAULT_MANIFEST_PATH
    );
    const manifest = verifyConsumer(manifestPath, "artifact");
    printJson({
      status: "verified",
      version: manifest.version,
    });
    return;
  }
  if (command === "verify-registry") {
    const manifestPath = resolve(
      options.get("--manifest") ?? DEFAULT_MANIFEST_PATH
    );
    const verified = verifyArtifact(manifestPath);
    const requirePresent = options.get("--require-present") === true;
    const registry = await queryRegistryStateWithRetry(
      verified.manifest.package,
      verified.manifest.version,
      verified.manifest.channel,
      requirePresent
    );
    const state = resolveRegistryState(verified.manifest, registry.integrity, {
      registryChannelVersion: registry.channelVersion,
      requirePresent,
    });
    if (registry.integrity !== undefined) {
      const attestationUrl = readRegistryAttestationUrl(
        registry.attestations,
        verified.manifest
      );
      const attestationResponse =
        await queryRegistryAttestationResponse(attestationUrl);
      verifyRegistryProvenance({
        attestationResponse,
        manifest: verified.manifest,
        registryAttestations: registry.attestations,
        repository: provenanceRepositoryUrl(verified.packageJson),
      });
    }
    const githubOutput = options.get("--github-output");
    if (githubOutput !== undefined) {
      writeGithubOutput(resolve(githubOutput), state, verified.manifest);
    }
    printJson({
      channel: verified.manifest.channel,
      publish: state.publish,
      status: state.status,
      tarball: verified.manifest.tarball,
      version: verified.manifest.version,
    });
    return;
  }
  if (command === "verify-consumer") {
    const manifestPath = resolve(
      options.get("--manifest") ?? DEFAULT_MANIFEST_PATH
    );
    const manifest = verifyConsumer(manifestPath, "registry");
    printJson({
      status: "verified",
      version: manifest.version,
    });
    return;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    await runReleaseCli(process.argv.slice(2));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown release failure";
    process.stderr.write(`release: ${message}\n`);
    process.exitCode = 1;
  }
}
