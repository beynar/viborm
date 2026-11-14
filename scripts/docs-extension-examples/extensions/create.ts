// biome-ignore-all lint/correctness/noUnusedImports: a preamble's imports serve the page's blocks.
// biome-ignore-all lint/correctness/noUnusedVariables: a preamble's names serve the page's blocks.
//
// Two blocks of the page are marked `ts expect-error`: "Judge writes" and
// "Judge the rows a write produces". Each writes an `update.fields[f]` entry
// whose filter reads an argument (`only({ archivistId: arg("user") })`,
// `check(placed)`), the contract's own spelling, which the library's types
// overflow on today (TS2589 in `RuleFunction`). Unmark them when that is fixed:
// this check then fails until they are.
import { client } from "docs-examples/shared";
import type { AnyDriver } from "viborm/driver";

declare const id: string;
declare const title: string;
declare const session: { userId: string };
declare const replica: AnyDriver;
declare function beforeRead(mode: string, input: unknown): void;
declare function afterRead(count: number): void;
declare function publish(rows: unknown[], certainty: string): Promise<void>;
declare function isRetryableError(error: unknown): boolean;
declare function record(...facts: unknown[]): void;
declare function recordAudit(...facts: unknown[]): void;

// @section sharing
import { accepts, arg, args, extension, facts, gate, only, rule } from "viborm";
import { v } from "viborm/validation";

const seen = { OR: [{ public: true }, { ownerId: arg("user") }] };
const own = { ownerId: arg("user") };
const archivist = { archivistId: arg("user") };

const db = client.$extends(
  extension(
    "sharing",
    args({ user: accepts(v.string()).required() }),
    rule({
      document: {
        read: {
          where: seen,
          fields: { notes: gate(own) },
          select: { $access: facts({ seen, own, archivist }) },
        },
        update: { where: only(own) },
      },
    })
  )
);

// @section compose
import { around, call, extension, methods, target } from "viborm";

const boundedReads = extension(
  "bounded-reads",
  call((c) => {
    c.set({ take: 100 });
  }, target("post", "findMany"))
);
const timing = extension(
  "timing",
  around(() => (run) => run())
);
const postTools = extension(
  "post-tools",
  methods(() => ({ $ping: () => "pong" }))
);

// @section application
import type { ExtendedClient } from "viborm";

const applicationExtensions = [boundedReads, timing, postTools] as const;
type ApplicationClient = ExtendedClient<
  typeof client,
  typeof applicationExtensions
>;
