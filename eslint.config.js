import js from "@eslint/js";
import tseslint from "typescript-eslint";

// 置き場ごとの塊の中身は issues/issue-1-design-detail.md の「ESLint の設定」の表にある（#1 の決定 1・9）

/**
 * #29 が料金プランの名前の書き出しを置いたら真にする。偽の間は書き出しが読めなければ名前の選び方を作らず、
 * 真になった後は読めないと設定の読み込みが失敗する
 */
export const PLAN_EXPORT_REQUIRED = false;

/** 料金プランの名前の書き出し（#29 が置く）。書き出しの `planNames` は名前の文字列の配列 */
const PLAN_EXPORT = "@nd-factory/contracts/plans";

/**
 * 料金プランの名前を読む。`required` が偽なら読めないときに null を返し、真なら例外を投げる。
 * 読めたのに形が文字列の配列でなければ、`required` によらず例外を投げる
 */
export async function loadPlanNames(load = () => import(PLAN_EXPORT), required = PLAN_EXPORT_REQUIRED) {
  let mod;
  try {
    mod = await load();
  } catch (error) {
    if (required) throw new Error(`料金プランの名前の書き出し ${PLAN_EXPORT} を読めない`, { cause: error });
    return null;
  }
  const names = mod?.planNames;
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === "string" && n.length > 0)) {
    throw new Error(`料金プランの名前の書き出し ${PLAN_EXPORT} の planNames が空でない文字列の配列でない`);
  }
  return names;
}

// 実行時のコードの置き場（`apps/*` の src）。テストのディレクトリと e2e を含まない
const APP_DIRS = ["api", "web", "runner", "nd-runtime", "db-prep"];
const WEB_SRC = ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"];
const API_SRC = ["apps/api/src/**/*.ts", "apps/api/src/**/*.tsx"];
const OTHER_APP_SRC = APP_DIRS.filter((d) => d !== "api" && d !== "web").flatMap((d) => [
  `apps/${d}/src/**/*.ts`,
  `apps/${d}/src/**/*.tsx`,
]);
const INFRA_LIB = ["infra/lib/**/*.ts", "infra/lib/**/*.tsx"];

const BOUNDARY = "は横断の部品だけが使う（#1 の決定 1・プラットフォームの決定 91）";

/** `node:crypto`（`crypto`）のうち、ID と冪等の鍵の生成に当たる関数 */
const CRYPTO_ID_FUNCTIONS = new Set(["randomUUID", "randomBytes"]);
const CRYPTO_SOURCE = /^(node:)?crypto$/;
const CRYPTO_MESSAGE = `ID と冪等の鍵の生成${BOUNDARY}`;

/** 文字列の値（文字列の Literal か、式を持たないテンプレートの文字列）。ほかは null */
function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/** 性質の参照・分割代入の鍵の名前（計算した鍵は文字列の値のときだけ）。ほかは null */
function keyName(key, computed) {
  if (!computed && key.type === "Identifier") return key.name;
  return staticString(key);
}

/** 既定の値つきの束縛（`{ a: c = x }`）の、既定の値 `x` からの書き込みの参照 */
const isDefaultValueWrite = (ref) =>
  ref.writeExpr?.parent?.type === "AssignmentPattern" && ref.writeExpr.parent.right === ref.writeExpr;

/**
 * `node` の評価の値がそのまま評価の値になる親の式（条件の式の分岐・論理の式の両辺・並びの式の最後・
 * 代入の式の右辺と論理の代入の左辺）。`node` はモジュールか約束の値なので、常に真の値として判定する。ほかは null
 */
function passThroughParent(node) {
  const parent = node.parent;
  switch (parent?.type) {
    case "ConditionalExpression":
      return parent.consequent === node || parent.alternate === node ? parent : null;
    case "LogicalExpression":
      // モジュールと約束は常に真なので、`&&` の左辺の値は評価の値にならない
      return parent.right === node || parent.operator !== "&&" ? parent : null;
    case "SequenceExpression":
      return parent.expressions.at(-1) === node ? parent : null;
    case "AssignmentExpression":
      if (parent.right === node) return parent.operator === "=" || LOGICAL_ASSIGN.has(parent.operator) ? parent : null;
      return parent.left === node && LOGICAL_ASSIGN.has(parent.operator) && parent.operator !== "&&=" ? parent : null;
  }
  return null;
}

