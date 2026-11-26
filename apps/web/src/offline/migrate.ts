import { seal, unseal } from "./crypto.ts";
import { type DeviceDb, type HoldReason, type KeyRow, type OutboxRow, readOwner, type StoreName } from "./db.ts";
import { sameBytes } from "./guarded-commit.ts";

// データベースの版の上げで、中身を保存先ごとに移す。順と扱いは #12 の設計書の「版の上げの表」。
// 復号と暗号化はトランザクションの外で済ませ、書くトランザクションで移行の記録・主キー・iv が変わっていないことを確かめる

type Converted = "outbox" | "login" | "pending" | "wait" | "authz";

/** 移す先の版と、形を変える保存先の変換。変換の無い保存先は行をそのまま維持する */
export type MigrationPlan = { version: number; convert: Partial<Record<Converted, (value: unknown) => unknown>> };

// 今の版は 1 で、移すものは無い
const CURRENT: MigrationPlan = { version: 1, convert: {} };

// キーの行はほかのすべての保存先が依存するため移さない。保留の件は移行の対象にしない
const ORDER: StoreName[] = ["keys", "login", "pending", "outbox", "held", "wait", "authz", "snapshots", "seq"];
const UNMIGRATED: ReadonlySet<StoreName> = new Set<StoreName>(["keys", "held", "seq"]);

type Row = { id?: string; answerTag?: string; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };
type Change = { key: string; iv: Uint8Array; next: Row | null; hold?: HoldReason };

const keyOf = (row: Row): string => row.answerTag ?? row.id ?? "";

async function changeOf(owner: KeyRow, store: StoreName, row: Row, convert: (value: unknown) => unknown): Promise<Change> {
  const base = { key: keyOf(row), iv: row.iv };
  let value: unknown;
  try {
    value = await unseal(owner.key, row);
    return { ...base, next: { ...row, ...(await seal(owner.key, convert(value))) } };
  } catch {
    // 移せない送る列の件は、元の暗号文のまま保留へ移す。送ったかもしれない件は結果未確認にする
    if (store === "outbox") {
      const sent = (value as { sendStarted?: unknown } | undefined)?.sendStarted === true;
      return { ...base, next: row, hold: sent ? "unknown-result" : "unmigrated" };
    }
    // 途中の記録は残す（読むときに復号できない扱いになる）。ほかは消す
    return { ...base, next: store === "pending" ? row : null };
  }
}

// 移し終えたら true。ほかの接続が先に行を書き換えていたら false（読み直してやり直す）
async function migrateStore(db: DeviceDb, store: StoreName, plan: MigrationPlan): Promise<boolean> {
  const owner = await readOwner(db);
  if (owner === null || owner.migrated[store] >= plan.version) return true;

  const rows = UNMIGRATED.has(store) ? [] : ((await db.getAll(store)) as Row[]);
  // 写しは読み直せるため移さずに消す
  const convert = UNMIGRATED.has(store) || store === "snapshots" ? undefined : plan.convert[store as Converted];
  const changes: Change[] = [];
  if (convert !== undefined) {
    for (const row of rows) changes.push(await changeOf(owner, store, row, convert));
  }
  // 記録だけが消えて古い写しが残ると照合せずに描くため、記録を移せなければ写しも同じトランザクションで消す
  const dropSnapshots = store === "snapshots" || (store === "authz" && changes.some((c) => c.next === null));

  const scope = new Set<StoreName>(["keys", store]);
  if (store === "outbox") scope.add("held");
  if (dropSnapshots) scope.add("snapshots");
  const tx = db.transaction([...scope], "readwrite");
  const current = await tx.objectStore("keys").get("main");
  if (current === undefined || current.migrated[store] >= plan.version) {
    await tx.done;
    return true;
  }
  if (convert !== undefined) {
    const now = (await tx.objectStore(store).getAll()) as Row[];
    const ivs = new Map(now.map((row) => [keyOf(row), row.iv]));
    const unchanged = now.length === changes.length && changes.every((c) => sameBytes(ivs.get(c.key) ?? null, c.iv));
    if (!unchanged) {
      await tx.done;
      return false;
    }
    for (const change of changes) {
      if (change.hold !== undefined) {
        await tx.objectStore("held").put({ ...(change.next as OutboxRow), holdReason: change.hold });
        await tx.objectStore("outbox").delete(change.key);
      } else if (change.next === null) {
        await tx.objectStore(store).delete(change.key);
      } else {
        await tx.objectStore(store).put(change.next as never);
      }
    }
  }
  const migrated = { ...current.migrated, [store]: plan.version };
  if (dropSnapshots) {
    await tx.objectStore("snapshots").clear();
    migrated.snapshots = plan.version;
  }
  await tx.objectStore("keys").put({ ...current, migrated });
  await tx.done;
  return true;
}

export async function runMigrations(db: DeviceDb, o: { only?: StoreName[]; plan?: MigrationPlan }): Promise<void> {
  const plan = o.plan ?? CURRENT;
  for (const store of o.only ?? ORDER) {
    while (!(await migrateStore(db, store, plan))) {
      // 行が書き換わったので読み直す
    }
  }
}
