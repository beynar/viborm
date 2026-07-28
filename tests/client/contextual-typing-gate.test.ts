/**
 * The contextual-typing gate (W8-B).
 *
 * ONE claim, checked on every public surface where a user writes an object
 * literal or a field-name string: a misspelled key is a COMPILE ERROR.
 *
 * Why a typo probe and not a "the editor completes this" assertion: completion
 * is not checkable from a test, but it has a checkable proxy. An editor offers
 * the keys of a CONCRETE contextual type; a surface that accepts an unknown key
 * had no concrete type to offer, so it offered nothing. Refusing the typo and
 * completing the key are the same property seen from two sides.
 *
 * The case study is `omit`, which shipped the gap TWICE — f842302 keyed the core
 * `createClient` config, and 2f7bd59 found the same hole still open in all
 * eleven driver-package wrappers, the entry point most apps actually import.
 * Both times the surface's RESULT types were already right; only the contextual
 * type while the literal was being written was wrong. That is why probes must
 * enter through the public API exactly as a user writes it — a probe that names
 * an internal type alias types the alias, not the call.
 *
 * Two things make a probe honest here:
 *  1. it enters through the PUBLIC surface (`s`, `createClient`, the driver
 *     wrapper, `client.<model>.<op>`), never an internal alias;
 *  2. there is a typo probe at EVERY nesting level, not just the outermost —
 *     `where` refusing a bad key says nothing about `where.relation.some`.
 *
 * A `// @ts-expect-error` that stops being an error fails this file (TS2578),
 * so a regression that re-opens a surface is a red type-check, and every probe
 * is self-falsifying: correct the spelling and the directive goes unused.
 *
 * Nothing here is called; only the types matter.
 */

import { createClient } from "@client/client";
import {
  PGliteDriver,
  createClient as pgliteCreateClient,
} from "@drivers/pglite";
import { push } from "@migrations/push";
import { s } from "@schema";
import { describe, expectTypeOf, test } from "vitest";

const author = s.model({
  id: s.string().id(),
  email: s.string(),
  passwordHash: s.string(),
  books: s.oneToMany(() => book).name("writer"),
});

const book = s.model({
  id: s.string().id(),
  title: s.string(),
  pages: s.int(),
  authorId: s.string(),
  writer: s
    .manyToOne(() => author)
    .fields("authorId")
    .references("id")
    .name("writer"),
});

const client = createClient({
  schema: { author, book },
  driver: new PGliteDriver(),
});

// ============================================================================
// MODEL BUILDER — field-name lists
// ============================================================================

describe("model builder field-name lists are keyed to the model's scalars", () => {
  const _keyed = () =>
    s
      .model({ a: s.string(), b: s.string() })
      .id(["a", "b"])
      .unique(["b"])
      .index(["a", "b"]);

  const _idTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .id(["a", "bb"]);

  const _uniqueTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .unique(["a", "bb"]);

  const _indexTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .index(["a", "bb"]);

  const _omitTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "bb" is not a scalar of this model
      .omit({ bb: true });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_idTypo).toBeFunction();
    expectTypeOf(_uniqueTypo).toBeFunction();
    expectTypeOf(_indexTypo).toBeFunction();
    expectTypeOf(_omitTypo).toBeFunction();
  });
});

/**
 * The option bags of the same three calls — the SECOND nesting level, and the
 * one that had shipped open. `{ name: "i", uniqu: true }` records an index that
 * is not unique; nothing downstream ever reads `uniqu`.
 *
 * Each is probed twice, fresh and non-fresh, because excess-property checking —
 * the only thing that refused these before — needs a fresh object literal. A bag
 * held in a variable (the "share one options object across two indexes" shape)
 * is exactly the case it waves through.
 */
const sharedCompoundOptions = { name: "ab", nmae: "ab" };
const sharedIndexOptions = { name: "i", uniqu: true };