/** 型だけの import・export の宣言か指定子 */
const typeOnly = (node) => node.importKind === "type" || node.exportKind === "type";

/** 書き込みの印のうち、変数の宣言の時点の値（import の束縛・関数の引数） */
const INITIAL = Symbol("initial");
/** 読み出し地点に届く書き込みが分からないとき（すべての書き込みが届き得る） */
const ANY = Symbol("any");
/** 右辺を評価するかが左辺の値で決まる代入の演算子 */
const LOGICAL_ASSIGN = new Set(["||=", "&&=", "??="]);
/** 評価の途中でほかのコード（ほかの関数の中の書き込み）が走り得る式 */
const RUNS_OTHER_CODE = new Set(["CallExpression", "NewExpression", "TaggedTemplateExpression", "AwaitExpression", "YieldExpression"]);

/**
 * `node:crypto`（`crypto`）の `randomUUID`・`randomBytes` を、どの書き方で取り出しても落とす規則。
 * `no-restricted-imports` の `importNames` は名前空間の import を丸ごと落とし、既定の import と動的な import
 * からの取り出しを見ないので、モジュールの値を束縛まで追って、対象の関数を取り出したところだけを落とす。
 * 見るのは名前つきの import・名前空間と既定の import の束縛・動的な import（`await` と `.then` の引数。
 * 約束を変数に置いてからのものを含む）・再書き出しで、モジュールの値（とその `.default`）の性質の参照・
 * 分割代入・別の名前への代入（条件の式の分岐・論理の式・連鎖の代入の評価の値を含む）と、モジュールの値を持つ
 * 束縛の書き出しを追う。変数の読み出しは、その地点に届き得る書き込み（コードの道筋で判定する）のどれかが
 * モジュールの値のときだけモジュールとして扱う
 */
