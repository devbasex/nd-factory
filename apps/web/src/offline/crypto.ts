// 端末に置く値の暗号化（AES-GCM）と、平文の列に置く HMAC の値。暗号を扱うのはこのファイルだけ（#12 の決定 3）

export type Sealed = { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

export class UnreadableError extends Error {
  override name = "UnreadableError";
}

// HMAC の入力の区切り。ID と指紋に現れない文字で、部分の境目が違う入力を別の値にする
const SEPARATOR = "\u0000";

export async function createKeySet(): Promise<{ key: CryptoKey; tagKey: CryptoKey }> {
  const [key, tagKey] = await Promise.all([
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  ]);
  return { key, tagKey };
}

export async function seal(key: CryptoKey, value: unknown): Promise<Sealed> {
  // eslint-disable-next-line no-restricted-properties -- 暗号の IV は ID でないため、横断の部品を通さない
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv, data };
}

export async function unseal<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, sealed.data);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch (cause) {
    throw new UnreadableError("端末のデータを復号できない", { cause });
  }
}

export async function tagOf(tagKey: CryptoKey, ...parts: string[]): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", tagKey, new TextEncoder().encode(parts.join(SEPARATOR)));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
