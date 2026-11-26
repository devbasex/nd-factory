import { ID_KINDS, idOf, type IdKind } from "@nd-factory/contracts/ids";
import { parse, v4, v7 } from "uuid";
import type { Clock } from "./clock.ts";

// ID は <種類の頭>_<UUIDv7>。画面でも動くよう node: の組み込みを読まず、乱数は uuid の乱数だけから取る（決定 6）

export type Id<K extends IdKind = IdKind> = `${K}_${string}`;

// 連番は 32 ビット（uuid の v7 が rand_a と rand_b の頭へ詰める幅）
const SEQ_LIMIT = 0x1_0000_0000;

// 単調性の状態（前のミリ秒と連番）。実行環境ごとに 1 つ持つ。uuid の v7 は msecs と seq を渡すと内側の状態を使わない
const state = { msecs: Number.NEGATIVE_INFINITY, seq: 0 };

// 新しいミリ秒の連番の始まり。uuid と同じく上の 1 ビットを空け、同じミリ秒の中で足す余地を残す
function randomSeq(): number {
  const bytes = parse(v4());
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) >>> 1;
}

const KINDS: ReadonlySet<string> = new Set(ID_KINDS);

// 集合に無い頭の ID は parseId がいつも null を返すため作らない（型の外から来た値も実行の時に照らす）
export function newId<K extends IdKind>(kind: K, clock: Clock): Id<K> {
  if (!KINDS.has(kind)) throw new TypeError(`ID の頭の集まりに無い種類: ${String(kind)}`);
  const now = clock.epochMs();
  if (now > state.msecs) {
    state.msecs = now;
    state.seq = randomSeq();
  } else {
    // 時計が進まないか戻った: 前のミリ秒のまま連番を足し、あふれたらミリ秒を進める
    state.seq += 1;
    if (state.seq >= SEQ_LIMIT) {
      state.seq = 0;
      state.msecs += 1;
    }
  }
  return `${kind}_${v7({ msecs: state.msecs, seq: state.seq })}`;
}

// 冪等キーは種類の頭を持たない UUIDv7（API の文書の冪等キーの条件）
export function newIdempotencyKey(clock: Clock): string {
  return v7({ msecs: clock.epochMs() });
}

const schemas = new Map<IdKind, ReturnType<typeof idOf>>();

// 形が合わなければ null（呼び手は 404 と同じに扱う）
export function parseId<K extends IdKind>(kind: K, value: string): Id<K> | null {
  let schema = schemas.get(kind);
  if (schema === undefined) {
    schema = idOf(kind);
    schemas.set(kind, schema);
  }
  return schema.safeParse(value).success ? (value as Id<K>) : null;
}