const noCryptoIdRule = {
  meta: { type: "problem", schema: [], messages: { banned: CRYPTO_MESSAGE } },
  create(context) {
    const { sourceCode } = context;
    const reported = new Set();
    const report = (node) => {
      if (reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId: "banned" });
    };

    // コードの道筋の区間ごとに、識別子の読み出しと代入・宣言の終わりを出てきた順に記録する
    const segmentEvents = new Map();
    const segmentCodePath = new Map();
    const codePathNode = new Map();
    const positions = new Map();
    const current = [];

    // 分割代入は分割元（既定の値つきの束縛の分割は既定の値）を先に評価するが、節を読む順では分割の形が先に来る。
    // 分割の形の中の出来事は溜めておき、分割元を読んだ後にその順のまま置く。flatRoots は溜めた出来事 → 一番外の分割の形の根
    const buffers = [];
    const pendingBuffers = new Map();
    const flatRoots = new Map();
    /** 分割元の後に評価する分割の形の根（分割元つきの宣言・代入の左辺・既定の値つきの束縛の左辺の分割の形） */
    const isReorderedPattern = (node) => {
      const parent = node.parent;
      if (parent?.type === "VariableDeclarator") return parent.id === node && parent.init !== null && parent.init !== undefined;
      return (parent?.type === "AssignmentExpression" || parent?.type === "AssignmentPattern") && parent.left === node;
    };
    const enterPattern = (node) => {
      if (isReorderedPattern(node)) buffers.push({ root: node, codePath: codePathStack.at(-1), events: [] });
    };
    const exitPattern = (node) => {
      if (isReorderedPattern(node) && buffers.at(-1)?.root === node) pendingBuffers.set(node.parent, buffers.pop());
    };
    /** 分割元を読み終えた分割代入（宣言・代入・既定の値つきの束縛）の、溜めた分割の形の出来事を置く */
    const flushPattern = (node) => {
      const buffer = pendingBuffers.get(node);
      if (buffer === undefined) return;
      pendingBuffers.delete(node);
      buffer.events.forEach(record);
    };

    const record = (node) => {
      const buffer = buffers.at(-1);
      if (buffer !== undefined && buffer.codePath === codePathStack.at(-1)) {
        buffer.events.push(node);
        // 入れ子の分割の形は外の形へ溜め直すので、最後に溜めた一番外の根が残る
        flatRoots.set(node, buffer.root);
        return;
      }
      const at = [];
      for (const segment of current.at(-1) ?? []) {
        const events = segmentEvents.get(segment);
        at.push({ segment, index: events.length });
        events.push(node);
      }
      positions.set(node, at);
    };
    const startSegment = (segment) => {
      current.at(-1).add(segment);
      segmentEvents.set(segment, []);
      segmentCodePath.set(segment, codePathStack.at(-1));
    };
    const endSegment = (segment) => current.at(-1).delete(segment);
    const codePathStack = [];

    // 論理の代入（`c ||= x`・`c &&= x`・`c ??= x`）の書き込みは、右辺を評価した道筋の右辺の終わりにだけ置く
    const logicalWriteKeys = new Map();
    const logicalWriteKey = (assignment) => {
      if (!logicalWriteKeys.has(assignment)) logicalWriteKeys.set(assignment, { logicalWrite: assignment });
      return logicalWriteKeys.get(assignment);
    };

    // import の式と import の宣言の束縛は、すべての節を読んだ後に追う（届く書き込みの判定に道筋が要る）
    const seeds = [];

    function findVariable(node, name) {
      for (let scope = sourceCode.getScope(node); scope !== null; scope = scope.upper) {
        const found = scope.set.get(name);
        if (found !== undefined) return found;
      }
      return null;
    }

    /**
     * 書き込みの参照の評価が終わる地点（代入の式・宣言の終わり。論理の代入は右辺を評価した道筋の右辺の終わり。
     * 既定の値つきの束縛は既定の値の後、ほかの分割代入と引数の束縛は識別子そのもの。分割の形の出来事は分割元の
     * 後に置くので、束縛はそれぞれ分割元と既定の値の後に順に書き込み、後の束縛の既定の値は先の束縛を読める）
     */
    function writePosition(identifier) {
      const parent = identifier.parent;
      if (parent?.type === "VariableDeclarator" && parent.id === identifier) return parent;
      if (parent?.type === "AssignmentExpression" && parent.left === identifier) {
        return LOGICAL_ASSIGN.has(parent.operator) ? logicalWriteKey(parent) : parent;
      }
      if (parent?.type === "AssignmentPattern" && parent.left === identifier) return parent;
      return identifier;
    }

    /**
     * 溜めて分割元の後に置いた出来事のうち、分割の形の中で評価するかが分かれる地点（既定の値・条件の式の分岐・
     * 論理の式と論理の代入の右辺・省略できる連鎖）の書き込み。溜めた出来事は分かれ道を持たないので、
     * この書き込みは届く書き込みを打ち切らない
     */
    function isConditionalFlatWrite(event) {
      const root = flatRoots.get(event);
      if (root === undefined) return false;
      if (event.logicalWrite !== undefined) return true;
      for (let node = event; node !== root && node.parent; node = node.parent) {
        const parent = node.parent;
        if (parent.type === "ChainExpression") return true;
        if (parent.type === "ConditionalExpression" && parent.test !== node) return true;
        if ((parent.type === "AssignmentPattern" || parent.type === "LogicalExpression") && parent.right === node) return true;
        if (parent.type === "AssignmentExpression" && parent.right === node && LOGICAL_ASSIGN.has(parent.operator)) return true;
      }
      return false;
    }

    const contains = (outer, inner) => outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];

    const functionOf = (ref) => ref.from.variableScope.block;
    const reachCache = new Map();

    /**
     * 読み出しの参照に届き得る書き込みの参照（と INITIAL）の集まり。分からなければ ANY を含む。
     * ほかの関数の中の書き込みは、読み出しの関数の中の書き込みを経ずに読み出しへ届く道筋に、ほかのコードが
     * 走り得る地点（呼び出し・await・yield）か関数の入り口があるときだけ届き得るものとする
     */
    function reachingWrites(variable, readRef) {
      if (reachCache.has(readRef)) return reachCache.get(readRef);
      const result = new Set();
      const writesAt = new Map();
      const outerWrites = [];
      for (const ref of variable.references) {
        if (!ref.isWrite()) continue;
        if (functionOf(ref) !== functionOf(readRef)) {
          outerWrites.push(ref);
          continue;
        }
        // 既定の値つきの分割代入は、同じ識別子に分割元と既定の値の書き込みの参照が同じ地点で並ぶ
        const key = writePosition(ref.identifier);
        writesAt.set(key, [...(writesAt.get(key) ?? []), ref]);
      }
      // 既定の値つきの引数（とその分割代入の束縛）は、呼び出し元が渡した値（INITIAL）も既定の値と同じ地点で書き込む
      for (const [key, writes] of writesAt) {
        const inParams = (def) => def.type === "Parameter" && def.node.params.some((param) => contains(param, key));
        if (key.range !== undefined && variable.defs.some(inParams)) {
          writes.push(INITIAL);
        }
      }
      const addOuter = () => outerWrites.forEach((ref) => result.add(ref));
      const home = variable.scope.variableScope.block;
      const visited = new Set();
      const scan = (segment, before) => {
        const events = segmentEvents.get(segment) ?? [];
        for (let i = before - 1; i >= 0; i--) {
          const writes = writesAt.get(events[i]);
          if (writes !== undefined) {
            writes.forEach((ref) => result.add(ref));
            if (!isConditionalFlatWrite(events[i])) return;
          }
          if (RUNS_OTHER_CODE.has(events[i].type)) addOuter();
        }
        if (segment.prevSegments.length === 0) {
          result.add(codePathNode.get(segmentCodePath.get(segment)) === home ? INITIAL : ANY);
          return;
        }
        for (const prev of segment.prevSegments) {
          if (visited.has(prev)) continue;
          visited.add(prev);
          scan(prev, (segmentEvents.get(prev) ?? []).length);
        }
      };
      const at = positions.get(readRef.identifier) ?? [];
      if (at.length === 0) result.add(ANY);
      for (const { segment, index } of at) scan(segment, index);
      reachCache.set(readRef, result);
      return result;
    }

    // 変数ごとの、モジュール（module）か import の約束（promise）の値を持つ書き込み
    const valueWrites = new Map();

    const isExported = (variable) =>
      variable.defs.some((def) => def.node.parent?.parent?.type === "ExportNamedDeclaration");

    /** 変数の書き込み `write`（参照か INITIAL）が `kind` の値を持つとき、届く読み出しを追う */
    function trackWrite(variable, write, kind) {
      if (variable === null) return;
      let writes = valueWrites.get(variable);
      if (writes === undefined) valueWrites.set(variable, (writes = new Map()));
      const kinds = writes.get(write) ?? new Set();
      if (kinds.has(kind)) return;
      kinds.add(kind);
      writes.set(write, kinds);
      // モジュールの値を持つ束縛の書き出しは、別のファイルからの取り出しを止められないので落とす
      if (isExported(variable)) variable.defs.forEach((def) => report(def.name));
      for (const ref of variable.references) {
        if (!ref.isRead() || ref.isValueReference === false) continue;
        // `export { c }` は束縛そのものを書き出すので、届く書き込みによらず落とす
        if (ref.identifier.parent?.type === "ExportSpecifier") {
          report(ref.identifier.parent);
          continue;
        }
        const reaching = reachingWrites(variable, ref);
        if (reaching.has(write) || reaching.has(ANY)) checkValue(ref.identifier, kind);
      }
    }

    /**
     * 値を受ける束縛の形（識別子・分割代入・既定の値つき）。`initial` は関数の引数のとき真。
     * `defaultValue` は値が既定の値つきの束縛の既定の値 `x`（`c = x`）のときの、その式
     */
    function checkTarget(target, kind, initial = false, defaultValue = null) {
      if (target.type === "AssignmentPattern") return checkTarget(target.left, kind, initial, defaultValue);
      if (target.type === "Identifier") {
        const variable = findVariable(target, target.name);
        if (variable === null) return;
        // 既定の値つきの分割代入は既定の値からの書き込みの参照も持つので、値の出所に合う書き込みを選ぶ
        const write = defaultValue !== null
          ? variable.references.find((ref) => ref.identifier === target && ref.writeExpr === defaultValue)
          : initial
          ? INITIAL
          : variable.references.find((ref) => ref.identifier === target && !isDefaultValueWrite(ref));
        return trackWrite(variable, write ?? INITIAL, kind);
      }
      if (kind === "module" && target.type === "ObjectPattern") return checkPattern(target, initial, defaultValue);
    }

    /** `defaultValue` は分割する値が既定の値（`{ default: c } = x`）のときの、その式。中の束縛まで渡す */
    function checkPattern(pattern, initial, defaultValue) {
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") {
          checkTarget(prop.argument, "module", initial, defaultValue);
          continue;
        }
        const name = keyName(prop.key, prop.computed);
        if (CRYPTO_ID_FUNCTIONS.has(name)) report(prop);
        else if (name === "default") checkTarget(prop.value, "module", initial, defaultValue);
      }
    }

    const checkValue = (node, kind) => (kind === "module" ? checkModuleValue(node) : checkImportPromise(node));

    /** `node` の評価の値がモジュール（かその `.default`）のとき、その使われ方を見る */
    function checkModuleValue(node) {
      const parent = node.parent;
      const through = passThroughParent(node);
      if (through !== null) checkModuleValue(through);
      switch (parent?.type) {
        case "TSAsExpression":
        case "TSNonNullExpression":
        case "TSSatisfiesExpression":
        case "TSTypeAssertion":
        case "ChainExpression":
        case "AwaitExpression":
          return checkModuleValue(parent);
        case "MemberExpression": {
          if (parent.object !== node) return;
          const name = keyName(parent.property, parent.computed);
          if (CRYPTO_ID_FUNCTIONS.has(name)) return report(parent);
          if (name === "default") return checkModuleValue(parent);
          return;
        }
        case "VariableDeclarator":
          if (parent.init === node) checkTarget(parent.id, "module");
          return;
        case "AssignmentExpression":
          if (parent.right === node && passThroughParent(node) !== null) checkTarget(parent.left, "module");
          return;
        case "AssignmentPattern":
          if (parent.right === node) checkTarget(parent.left, "module", false, node);
          return;
        case "ExportDefaultDeclaration":
          return report(parent);
      }
    }

    /** 動的な import の約束の値（`await` か `.then` の関数の最初の引数・変数への保存）を見る */
    function checkImportPromise(node) {
      const parent = node.parent;
      const through = passThroughParent(node);
      if (through !== null) checkImportPromise(through);
      switch (parent?.type) {
        case "TSAsExpression":
        case "TSNonNullExpression":
        case "TSSatisfiesExpression":
        case "TSTypeAssertion":
          return checkImportPromise(parent);
        case "AwaitExpression":
          return checkModuleValue(parent);
        case "VariableDeclarator":
          if (parent.init === node) checkTarget(parent.id, "promise");
          return;
        case "AssignmentExpression":
          if (parent.right === node && passThroughParent(node) !== null) checkTarget(parent.left, "promise");
          return;
        case "AssignmentPattern":
          if (parent.right === node) checkTarget(parent.left, "promise", false, node);
          return;
        case "ExportDefaultDeclaration":
          return report(parent);
        case "MemberExpression":
          if (
            parent.object === node &&
            keyName(parent.property, parent.computed) === "then" &&
            parent.parent?.type === "CallExpression" &&
            parent.parent.callee === parent
          ) {
            const param = parent.parent.arguments[0]?.params?.[0];
            if (param !== undefined) checkTarget(param, "module", true);
          }
      }
    }

    const isCryptoSource = (source) => CRYPTO_SOURCE.test(staticString(source) ?? "");

    return {
      onCodePathStart(codePath, node) {
        codePathStack.push(codePath);
        codePathNode.set(codePath, node);
        current.push(new Set());
      },
      onCodePathEnd() {
        codePathStack.pop();
        current.pop();
      },
      onCodePathSegmentStart: startSegment,
      onCodePathSegmentEnd: endSegment,
      onUnreachableCodePathSegmentStart: startSegment,
      onUnreachableCodePathSegmentEnd: endSegment,
      Identifier: record,
      ObjectPattern: enterPattern,
      ArrayPattern: enterPattern,
      "ObjectPattern:exit": exitPattern,
      "ArrayPattern:exit": exitPattern,
      // 分割元を読み終えたので、溜めた分割の形の出来事を置いてから、代入・宣言・束縛の終わりを置く
      ...Object.fromEntries(
        ["VariableDeclarator", "AssignmentExpression", "AssignmentPattern"].map((type) => [
          `${type}:exit`,
          (node) => {
            flushPattern(node);
            record(node);
          },
        ]),
      ),
      // ほかのコードが走り得る地点（ほかの関数の中の書き込みが届き得る）
      ...Object.fromEntries([...RUNS_OTHER_CODE].map((type) => [`${type}:exit`, record])),
      "*:exit"(node) {
        const parent = node.parent;
        if (parent?.type === "AssignmentExpression" && parent.right === node && LOGICAL_ASSIGN.has(parent.operator)) {
          record(logicalWriteKey(parent));
        }
      },
      ImportDeclaration(node) {
        if (!isCryptoSource(node.source) || typeOnly(node)) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (typeOnly(spec)) continue;
            const name = keyName(spec.imported, false);
            if (CRYPTO_ID_FUNCTIONS.has(name)) report(spec);
            else if (name === "default") seeds.push(() => sourceCode.getDeclaredVariables(spec).forEach((v) => trackWrite(v, INITIAL, "module")));
          } else {
            seeds.push(() => sourceCode.getDeclaredVariables(spec).forEach((v) => trackWrite(v, INITIAL, "module")));
          }
        }
      },
      ImportExpression(node) {
        if (isCryptoSource(node.source)) seeds.push(() => checkImportPromise(node));
      },
      ExportNamedDeclaration(node) {
        if (node.source === null || node.source === undefined || !isCryptoSource(node.source) || typeOnly(node)) return;
        for (const spec of node.specifiers) {
          const name = keyName(spec.local, false);
          if (!typeOnly(spec) && (CRYPTO_ID_FUNCTIONS.has(name) || name === "default")) report(spec);
        }
      },
      ExportAllDeclaration(node) {
        if (isCryptoSource(node.source) && !typeOnly(node)) report(node);
      },
      "Program:exit"() {
        for (const seed of seeds) seed();
      },
    };
  },
};

