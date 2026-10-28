/**
 * The studio's JSON API. Every read and write goes through the application's
 * own VibORM client, so its validation, defaults, generators and relation
 * semantics are the ones the studio exercises; no SQL is written here.
 *
 * The API owns four things only: which model a path names, the paging bound,
 * that an update or delete addresses exactly one row by its key, and whether
 * the studio writes at all (`--readonly`). What a `where`, `orderBy` or `data`
 * may contain is the client's to decide, and its refusal comes back as a 400
 * with the client's own message.
 */

import type { Model } from "@src/schema/model";
import { dialectOf, explainStatements } from "./explain";
import { QUERY_OPERATIONS } from "./query";
import { parseQueryCode } from "./query-code";
import { describeSchema, type StudioModel, type StudioSchema } from "./schema";
import { encodeJson } from "./server";

export interface StudioRequest {
  readonly method: string;
  /** The path below `/api`, e.g. `/models/user/rows`. */
  readonly path: string;
  readonly body: unknown;
}

export interface StudioResponse {
  readonly status: number;
  /** JSON to encode, or the text of a file when `file` names it. */
  readonly body: unknown;
  readonly file?: { readonly name: string; readonly type: string };
}

/** The schema as the page reads it: the models, and whether it may write. */
export interface StudioDescription extends StudioSchema {
  readonly readonly: boolean;
  /** The config the studio opened: what the page keys the layout it saves by. */
  readonly project: string;
}