describe("model builder option bags refuse a key they do not read", () => {
  const _keyed = () =>
    s
      .model({ a: s.string(), b: s.string() })
      .id(["a", "b"], { name: "pk" })
      .unique(["a"], { name: "uq" })
      .index(["b"], {
        name: "ix",
        unique: true,
        type: "btree",
        where: "b > 0",
      });

  const _idOptionTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .id()
      .id(["a", "b"], { nmae: "ab" });

  const _idOptionTypoBesideReal = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .id()
      .id(["a", "b"], { name: "ab", nmae: "ab" });

  const _idOptionTypoNonFresh = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .id()
      .id(["a", "b"], sharedCompoundOptions);

  const _uniqueOptionTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .unique()
      .unique(["a", "b"], { nmae: "ab" });

  const _uniqueOptionTypoNonFresh = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "nmae" is not an option of .unique()
      .unique(["a", "b"], sharedCompoundOptions);

  const _indexOptionTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "uniqu" is not an index option
      .index(["a"], { name: "i", uniqu: true });

  const _indexOptionTypoNonFresh = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "uniqu" is not an index option
      .index(["a"], sharedIndexOptions);

  const _indexOptionValueTypo = () =>
    s
      .model({ a: s.string(), b: s.string() })
      // @ts-expect-error - "btre" is not an IndexType
      .index(["a"], { type: "btre" });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_idOptionTypo).toBeFunction();
    expectTypeOf(_idOptionTypoBesideReal).toBeFunction();
    expectTypeOf(_idOptionTypoNonFresh).toBeFunction();
    expectTypeOf(_uniqueOptionTypo).toBeFunction();
    expectTypeOf(_uniqueOptionTypoNonFresh).toBeFunction();
    expectTypeOf(_indexOptionTypo).toBeFunction();
    expectTypeOf(_indexOptionTypoNonFresh).toBeFunction();
    expectTypeOf(_indexOptionValueTypo).toBeFunction();
  });
});

/**
 * `.id()` / `.unique()` name the constraint they build, and the name must survive
 * the option bag's new keying — a bag typed only for its refusal would widen the
 * name and lose the compound key's identity.
 */
describe("a named compound key keeps its literal name", () => {
  test("the explicit name is the constraint key", () => {
    const model = s
      .model({ a: s.string(), b: s.string() })
      .id(["a", "b"], { name: "pk_ab" });
    expectTypeOf<
      keyof NonNullable<(typeof model)["~"]["state"]["compoundId"]>
    >().toEqualTypeOf<"pk_ab">();
  });

  test("with no name the joined field names are", () => {
    const model = s.model({ a: s.string(), b: s.string() }).unique(["a", "b"]);
    expectTypeOf<
      keyof NonNullable<(typeof model)["~"]["state"]["compoundUniques"]>
    >().toEqualTypeOf<"a_b">();
  });
});

// ============================================================================
// RELATION BUILDER
// ============================================================================

/**
 * `.fields()` and `.references()` take bare `string`, and BOTH are pinned here as
 * accepting a typo — a negative pin, not an oversight. See the doc comments on
 * `ToOneRelation.fields` / `.references` for why: `.fields()` names siblings of
 * the very object literal being typed (no type exists yet), and keying
 * `.references()` through the getter resolves the target model mid-inference,
 * which is precisely what `RelationState.getter: any` exists to prevent — it was
 * measured at 123 estate type errors, with a self-referential relation reporting
 * its own correct `"id"` as `never`.
 *
 * Both are refused at RUNTIME by schema validation (FK001 for `.fields`, FK002
 * for `.references`, both severity `error`).
 *
 * The two probes below therefore carry NO `@ts-expect-error`: they are misspelled
 * calls that compile, and their compiling IS the pin. The day either surface gets
 * keyed, the line turns red — at which point delete the probe, move it up into
 * the keyed sections, and correct the doc comment that says it cannot be done.
 */