/** このリポジトリの規則（`nd-factory/<名前>`） */
const localPlugin = { rules: { "no-crypto-id": noCryptoIdRule } };

/** `apps/*` の src で、横断の部品の外での直の利用を落とす選び方（`no-restricted-syntax` 以外） */
const boundaryRules = {
  "nd-factory/no-crypto-id": "error",
  "no-restricted-properties": [
    "error",
    { object: "Date", property: "now", message: `時計${BOUNDARY}` },
    { object: "Math", property: "random", message: `ID と冪等の鍵の生成${BOUNDARY}` },
    { object: "crypto", property: "randomUUID", message: `ID と冪等の鍵の生成${BOUNDARY}` },
    { object: "crypto", property: "getRandomValues", message: `ID と冪等の鍵の生成${BOUNDARY}` },
  ],
  "no-restricted-globals": [
    "error",
    {
      globals: [
        { name: "console", message: `ログと伏せ字${BOUNDARY}` },
        { name: "fetch", message: `外部の呼び出し${BOUNDARY}` },
      ],
      checkGlobalObject: true,
      // Node.js の大域のオブジェクト `global` からの参照も落とす（既定は globalThis・self・window）
      globalObjects: ["global"],
    },
  ],
  "@typescript-eslint/no-restricted-imports": [
    "error",
    {
      paths: [
        // Node.js は `node:` を付けない指定子も受け付けるので、両方の表記を落とす
        ...["node:http", "http", "node:https", "https"].map((name) => ({
          name,
          message: `外部の呼び出し${BOUNDARY}`,
          allowTypeImports: true,
        })),
        { name: "uuid", message: `ID と冪等の鍵の生成${BOUNDARY}`, allowTypeImports: true },
        { name: "node:console", message: `ログと伏せ字${BOUNDARY}`, allowTypeImports: true },
        { name: "console", message: `ログと伏せ字${BOUNDARY}`, allowTypeImports: true },
      ],
      patterns: [
        {
          group: ["@aws-sdk/*"],
          message: `外部の呼び出し・条件つきの書き込み・操作の記録の書き手${BOUNDARY}`,
          allowTypeImports: true,
        },
      ],
    },
  ],
};

