# M1 derivation probes (throwaway, before the pins were written)

Five probe files were written, run and deleted; their measurements are now
carried by the two permanent pins. Recorded here so the derivation's evidence
is not only in a transcript. Each line is verbatim stdout.

## Probe 1 — which shapes reach the sentences (SQLite + PGlite, `supportsReturning` forced false)

    PROBE-A {"id":"01M2ZH0QYR4RMZ0TPC55GEHHVF","label":"one"}
        `s.string().id()` with no id in the payload: the ULID is spelled at
        admission, nothing is produced, no refusal.
    PROBE-C [{"id":"01M2ZH0QZ8JEH8PJTNEX7H31SD",...},{"id":"01M2ZH0QZ8JEH8PJTNEX7H31SE",...}]
        the same through `createMany({ data, select })`.
    PROBE-D-throw Raptor 3 interactive output requires RETURNING or one generated increment field
    PROBE-D-many-throw Driver 'pglite' cannot locate one selected createMany row after insertion.
        a compound key of two `increment` parts (`.id(["tenantId","recordId"])`),
        interactive, capability-false: BOTH sentences, reproduced.
    PROBE-E-throw INSERT did not produce the required record
    PROBE-E-onlykey-throw INSERT did not produce the required record
        `id` increment (sole key) + `seq` increment (non-key), `select: {id, seq}`:
        NOT #33 — the throw is the later one at `operation-context.ts:2632`,
        so `produced` held ONE field. `demanded` is the engine's own need (the
        row key, and what a dependent must read), not the caller's `select`;
        the non-key column is answered by the terminal read. PGlite reports no
        `insertId`, which is what that cell then fails on.
    PROBE-B (failed) INSERT did not produce the required record
        the plain `SQLite3Driver` populates no `insertId` at all (only mysql2,
        planetscale and d1 do), which is why the credential-free pin's driver
        reports `last_insert_rowid()` itself.

## Probe 2 — every create route (SQLite, `supportsReturning` forced false)

    P2-nested {"id":"01M2ZHAFP8CYTPX3XDE0QSQC41","books":[{"id":"01M2ZHAFPAPWV8AEJGXWATQ4VZ","title":"T1"}]}
    P2-upsert {"id":"01M2ZHAFPE8DVE704SZSC30GGD","name":"B"}
    P2-connectOrCreate {"id":"01M2ZHAFPGGK0X6QQVH8FS6XH9","authorId":"01M2ZHAFPHAT9ZD5BF45TRGK0Q"}
    P2-nested-createMany {"id":"01M2ZHAFPHAT9ZD5BF45TRGK0R","books":[{"id":"…0S"},{"id":"…0T"}]}
    P2-createMany-skipDuplicates [{"id":"01M2ZHAFPJVZDVY1PP173YAMTJ","name":"E"},{"id":"…TK","name":"F"}]
        every route fills the ORM's own defaults at admission. These became
        cells 1–3 of `generated-key-reach.test.ts`.

## Probe 3 — the MySQL lane (Docker, MySQL 8.4.11)

    PROBE-MYSQL-version [{"v":"8.4.11"}]
    PROBE-MYSQL-two-auto THROW QueryError: Query execution failed
      code: 'V2001',
      originalCause: [Error: Underlying error details redacted] { errno: 1075, sqlState: '42000' },
      meta: { providerErrno: 1075, providerSqlState: '42000', … }
        `CREATE TABLE … (tenant_id INT NOT NULL AUTO_INCREMENT, record_id INT
        NOT NULL AUTO_INCREMENT, …, PRIMARY KEY (tenant_id, record_id), UNIQUE
        KEY (tenant_id))` — refused. This became cell 1 of the MySQL pin.
    PROBE-MYSQL-one-auto [{"id":1}]
    PROBE-MYSQL-uuid [{"u":"cb152c2f-b4f9-11f1-9ad3-6a0eeed5ea57"}]
    PROBE-MYSQL-next-auto [{"next":2}]
        `information_schema.TABLES.AUTO_INCREMENT` answers the next value, and
        answers the same one to every reader: a statistic, not a reservation.
        This became cell 5 of the MySQL pin.
