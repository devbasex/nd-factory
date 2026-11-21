import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

// PostgreSQL の既定と同じ回数と塩の長さ
export const SCRAM_ITERATIONS = 4096;
export const SCRAM_SALT_BYTES = 16;

// 印字できる ASCII だけ。PostgreSQL が掛ける SASLprep を持たないため、それで形の変わらない文字に限る
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

// パスワードを SQL に載せる前に、RFC 7677 の SCRAM-SHA-256 の検証子へ変える
// 形は PostgreSQL の SCRAM-SHA-256$<回数>:<塩>$<StoredKey>:<ServerKey>（どれも base64）
export function scramVerifier(password: string, opts?: { salt?: Uint8Array; iterations?: number }): string {
  // 例外の文にパスワードを入れない
  if (!PRINTABLE_ASCII.test(password)) throw new Error("パスワードは印字できる ASCII の文字だけにする");
  const iterations = opts?.iterations ?? SCRAM_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("回数は 1 以上の整数");
  const salt = opts?.salt ?? randomBytes(SCRAM_SALT_BYTES);
  if (salt.length === 0) throw new Error("塩が空");

  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  const b64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}