describe("relation FK spellings are runtime-checked, not type-checked", () => {
  const _fieldsTypoCompiles = () =>
    s.model({
      authorId: s.string(),
      // "authorIdd" is a typo the TYPE cannot catch — FK001 catches it.
      writer: s
        .manyToOne(() => author)
        .fields("authorIdd")
        .references("id"),
    });

  const _referencesTypoCompiles = () =>
    s.model({
      authorId: s.string(),
      // "idd" is a typo the TYPE cannot catch — FK002 catches it.
      writer: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("idd"),
    });

  const _onDeleteTypo = () =>
    s.model({
      authorId: s.string(),
      writer: s
        .manyToOne(() => author)
        .fields("authorId")
        .references("id")
        // @ts-expect-error - "cascde" is not a referential action
        .onDelete("cascde"),
    });

  test("the two FK probes are the pinned negative, onDelete is the positive", () => {
    expectTypeOf(_fieldsTypoCompiles).toBeFunction();
    expectTypeOf(_referencesTypoCompiles).toBeFunction();
    expectTypeOf(_onDeleteTypo).toBeFunction();
  });
});

// ============================================================================
// CLIENT CONFIG — core and driver wrapper
// ============================================================================

/**
 * The surface the case-study commits fixed, extended from `omit`'s KEYS to the
 * config's own keys. `createClient` infers `Config` from the literal, so the
 * literal's keys are "known" by construction and excess-property checking has
 * nothing to say — `cacheVerison: 1` used to compile and be read by no one.
 *
 * Probed on both entry points, because 2f7bd59's whole finding was that fixing
 * the core one left the eleven wrappers open.
 */
const sharedConfig = {
  schema: { author, book },
  driver: new PGliteDriver(),
  cacheVerison: 1,
};

describe("createClient config refuses a key it does not read", () => {
  const _keyed = () =>
    createClient({
      schema: { author, book },
      driver: new PGliteDriver(),
      cacheVersion: 1,
      decimal: "string",
      omit: { author: { passwordHash: true } },
    });

  const _configTypo = () =>
    createClient({
      schema: { author, book },
      driver: new PGliteDriver(),
      // @ts-expect-error - "cacheVerison" is not a config key
      cacheVerison: 1,
    });

  // @ts-expect-error - "cacheVerison" is not a config key, fresh literal or not
  const _configTypoNonFresh = () => createClient(sharedConfig);

  const _decimalValueTypo = () =>
    createClient({
      schema: { author, book },
      driver: new PGliteDriver(),
      // @ts-expect-error - "strng" is not a decimal mode
      decimal: "strng",
    });

  const _instrumentationTypo = () =>
    createClient({
      schema: { author, book },
      driver: new PGliteDriver(),
      instrumentation: {
        // @ts-expect-error - "enabld" is not an instrumentation key
        enabld: true,
      },
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_configTypo).toBeFunction();
    expectTypeOf(_configTypoNonFresh).toBeFunction();
    expectTypeOf(_decimalValueTypo).toBeFunction();
    expectTypeOf(_instrumentationTypo).toBeFunction();
  });
});

describe("the driver-package createClient is keyed the same way", () => {
  const _keyed = () =>
    pgliteCreateClient({
      schema: { author, book },
      dataDir: "memory://",
      cacheVersion: 1,
      omit: { author: { passwordHash: true } },
    });

  const _driverOptionTypo = () =>
    pgliteCreateClient({
      schema: { author, book },
      // @ts-expect-error - "dataDr" is not a pglite option
      dataDr: "memory://",
    });

  const _sharedConfigKeyTypo = () =>
    pgliteCreateClient({
      schema: { author, book },
      // @ts-expect-error - "cacheVerison" is not a config key
      cacheVerison: 1,
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_driverOptionTypo).toBeFunction();
    expectTypeOf(_sharedConfigKeyTypo).toBeFunction();
  });
});

// ============================================================================
// QUERY ARGS — one probe per nesting level
// ============================================================================

/**
 * These types are derived from the validation schemas rather than written by
 * hand, so they are the surface most likely to be ASSUMED safe. Every level is
 * probed instead: the operation's own keys, each clause, the operators inside a
 * clause, and the same clauses again one relation deeper.
 *
 * Read the `where` probes at exactly their strength: each spells a literal whose
 * keys are ALL wrong. A typo written beside a CORRECT key is a weaker property
 * that `where` does not have — see the pinned negative directly below this block.
 */
