import routesData from "@nd-factory/contracts/generated/routes.json" with { type: "json" };
import type { Endpoint } from "@nd-factory/contracts/operation";
import { HttpMethod, type HttpApi, type HttpRoute } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import type { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

// HTTP の経路の部品。形の正本の生成物 routes.json（操作ごとの POST の経路と受け口）のうち、渡した受け口の経路を
// 1 つの関数へつなぐ（決定 8 と同じく、スタックへ入れるのは経路を最初に使う子）。経路を手で書かず、操作の表と食い違わせない

export type { Endpoint };

// 受け口の集まり（形の正本の operation.ts の Endpoint）。型の集まりと食い違えば、下の照らしが型検査で落ちる
export const API_ENDPOINTS = ["user", "runner", "machine", "db_prep"] as const satisfies readonly Endpoint[];
type MissingEndpoint = Exclude<Endpoint, (typeof API_ENDPOINTS)[number]>;
const allEndpoints: [MissingEndpoint] extends [never] ? true : MissingEndpoint = true;
void allEndpoints;

export type ApiRoute = { readonly method: "POST"; readonly path: string; readonly operation: string; readonly endpoint: Endpoint };

export type ApiRoutesProps = {
  readonly api: HttpApi;
  readonly fn: IFunction;
  readonly endpoints: readonly Endpoint[];
};

function isEndpoint(value: unknown): value is Endpoint {
  return typeof value === "string" && (API_ENDPOINTS as readonly string[]).includes(value);
}

// routes.json を照らして読む。形の違う行があれば合成の前に投げる（生成物の古さは CI の check が落とす）
export function loadRoutes(raw: unknown): readonly ApiRoute[] {
  if (!Array.isArray(raw)) throw new Error("routes.json は経路の配列にする");
  const seen = new Set<string>();
  return raw.map((entry: unknown, i): ApiRoute => {
    const r = (entry ?? {}) as Record<string, unknown>;
    if (r["method"] !== "POST") throw new Error(`routes.json の ${i} 番目の method は POST にする`);
    if (typeof r["path"] !== "string" || !r["path"].startsWith("/v1/")) throw new Error(`routes.json の ${i} 番目の path は /v1/ で始める`);
    if (typeof r["operation"] !== "string") throw new Error(`routes.json の ${i} 番目に operation が無い`);
    if (!isEndpoint(r["endpoint"])) throw new Error(`routes.json の ${i} 番目の受け口を知らない: ${JSON.stringify(r["endpoint"])}`);
    if (seen.has(r["path"])) throw new Error(`routes.json の経路が重なる: ${r["path"]}`);
    seen.add(r["path"]);
    return { method: "POST", path: r["path"], operation: r["operation"], endpoint: r["endpoint"] };
  });
}

export const ROUTES: readonly ApiRoute[] = loadRoutes(routesData);

export class ApiRoutes extends Construct {
  readonly routes: readonly HttpRoute[];

  constructor(scope: Construct, id: string, props: ApiRoutesProps) {
    super(scope, id);
    const wanted = new Set<Endpoint>();
    for (const endpoint of props.endpoints) {
      if (!isEndpoint(endpoint)) throw new Error(`知らない受け口: ${JSON.stringify(endpoint)}`);
      if (wanted.has(endpoint)) throw new Error(`受け口が重なる: ${endpoint}`);
      wanted.add(endpoint);
    }
    // 呼び出しの許可は経路ごとに作らず、この API からの呼び出しに限った 1 件を共有する。既定の経路ごとの許可では、
    // user だけで数十の経路があり、関数のリソースベースポリシーが Lambda の上限（20 KB）を超えてデプロイが落ちる
    const integration = new HttpLambdaIntegration("Integration", props.fn, { scopePermissionToRoute: false });
    // 経路は API の下に POST<path> の ID で作る。同じ API へ同じ経路を 2 回登録すると、ID の重なりで合成が投げる
    this.routes = ROUTES.filter((route) => wanted.has(route.endpoint)).flatMap((route) =>
      props.api.addRoutes({ path: route.path, methods: [HttpMethod.POST], integration }),
    );
  }
}
