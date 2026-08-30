import {
  auditPackedPackage,
  compareReleaseVersions,
  hashArtifactBytes,
  parseReleaseVersion,
  ReleaseContractError,
  resolveRegistryState,
  runReleaseCli,
  validateReleaseContract,
  verifyArtifactIntegrity,
  verifyNpmSignatureAuditReport,
  verifyRegistryProvenance,
} from "../../scripts/release.mjs";

const fortyAs = "a".repeat(40);
const fortyBs = "b".repeat(40);

const contract = {
  artifact: {
    allowedDistSuffixes: [".d.mts", ".mjs", ".mjs.map"],
    allowedRootFiles: ["LICENSE", "README.md", "package.json"],
    forbiddenPrefixes: ["dist/internal/", "src/"],
    maximumCompressedBytes: 1000,
    maximumFileCount: 10,
    maximumUnpackedBytes: 2000,
    requiredFiles: ["LICENSE", "README.md", "package.json"],
  },
  package: {
    bin: "dist/cli.mjs",
    bugs: "https://github.com/beynar/viborm/issues",
    homepage: "https://viborm.dev",
    name: "viborm",
    license: "MIT",
    node: ">=22",
    packageManager: "pnpm@10.11.0",
    publishAccess: "public",
    repository: "git+https://github.com/beynar/viborm.git",
  },
  schemaVersion: 1,
};

function packageJson(version = "1.0.0") {
  return {
    bin: { viborm: "dist/cli.mjs" },
    bugs: "https://github.com/beynar/viborm/issues",
    engines: { node: ">=22" },
    exports: {
      ".": {
        import: "./dist/index.mjs",
        types: "./dist/index.d.mts",
      },
    },
    homepage: "https://viborm.dev",
    name: "viborm",
    license: "MIT",
    packageManager: "pnpm@10.11.0",
    publishConfig: { access: "public" },
    repository: "git+https://github.com/beynar/viborm.git",
    version,
  };
}

function files(extra = []) {
  return [
    { path: "LICENSE", size: 1 },
    { path: "README.md", size: 1 },
    { path: "dist/index.d.mts", size: 1 },
    { path: "dist/index.mjs", size: 1 },
    { path: "package.json", size: 1 },
    ...extra,
  ];
}

function expectRefusal(name, action, text) {
  try {
    action();
  } catch (error) {
    if (!(error instanceof ReleaseContractError)) {
      throw error;
    }
    if (!error.message.includes(text)) {
      throw new Error(
        `${name} refused with ${JSON.stringify(error.message)}, expected ${JSON.stringify(text)}`
      );
    }
    return;
  }
  throw new Error(`${name} was accepted`);
}

async function expectAsyncRefusal(name, action, text) {
  try {
    await action();
  } catch (error) {
    if (!(error instanceof ReleaseContractError)) {
      throw error;
    }
    if (!error.message.includes(text)) {
      throw new Error(
        `${name} refused with ${JSON.stringify(error.message)}, expected ${JSON.stringify(text)}`
      );
    }
    return;
  }
  throw new Error(`${name} was accepted`);
}

const stable = parseReleaseVersion("1.2.3");
if (stable.channel !== "latest") {
  throw new Error("Stable release did not select latest");
}
const candidate = parseReleaseVersion("1.2.3-rc.4");
if (candidate.channel !== "next") {
  throw new Error("Release candidate did not select next");
}
expectRefusal(
  "beta channel",
  () => parseReleaseVersion("1.2.3-beta.1"),
  "rc.N"
);
if (
  compareReleaseVersions("1.0.0-rc.2", "1.0.0-rc.1") <= 0 ||
  compareReleaseVersions("1.0.0", "1.0.0-rc.9") <= 0 ||
  compareReleaseVersions("1.1.0", "1.0.9") <= 0
) {
  throw new Error("Release version ordering is incorrect");
}
expectRefusal("zero rc", () => parseReleaseVersion("1.2.3-rc.0"), "start at 1");

