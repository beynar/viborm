/**
 * Review of the third extension wave (2026-11-15): the instrumentation
 * presents failures through `disclosed`, and since 50be29cd0 a failure the
 * library did not make puts its own `code` on the span as
 * `viborm.error.code` when the code has the shape of one. The shape admits
 * any five characters of `[0-9A-Z]` (a SQLSTATE's): a five-digit value an
 * extension's error carries (a postal code, a PIN) reaches the tracer. On
 * f656c7aa5 such a failure set no `viborm.error.code`.
 *
 * The second half pins what held: with every setting off, no span or log
 * carries statement text, a parameter value or a stack.
 *
 * Runs on in-memory SQLite, through a platform tracer that records all.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { around, extension, work } from "@src/index";
import { instrumentation } from "@src/instrumentation/exports";
import type { SpanTracer } from "@src/instrumentation/types";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

const STACK_FRAME = /\n\s+at /;

const post = s.model({ id: s.int().id(), title: s.string().unique() });

interface Recorded {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
  status?: unknown;
  exception?: unknown;
}

function recording() {
  const spans: Recorded[] = [];
  const tracer: SpanTracer = {
    startActiveSpan(name, fn) {
      const span: Recorded = { name, attributes: {} };
      spans.push(span);
      return fn({
        setAttribute(key, value) {
          span.attributes[key] = value;
        },
        setStatus(status) {
          span.status = status;
        },
        recordException(error) {
          span.exception = {
            name: error.name,
            message: error.message,
            stack: error.stack,
          };
        },
        end() {
          // Nothing to keep: the record is the span.
        },
      });
    },
  };
  return { spans, tracer };
}

/** A client whose `audit` extension runs a unit of its own that fails with `code`. */
async function auditing(code: string) {
  const { spans, tracer } = recording();
  const base = createClient({ schema: { post }, dataDir: ":memory:" });
  await syncLiveSchema(base as never);
  const db = base.$extends(instrumentation({ tracing: { tracer } })).$extends(
    extension(
      "audit",
      around(() => async (run) => {
        try {
          await work(
            run,
            {
              kind: "audit",
              operation: "record",
              note: { span: "audit.record" },
            },
            () => {
              const failure = new Error("audit failed");
              Object.assign(failure, { code });
              throw failure;
            }
          );
        } catch {
          // The audit's failure is its span's; the call goes on.
        }
        return run();
      })
    )
  );
  await db.post.findMany();
  await base.$disconnect();
  return spans.find((span) => span.name === "audit.record");
}

describe("a foreign failure's code on its span", () => {
  test("a five-digit value is no code: it is not put on the span", async () => {
    const span = await auditing("75001");
    expect(span?.attributes["error.type"]).toBe("Error");
    expect(span?.attributes["viborm.error.code"]).toBeUndefined();
  });
  test("a message is never put on the span", async () => {
    const span = await auditing("not a code: 75001");
    expect(span?.attributes["viborm.error.code"]).toBeUndefined();
  });
});

describe("with every setting off, nothing of a statement reaches the tracer or the logs", () => {
  test("no statement text, parameter value or stack", async () => {
    const { spans, tracer } = recording();
    const logs: unknown[] = [];
    const keep = (event: unknown) => {
      logs.push(event);
    };
    const base = createClient({ schema: { post }, dataDir: ":memory:" });
    await syncLiveSchema(base as never);
    await base.post.create({ data: { id: 1, title: "secret-taken" } });
    const db = base.$extends(
      instrumentation({
        tracing: { tracer },
        logging: { query: keep, error: keep },
      })
    );
    await db.post.findMany({ where: { title: "secret-read" } });
    await expect(
      db.post.create({ data: { id: 2, title: "secret-taken" } })
    ).rejects.toThrow();
    await base.$disconnect();
    const shown = JSON.stringify({ spans, logs }, (_key, value: unknown) =>
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack }
        : value
    );
    expect(spans.length).toBeGreaterThan(0);
    expect(logs.length).toBeGreaterThan(0);
    expect(shown).not.toContain("secret-");
    expect(shown).not.toContain("SELECT");
    expect(shown).not.toContain("INSERT");
    expect(shown).not.toMatch(STACK_FRAME);
  });
});
