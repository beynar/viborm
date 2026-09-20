/**
 * N4/A4 rows 48 + 49 — the CLASSIFICATION cell.
 *
 * The census tells a public refusal from an internal invariant by CLASS, never
 * by message text. Both sentences are now invariants, so each of the two
 * unreachable states must fail as an `EngineInvariantError` and must NOT be a
 * `VibORMError`.
 *
 * RED AT THE BASE (bf7ac30b4): `shared/invariant.ts` does not exist there and
 * both sites throw a bare `Error`.
 */
import { VibORMError } from "@errors/base";
import { EngineInvariantError } from "@query-engine/raptor3/shared/invariant";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { describe, expect, it } from "vitest";

function fixture() {
  const post: any = s
    .model({ id: s.int().id(), title: s.string() })
    .map("a4c_posts");
  const video: any = s
    .model({ id: s.int().id(), title: s.string() })
    .map("a4c_videos");
  const note: any = s
    .model({
      id: s.int().id(),
      subject: s
        .toOne({ post: () => post, video: () => video })
        .name("subject")
        .optional(),
    })
    .map("a4c_notes");
  return { post, video, note };
}

describe("N4/A4 — an invariant failure is not a refusal", () => {
  const schema = fixture();
  const engine = new EngineSchema(schema as any);
  const note = schema.note;

  it("row 49: a carrier addressed with no arm is an EngineInvariantError", () => {
    let thrown: unknown;
    try {
      engine.membership(note, "subject");
    } catch (failure) {
      thrown = failure;
    }
    expect(thrown).toBeInstanceOf(EngineInvariantError);
    expect(thrown).not.toBeInstanceOf(VibORMError);
  });

  it("row 49: an undeclared arm is an EngineInvariantError", () => {
    let thrown: unknown;
    try {
      engine.membership(note, "subject", "absent");
    } catch (failure) {
      thrown = failure;
    }
    expect(thrown).toBeInstanceOf(EngineInvariantError);
    expect(thrown).not.toBeInstanceOf(VibORMError);
  });

  it("row 48: a field the model does not store is an EngineInvariantError", () => {
    let thrown: unknown;
    try {
      engine.physicalField(note, "subject");
    } catch (failure) {
      thrown = failure;
    }
    expect(thrown).toBeInstanceOf(EngineInvariantError);
    expect(thrown).not.toBeInstanceOf(VibORMError);
  });
});
