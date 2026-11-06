import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { getD1Database } from "@calcom/prisma/d1";
import type { D1Database } from "@cloudflare/workers-types";
import type { CompiledQuery, DatabaseConnection, Dialect, Driver, QueryResult } from "kysely";
import {
  DeduplicateJoinsPlugin,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import type { Booking, DB } from "./types";

export type { DB, Booking };

class D1Connection implements DatabaseConnection {
  constructor(private readonly database: D1Database) {}

  async executeQuery<R>({ sql, parameters, query }: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.database
      .prepare(sql)
      .bind(...parameters)
      .all<R>();
    return {
      rows: result.results,
      numAffectedRows: BigInt(result.meta.changes),
      insertId: query.kind === "InsertQueryNode" ? BigInt(result.meta.last_row_id) : undefined,
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new ErrorWithCode(ErrorCode.InternalServerError, "D1 query streaming is unsupported");
  }
}

class D1Driver implements Driver {
  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new D1Connection(getD1Database());
  }

  async beginTransaction(): Promise<void> {
    throw new ErrorWithCode(ErrorCode.InternalServerError, "D1 interactive transactions are unsupported");
  }

  async commitTransaction(): Promise<void> {
    throw new ErrorWithCode(ErrorCode.InternalServerError, "D1 interactive transactions are unsupported");
  }

  async rollbackTransaction(): Promise<void> {
    throw new ErrorWithCode(ErrorCode.InternalServerError, "D1 interactive transactions are unsupported");
  }

  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

const dialect = {
  createDriver: () => new D1Driver(),
  createQueryCompiler: () => new SqliteQueryCompiler(),
  createAdapter: () => new SqliteAdapter(),
  createIntrospector: <T>(db: Kysely<T>) => new SqliteIntrospector(db),
} satisfies Dialect;

export default new Kysely<DB>({ dialect, plugins: [new DeduplicateJoinsPlugin()] });