/** The delegate surface the studio calls on `client[model]`. */
interface ModelDelegate {
  findMany(args: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  count(args: Record<string, unknown>): Promise<number>;
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  delete(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface StudioApiOptions {
  /** The application's client, as its config exports it. */
  readonly client: object;
  readonly models: Readonly<Record<string, Model<any>>>;
  readonly dialect: string;
  /** Refuse every create, update and delete. */
  readonly readonly?: boolean;
  /** The config's path, which a reload keeps. */
  readonly project?: string;
  /** Where the page keeps what it remembers of the project (its views, the diagram's layout); none, it keeps it itself. */
  readonly store?: StudioStore;
  /** How the database stands against the schema, for this client. */
  readonly drift?: (client: object) => Promise<StudioDrift>;
  /** The client, extended to report each statement it runs and each span it opens; without it, a query runs untraced. */
  readonly trace?: (
    client: object,
    report: StudioTraceReport
  ) => Promise<object>;
}

/** How the database stands against the schema: what `viborm push` would do to it, as the project's migrations say. */
export type StudioDrift =
  | { readonly state: "in-sync" }
  | {
      readonly state: "drift";
      readonly destructive: boolean;
      readonly operations: readonly {
        readonly label: string;
        readonly risk: string;
      }[];
      readonly statements: readonly string[];
    }
  | { readonly state: "unknown"; readonly reason: string };

/** One statement a query ran, as the project's instrumentation reports it. */
export interface StudioStatement {
  readonly sql?: string;
  readonly params?: readonly unknown[];
  readonly duration?: number;
}

/** One span the project's instrumentation opened while a query ran. */
export interface StudioSpan {
  readonly id: number;
  /** The span it ran inside. */
  readonly parent?: number;
  readonly name: string;
  /** When it started, in milliseconds: from the query's start once the API answers. */
  readonly start: number;
  readonly duration: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly error?: string;
}

/** Where a traced client reports what a query did. */
export interface StudioTraceReport {
  statement(statement: StudioStatement): void;
  span(span: StudioSpan): void;
}

/** What the page remembers of a project, by name, kept by the studio rather than the browser. */
export interface StudioStore {
  read(name: StoredName): Promise<unknown>;
  write(name: StoredName, value: unknown): Promise<void>;
}
export type StoredName = "views" | "queries" | "layout";
const STORE_ROUTE = /^\/store\/(views|queries|layout)$/;

/** The most changes one save sends. */
export const MAX_CHANGES = 1000;
/** The largest page one request may read. */
export const MAX_PAGE_SIZE = 500;
/** The most rows one export writes. */
export const MAX_EXPORT_ROWS = 100_000;
const DEFAULT_PAGE_SIZE = 50;

/** One change of a save, refused or failed: which one, by its place in the list. */
class ChangeFailure extends Error {
  readonly at: number;
  constructor(at: number, cause: unknown) {
    super("A change failed", { cause });
    this.at = at;
  }
}

class Refusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ROUTE = /^\/models\/([^/]+)\/(rows|export)$/;

export function createStudioApi(options: StudioApiOptions) {
  const schema: StudioDescription = {
    ...describeSchema(options.models, options.dialect),
    readonly: options.readonly === true,
    project: options.project ?? "",
  };
  const byName = new Map(schema.models.map((model) => [model.name, model]));
  const select = (model: StudioModel) => selection(model, byName);

  const delegateOf = (model: StudioModel): ModelDelegate =>
    Reflect.get(options.client, model.name) as ModelDelegate;

  async function route(request: StudioRequest): Promise<unknown> {
    if (request.path === "/schema") {
      if (request.method !== "GET") throw methodNotAllowed();
      return schema;
    }
    if (request.path === "/changes") {
      if (request.method !== "POST") throw methodNotAllowed();
      return saveChanges(request.body);
    }
    const stored = STORE_ROUTE.exec(request.path);
    if (stored) return keep(stored[1] as StoredName, request);
    if (request.path === "/drift") {
      if (request.method !== "GET") throw methodNotAllowed();
      return drift();
    }
    if (request.path === "/query") {
      if (request.method !== "POST") throw methodNotAllowed();
      return query(request.body);
    }
    if (request.path === "/explain") {
      if (request.method !== "POST") throw methodNotAllowed();
      return explain(request.body);
    }
    const match = ROUTE.exec(request.path);
    if (!match) throw new Refusal(404, "not_found", "Unknown studio route");
    if (request.method !== "POST") throw methodNotAllowed();
    const name = decodeURIComponent(match[1]!);
    const model = byName.get(name);
    if (!model) {
      throw new Refusal(404, "unknown_model", `Unknown model "${name}"`);
    }
    const body = request.body ?? {};
    if (!isRecord(body)) {
      throw new Refusal(400, "invalid_body", "The body must be a JSON object");
    }
    const delegate = delegateOf(model);
    return match[2] === "rows"
      ? readRows(model, delegate, body, select(model))
      : exportRows(model, delegate, body);
  }

  /** The database against the schema; a check that cannot be made says why rather than failing the page. */
  async function drift(): Promise<StudioDrift> {
    if (!options.drift) {
      return {
        state: "unknown",
        reason: "This studio does not compare the database with the schema.",
      };
    }
    try {
      return await options.drift(options.client);
    } catch (error) {
      return {
        state: "unknown",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * A read's plan: the read runs traced, so the statements it ran are known with the values they bound, then the
   * database explains each (`explainStatements`).
   */
  async function explain(body: unknown) {
    const dialect = dialectOf(options.dialect);
    if (!(options.trace && dialect)) {
      throw new Refusal(
        501,
        "no_explain",
        "This studio cannot explain a query: it needs the project's instrumentation and a SQL database it knows."
      );
    }
    if (
      isRecord(body) &&
      body.analyze !== undefined &&
      typeof body.analyze !== "boolean"
    ) {
      throw new Refusal(400, "invalid_analyze", "analyze must be a boolean");
    }
    const ran = await query(body);
    // `analyze: false` asks the plan only: the statement does not run again.
    const analyze = !(isRecord(body) && body.analyze === false);
    return {
      ...ran,
      analyze,
      explained: await explainStatements(
        options.client,
        dialect,
        ran.statements,
        analyze
      ),
    };
  }

  /** One read, as written on the query page: its answer, how long it took, and the statements it ran. */
  async function query(body: unknown) {
    if (!isRecord(body)) {
      throw new Refusal(400, "invalid_body", "The body must be a JSON object");
    }
    let input = body;
    if ("code" in input) {
      try {
        input = { ...parseQueryCode(input.code) };
      } catch (error) {
        throw new Refusal(
          400,
          "invalid_query_code",
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    const model =
      typeof input.model === "string" ? byName.get(input.model) : undefined;
    if (!model) {
      throw new Refusal(
        404,
        "unknown_model",
        `Unknown model "${String(input.model)}"`
      );
    }
    const operation = QUERY_OPERATIONS.find((name) => name === input.operation);
    if (!operation) {
      throw new Refusal(
        400,
        "invalid_operation",
        `The query page reads: ${QUERY_OPERATIONS.join(", ")}`
      );
    }
    const args = input.args ?? {};
    if (!isRecord(args)) {
      throw new Refusal(400, "invalid_args", "args must be an object");
    }
    const statements: StudioStatement[] = [];
    const spans: StudioSpan[] = [];
    const client = options.trace
      ? await options.trace(options.client, {
          statement: (statement) => statements.push(statement),
          span: (span) => spans.push(span),
        })
      : options.client;
    const delegate = Reflect.get(client, model.name) as Record<
      string,
      (args: unknown) => Promise<unknown>
    >;
    const started = performance.now();
    const result = await delegate[operation]!(args);
    const duration = Math.round(performance.now() - started);
    // The instrumentation ends the operation's span once its promise settled, a few microtasks after this await:
    // one turn of the loop and every span the query opened has ended.
    if (options.trace) await new Promise((resolve) => setImmediate(resolve));
    const at = (time: number) => Math.round(time * 100) / 100;
    return {
      model: model.name,
      operation,
      result: result ?? null,
      duration,
      statements,
      // In the order they started, from the query's start.
      spans: spans
        .map((span) => ({
          ...span,
          start: at(span.start - started),
          duration: at(span.duration),
        }))
        .sort((left, right) => left.start - right.start),
    };
  }

  /** What the page remembers, read (GET) or kept (POST `{ value }`), even by a read-only studio: it is not the data. */
  async function keep(name: StoredName, request: StudioRequest) {
    const { store } = options;
    if (!store) {
      throw new Refusal(
        404,
        "no_store",
        "This studio keeps nothing: the page does"
      );
    }
    if (request.method === "GET")
      return { value: (await store.read(name)) ?? null };
    if (request.method !== "POST") throw methodNotAllowed();
    if (!(isRecord(request.body) && "value" in request.body)) {
      throw new Refusal(400, "invalid_body", "Send { value }");
    }
    await store.write(name, request.body.value);
    return { kept: name };
  }

  /**
   * The changes the member stacked, written in their order in one transaction
   * of the client: every one of them, or none. Each is checked before any is
   * written; a failure names the change by its place in the list (`at`).
   */
  async function saveChanges(body: unknown) {
    if (schema.readonly) {
      throw new Refusal(
        403,
        "read_only",
        "The studio was started with --readonly: it does not write"
      );
    }
    const changes = isRecord(body) ? body.changes : undefined;
    if (!Array.isArray(changes) || changes.length > MAX_CHANGES) {
      throw new Refusal(
        400,
        "invalid_changes",
        `changes must be a list of at most ${MAX_CHANGES} changes`
      );
    }
    const planned = changes.map((change, at) => {
      try {
        return planChange(change);
      } catch (error) {
        throw new ChangeFailure(at, error);
      }
    });
    const transaction = Reflect.get(options.client, "$transaction") as (
      run: (tx: object) => Promise<void>
    ) => Promise<void>;
    await transaction.call(options.client, async (tx) => {
      for (const [at, change] of planned.entries()) {
        const delegate = Reflect.get(tx, change.model.name) as ModelDelegate;
        try {
          await delegate[change.action]({
            ...change.args,
            select: scalarSelection(change.model),
          });
        } catch (error) {
          throw new ChangeFailure(at, error);
        }
      }
    });
    return { saved: planned.length };
  }

  function planChange(change: unknown) {
    if (!isRecord(change)) {
      throw new Refusal(400, "invalid_change", "A change must be an object");
    }
    const model =
      typeof change.model === "string" ? byName.get(change.model) : undefined;
    if (!model) {
      throw new Refusal(
        404,
        "unknown_model",
        `Unknown model "${String(change.model)}"`
      );
    }
    switch (change.action) {
      case "create":
        return {
          model,
          action: "create" as const,
          args: { data: decodeData(model, change.data) },
        };
      case "update":
        return {
          model,
          action: "update" as const,
          args: {
            where: uniqueWhere(model, change.key),
            data: decodeData(model, change.data),
          },
        };
      case "delete":
        return {
          model,
          action: "delete" as const,
          args: { where: uniqueWhere(model, change.key) },
        };
      default:
        throw new Refusal(
          400,
          "invalid_action",
          'A change\'s action is "create", "update" or "delete"'
        );
    }
  }

  return {
    schema,
    async handle(request: StudioRequest): Promise<StudioResponse> {
      try {
        const answer = await route(request);
        return answer instanceof FileAnswer
          ? { status: 200, body: answer.text, file: answer.file }
          : { status: 200, body: answer };
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const methodNotAllowed = () =>
  new Refusal(405, "method_not_allowed", "Method not allowed");

/** What a page asks: its filter, its search and its order, checked and combined. */
function queryOf(model: StudioModel, body: Record<string, unknown>) {
  if (body.where !== undefined && !isRecord(body.where)) {
    throw new Refusal(400, "invalid_where", "where must be an object");
  }
  const search = body.search ?? "";
  if (typeof search !== "string") {
    throw new Refusal(400, "invalid_search", "search must be a string");
  }
  const ignoreCase = body.ignoreCase ?? false;
  if (typeof ignoreCase !== "boolean") {
    throw new Refusal(
      400,
      "invalid_ignore_case",
      "ignoreCase must be true or false"
    );
  }
  const where = combine(
    body.where as Record<string, unknown> | undefined,
    searchWhere(model, search.trim(), ignoreCase)
  );
  const orderBy = withTieBreaker(model, body.orderBy);
  return { ...(where ? { where } : {}), ...(orderBy ? { orderBy } : {}) };
}

async function readRows(
  model: StudioModel,
  delegate: ModelDelegate,
  body: Record<string, unknown>,
  select: Record<string, unknown>
) {
  const skip = body.skip ?? 0;
  const take = body.take ?? DEFAULT_PAGE_SIZE;
  if (!(Number.isSafeInteger(skip) && (skip as number) >= 0)) {
    throw new Refusal(400, "invalid_skip", "skip must be a whole number ≥ 0");
  }
  if (
    !(
      Number.isSafeInteger(take) &&
      (take as number) >= 1 &&
      (take as number) <= MAX_PAGE_SIZE
    )
  ) {
    throw new Refusal(
      400,
      "invalid_take",
      `take must be a whole number between 1 and ${MAX_PAGE_SIZE}`
    );
  }
  const query = queryOf(model, body);
  const [rows, total] = await Promise.all([
    delegate.findMany({ ...query, skip, take, select }),
    delegate.count(query.where ? { where: query.where } : {}),
  ]);
  return { rows, total };
}

/** A file the API answers with, rather than JSON. */
class FileAnswer {
  readonly text: string;
  readonly file: { readonly name: string; readonly type: string };
  constructor(text: string, name: string, type: string) {
    this.text = text;
    this.file = { name, type };
  }
}

/** Every row a page's filter, search and order reach, as CSV or JSON, read a page at a time. */
async function exportRows(
  model: StudioModel,
  delegate: ModelDelegate,
  body: Record<string, unknown>
) {
  const format = body.format ?? "csv";
  if (format !== "csv" && format !== "json") {
    throw new Refusal(400, "invalid_format", 'format must be "csv" or "json"');
  }
  const names = model.fields.map((field) => field.name);
  const columns = body.columns ?? names;
  if (
    !(Array.isArray(columns) && columns.length) ||
    columns.some(
      (column) => typeof column !== "string" || !names.includes(column)
    ) ||
    new Set(columns).size !== columns.length
  )
    throw new Refusal(
      400,
      "invalid_columns",
      "columns must name distinct scalar fields"
    );
  const picked: string[] = columns;
  const query = queryOf(model, body);
  const select = Object.fromEntries(picked.map((name) => [name, true]));
  const rows: Record<string, unknown>[] = [];
  for (;;) {
    // The last page asks for one row past the ceiling: only that row refuses.
    const take = Math.min(MAX_PAGE_SIZE, MAX_EXPORT_ROWS + 1 - rows.length);
    const page = await delegate.findMany({
      ...query,
      skip: rows.length,
      take,
      select,
    });
    rows.push(...page);
    if (rows.length > MAX_EXPORT_ROWS) {
      throw new Refusal(
        413,
        "export_too_large",
        `An export writes at most ${MAX_EXPORT_ROWS} rows: narrow the filter`
      );
    }
    if (page.length < take) break;
  }
  return format === "json"
    ? new FileAnswer(encodeJson(rows), `${model.name}.json`, "application/json")
    : new FileAnswer(toCsv(picked, rows), `${model.name}.csv`, "text/csv");
}

const CSV_QUOTED = /[",\r\n]|^\s|\s$/;

/** RFC 4180 CSV: a header, then a line per row; structures as JSON, bytes as base64. */
export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[]
): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    // A value as its JSON reads (a Decimal, a Date, bytes as base64), a structure as JSON.
    const json: unknown = JSON.parse(encodeJson(value));
    const text =
      typeof json === "object" && json !== null
        ? JSON.stringify(json)
        : String(json);
    return CSV_QUOTED.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    columns.map(cell).join(","),
    ...rows.map((row) => columns.map((column) => cell(row[column])).join(",")),
  ].join("\r\n");
}

/** Free text: any text column containing the words. */
/** The words in any text column; `ignoreCase` folds ASCII letters, as the client's `mode: "insensitive"` does everywhere. */
function searchWhere(
  model: StudioModel,
  search: string,
  ignoreCase: boolean
): Record<string, unknown> | undefined {
  if (search === "") return undefined;
  const text = model.fields.filter((field) => field.searchable);
  if (text.length === 0) return undefined;
  const mode = ignoreCase ? { mode: "insensitive" } : {};
  return {
    OR: text.map((field) => ({ [field.name]: { contains: search, ...mode } })),
  };
}

function combine(
  ...clauses: (Record<string, unknown> | undefined)[]
): Record<string, unknown> | undefined {
  const present = clauses.filter((clause) => clause !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : { AND: present };
}

/** A page is only stable when its order is total: the key closes every sort. */
function withTieBreaker(model: StudioModel, orderBy: unknown): unknown {
  const given =
    orderBy === undefined ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
  const named = new Set(
    given.flatMap((entry) => (isRecord(entry) ? Object.keys(entry) : []))
  );
  const tail = (model.key?.fields ?? [])
    .filter((field) => !named.has(field))
    .map((field) => ({ [field]: "asc" }));
  const all = [...given, ...tail];
  return all.length === 0 ? undefined : all;
}

function scalarSelection(model: StudioModel): Record<string, unknown> {
  const select: Record<string, unknown> = {};
  for (const field of model.fields) select[field.name] = true;
  return select;
}

/**
 * Every column, the key of the row each to-one relation reaches (null when
 * there is none), and how many rows each to-many relation holds.
 */
function selection(
  model: StudioModel,
  models: ReadonlyMap<string, StudioModel>
): Record<string, unknown> {
  const select = scalarSelection(model);
  const keyOf = (target: StudioModel | undefined) =>
    target?.key && {
      select: Object.fromEntries(
        target.key.fields.map((field) => [field, true])
      ),
    };
  for (const relation of model.relations) {
    if (relation.cardinality !== "one") continue;
    // A polymorphic to-one reads `{ type, data }`: each variant's key, under its name
    // (every target of one has a scalar primary key, or the client refuses the schema).
    const reached = relation.variants
      ? Object.fromEntries(
          relation.variants.map((variant) => [
            variant.name,
            keyOf(models.get(variant.target)),
          ])
        )
      : keyOf(models.get(relation.targets[0]!));
    if (reached) select[relation.name] = reached;
  }
  const counted = model.relations.filter(
    (relation) => relation.cardinality === "many"
  );
  if (counted.length > 0) {
    select._count = {
      select: Object.fromEntries(
        counted.map((relation) => [relation.name, true])
      ),
    };
  }
  return select;
}

/** The one row a key names, spelled as the model's unique selector. */
function uniqueWhere(model: StudioModel, key: unknown) {
  if (!model.key) {
    throw new Refusal(
      400,
      "no_key",
      `Model "${model.name}" has no primary or unique key to address a row by`
    );
  }
  const fields = model.key.fields;
  const given = isRecord(key) ? Object.keys(key) : [];
  if (
    !isRecord(key) ||
    given.length !== fields.length ||
    !fields.every((field) => Object.hasOwn(key, field))
  ) {
    throw new Refusal(
      400,
      "invalid_key",
      `key must name exactly ${fields.join(", ")}`
    );
  }
  const values = Object.fromEntries(fields.map((field) => [field, key[field]]));
  return model.key.name === undefined ? values : { [model.key.name]: values };
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const VIBORM_CODE = /^V\d+$/;

/** JSON carries bytes as base64; the client takes them as a `Uint8Array`. */
function decodeData(model: StudioModel, data: unknown) {
  if (!isRecord(data)) {
    throw new Refusal(400, "invalid_data", "data must be an object");
  }
  const decoded: Record<string, unknown> = { ...data };
  for (const field of model.fields) {
    const value = decoded[field.name];
    if (field.type !== "blob" || field.list || typeof value !== "string") {
      continue;
    }
    if (!BASE64.test(value)) {
      throw new Refusal(
        400,
        "invalid_data",
        `${field.name} must be base64 text`
      );
    }
    decoded[field.name] = Uint8Array.from(Buffer.from(value, "base64"));
  }
  return decoded;
}

/**
 * A refusal keeps its status. A VibORM error is read by its code rather than
 * its class: the client may come from the application's own copy of VibORM.
 */
function failure(error: unknown): StudioResponse {
  if (error instanceof ChangeFailure) {
    const { status, body } = failure(error.cause);
    const { error: said } = body as { error: Record<string, unknown> };
    return { status, body: { error: { ...said, at: error.at } } };
  }
  if (error instanceof Refusal) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  const code = isRecord(error) ? error.code : undefined;
  const message =
    error instanceof Error ? error.message : "The studio request failed";
  if (typeof code === "string" && VIBORM_CODE.test(code)) {
    return { status: statusOf(code), body: { error: { code, message } } };
  }
  return { status: 500, body: { error: { code: "internal", message } } };
}

function statusOf(code: string): number {
  if (code.startsWith("V4")) return 400;
  if (code.startsWith("V3")) return 409;
  if (code === "V6001") return 404;
  if (code.startsWith("V7") || code.startsWith("V8")) return 422;
  return 500;
}
