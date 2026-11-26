// アプリ専用の bootstrap の qualifier が、別の設置と衝突しないかを判定する。qualifier は 8 桁に縮めた値なので、
// 違う設置が同じ値になりうる。成功にするのは「新しく作る」と「この設置のものを更新する」の 2 つだけで、読めないときも拒む

export type BootstrapStack = { status: string; qualifier: string | undefined; tags: Record<string, string> };

export type BootstrapReader = {
  // /cdk-bootstrap/<qualifier>/version があるか。ParameterNotFound だけを偽にし、ほかの失敗は投げる
  versionExists: (qualifier: string) => Promise<boolean>;
  // この名前のスタック。存在しないときだけ null
  describeStack: (name: string) => Promise<BootstrapStack | null>;
};

export type QualifierTarget = { qualifier: string; stackName: string; tags: Record<string, string> };

export type QualifierCheck = { ok: true; mode: "create" | "update" } | { ok: false; reason: string };

const SETTLED = ["CREATE_COMPLETE", "UPDATE_COMPLETE"];

function refuse(reason: string): QualifierCheck {
  return { ok: false, reason };
}

function judgeStack(target: QualifierTarget, stack: BootstrapStack): QualifierCheck {
  if (!SETTLED.includes(stack.status)) {
    return refuse(`スタック ${target.stackName} が作成か更新の終わった状態でない（${stack.status}）`);
  }
  if (stack.qualifier !== target.qualifier) {
    return refuse(`スタック ${target.stackName} の qualifier が違う（${stack.qualifier ?? "無し"}。この設置は ${target.qualifier}）`);
  }
  const wrong = Object.entries(target.tags).filter(([key, value]) => stack.tags[key] !== value);
  if (wrong.length > 0) {
    return refuse(`スタック ${target.stackName} のタグがこの設置の値でない（${wrong.map(([key]) => key).join(", ")}）`);
  }
  return { ok: true, mode: "update" };
}

export async function checkQualifier(target: QualifierTarget, reader: BootstrapReader): Promise<QualifierCheck> {
  let used: boolean;
  let stack: BootstrapStack | null;
  try {
    used = await reader.versionExists(target.qualifier);
    stack = await reader.describeStack(target.stackName);
  } catch (e) {
    return refuse(`bootstrap の状態を読めない（${e instanceof Error ? e.message : String(e)}）`);
  }
  if (stack) return judgeStack(target, stack);
  if (used) return refuse(`qualifier ${target.qualifier} は別の bootstrap が使っている`);
  return { ok: true, mode: "create" };
}
