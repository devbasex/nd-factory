import routes from "@nd-factory/contracts/generated/routes.json" with { type: "json" };
import { App, Stack } from "aws-cdk-lib";
import { HttpApi } from "aws-cdk-lib/aws-apigatewayv2";
import { Template } from "aws-cdk-lib/assertions";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { API_ENDPOINTS, ApiRoutes, loadRoutes, type Endpoint } from "../lib/api-routes.ts";
import { TEST_ENV, resources } from "./support.ts";

// 経路の部品を 1 つの API と 1 つの関数に置いたスタックを合成する（アプリのスタックへは入れない）
function scaffold() {
  const app = new App();
  const stack = new Stack(app, "acme-test-routes", { env: TEST_ENV });
  const api = new HttpApi(stack, "Api", { apiName: "acme-test-api" });
  const fn = new LambdaFunction(stack, "Fn", {
    functionName: "acme-test-api-fn",
    runtime: Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: Code.fromInline("exports.handler = async () => ({ statusCode: 200 });"),
  });
  return { stack, api, fn };
}

function routeKeys(template: Template): string[] {
  return Object.values(resources(template))
    .filter((r) => r.Type === "AWS::ApiGatewayV2::Route")
    .map((r) => String(r.Properties?.["RouteKey"]))
    .sort();
}

function expectedKeys(endpoints: readonly Endpoint[]): string[] {
  return routes
    .filter((r) => (endpoints as readonly string[]).includes(r.endpoint))
    .map((r) => `${r.method} ${r.path}`)
    .sort();
}

describe("ROUTES", () => {
  it("routes.json の受け口はどれも部品の知る受け口で、部品の知る受け口はどれも routes.json に経路を持つ", () => {
    expect([...new Set(routes.map((r) => r.endpoint))].sort()).toEqual([...API_ENDPOINTS].sort());
  });

  it("形の違う行や重なる経路を読むと投げる", () => {
    const ok = { method: "POST", path: "/v1/users/get", operation: "users.get", endpoint: "user" };
    expect(loadRoutes([ok])).toEqual([ok]);
    expect(() => loadRoutes({})).toThrow(/配列/);
    expect(() => loadRoutes([{ ...ok, method: "GET" }])).toThrow(/POST/);
    expect(() => loadRoutes([{ ...ok, path: "/users/get" }])).toThrow(/\/v1\//);
    expect(() => loadRoutes([{ ...ok, operation: 1 }])).toThrow(/operation/);
    expect(() => loadRoutes([{ ...ok, endpoint: "webhook" }])).toThrow(/受け口を知らない/);
    expect(() => loadRoutes([ok, { ...ok, operation: "users.get2" }])).toThrow(/経路が重なる/);
  });
});

describe("ApiRoutes", () => {
  it("すべての受け口を渡すと、routes.json の経路と同じ数と同じ鍵の POST の経路を作る", () => {
    const { stack, api, fn } = scaffold();
    new ApiRoutes(stack, "Routes", { api, fn, endpoints: API_ENDPOINTS });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::ApiGatewayV2::Route", routes.length);
    expect(routeKeys(template)).toEqual(expectedKeys(API_ENDPOINTS));
    expect(routeKeys(template).every((key) => key.startsWith("POST /v1/"))).toBe(true);
  });

  it("受け口 runner だけを渡すと、runner の経路だけを作る", () => {
    const { stack, api, fn } = scaffold();
    const built = new ApiRoutes(stack, "Routes", { api, fn, endpoints: ["runner"] });
    const template = Template.fromStack(stack);
    const runner = expectedKeys(["runner"]);
    expect(runner.length).toBeGreaterThan(0);
    expect(routeKeys(template)).toEqual(runner);
    expect(built.routes).toHaveLength(runner.length);
  });

  it("経路はどれも渡した関数へつなぐ 1 つの統合を通す", () => {
    const { stack, api, fn } = scaffold();
    new ApiRoutes(stack, "Routes", { api, fn, endpoints: ["machine", "db_prep"] });
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::ApiGatewayV2::Integration", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Integration", { IntegrationType: "AWS_PROXY", PayloadFormatVersion: "2.0" });
  });

  it("同じ受け口を 2 回渡すと合成の前に投げる", () => {
    const { stack, api, fn } = scaffold();
    expect(() => new ApiRoutes(stack, "Routes", { api, fn, endpoints: ["runner", "runner"] })).toThrow(/受け口が重なる/);
  });

  it("同じ API へ同じ経路を 2 つの部品で登録すると投げる", () => {
    const { stack, api, fn } = scaffold();
    new ApiRoutes(stack, "UserRoutes", { api, fn, endpoints: ["user"] });
    expect(() => new ApiRoutes(stack, "MoreRoutes", { api, fn, endpoints: ["runner", "user"] })).toThrow();
  });

  it("知らない受け口を型の外から渡すと投げる", () => {
    const { stack, api, fn } = scaffold();
    expect(() => new ApiRoutes(stack, "Routes", { api, fn, endpoints: ["webhook" as Endpoint] })).toThrow(/知らない受け口/);
  });
});
