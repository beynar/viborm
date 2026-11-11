/**
 * How the driver authenticates to Snowflake's SQL API, with WebCrypto only, so
 * the same code signs in Node, Bun, a Worker and a Durable Object.
 *
 * Key-pair authentication signs a JWT with the user's RSA private key
 * (docs.snowflake.com/en/developer-guide/sql-api/authenticating):
 *
 * - `iss` is `ACCOUNT.USER.SHA256:<fingerprint>`, the fingerprint being the
 *   base64 SHA-256 of the public key's DER `SubjectPublicKeyInfo`;
 * - `sub` is `ACCOUNT.USER`, both upper-cased, the account without its region
 *   or any part after a period;
 * - the token is valid for at most an hour, so it is renewed a minute before.
 *
 * WebCrypto cannot export a public key from a private one, so the public key
 * is rebuilt from the private key's JWK modulus and exponent.
 *
 * An OAuth or programmatic access token is sent as given, or asked of the
 * caller's function on each request, which is where a refresh belongs.
 */

import { ClientInitializationError } from "@errors";

export type SnowflakeTokenType =
  | "KEYPAIR_JWT"
  | "OAUTH"
  | "PROGRAMMATIC_ACCESS_TOKEN";

export interface SnowflakeCredentials {
  readonly account: string;
  readonly username?: string;
  /** PKCS#8 (`BEGIN PRIVATE KEY`) or PKCS#1 (`BEGIN RSA PRIVATE KEY`) PEM, or a key you imported. */
  readonly privateKey?: string | CryptoKey;
  /** An OAuth or programmatic access token, or a function answering one. */
  readonly token?: string | (() => string | Promise<string>);
  readonly tokenType?: Exclude<SnowflakeTokenType, "KEYPAIR_JWT">;
}

export interface Authorization {
  readonly token: string;
  readonly type: SnowflakeTokenType;
}

const LIFETIME_SECONDS = 3600;
const RENEW_BEFORE_SECONDS = 60;
const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const PEM = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/;

function configuration(message: string): ClientInitializationError {
  return new ClientInitializationError(message, {
    meta: { driver: "snowflake", operation: "configuration" },
  });
}

function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const base64Url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const utf8 = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

/** One DER length. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const head = [tag, ...derLength(content.length)];
  const out = new Uint8Array(head.length + content.length);
  out.set(head);
  out.set(content, head.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** `AlgorithmIdentifier { rsaEncryption, NULL }`. */
const RSA_ALGORITHM = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

/** A PKCS#1 `RSAPrivateKey` wrapped as the PKCS#8 WebCrypto imports. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  return der(
    0x30,
    concat(new Uint8Array([0x02, 0x01, 0x00]), RSA_ALGORITHM, der(0x04, pkcs1))
  );
}

/** The private key a PEM holds, as the PKCS#8 bytes WebCrypto imports. */
export function privateKeyBytes(pem: string): Uint8Array<ArrayBuffer> {
  const match = PEM.exec(pem);
  if (!match)
    throw configuration(
      "The Snowflake private key must be a PEM block: -----BEGIN PRIVATE KEY----- (PKCS#8) or -----BEGIN RSA PRIVATE KEY----- (PKCS#1)."
    );
  const [, label, body] = match;
  if (label === "PRIVATE KEY") return base64ToBytes(body!);
  if (label === "RSA PRIVATE KEY") return pkcs1ToPkcs8(base64ToBytes(body!));
  if (label === "ENCRYPTED PRIVATE KEY")
    throw configuration(
      "The Snowflake private key is encrypted. Decrypt it first (openssl pkcs8 -in key.p8 -out key.pem), or import it yourself and pass the CryptoKey."
    );
  throw configuration(`A "${label}" PEM block is not an RSA private key.`);
}

/** The account as a JWT names it: upper-cased, without region or suffix. */
export function jwtAccount(account: string): string {
  return account.split(".")[0]!.toUpperCase();
}

async function importPrivateKey(key: string | CryptoKey): Promise<CryptoKey> {
  if (typeof key !== "string") return key;
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      privateKeyBytes(key),
      RSA,
      true,
      ["sign"]
    );
  } catch (error) {
    if (error instanceof ClientInitializationError) throw error;
    throw configuration(
      `The Snowflake private key could not be imported as an RSA key: ${error instanceof Error ? error.message : String(error)}.`
    );
  }
}

/** `SHA256:` and the base64 SHA-256 of the public key's DER encoding. */
export async function publicKeyFingerprint(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, ext: true },
    RSA,
    true,
    ["verify"]
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
  return `SHA256:${bytesToBase64(digest)}`;
}

/** One signed key-pair JWT, issued at `now` (seconds). */
export async function signKeyPairJwt(
  account: string,
  username: string,
  key: CryptoKey,
  now: number,
  fingerprint?: string
): Promise<string> {
  const subject = `${jwtAccount(account)}.${username.toUpperCase()}`;
  const payload = {
    iss: `${subject}.${fingerprint ?? (await publicKeyFingerprint(key))}`,
    sub: subject,
    iat: now,
    exp: now + LIFETIME_SECONDS,
  };
  const signingInput = `${base64Url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })))}.${base64Url(utf8(JSON.stringify(payload)))}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(RSA, key, utf8(signingInput))
  );
  return `${signingInput}.${base64Url(signature)}`;
}

/**
 * The Authorization a request carries. One per driver: it keeps the imported
 * key, its fingerprint and the current JWT, never anything module-wide.
 */
export class SnowflakeAuthenticator {
  readonly #credentials: SnowflakeCredentials;
  readonly #now: () => number;
  #key: Promise<{ key: CryptoKey; fingerprint: string }> | undefined;
  #jwt: { token: string; renewAt: number } | undefined;

  constructor(credentials: SnowflakeCredentials, now = () => Date.now()) {
    const { privateKey, token, username } = credentials;
    if ((privateKey === undefined) === (token === undefined))
      throw configuration(
        "Snowflake needs exactly one credential: a privateKey (with a username) for key-pair authentication, or a token for OAuth."
      );
    if (privateKey !== undefined && !username)
      throw configuration(
        "Snowflake key-pair authentication needs the username the key belongs to."
      );
    this.#credentials = credentials;
    this.#now = now;
  }

  async authorization(): Promise<Authorization> {
    const { token, tokenType } = this.#credentials;
    if (token !== undefined) {
      const value = typeof token === "function" ? await token() : token;
      if (typeof value !== "string" || value.length === 0)
        throw configuration("The Snowflake token function answered no token.");
      return { token: value, type: tokenType ?? "OAUTH" };
    }
    const now = Math.floor(this.#now() / 1000);
    if (this.#jwt && now < this.#jwt.renewAt)
      return { token: this.#jwt.token, type: "KEYPAIR_JWT" };
    this.#key ??= importPrivateKey(this.#credentials.privateKey!).then(
      async (key) => ({ key, fingerprint: await publicKeyFingerprint(key) })
    );
    let imported: { key: CryptoKey; fingerprint: string };
    try {
      imported = await this.#key;
    } catch (error) {
      this.#key = undefined;
      throw error;
    }
    const jwt = await signKeyPairJwt(
      this.#credentials.account,
      this.#credentials.username!,
      imported.key,
      now,
      imported.fingerprint
    );
    this.#jwt = { token: jwt, renewAt: now + LIFETIME_SECONDS - RENEW_BEFORE_SECONDS };
    return { token: jwt, type: "KEYPAIR_JWT" };
  }
}
