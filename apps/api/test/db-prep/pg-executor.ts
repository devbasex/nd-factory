import { randomBytes, randomUUID } from "node:crypto";
import { Client, escapeIdentifier } from "pg";
import { describe, it } from "vitest";
import { ADMIN_DATABASE, type Row, type SqlExecutor, type SqlParam, type SqlValue, toRow } from "../../src/db-prep/sql-executor.ts";

// テストで使う SqlExecutor の pg の実装。Data API の実装と同じ文（:name の引数）を受け、同じ形の行を返す
export type PgExecutor = SqlExecutor & { close(): Promise<void> };

// :name の引数を pg の $n へ変える。文字列・引用した識別子・注釈・型の決め（::）の中の : は引数にしない
export function toPositional(sql: string, params: SqlParam[] | undefined): { text: string; values: SqlValue[] } {
  const byName = new Map<string, SqlValue>();
  for (const p of params ?? []) {
    if (byName.has(p.name)) throw new Error(`引数の名前が重なる: ${p.name}`);
    byName.set(p.name, p.value);
  }
  const order: string[] = [];
  let text = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const end = endOfQuoted(sql, i, c);
      text += sql.slice(i, end);
      i = end;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      const end = nl === -1 ? sql.length : nl;
      text += sql.slice(i, end);
      i = end;
    } else if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      if (close === -1) throw new Error("閉じない注釈");
      text += sql.slice(i, close + 2);
      i = close + 2;
    } else if (c === ":" && sql[i + 1] === ":") {
      text += "::";
      i += 2;
    } else if (c === ":" && /[A-Za-z_]/.test(sql[i + 1] ?? "")) {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i + 1))?.[0] ?? "";
      if (!byName.has(name)) throw new Error(`引数が渡されていない: ${name}`);
      let n = order.indexOf(name);
      if (n === -1) n = order.push(name) - 1;
      // 整数は Data API が longValue（bigint）で渡すのに合わせて型を決める。型の無い引数で送ると、Data API でだけ落ちる文を見逃す
      text += Number.isInteger(byName.get(name)) ? `$${n + 1}::bigint` : `$${n + 1}`;
      i += 1 + name.length;
    } else {
      text += c;
      i += 1;
    }
  }
  return { text, values: order.map((name) => byName.get(name) ?? null) };
}

// 引用の終わりの次の位置。引用の文字を 2 つ重ねたものは中身として読む
function endOfQuoted(sql: string, start: number, quote: string): number {
  let j = start + 1;
  while (j < sql.length) {
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j += 1;
  }
  throw new Error("閉じない引用");
}

export function createPgExecutor(connect: (database: string) => Promise<Client>): PgExecutor {
  // 自動の確定で打つ文は、データベースごとに 1 本の接続を使い回す
  const shared = new Map<string, Promise<Client>>();
  // トランザクションごとに専用の接続を結ぶ
  const txs = new Map<string, { database: string; client: Client }>();

  function sharedClient(database: string): Promise<Client> {
    let c = shared.get(database);
    if (!c) {
      c = connect(database);
      shared.set(database, c);
    }
    return c;
  }

  function take(transactionId: string): { database: string; client: Client } {
    const tx = txs.get(transactionId);
    if (!tx) throw new Error("知らないトランザクション");
    txs.delete(transactionId);
    return tx;
  }

  return {
    async execute(sql, params, opts) {
      const { text, values } = toPositional(sql, params);
      let client: Client;
      if (opts.transactionId === undefined) {
        client = await sharedClient(opts.database);
      } else {
        const tx = txs.get(opts.transactionId);
        if (!tx) throw new Error("知らないトランザクション");
        if (tx.database !== opts.database) throw new Error("トランザクションのデータベースと違う");
        client = tx.client;
      }
      // トランザクションの中の文が失敗しても接続は txs に残す（呼ぶ側の rollback か close() が閉じる）
      const res = await client.query<Record<string, unknown>>({ text, values });
      return res.rows.map((r): Row => toRow(r));
    },

    async begin(opts) {
      const client = await connect(opts.database);
      try {
        await client.query("BEGIN");
      } catch (e) {
        await client.end();
        throw e;
      }
      const id = randomUUID();
      txs.set(id, { database: opts.database, client });
      return id;
    },

    async commit(transactionId) {
      const tx = take(transactionId);
      try {
        const res = await tx.client.query("COMMIT");
        // 失敗した文の後の COMMIT を PostgreSQL は ROLLBACK として受ける。確定しなかったことを投げて知らせる
        if (res.command !== "COMMIT") throw new Error("トランザクションが確定せずに巻き戻った");
      } finally {
        await tx.client.end();
      }
    },

    async rollback(transactionId) {
      const tx = take(transactionId);
      try {
        await tx.client.query("ROLLBACK");
      } finally {
        await tx.client.end();
      }
    },

    // 後始末の経路: commit か rollback を呼ばれたトランザクションは、その場で接続を閉じて txs から外す。
    // 文が失敗しても rollback を呼ばれなければ、接続は txs に残り、確定しないトランザクションが DB に残る。
    // close() がそれらの接続も閉じ（閉じた接続のトランザクションは PostgreSQL が巻き戻す）、
    // withTestDatabase は最後に close() を呼んでから DROP DATABASE … WITH (FORCE) で消す
    async close() {
      const clients = [...(await Promise.allSettled(shared.values()))].flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      clients.push(...[...txs.values()].map((t) => t.client));
      shared.clear();
      txs.clear();
      await Promise.allSettled(clients.map((c) => c.end()));
    },
  };
}