validateReleaseContract({
  commitSha: fortyAs,
  contract,
  mainSha: fortyAs,
  packageJson: packageJson(),
  ref: "refs/heads/main",
  requestedVersion: "1.0.0",
});
expectRefusal(
  "npm-normalized CLI path",
  () =>
    validateReleaseContract({
      commitSha: fortyAs,
      contract,
      mainSha: fortyAs,
      packageJson: {
        ...packageJson(),
        bin: { viborm: "./dist/cli.mjs" },
      },
      ref: "refs/heads/main",
      requestedVersion: "1.0.0",
    }),
  "Package CLI must map"
);
expectRefusal(
  "requested version mismatch",
  () =>
    validateReleaseContract({
      commitSha: fortyAs,
      contract,
      mainSha: fortyAs,
      packageJson: packageJson(),
      ref: "refs/heads/main",
      requestedVersion: "1.0.1",
    }),
  "does not match package.json"
);
expectRefusal(
  "tag authority",
  () =>
    validateReleaseContract({
      commitSha: fortyAs,
      contract,
      mainSha: fortyBs,
      packageJson: packageJson(),
      ref: "refs/tags/v1.0.1",
      requestedVersion: "1.0.0",
    }),
  "refs/heads/main"
);

auditPackedPackage(
  {
    files: files(),
    size: 100,
    unpackedSize: 200,
  },
  packageJson(),
  contract
);
expectRefusal(
  "forbidden packed file",
  () =>
    auditPackedPackage(
      {
        files: files([{ path: "dist/internal/probe.mjs", size: 1 }]),
        size: 100,
        unpackedSize: 200,
      },
      packageJson(),
      contract
    ),
  "forbidden path"
);
expectRefusal(
  "compressed size budget",
  () =>
    auditPackedPackage(
      { files: files(), size: 1001, unpackedSize: 200 },
      packageJson(),
      contract
    ),
  "budget is 1000"
);

const artifact = Buffer.from("exact release bytes");
const hashes = hashArtifactBytes(artifact);
verifyArtifactIntegrity(artifact, hashes);
expectRefusal(
  "altered release bytes",
  () => verifyArtifactIntegrity(Buffer.from("different bytes"), hashes),
  "SHA-256"
);
expectRefusal(
  "altered npm integrity",
  () =>
    verifyArtifactIntegrity(artifact, {
      integrity: "sha512-different",
      sha256: hashes.sha256,
    }),
  "npm integrity"
);

const manifest = {
  channel: "latest",
  commit: fortyAs,
  integrity: hashes.integrity,
  package: "viborm",
  ref: "refs/heads/main",
  version: "1.0.0",
};

const provenancePredicateType = "https://slsa.dev/provenance/v1";
const provenanceUrl =
  "https://registry.npmjs.org/-/npm/v1/attestations/viborm@1.0.0";
const repository = "https://github.com/beynar/viborm";
const workflowPath = ".github/workflows/release.yml";
const subjectDigest = Buffer.from(
  hashes.integrity.slice("sha512-".length),
  "base64"
).toString("hex");
const registryAttestations = {
  provenance: { predicateType: provenancePredicateType },
  url: provenanceUrl,
};

function provenanceStatement({
  commit = fortyAs,
  digest = subjectDigest,
  path = workflowPath,
  sourceRepository = repository,
} = {}) {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        buildType:
          "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            path,
            ref: "refs/heads/main",
            repository: sourceRepository,
          },
        },
        internalParameters: {
          github: { event_name: "workflow_dispatch" },
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: commit },
            uri: `git+${repository}@refs/heads/main`,
          },
        ],
      },
      runDetails: {
        builder: {
          id: "https://github.com/actions/runner/github-hosted",
        },
        metadata: {
          invocationId: `${repository}/actions/runs/123/attempts/1`,
        },
      },
    },
    predicateType: provenancePredicateType,
    subject: [
      {
        digest: { sha512: digest },
        name: "pkg:npm/viborm@1.0.0",
      },
    ],
  };
}

function provenanceResponse(statement = provenanceStatement()) {
  return {
    attestations: [
      {
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            payloadType: "application/vnd.in-toto+json",
            signatures: [{ sig: "signed" }],
          },
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          verificationMaterial: {
            certificate: { rawBytes: "certificate" },
            tlogEntries: [{}],
          },
        },
        predicateType: provenancePredicateType,
      },
    ],
  };
}

