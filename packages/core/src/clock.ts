// 時計。時刻の元を注入でき、テストで差し替える。画面でも動くよう node: の組み込みを読まない（決定 6）

export type Clock = {
  now(): Date;
  // RFC 3339 の UTC（末尾 Z・ミリ秒 3 桁）
  iso(): string;
  // UNIX のミリ秒。newId と TTL の計算が使う
  epochMs(): number;
};

// source は UNIX のミリ秒を返す。元が戻っても、同じ時計から得た値は減らない
export function createClock(source: () => number = () => Date.now()): Clock {
  let last = Number.NEGATIVE_INFINITY;
  const read = (): number => {
    const ms = source();
    if (ms > last) last = ms;
    return last;
  };
  return {
    now: () => new Date(read()),
    iso: () => new Date(read()).toISOString(),
    epochMs: read,
  };
}
