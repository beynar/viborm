/** Lossless values shared by recorded replays and benchmark report transport. */
import assert from "node:assert/strict";
import { isDate } from "node:util/types";

/** Tags wrap every array/record, so fixture-shaped arrays cannot impersonate values. */
export function encodeEvidenceValue(value) {
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    assert(
      Number.isFinite(value),
      "Evidence only admits finite fixture numbers"
    );
    return Object.is(value, -0) ? ["minus-zero"] : value;
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (isDate(value)) return ["date", Date.prototype.toISOString.call(value)];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      assert(Object.hasOwn(value, index), "Sparse evidence fixture array");
    }
    return ["array", value.map(encodeEvidenceValue)];
  }
  assert(typeof value === "object", "Unsupported evidence fixture value");
  const prototype = Object.getPrototypeOf(value);
  const constructor =
    prototype === null
      ? undefined
      : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  // Native rows and structuredClone can cross the test runner's realm boundary.
  assert(
    prototype === null ||
      (Object.getPrototypeOf(prototype) === null &&
        typeof constructor === "function" &&
        constructor.name === "Object"),
    "Unsupported evidence fixture prototype"
  );
  return [
    prototype === null ? "null-record" : "record",
    Object.entries(value).map(([key, child]) => [
      key,
      encodeEvidenceValue(child),
    ]),
  ];
}

export function decodeEvidenceValue(wire) {
  if (wire === null || typeof wire === "string" || typeof wire === "boolean")
    return wire;
  if (typeof wire === "number") {
    assert(Number.isFinite(wire), "Invalid evidence number");
    return wire;
  }
  assert(Array.isArray(wire), "Invalid evidence wire value");
  const tag = wire[0];
  const payload = wire[1];
  if (tag === "undefined" || tag === "minus-zero") {
    assert.equal(wire.length, 1);
    return tag === "undefined" ? undefined : -0;
  }
  assert.equal(wire.length, 2);
  if (tag === "date") {
    assert(typeof payload === "string", "Invalid evidence Date");
    const date = new Date(payload);
    assert.equal(date.toISOString(), payload, "Invalid evidence Date");
    return date;
  }
  if (tag === "bigint") {
    assert(
      typeof payload === "string" && /^-?(0|[1-9][0-9]*)$/.test(payload),
      "Invalid evidence bigint"
    );
    return BigInt(payload);
  }
  assert(Array.isArray(payload), "Invalid evidence container");
  if (tag === "array") return payload.map(decodeEvidenceValue);
  assert(
    tag === "record" || tag === "null-record",
    "Unknown evidence wire tag"
  );
  const keys = new Set();
  const record = Object.fromEntries(
    payload.map((entry) => {
      assert(
        Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === "string",
        "Invalid evidence record entry"
      );
      const key = entry[0];
      assert(!keys.has(key), "Duplicate evidence record key");
      keys.add(key);
      return [key, decodeEvidenceValue(entry[1])];
    })
  );
  if (tag === "null-record") Object.setPrototypeOf(record, null);
  return record;
}

export function serializeEvidenceReport(report) {
  return JSON.stringify({
    encoding: "viborm-evidence-v1",
    value: encodeEvidenceValue(report),
  });
}

export function parseEvidenceReport(serialized) {
  const envelope = JSON.parse(serialized);
  // Skips are control output, never a measured sample or an adoption report.
  if (envelope.status === "skipped") return envelope;
  assert.equal(
    envelope.encoding,
    "viborm-evidence-v1",
    "Unsupported evidence report encoding"
  );
  return decodeEvidenceValue(envelope.value);
}