verifyRegistryProvenance({
  attestationResponse: provenanceResponse(),
  manifest,
  registryAttestations,
  repository,
});
verifyNpmSignatureAuditReport({ invalid: [], missing: [] });
expectRefusal(
  "invalid npm signature",
  () =>
    verifyNpmSignatureAuditReport({
      invalid: [{ name: "viborm", version: "1.0.0" }],
      missing: [],
    }),
  "invalid package signature"
);
expectRefusal(
  "missing npm signature",
  () =>
    verifyNpmSignatureAuditReport({
      invalid: [],
      missing: [{ name: "viborm", version: "1.0.0" }],
    }),
  "without a verifiable signature"
);
expectRefusal(
  "malformed npm signature audit",
  () => verifyNpmSignatureAuditReport({ invalid: [] }),
  "invalid and missing arrays"
);
expectRefusal(
  "missing registry provenance",
  () =>
    verifyRegistryProvenance({
      attestationResponse: provenanceResponse(),
      manifest,
      registryAttestations: undefined,
      repository,
    }),
  "dist.attestations"
);
expectRefusal(
  "wrong registry provenance predicate",
  () =>
    verifyRegistryProvenance({
      attestationResponse: provenanceResponse(),
      manifest,
      registryAttestations: {
        ...registryAttestations,
        provenance: { predicateType: "https://slsa.dev/provenance/v0.2" },
      },
      repository,
    }),
  "SLSA v1"
);
expectRefusal(
  "redirected registry provenance",
  () =>
    verifyRegistryProvenance({
      attestationResponse: provenanceResponse(),
      manifest,
      registryAttestations: {
        ...registryAttestations,
        url: "https://attacker.invalid/viborm@1.0.0",
      },
      repository,
    }),
  "canonical npm registry URL"
);
expectRefusal(
  "missing SLSA bundle",
  () =>
    verifyRegistryProvenance({
      attestationResponse: { attestations: [] },
      manifest,
      registryAttestations,
      repository,
    }),
  "exactly one SLSA v1"
);
expectRefusal(
  "wrong provenance repository",
  () =>
    verifyRegistryProvenance({
      attestationResponse: provenanceResponse(
        provenanceStatement({
          sourceRepository: "https://github.com/attacker/viborm",
        })
      ),
      manifest,
      registryAttestations,
      repository,
    }),
  "repository"
);
expectRefusal(
  "wrong provenance workflow",
  () =>
    verifyRegistryProvenance({
      attestationResponse: provenanceResponse(
        provenanceStatement({ path: ".github/workflows/attacker.yml" })
      ),
      manifest,
      registryAttestations,
      repository,
    }),
  "workflow path"
);
expectRefusal(
  "wrong provenance commit",
  () =>
    verifyRegistryProvenance({
      attestationResponse: provenanceResponse(
        provenanceStatement({ commit: fortyBs })
      ),
      manifest,
      registryAttestations,
      repository,
    }),
  "commit"
);
expectRefusal(
  "wrong provenance subject",
  () =>
    verifyRegistryProvenance({
      attestationResponse: provenanceResponse(
        provenanceStatement({ digest: "0".repeat(128) })
      ),
      manifest,
      registryAttestations,
      repository,
    }),
  "tarball digest"
);
const absent = resolveRegistryState(manifest, undefined);
if (!absent.publish || absent.status !== "publish-required") {
  throw new Error("Absent registry version did not request publication");
}
expectRefusal(
  "older queued release",
  () =>
    resolveRegistryState(manifest, undefined, {
      registryChannelVersion: "1.1.0",
    }),
  "move dist-tag latest backward"
);
const existing = resolveRegistryState(manifest, hashes.integrity, {
  registryChannelVersion: "1.0.0",
});
if (existing.publish || existing.status !== "already-published") {
  throw new Error("Identical registry version was not accepted idempotently");
}
expectRefusal(
  "different registry artifact",
  () =>
    resolveRegistryState(manifest, "sha512-different", {
      registryChannelVersion: "1.0.0",
    }),
  "different integrity"
);
expectRefusal(
  "wrong registry dist-tag",
  () =>
    resolveRegistryState(manifest, hashes.integrity, {
      registryChannelVersion: "0.1.0",
    }),
  "dist-tag latest"
);
expectRefusal(
  "missing post-publish artifact",
  () => resolveRegistryState(manifest, undefined, { requirePresent: true }),
  "after publication"
);

await expectAsyncRefusal(
  "misspelled manifest option",
  () => runReleaseCli(["verify-artifact", "--manfiest", "release.json"]),
  "Unexpected release option --manfiest"
);
await expectAsyncRefusal(
  "redirected artifact output",
  () => runReleaseCli(["artifact", "--output-dir", "src"]),
  "Unexpected release option --output-dir"
);
await expectAsyncRefusal(
  "duplicate release option",
  () =>
    runReleaseCli([
      "verify-artifact",
      "--manifest",
      "first.json",
      "--manifest",
      "second.json",
    ]),
  "was supplied more than once"
);

console.log("release artifact contract: pass");
