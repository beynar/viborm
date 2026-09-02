import type { Operation } from "../types";
import { QueryEngineError } from "../types";

const HEX_BYTES_REGEX = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64_REGEX =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const BASE64_PROVIDER_REGEX = /^base64:type\d+:(.*)$/;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function unsupportedBlobValue(
  provider: string,
  operation: Operation,
  representation: string
): never {
  throw new QueryEngineError(
    `Driver "${provider}" returned an unsupported ${representation} blob representation.`,
    {
      meta: {
        driver: provider,
        operation,
        scalarType: "blob",
        representation,
      },
    }
  );
}

function hexToUint8Array(
  hex: string,
  provider: string,
  operation: Operation
): Uint8Array {
  if (!HEX_BYTES_REGEX.test(hex)) {
    return unsupportedBlobValue(provider, operation, "hex string");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToUint8Array(
  base64: string,
  provider: string,
  operation: Operation
): Uint8Array {
  if (!BASE64_REGEX.test(base64)) {
    return unsupportedBlobValue(provider, operation, "base64 string");
  }
  if (base64.length === 0) {
    return new Uint8Array();
  }

  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((base64.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < base64.length; index += 4) {
    const first = BASE64_ALPHABET.indexOf(base64.charAt(index));
    const second = BASE64_ALPHABET.indexOf(base64.charAt(index + 1));
    const thirdChar = base64.charAt(index + 2);
    const fourthChar = base64.charAt(index + 3);
    const third = thirdChar === "=" ? 0 : BASE64_ALPHABET.indexOf(thirdChar);
    const fourth = fourthChar === "=" ? 0 : BASE64_ALPHABET.indexOf(fourthChar);

    out[offset] = first * 4 + Math.floor(second / 16);
    offset += 1;
    if (thirdChar !== "=") {
      out[offset] = (second % 16) * 16 + Math.floor(third / 4);
      offset += 1;
    }
    if (fourthChar !== "=") {
      out[offset] = (third % 4) * 64 + fourth;
      offset += 1;
    }
  }
  return out;
}

/**
 * Normalize every driver's binary representation to a plain Uint8Array —
 * the one public blob type. Strings are hex ("\x..." from PG JSON,
 * "base64:typeNNN:..." from MySQL JSON, plain hex from our blobToHex cast).
 */
export function parseBlobValue(
  value: unknown,
  provider: string,
  operation: Operation
): Uint8Array {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    );
    return new Uint8Array(bytes);
  }
  if (Array.isArray(value)) {
    for (const byte of value) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        return unsupportedBlobValue(provider, operation, "byte array");
      }
    }
    return Uint8Array.from(value);
  }
  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      return hexToUint8Array(value.slice(2), provider, operation);
    }
    if (value.startsWith("base64:type")) {
      const match = BASE64_PROVIDER_REGEX.exec(value);
      if (!match) {
        return unsupportedBlobValue(provider, operation, "base64 string");
      }
      const payloadStart = value.indexOf(":", "base64:type".length) + 1;
      return base64ToUint8Array(value.slice(payloadStart), provider, operation);
    }
    return hexToUint8Array(value, provider, operation);
  }
  return unsupportedBlobValue(provider, operation, typeof value);
}
