/**
 * Content-addressed identity for Migration V1.
 *
 * One hash owner: SHA-256 over a frozen ASCII domain label, 0x00, then the
 * exact bytes being authenticated. Filenames and stored hex digests are the
 * lowercase 64-hex form of that digest. There is no self-referential checksum
 * header and no second hasher.
 */

import { createHash } from "node:crypto";
import { MigrationError, VibORMErrorCode } from "../errors";

export type Sha256 = string;

export const HASH_ALGORITHM = "sha256";

export const HASH_DOMAIN = {
  estate: "viborm.migration.estate.v1",
  snapshot: "viborm.migration.snapshot.v1",
  sql: "viborm.migration.sql.v1",
  dispatch: "viborm.migration.dispatch.v1",
  transition: "viborm.migration.transition.v1",
  state: "viborm.migration.state.v1",
  path: "viborm.migration.path.v1",
  plan: "viborm.migration.plan.v1",
  resetPlan: "viborm.migration.reset-plan.v1",
  event: "viborm.migration.event.v1",
} as const;

export type HashDomain = (typeof HASH_DOMAIN)[keyof typeof HASH_DOMAIN];

const HEX64 = /^[0-9a-f]{64}$/;
const UTF8 = new TextEncoder();

export function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && HEX64.test(value);
}

export function parseSha256(value: unknown, label: string): Sha256 {
  if (!isSha256(value)) {
    throw new MigrationError(
      `${label} is not a lowercase 64-hex SHA-256 digest`,
      VibORMErrorCode.MIGRATION_INVALID_ESTATE
    );
  }
  return value;
}

export function sha256Hex(bytes: Uint8Array): Sha256 {
  return createHash("sha256").update(bytes).digest("hex");
}

export function domainHash(domain: HashDomain, bytes: Uint8Array): Sha256 {
  const prefix = UTF8.encode(domain);
  const input = new Uint8Array(prefix.length + 1 + bytes.length);
  input.set(prefix, 0);
  input[prefix.length] = 0;
  input.set(bytes, prefix.length + 1);
  return sha256Hex(input);
}

export function utf8Bytes(text: string): Uint8Array {
  return UTF8.encode(text);
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