/**
 * 動的な import（`import("…")`）で丸ごと落とす指定子。静的な import は `no-restricted-imports` が落とすが、
 * 動的な import には掛からないので `no-restricted-syntax` で同じ対象を落とす
 */
const DYNAMIC_IMPORT_BANS = [
  { source: "^@aws-sdk\\x2F", message: `外部の呼び出し・条件つきの書き込み・操作の記録の書き手${BOUNDARY}` },
  { source: "^(node:)?https?$", message: `外部の呼び出し${BOUNDARY}` },
  { source: "^uuid$", message: `ID と冪等の鍵の生成${BOUNDARY}` },
  { source: "^(node:)?console$", message: `ログと伏せ字${BOUNDARY}` },
];
const dynamicImportSyntax = DYNAMIC_IMPORT_BANS.flatMap(({ source, message }) => [
  { selector: `ImportExpression[source.value=/${source}/]`, message },
  { selector: `ImportExpression > TemplateLiteral > TemplateElement[value.cooked=/${source}/]`, message },
]);

/**
 * 大域のオブジェクトからの分割代入（`const { console } = globalThis`）。`no-restricted-globals` の
 * `checkGlobalObject` は性質の参照だけを見るので、分割代入は `no-restricted-syntax` で落とす
 */
const GLOBAL_OBJECT_NAME = "/^(globalThis|global|window|self)$/";
const RESTRICTED_GLOBAL_KEY = ":matches([key.name=/^(console|fetch)$/], [key.value=/^(console|fetch)$/])";
const globalDestructureSyntax = [
  `VariableDeclarator[init.name=${GLOBAL_OBJECT_NAME}] > ObjectPattern > Property${RESTRICTED_GLOBAL_KEY}`,
  `AssignmentExpression[right.name=${GLOBAL_OBJECT_NAME}] > ObjectPattern > Property${RESTRICTED_GLOBAL_KEY}`,
].map((selector) => ({ selector, message: `ログと伏せ字・外部の呼び出し${BOUNDARY}` }));