describe("query args refuse a typo at every nesting level", () => {
  const _keyed = () =>
    client.book.findMany({
      where: { title: { contains: "x" }, writer: { is: { email: "e" } } },
      select: { id: true, writer: { select: { email: true } } },
      orderBy: { title: "asc" },
      distinct: ["title"],
      cursor: { id: "1" },
    });

  const _operationKeyTypo = () =>
    // @ts-expect-error - "wher" is not an operation key
    client.book.findMany({ wher: { title: "x" } });

  const _whereTypo = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.findMany({ where: { ttitle: "x" } });

  const _whereOperatorTypo = () =>
    // @ts-expect-error - "contians" is not a string filter operator
    client.book.findMany({ where: { title: { contians: "x" } } });

  const _selectTypo = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.findMany({ select: { ttitle: true } });

  const _selectNestedTypo = () =>
    client.author.findMany({
      // @ts-expect-error - "ttitle" is not a field of book
      select: { id: true, books: { select: { ttitle: true } } },
    });

  const _includeTypo = () =>
    // @ts-expect-error - "bokos" is not a relation of author
    client.author.findMany({ include: { bokos: true } });

  const _includeNestedWhereTypo = () =>
    client.author.findMany({
      // @ts-expect-error - "ttitle" is not a field of book
      include: { books: { where: { ttitle: "x" } } },
    });

  const _relationFilterTypo = () =>
    client.author.findMany({
      // @ts-expect-error - "ttitle" is not a field of book
      where: { books: { some: { ttitle: "x" } } },
    });

  const _orderByTypo = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.findMany({ orderBy: { ttitle: "asc" } });

  const _orderByValueTypo = () =>
    // @ts-expect-error - "ascending" is not a sort order
    client.book.findMany({ orderBy: { title: "ascending" } });

  const _omitTypo = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.findMany({ omit: { ttitle: true } });

  const _distinctTypo = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.findMany({ distinct: ["ttitle"] });

  const _cursorTypo = () =>
    // @ts-expect-error - "idd" is not a field of book
    client.book.findMany({ cursor: { idd: "1" } });

  const _dataTypo = () =>
    client.book.create({
      // @ts-expect-error - "ttitle" is not a field of book
      data: { id: "1", ttitle: "x", pages: 1, authorId: "a" },
    });

  const _nestedDataTypo = () =>
    client.author.create({
      data: {
        id: "1",
        email: "e",
        passwordHash: "p",
        // @ts-expect-error - "ttitle" is not a field of book
        books: { create: { id: "b", ttitle: "x", pages: 1 } },
      },
    });

  const _aggregateTypo = () =>
    // @ts-expect-error - "pagess" is not a numeric field of book
    client.book.aggregate({ _sum: { pagess: true } });

  const _groupByTypo = () =>
    // @ts-expect-error - "ttitle" is not a field of book
    client.book.groupBy({ by: ["ttitle"] });

  const _havingTypo = () =>
    client.book.groupBy({
      by: ["title"],
      // @ts-expect-error - "pagess" is not a field of book
      having: { pagess: { _sum: { gt: 1 } } },
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_operationKeyTypo).toBeFunction();
    expectTypeOf(_whereTypo).toBeFunction();
    expectTypeOf(_whereOperatorTypo).toBeFunction();
    expectTypeOf(_selectTypo).toBeFunction();
    expectTypeOf(_selectNestedTypo).toBeFunction();
    expectTypeOf(_includeTypo).toBeFunction();
    expectTypeOf(_includeNestedWhereTypo).toBeFunction();
    expectTypeOf(_relationFilterTypo).toBeFunction();
    expectTypeOf(_orderByTypo).toBeFunction();
    expectTypeOf(_orderByValueTypo).toBeFunction();
    expectTypeOf(_omitTypo).toBeFunction();
    expectTypeOf(_distinctTypo).toBeFunction();
    expectTypeOf(_cursorTypo).toBeFunction();
    expectTypeOf(_dataTypo).toBeFunction();
    expectTypeOf(_nestedDataTypo).toBeFunction();
    expectTypeOf(_aggregateTypo).toBeFunction();
    expectTypeOf(_groupByTypo).toBeFunction();
    expectTypeOf(_havingTypo).toBeFunction();
  });
});