// --- テストの接続の共通の道具 ---

const PG_URL = process.env.ND_TEST_PG_URL;

function isCi(): boolean {
  const v = process.env.CI?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

// PostgreSQL を使うテストの組。接続の値が無ければ、CI では落とし、手元では飛ばす
export function describePg(name: string, fn: () => void): void {
  if (PG_URL) {
    describe(name, { timeout: 60_000 }, fn);
  } else if (isCi()) {
    describe(name, () => {
      it("ND_TEST_PG_URL が要る", () => {
        throw new Error("CI では PostgreSQL のサービスコンテナの接続の値 ND_TEST_PG_URL を渡す");
      });
    });
  } else {
    describe.skip(name, fn);
  }
}

export type Credentials = { user: string; password: string };

export type TestDatabase = {
  // 使い捨てのデータベースの名前
  name: string;
  // 接続を開く。既定は使い捨てのデータベースへ、接続の値の役割で
  connect(database?: string, credentials?: Credentials): Promise<Client>;
  // 管理のデータベース（postgres）を使い捨てのデータベースへ読み替える SqlExecutor
  executor(): PgExecutor;
  // 後始末で消す役割（役割はデータベースの外に残るため）
  dropRoleLater(role: string): void;
};

function urlFor(database: string, credentials?: Credentials): string {
  if (!PG_URL) throw new Error("ND_TEST_PG_URL が無い");
  const url = new URL(PG_URL);
  url.pathname = `/${encodeURIComponent(database)}`;
  if (credentials) {
    url.username = encodeURIComponent(credentials.user);
    url.password = encodeURIComponent(credentials.password);
  }
  return url.toString();
}

function adminDatabaseOfUrl(): string {
  if (!PG_URL) throw new Error("ND_TEST_PG_URL が無い");
  return decodeURIComponent(new URL(PG_URL).pathname.replace(/^\//, "")) || "postgres";
}

async function open(database: string, credentials?: Credentials): Promise<Client> {
  const client = new Client({ connectionString: urlFor(database, credentials) });
  // 切られた接続の誤りは打った文の失敗で受ける。出来事のまま放ると処理が落ちる
  client.on("error", () => undefined);
  await client.connect();
  return client;
}

// テストごとに使い捨てのデータベースを作り、終えたら接続ごと消す
export async function withTestDatabase<T>(fn: (db: TestDatabase) => Promise<T>): Promise<T> {
  const name = `nd_test_${randomBytes(6).toString("hex")}`;
  const admin = await open(adminDatabaseOfUrl());
  const clients: Client[] = [];
  const executors: PgExecutor[] = [];
  const roles: string[] = [];
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(name)}`);
    const connect = async (database: string = name, credentials?: Credentials): Promise<Client> => {
      const c = await open(database, credentials);
      clients.push(c);
      return c;
    };
    const db: TestDatabase = {
      name,
      connect,
      executor() {
        const ex = createPgExecutor((database) => connect(database === ADMIN_DATABASE ? name : database));
        executors.push(ex);
        return ex;
      },
      dropRoleLater(role) {
        roles.push(role);
      },
    };
    return await fn(db);
  } finally {
    await Promise.allSettled(executors.map((e) => e.close()));
    await Promise.allSettled(clients.map((c) => c.end()));
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`);
      for (const role of roles) await admin.query(`DROP ROLE IF EXISTS ${escapeIdentifier(role)}`);
    } finally {
      await admin.end();
    }
  }
}
