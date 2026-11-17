import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

// 合成の結果の置き場の要約値の作り方。置き場のすべてのファイルのパスと中身の SHA-256 を並べ、その並びの SHA-256 を取る。
// 設置のコマンドは Node で、反映のパイプラインの CodeBuild はシェルで数えるため、2 つが同じ値になることをテストで照らす。
// 作り方を変えるときは、この 2 つを同じ変更で直す

export const ASSEMBLY_DIGEST_SHELL =
  "find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64";

export class AssemblyDigestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssemblyDigestError";
  }
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// find の -type f と同じく、ふつうのファイルだけを集める（リンクとディレクトリは数えない）
async function listFiles(root: string, rel: string, acc: string[]): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) await listFiles(root, child, acc);
    else if (e.isFile()) acc.push(child);
  }
}

// sha256sum は名前にバックスラッシュか改行があると、行頭に \ を付けて名前を書き換える
function sumLine(hash: string, name: string): string {
  if (/[\\\n\r]/.test(name)) {
    const escaped = name.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    return `\\${hash}  ${escaped}\n`;
  }
  return `${hash}  ${name}\n`;
}

export async function assemblyDigest(dir: string): Promise<string> {
  let info;
  try {
    info = await stat(dir);
  } catch {
    throw new AssemblyDigestError(`合成の結果の置き場が無い: ${dir}`);
  }
  if (!info.isDirectory()) throw new AssemblyDigestError(`合成の結果の置き場がディレクトリでない: ${dir}`);

  const files: string[] = [];
  await listFiles(dir, ".", files);
  // LC_ALL=C sort はバイトの順に並べる
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  let listing = "";
  if (files.length === 0) {
    // ファイルが無いと xargs は引数なしで sha256sum を 1 回打ち、空の標準入力の値を出す
    listing = `${sha256("")}  -\n`;
  } else {
    for (const f of files) listing += sumLine(sha256(await readFile(join(dir, f))), f);
  }
  return sha256(listing);
}
