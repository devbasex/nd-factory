import { type WebConfig, webConfigSchema } from "@nd-factory/contracts/web-config";

// 画面の設定の値を同じ配信元の /config.json から読む。値は反映のときにスタックが書くので、ビルドに焼き込まない

const CONFIG_PATH = "/config.json";

export class RuntimeConfigError extends Error {
  override name = "RuntimeConfigError";
}

export async function loadRuntimeConfig(fetchFn: typeof fetch): Promise<WebConfig> {
  let res: Response;
  try {
    // 反映で値が変わった直後に古い値を使わないよう、控えを使わない
    res = await fetchFn(CONFIG_PATH, { cache: "no-store" });
  } catch (e) {
    throw new RuntimeConfigError("画面の設定の値に届かない", { cause: e });
  }
  if (!res.ok) throw new RuntimeConfigError(`画面の設定の値を読めない（${res.status}）`);
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (e) {
    throw new RuntimeConfigError("画面の設定の値が JSON でない", { cause: e });
  }
  const parsed = webConfigSchema.safeParse(raw);
  if (!parsed.success) throw new RuntimeConfigError("画面の設定の値が形に合わない");
  return parsed.data;
}