/** `apps/*` の src で、時計と条件つきの書き込みと動的な import と大域のオブジェクトからの分割代入を落とす `no-restricted-syntax` の選び方 */
const boundarySyntax = [
  ...dynamicImportSyntax,
  ...globalDestructureSyntax,
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: `時計${BOUNDARY}` },
  { selector: "Property[key.name='ConditionExpression']", message: `条件つきの書き込み${BOUNDARY}` },
  { selector: "Property[key.value='ConditionExpression']", message: `条件つきの書き込み${BOUNDARY}` },
];

/** 画面・`apps/api`・`infra/lib` で経路の直書きを落とす選び方（I14・K2-2・K2-3）。`\x2F` は `/` */
const ROUTE_MESSAGE = "HTTP の経路は形の正本の経路の登録の書き出しからだけ読む（I14）";
const routeSyntax = [
  { selector: "Literal[value=/\\x2Fv1\\x2F/]", message: ROUTE_MESSAGE },
  { selector: "TemplateElement[value.raw=/\\x2Fv1\\x2F/]", message: ROUTE_MESSAGE },
];

/** 選び方の文字列の値に置けるよう、`\` と `"` を逃がす */
function selectorString(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * 正規表現に置けるよう、記号を UTF-16 の符号単位ごとに `\uXXXX` の形に逃がす（`/` を含めて選び方の区切りに
 * 当たらないようにする。`\x` は 2 桁しか読まないので全角の記号に使えない）
 */
function regexpLiteral(value) {
  return value.replace(/[^\p{L}\p{N} _-]/gu, (c) =>
    Array.from({ length: c.length }, (_, i) => `\\u${c.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""),
  );
}

/** 画面で料金プランの名前と同じ文字列を落とす選び方（I8）。JSX の属性の値は Literal、本文は JSXText */
function planSyntax(planNames) {
  const message = "画面は料金プランの名前で分けない。API が返す「使えるか」と理由のコードだけを見る（I8）";
  return planNames.flatMap((name) => [
    { selector: `Literal[value=${selectorString(name)}]`, message },
    { selector: `TemplateElement[value.cooked=${selectorString(name)}]`, message },
    { selector: `JSXText[value=/^\\s*${regexpLiteral(name)}\\s*$/]`, message },
  ]);
}

/** `apps/web` の外の `*.tsx` を 1 ファイル 1 件で落とす選び方（プラットフォームの決定 140） */
const tsxOutsideWebSyntax = [
  { selector: "Program", message: "画面（apps/web）の外は TSX を使わない（プラットフォームの決定 140）" },
];

/** `files` の glob のうち `*.ts` だけ・`*.tsx` だけを取り出す */
const onlyTs = (globs) => globs.filter((g) => g.endsWith(".ts"));
const onlyTsx = (globs) => globs.filter((g) => g.endsWith(".tsx"));

/**
 * 設定を組む。ESLint は同じ規則を後の塊で上書きするので、同じファイルに掛かる `no-restricted-syntax` の
 * 選び方は、置き場が重なる組ごとに 1 つの塊へまとめる。`planNames` が null なら名前の選び方を作らない
 */
export function buildConfig({ planNames }) {
  const plan = planNames === null ? [] : planSyntax(planNames);
  const syntax = (...groups) => ({ "no-restricted-syntax": ["error", ...groups.flat()] });
  return tseslint.config(
    {
      ignores: ["**/node_modules/**", "**/dist/**", "**/cdk.out/**", "**/test-results/**", "**/playwright-report/**"],
    },
    {
      // 除外の注釈が使われなくなったら誤りにする（#1 の決定 9）。files を持たないのですべての塊に掛かる
      linterOptions: { reportUnusedDisableDirectives: "error" },
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ["**/*.ts", "**/*.tsx"],
      rules: {
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
        "@typescript-eslint/consistent-type-imports": "error",
      },
    },
    { files: [...WEB_SRC, ...API_SRC, ...OTHER_APP_SRC], plugins: { "nd-factory": localPlugin }, rules: boundaryRules },
    // 画面の大域のオブジェクトを知らせ、`window.fetch` と `self.fetch` も `checkGlobalObject` で落とす
    { files: WEB_SRC, languageOptions: { globals: { window: "readonly", self: "readonly" } } },
    // Node.js の大域のオブジェクトを知らせ、`global.console` と `global.fetch` も `checkGlobalObject` で落とす
    { files: [...API_SRC, ...OTHER_APP_SRC], languageOptions: { globals: { global: "readonly" } } },
    // 画面: 横断の部品・料金プランの名前・経路
    { files: WEB_SRC, rules: syntax(boundarySyntax, plan, routeSyntax) },
    // apps/api: 横断の部品・経路（*.tsx は画面の外の TSX も）
    { files: onlyTs(API_SRC), rules: syntax(boundarySyntax, routeSyntax) },
    { files: onlyTsx(API_SRC), rules: syntax(boundarySyntax, routeSyntax, tsxOutsideWebSyntax) },
    // ほかの apps/*: 横断の部品（*.tsx は画面の外の TSX も）
    { files: onlyTs(OTHER_APP_SRC), rules: syntax(boundarySyntax) },
    { files: onlyTsx(OTHER_APP_SRC), rules: syntax(boundarySyntax, tsxOutsideWebSyntax) },
    // infra/lib: 経路（*.tsx は画面の外の TSX も）
    { files: onlyTs(INFRA_LIB), rules: syntax(routeSyntax) },
    { files: onlyTsx(INFRA_LIB), rules: syntax(routeSyntax, tsxOutsideWebSyntax) },
    // 上のどれにも当たらない、apps/web の外の *.tsx
    {
      files: ["**/*.tsx"],
      ignores: ["apps/web/**", ...onlyTsx(API_SRC), ...onlyTsx(OTHER_APP_SRC), ...onlyTsx(INFRA_LIB)],
      rules: syntax(tsxOutsideWebSyntax),
    },
  );
}

export default buildConfig({ planNames: await loadPlanNames() });
