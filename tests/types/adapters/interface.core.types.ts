import { type DatabaseAdapter, postgresAdapter } from "@src/adapters";

const adapter: DatabaseAdapter = postgresAdapter;
const identifierSql = adapter.identifiers.escape("user");
const parameterSql = adapter.literals.value("Ada");

void identifierSql;
void parameterSql;
