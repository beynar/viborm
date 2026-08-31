/**
 * One hostile-input boundary for generation options and manual definitions.
 * It settles every caller-owned accessor before estate or provider access.
 */

import { Sql } from "@sql";
import { errorCause } from "../drivers/shared/driver-options";
import { MigrationError, VibORMErrorCode } from "../errors";
import { snapshotExactArray, snapshotExactRecord } from "./input-boundary";
import type { ResolveCallback } from "./types";
import type {
  GenerateV1Options,
  ManualMigrationInput,
  ManualTransitionInput,
  MigrationCheckInput,
} from "./v1-types";

export function normalizeGenerateOptions(options: unknown): GenerateV1Options {
  const record = snapshotExactRecord(
    options,
    ["name", "from", "dryRun", "resolve", "skipValidation", "manualMigration"],
    "generate options",
    refuseGenerateOptions
  );
  const { name, from, dryRun, resolve, skipValidation, manualMigration } =
    record;
  if (name !== undefined && typeof name !== "string") {
    return refuseGenerateOptions("generate name must be a string");
  }
  if (from !== undefined && from !== null && typeof from !== "string") {
    return refuseGenerateOptions("generate from must be a state id or null");
  }
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    return refuseGenerateOptions("generate dryRun must be a boolean");
  }
  if (skipValidation !== undefined && typeof skipValidation !== "boolean") {
    return refuseGenerateOptions("generate skipValidation must be a boolean");
  }
  if (resolve !== undefined && !isResolveCallback(resolve)) {
    return refuseGenerateOptions("generate resolve must be a function");
  }
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    ...(from === undefined ? {} : { from }),
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(resolve === undefined ? {} : { resolve }),
    ...(skipValidation === undefined ? {} : { skipValidation }),
    ...(manualMigration === undefined
      ? {}
      : { manualMigration: snapshotManualMigration(manualMigration) }),
  });
}

function snapshotManualMigration(value: unknown): ManualMigrationInput {
  const record = snapshotExactRecord(
    value,
    ["transitions", "destinationChecks"],
    "manual migration",
    refuseManualDefinition
  );
  const transitions = snapshotExactArray(
    record.transitions,
    "manual migration transitions",
    refuseManualDefinition
  ).map((transition, index) =>
    snapshotManualTransition(transition, `manual transition ${index}`)
  );
  if (transitions.length === 0) {
    return refuseManualDefinition(
      "A manual migration must define at least one parent transition"
    );
  }
  const destinationChecks =
    record.destinationChecks === undefined
      ? undefined
      : snapshotExactArray(
          record.destinationChecks,
          "manual destination checks",
          refuseManualDefinition
        ).map((check, index) =>
          snapshotManualCheck(check, `manual destination check ${index}`)
        );
  return Object.freeze({
    transitions: Object.freeze(transitions),
    ...(destinationChecks === undefined
      ? {}
      : { destinationChecks: Object.freeze(destinationChecks) }),
  });
}

function snapshotManualTransition(
  value: unknown,
  label: string
): ManualTransitionInput {
  const record = snapshotExactRecord(
    value,
    ["from", "execution", "up", "originChecks", "rollback"],
    label,
    refuseManualDefinition
  );
  const { from, execution } = record;
  if (from !== null && typeof from !== "string") {
    return refuseManualDefinition(`${label}.from must be a state id or null`);
  }
  if (execution !== "transactional" && execution !== "stepwise") {
    return refuseManualDefinition(
      `${label}.execution must be transactional or stepwise`
    );
  }
  const up = snapshotSqlArray(record.up, `${label}.up`);
  const originChecks =
    record.originChecks === undefined
      ? undefined
      : snapshotExactArray(
          record.originChecks,
          `${label}.originChecks`,
          refuseManualDefinition
        ).map((check, index) =>
          snapshotManualCheck(check, `${label}.originChecks[${index}]`)
        );
  return Object.freeze({
    from,
    execution,
    up,
    ...(originChecks === undefined
      ? {}
      : { originChecks: Object.freeze(originChecks) }),
    rollback: snapshotManualRollback(record.rollback, `${label}.rollback`),
  });
}

function snapshotManualRollback(
  value: unknown,
  label: string
): ManualTransitionInput["rollback"] {
  const discriminant = snapshotExactRecord(
    value,
    ["kind", "execution", "sql", "reason"],
    label,
    refuseManualDefinition
  );
  if (discriminant.kind === "irreversible") {
    if (
      discriminant.execution !== undefined ||
      discriminant.sql !== undefined ||
      typeof discriminant.reason !== "string"
    ) {
      return refuseManualDefinition(
        `${label} has an invalid irreversible shape`
      );
    }
    return Object.freeze({
      kind: "irreversible",
      reason: discriminant.reason,
    });
  }
  if (discriminant.kind !== "manual") {
    return refuseManualDefinition(`${label}.kind is invalid`);
  }
  if (
    discriminant.reason !== undefined ||
    (discriminant.execution !== "transactional" &&
      discriminant.execution !== "stepwise")
  ) {
    return refuseManualDefinition(`${label} has an invalid manual shape`);
  }
  return Object.freeze({
    kind: "manual",
    execution: discriminant.execution,
    sql: snapshotSqlArray(discriminant.sql, `${label}.sql`),
  });
}

function snapshotManualCheck(
  value: unknown,
  label: string
): MigrationCheckInput {
  const record = snapshotExactRecord(
    value,
    ["kind", "query", "equals"],
    label,
    refuseManualDefinition
  );
  if (record.kind !== "trusted-read" || typeof record.equals !== "boolean") {
    return refuseManualDefinition(`${label} has an invalid check shape`);
  }
  return Object.freeze({
    kind: "trusted-read",
    query: snapshotSql(record.query, `${label}.query`),
    equals: record.equals,
  });
}

function snapshotSqlArray(value: unknown, label: string): readonly Sql[] {
  const entries = snapshotExactArray(value, label, refuseManualDefinition);
  const sql: Sql[] = [];
  for (let index = 0; index < entries.length; index++) {
    sql.push(snapshotSql(entries[index], `${label}[${index}]`));
  }
  return Object.freeze(sql);
}

function snapshotSql(value: unknown, label: string): Sql {
  try {
    if (!(value instanceof Sql)) {
      return refuseManualDefinition(`${label} must be a Sql value`);
    }
    const rawStrings: unknown = Reflect.get(value, "strings");
    const rawValues: unknown = Reflect.get(value, "values");
    if (!(Array.isArray(rawStrings) && Array.isArray(rawValues))) {
      return refuseManualDefinition(
        `${label}.strings and ${label}.values must be arrays`
      );
    }
    const strings = Array.from(rawStrings);
    const values = Array.from(rawValues);
    if (!strings.every((entry) => typeof entry === "string")) {
      return refuseManualDefinition(`${label}.strings must contain strings`);
    }
    if (strings.length !== values.length + 1) {
      return refuseManualDefinition(
        `${label} has an invalid strings and values shape`
      );
    }
    return new Sql(Object.freeze(strings), Object.freeze(values));
  } catch (failure) {
    return refuseManualDefinition(
      `${label} could not be read`,
      errorCause(failure)
    );
  }
}

function isResolveCallback(value: unknown): value is ResolveCallback {
  return typeof value === "function";
}

function refuseGenerateOptions(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.INVALID_INPUT, { cause });
}

function refuseManualDefinition(message: string, cause?: Error): never {
  throw new MigrationError(message, VibORMErrorCode.MIGRATION_INVALID_ESTATE, {
    cause,
  });
}
