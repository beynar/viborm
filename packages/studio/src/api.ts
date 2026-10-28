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
}

/** The largest page one request may read. */
export const MAX_PAGE_SIZE = 500;
/** The most rows one export writes. */
export const MAX_EXPORT_ROWS = 100_000;
const DEFAULT_PAGE_SIZE = 50;

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

const ROUTE = /^\/models\/([^/]+)\/(rows|export|create|update|delete)$/;

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
    const action = match[2]!;
    if (schema.readonly && action !== "rows" && action !== "export") {
      throw new Refusal(
        403,
        "read_only",
        "The studio was started with --readonly: it does not write"
      );
    }
    switch (action) {
      case "rows":
        return readRows(model, delegate, body, select(model));
      case "export":
        return exportRows(model, delegate, body);
      case "create":
        return {
          row: await delegate.create({
            data: decodeData(model, body.data),
            select: select(model),
          }),
        };
      case "update":
        return {
          row: await delegate.update({
            where: uniqueWhere(model, body.key),
            data: decodeData(model, body.data),
            select: select(model),
          }),
        };
      default:
        return {
          row: await delegate.delete({
            where: uniqueWhere(model, body.key),
            select: scalarSelection(model),
          }),
        };
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
  const where = combine(
    body.where as Record<string, unknown> | undefined,
    searchWhere(model, search.trim())
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
  const query = queryOf(model, body);
  const select = scalarSelection(model);
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
    : new FileAnswer(
        toCsv(
          model.fields.map((field) => field.name),
          rows
        ),
        `${model.name}.csv`,
        "text/csv"
      );
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
function searchWhere(
  model: StudioModel,
  search: string
): Record<string, unknown> | undefined {
  if (search === "") return undefined;
  const text = model.fields.filter((field) => field.searchable);
  if (text.length === 0) return undefined;
  return {
    OR: text.map((field) => ({ [field.name]: { contains: search } })),
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