/**
 * The exact reach of the `where` probes above — measured at the merge of W8-A
 * (operand callbacks) and W8-B (this file), because the two lanes read as
 * contradicting each other and did not.
 *
 * Every `where` probe above spells a literal whose keys are ALL wrong, and that
 * is refused: no member of the operand union matches, so the compiler reports.
 * A typo written BESIDE a correct key is a different, weaker property, and it is
 * NOT refused — `{ gt: 1, ltt: 100 }` matches the filter member and excess-
 * property checking does not fire through the union. `where` has no EPC.
 *
 * This is PRE-EXISTING, not something the callback union cost. The four probes
 * below were run against 2f7bd59 (pre-merge, plain values only, no callback in
 * the union) and against the merged tree: byte-identical outcomes, only the
 * all-wrong literal refused in both. Widening the operand to accept a callback
 * changed nothing here.
 *
 * The doctrine holds where it must — at RUNTIME the strict object schemas refuse
 * these keys, identically beside a plain value, a token, a fragment and a
 * callback ("an unknown key is refused the same way beside every operand kind"
 * in tests/query-engine/operand-callback-sql.test.ts). The gap is DX-only.
 *
 * Same convention as the FK pins above: no `@ts-expect-error`, because these
 * compile, and their compiling IS the pin. The day `where` gets excess-property
 * checking these four lines turn red — delete them and correct this comment.
 */
describe("a where typo BESIDE a correct key is the pinned negative", () => {
  const _numericOperatorTypoAlone = () =>
    // @ts-expect-error - "gtt" alone matches no member of the operand union
    client.book.findMany({ where: { pages: { gtt: 1 } } });

  const _numericOperatorTypoBesideCompiles = () =>
    client.book.findMany({ where: { pages: { gt: 1, ltt: 100 } } });

  const _stringOperatorTypoBesideCompiles = () =>
    client.book.findMany({
      where: { title: { contains: "x", startsWit: "y" } },
    });

  const _fieldTypoBesideCompiles = () =>
    client.book.findMany({ where: { title: "x", ttitle: "y" } });

  const _operandCallbackStillTyped = () =>
    client.book.findMany({
      where: { pages: { gt: (ctx) => ctx.fields.pages } },
    });

  test("all-wrong is refused; typo-beside-correct is pinned as compiling", () => {
    expectTypeOf(_numericOperatorTypoAlone).toBeFunction();
    expectTypeOf(_numericOperatorTypoBesideCompiles).toBeFunction();
    expectTypeOf(_stringOperatorTypoBesideCompiles).toBeFunction();
    expectTypeOf(_fieldTypoBesideCompiles).toBeFunction();
    expectTypeOf(_operandCallbackStillTyped).toBeFunction();
  });
});

// ============================================================================
// TRANSACTION AND MIGRATION OPTIONS
// ============================================================================

describe("$transaction and push option bags are keyed", () => {
  const _keyed = () =>
    client.$transaction(async () => 1, {
      isolationLevel: "Serializable",
      timeout: 1,
      maxWait: 1,
    });

  const _txOptionTypo = () =>
    // @ts-expect-error - "timeut" is not a transaction option
    client.$transaction(async () => 1, { timeut: 1 });

  const _txIsolationValueTypo = () =>
    // @ts-expect-error - "Serializble" is not an isolation level
    client.$transaction(async () => 1, { isolationLevel: "Serializble" });

  const _batchTxOptionTypo = () =>
    // @ts-expect-error - the sequential form takes isolationLevel only
    client.$transaction([client.book.findMany()], { timeout: 1 });

  const _pushOptionTypo = () =>
    push(client, {
      // @ts-expect-error - "dryRnu" is not a push option
      dryRnu: true,
    });

  test("the probes above compile (assertions live in @ts-expect-error)", () => {
    expectTypeOf(_keyed).toBeFunction();
    expectTypeOf(_txOptionTypo).toBeFunction();
    expectTypeOf(_txIsolationValueTypo).toBeFunction();
    expectTypeOf(_batchTxOptionTypo).toBeFunction();
    expectTypeOf(_pushOptionTypo).toBeFunction();
  });
});
