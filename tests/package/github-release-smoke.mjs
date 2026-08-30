import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GithubReleaseError,
  readGithubReleaseIntent,
  resolveGithubReleaseState,
  runGithubReleaseCli,
} from "../../scripts/github-release.mjs";
import { hashArtifactBytes } from "../../scripts/release.mjs";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const tarball = {
  integrity: "sha512-tarball",
  name: "viborm-1.0.0.tgz",
  sha256: "tarball-sha256",
};
const manifest = {
  integrity: "sha512-manifest",
  name: "viborm-release.json",
  sha256: "manifest-sha256",
};
const intent = {
  assets: [tarball, manifest],
  commit,
  latest: true,
  prerelease: false,
  tag: "v1.0.0",
  title: "VibORM 1.0.0",
  version: "1.0.0",
};

const fixtureRoot = mkdtempSync(join(tmpdir(), "viborm-github-release-"));
try {
  const fixtureTarball = Buffer.from("exact tarball bytes");
  const fixtureHashes = hashArtifactBytes(fixtureTarball);
  const fixtureManifest = {
    channel: "latest",
    commit,
    integrity: fixtureHashes.integrity,
    main: commit,
    package: "viborm",
    ref: "refs/heads/main",
    schemaVersion: 1,
    sha256: fixtureHashes.sha256,
    tarball: "viborm-1.0.0.tgz",
    version: "1.0.0",
  };
  const fixtureManifestPath = join(fixtureRoot, "viborm-release.json");
  writeFileSync(join(fixtureRoot, fixtureManifest.tarball), fixtureTarball);
  writeFileSync(
    fixtureManifestPath,
    `${JSON.stringify(fixtureManifest, null, 2)}\n`
  );
  const fixtureIntent = readGithubReleaseIntent(fixtureManifestPath);
  if (
    fixtureIntent.commit !== commit ||
    fixtureIntent.assets.map((entry) => entry.name).join(",") !==
      "viborm-1.0.0.tgz,viborm-release.json"
  ) {
    throw new Error("Exact local release assets did not produce the intent");
  }
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}

function release(overrides = {}) {
  return {
    draft: true,
    id: 42,
    immutable: false,
    name: intent.title,
    prerelease: false,
    tag_name: intent.tag,
    ...overrides,
  };
}

function asset(expected, overrides = {}) {
  return {
    integrity: expected.integrity,
    name: expected.name,
    sha256: expected.sha256,
    state: "uploaded",
    ...overrides,
  };
}

function observed(overrides = {}) {
  return {
    assets: [],
    release: undefined,
    tagCommit: commit,
    ...overrides,
  };
}

function expectRefusal(name, action, text) {
  try {
    action();
  } catch (error) {
    if (!(error instanceof GithubReleaseError)) {
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

const absent = resolveGithubReleaseState(intent, observed());
if (absent.action !== "create-draft") {
  throw new Error("An absent GitHub release did not request draft creation");
}

const partialDraft = resolveGithubReleaseState(
  intent,
  observed({
    assets: [asset(tarball)],
    release: release(),
  })
);
if (
  partialDraft.action !== "complete-draft" ||
  partialDraft.missingAssets.join(",") !== manifest.name
) {
  throw new Error("A partial draft did not resume at its missing asset");
}

const completeDraft = resolveGithubReleaseState(
  intent,
  observed({
    assets: [asset(tarball), asset(manifest)],
    release: release(),
  })
);
if (
  completeDraft.action !== "complete-draft" ||
  completeDraft.missingAssets.length !== 0
) {
  throw new Error("A complete draft was not ready for publication");
}

const published = resolveGithubReleaseState(
  intent,
  observed({
    assets: [asset(tarball), asset(manifest)],
    latestReleaseId: 42,
    release: release({ draft: false, immutable: true }),
  })
);
if (published.action !== "verified") {
  throw new Error("An exact published GitHub release was not idempotent");
}

const prereleaseIntent = {
  ...intent,
  latest: false,
  prerelease: true,
  tag: "v1.0.0-rc.1",
  title: "VibORM 1.0.0-rc.1",
  version: "1.0.0-rc.1",
};
const publishedPrerelease = resolveGithubReleaseState(
  prereleaseIntent,
  observed({
    assets: [asset(tarball), asset(manifest)],
    release: release({
      draft: false,
      immutable: true,
      name: prereleaseIntent.title,
      prerelease: true,
      tag_name: prereleaseIntent.tag,
    }),
  })
);
if (publishedPrerelease.action !== "verified") {
  throw new Error("An exact published prerelease was not idempotent");
}

expectRefusal(
  "wrong tag commit",
  () => resolveGithubReleaseState(intent, observed({ tagCommit: otherCommit })),
  "resolves to"
);
expectRefusal(
  "wrong release tag",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({ release: release({ tag_name: "v1.0.1" }) })
    ),
  "does not match"
);
expectRefusal(
  "wrong release title",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({ release: release({ name: "VibORM" }) })
    ),
  "title"
);
expectRefusal(
  "wrong release channel",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({ release: release({ prerelease: true }) })
    ),
  "prerelease state"
);
expectRefusal(
  "altered release asset",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({
        assets: [asset(tarball, { sha256: "different" })],
        release: release(),
      })
    ),
  "different SHA-256"
);
expectRefusal(
  "altered release asset integrity",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({
        assets: [asset(tarball, { integrity: "sha512-different" })],
        release: release(),
      })
    ),
  "different npm integrity"
);
expectRefusal(
  "unexpected release asset",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({
        assets: [
          asset(tarball),
          asset(manifest),
          asset({
            integrity: "sha512-notes",
            name: "notes.txt",
            sha256: "notes-sha256",
          }),
        ],
        release: release(),
      })
    ),
  "unexpected asset"
);
expectRefusal(
  "published release missing an asset",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({
        assets: [asset(tarball)],
        latestReleaseId: 42,
        release: release({ draft: false, immutable: true }),
      })
    ),
  "missing asset"
);
expectRefusal(
  "published mutable release",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({
        assets: [asset(tarball), asset(manifest)],
        latestReleaseId: 42,
        release: release({ draft: false }),
      })
    ),
  "is not immutable"
);
expectRefusal(
  "stable release not latest",
  () =>
    resolveGithubReleaseState(
      intent,
      observed({
        assets: [asset(tarball), asset(manifest)],
        latestReleaseId: 41,
        release: release({ draft: false, immutable: true }),
      })
    ),
  "not the repository latest"
);
expectRefusal(
  "misspelled option",
  () => runGithubReleaseCli(["publish", "--manfiest", "release.json"]),
  "Unexpected GitHub release option"
);
expectRefusal(
  "duplicate option",
  () =>
    runGithubReleaseCli([
      "publish",
      "--manifest",
      "first.json",
      "--manifest",
      "second.json",
    ]),
  "supplied more than once"
);

console.log("GitHub release protocol: pass");
