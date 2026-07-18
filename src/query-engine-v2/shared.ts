import { QueryEngineError } from "@errors";
import type { Model } from "@schema/model";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Thrown by a concrete operation's constructor when the requested payload shape
 * is outside V2's supported family (a wrong argument key, an unsupported
 * relation kind, a compound key, a to-one upsert, …). It is the routing signal
 * the P2a client proxy switches on: an `UnsupportedOperationError` means "let V1
 * handle this whole tree"; any other construction error (a `ValidationError`,
 * the own-write preflight rejection) is a real failure V1 would also raise and
 * is allowed to propagate. It is never surfaced to end users through the routed
 * path — the proxy converts it into a V1 call.
 */
export class UnsupportedOperationError extends QueryEngineError {}

export function getStepModelName(model: Model<any>, fallback: string): string {
  return model["~"].names.ts ?? model["~"].names.sql ?? fallback;
}
