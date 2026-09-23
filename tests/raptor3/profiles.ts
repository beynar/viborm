/** SQLite models of transport capabilities, not evidence for hosted providers. */
export const G0_PROFILES = [
  "sqlite-interactive",
  "sqlite-atomic-batch",
] as const;
export type ProfileId = (typeof G0_PROFILES)[number];

/** Lane A protocol fixtures, not named database or hosted-provider conformance. */
export const TRANSPORT_PROFILES = [
  "scripted-returning-weak",
  "scripted-returning-ack",
] as const;
export type TransportProfileId = (typeof TRANSPORT_PROFILES)[number];

export const PROFILE_CONTRACTS = {
  "sqlite-interactive": {
    provider: "better-sqlite3",
    transactions: true,
    nativeBatch: false,
    resultOwnership: "borrowed",
    claim:
      "Real SQLite with interactive transactions and controlled completions",
  },
  "sqlite-atomic-batch": {
    provider: "better-sqlite3",
    transactions: false,
    nativeBatch: true,
    resultOwnership: "borrowed",
    claim: "Real SQLite atomic submissions; restricted transport model, not D1",
  },
} as const;

export const PROVIDER_LANES = [
  {
    gate: "G1",
    provider: "PostgreSQL",
    evidence:
      "Existing PGlite contracts; actual PostgreSQL connections for concurrent races",
  },
  {
    gate: "G2",
    provider: "MySQL",
    evidence: "Existing mysql2 live-provider contracts; no SQLite substitution",
  },
  {
    gate: "G3",
    provider: "Batch/progressive transports",
    evidence:
      "Actual supported provider contracts plus labeled SQLite transport models",
  },
  {
    gate: "G4",
    provider: "Every release-required driver",
    evidence:
      "Existing support classification; missing required provider evidence blocks cutover",
  },
] as const;
