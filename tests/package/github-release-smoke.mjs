import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

const cliFixtureRoot = mkdtempSync(
  join(tmpdir(), "viborm-github-release-cli-")
);
try {
  const cliTarball = Buffer.from("authoritative release bytes");
  const cliHashes = hashArtifactBytes(cliTarball);
  const cliManifest = {
    channel: "latest",
    commit,
    integrity: cliHashes.integrity,
    main: commit,
    package: "viborm",
    ref: "refs/heads/main",
    schemaVersion: 1,
    sha256: cliHashes.sha256,
    tarball: "viborm-1.0.0.tgz",
    version: "1.0.0",
  };
  const cliManifestPath = join(cliFixtureRoot, "viborm-release.json");
  const fakeBinPath = join(cliFixtureRoot, "bin");
  const fakeGhPath = join(fakeBinPath, "gh");
  const fakeStatePath = join(cliFixtureRoot, "github-state.json");
  mkdirSync(fakeBinPath);
  writeFileSync(join(cliFixtureRoot, cliManifest.tarball), cliTarball);
  writeFileSync(cliManifestPath, `${JSON.stringify(cliManifest, null, 2)}\n`);
  writeFileSync(
    fakeStatePath,
    `${JSON.stringify({ calls: [], listingVisible: false, release: undefined })}\n`
  );
  writeFileSync(
    fakeGhPath,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const endpoint = args.find(
  (argument) => argument.startsWith("repos/") || argument.startsWith("https://")
);
const statePath = process.env.FAKE_GITHUB_STATE;
const commit = process.env.FAKE_GITHUB_COMMIT;
const state = JSON.parse(readFileSync(statePath, "utf8"));
state.calls.push({ endpoint, method });

function save() {
  writeFileSync(statePath, JSON.stringify(state));
}

function json(value) {
  save();
  process.stdout.write(JSON.stringify(value));
}

function body() {
  return JSON.parse(readFileSync(0, "utf8"));
}

if (method === "GET" && endpoint.includes("/commits/")) {
  json({ sha: commit });
} else if (method === "GET" && endpoint.includes("/releases?")) {
  json([state.listingVisible ? [state.release] : []]);
} else if (method === "POST" && endpoint.endsWith("/releases")) {
  const input = body();
  state.release = {
    assets: [],
    draft: input.draft,
    id: 42,
    immutable: false,
    name: input.name,
    prerelease: input.prerelease,
    tag_name: process.env.FAKE_GITHUB_CREATE_TAG ?? input.tag_name,
  };
  json(state.release);
} else if (method === "GET" && endpoint.endsWith("/releases/42")) {
  json(state.release);
} else if (method === "POST" && endpoint.startsWith("https://uploads.github.com/")) {
  const inputPath = args[args.indexOf("--input") + 1];
  const name = new URL(endpoint).searchParams.get("name");
  const id = state.release.assets.length + 100;
  const assetPath = statePath + ".asset-" + id;
  writeFileSync(assetPath, readFileSync(inputPath));
  state.release.assets.push({ id, name, path: assetPath, state: "uploaded" });
  json(state.release.assets.at(-1));
} else if (method === "GET" && endpoint.includes("/releases/assets/")) {
  const id = Number(endpoint.split("/").at(-1));
  const asset = state.release.assets.find((candidate) => candidate.id === id);
  save();
  process.stdout.write(readFileSync(asset.path));
} else if (method === "PATCH" && endpoint.endsWith("/releases/42")) {
  const input = body();
  state.release = {
    ...state.release,
    draft: input.draft,
    immutable: true,
    name: input.name,
    prerelease: input.prerelease,
    tag_name: input.tag_name,
  };
  json(state.release);
} else if (method === "GET" && endpoint.endsWith("/releases/latest")) {
  json(state.release);
} else {
  save();
  process.stderr.write("Unexpected fake gh call: " + method + " " + endpoint + "\\n");
  process.exitCode = 1;
}
`
  );
  chmodSync(fakeGhPath, 0o755);

  function runCli(extraEnvironment = {}) {
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../scripts/github-release.mjs", import.meta.url)
        ),
        "publish",
        "--manifest",
        cliManifestPath,
        "--repository",
        "example/viborm",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...extraEnvironment,
          FAKE_GITHUB_COMMIT: commit,
          FAKE_GITHUB_STATE: fakeStatePath,
          PATH: `${fakeBinPath}:${process.env.PATH}`,
        },
      }
    );
  }

  const cliExecution = runCli();
  if (cliExecution.status !== 0) {
    throw new Error(
      `CLI did not trust the authoritative mutation responses:\n${cliExecution.stderr}`
    );
  }
  const fakeState = JSON.parse(readFileSync(fakeStatePath, "utf8"));
  const listingCalls = fakeState.calls.filter((call) =>
    call.endpoint.includes("/releases?")
  );
  const directReleaseCalls = fakeState.calls.filter(
    (call) => call.method === "GET" && call.endpoint.endsWith("/releases/42")
  );
  if (listingCalls.length !== 1 || directReleaseCalls.length !== 1) {
    throw new Error(
      "CLI did not limit discovery to one listing and reobserve the known release by id"
    );
  }

  const uploadedTarballPath = `${fakeStatePath}.resume-tarball`;
  writeFileSync(uploadedTarballPath, cliTarball);
  writeFileSync(
    fakeStatePath,
    JSON.stringify({
      calls: [],
      listingVisible: true,
      release: {
        assets: [
          {
            id: 100,
            name: cliManifest.tarball,
            path: uploadedTarballPath,
            state: "uploaded",
          },
        ],
        draft: true,
        id: 42,
        immutable: false,
        name: "VibORM 1.0.0",
        prerelease: false,
        tag_name: "v1.0.0",
      },
    })
  );
  const resumedExecution = runCli();
  if (resumedExecution.status !== 0) {
    throw new Error(
      `CLI did not resume the listed partial draft:\n${resumedExecution.stderr}`
    );
  }
  const resumedState = JSON.parse(readFileSync(fakeStatePath, "utf8"));
  if (
    resumedState.calls.some(
      (call) => call.method === "POST" && call.endpoint.endsWith("/releases")
    )
  ) {
    throw new Error("CLI recreated a draft instead of resuming it");
  }

  writeFileSync(
    fakeStatePath,
    JSON.stringify({ calls: [], listingVisible: false, release: undefined })
  );
  const mismatchedExecution = runCli({
    FAKE_GITHUB_CREATE_TAG: "v1.0.1",
  });
  if (
    mismatchedExecution.status === 0 ||
    !mismatchedExecution.stderr.includes("does not match")
  ) {
    throw new Error("CLI accepted a mismatched create response");
  }
  const mismatchedState = JSON.parse(readFileSync(fakeStatePath, "utf8"));
  if (
    mismatchedState.calls.some(
      (call) =>
        call.method === "PATCH" ||
        call.endpoint.startsWith("https://uploads.github.com/")
    )
  ) {
    throw new Error("CLI mutated a release after a mismatched create response");
  }
} finally {
  rmSync(cliFixtureRoot, { force: true, recursive: true });
}

console.log("GitHub release protocol: pass");
