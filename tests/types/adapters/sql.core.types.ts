import { empty, join, raw, type Sql, sql } from "@src/index";

const _bound: Sql = sql`SELECT ${1}`;
const _rawString: Sql = raw("SELECT 1");
const _rawTemplate: Sql = sql.raw`SELECT 1`;
const _joined: Sql = join([1, sql`SELECT ${2}`], ", ");
const _propertyJoin: Sql = sql.join([1, 2]);
const _propertyEmpty: Sql = sql.empty;
const _directEmpty: Sql = empty;

// @ts-expect-error - SQL exposes only raw, empty, and join as helpers
sql.unknown`SELECT 1`;
