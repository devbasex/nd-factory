import { fileURLToPath } from "node:url";
import type { Settings } from "@nd-factory/contracts/settings";
import { CfnOutput, Duration, SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Distribution, PriceClass, S3OriginAccessControl, ViewerProtocolPolicy } from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import {
  OAuthScope,
  ProviderAttribute,
  UserPool,
  UserPoolClientIdentityProvider,
  UserPoolIdentityProviderGoogle,
} from "aws-cdk-lib/aws-cognito";
import { AttributeType, Billing, TableV2 } from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { appResourceNames, applyTags, loginDomainUrl } from "./naming.ts";

// 縦の切れ端のスタック: 利用者プール・画面の配信・API・利用者の表・画面の設定の値。
// 戻り先の URL が配信の名前を要り、画面の設定の値がすべてを要るため、1 つのスタックに置く

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const API_ENTRY = fileURLToPath(new URL("../../apps/api/src/users-handler.ts", import.meta.url));
const LOCK_FILE = fileURLToPath(new URL("../../package-lock.json", import.meta.url));

export type AppStackProps = StackProps & {
  settings: Settings;
  // 画面のビルドの出力（apps/web/dist）。テストは一時のディレクトリを渡す
  webDistPath: string;
};

export class AppStack extends Stack {
  // 配信の置き場の config.json に書く値。反映のときに値が決まる部分はトークンのまま持つ
  readonly webConfig: { api_url: string; authority: string; client_id: string; login_ready: boolean };

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const s = props.settings;
    const names = appResourceNames(s);
    const clientId = s.login.google.client_id;

    // 利用者の表。要求の数の課金にし、時間で費用を掛けない
    const table = new TableV2(this, "UsersTable", {
      tableName: names.usersTable,
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billing: Billing.onDemand(),
    });

    // 経路の Lambda。Docker を使わず手元の esbuild で束ねる
    const fn = new NodejsFunction(this, "UsersFunction", {
      functionName: names.usersFunction,
      entry: API_ENTRY,
      handler: "handler",
      projectRoot: REPO_ROOT,
      depsLockFilePath: LOCK_FILE,
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { USERS_TABLE: table.tableName },
      // SDK も束ねる。実行環境に入っている SDK の版に頼らず、package-lock.json の版で動かす
      bundling: { forceDockerBundling: false, target: "node24", sourceMap: false, minify: true, externalModules: [] },
    });
    table.grantReadWriteData(fn);

    // 画面の配信。置き場は公開せず、CloudFront だけが OAC で読む
    const webBucket = new Bucket(this, "WebBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });
    const oac = new S3OriginAccessControl(this, "WebOriginAccess", { originAccessControlName: names.webOriginAccess });
    const distribution = new Distribution(this, "WebDistribution", {
      comment: names.distributionComment,
      defaultRootObject: "index.html",
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(webBucket, { originAccessControl: oac }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });
    const webOrigin = `https://${distribution.distributionDomainName}`;
    const webRoot = `${webOrigin}/`;

    // Google の secret の器。値は自動で作り、人が本物の値で上書きする。生成の設定と名前は設定の値で変えない
    // （変えると器に新しい版ができ、人が入れた値を上書きしたかを版で見分けられなくなる）
    const googleSecret = new Secret(this, "GoogleOAuthSecret", {
      secretName: names.googleSecret,
      description: "Google の OAuth クライアントの secret。人が本物の値を入れる",
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    // 利用者プール。自分の登録を止め、利用者は Google の IdP からだけ入る
    const userPool = new UserPool(this, "UserPool", {
      userPoolName: names.userPool,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
    });
    userPool.addDomain("LoginDomain", { cognitoDomain: { domainPrefix: names.loginDomain } });

    let google: UserPoolIdentityProviderGoogle | undefined;
    if (clientId) {
      google = new UserPoolIdentityProviderGoogle(this, "GoogleIdp", {
        userPool,
        clientId,
        // 合成の出力に値を持たない動的な参照で渡す
        clientSecretValue: SecretValue.secretsManager(googleSecret.secretArn),
        scopes: ["openid", "email", "profile"],
        attributeMapping: { email: ProviderAttribute.GOOGLE_EMAIL },
      });
    }

    const client = userPool.addClient("WebClient", {
      userPoolClientName: names.webClient,
      generateSecret: false,
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [google ? UserPoolClientIdentityProvider.GOOGLE : UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [webRoot],
        logoutUrls: [webRoot],
      },
    });
    if (google) client.node.addDependency(google);

    // API。認証の無い要求は JWT の認可で拒み、Lambda を起こさない
    const authorizer = new HttpJwtAuthorizer("Jwt", `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`, {
      authorizerName: names.jwtAuthorizer,
      jwtAudience: [client.userPoolClientId],
    });
    const api = new HttpApi(this, "Api", {
      apiName: names.api,
      corsPreflight: {
        allowOrigins: [webOrigin],
        allowMethods: [CorsHttpMethod.PUT],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });
    api.addRoutes({
      path: "/v1/users",
      methods: [HttpMethod.PUT],
      integration: new HttpLambdaIntegration("UsersIntegration", fn),
      authorizer,
    });

    this.webConfig = {
      api_url: api.apiEndpoint,
      authority: loginDomainUrl(s, this.region),
      client_id: client.userPoolClientId,
      // Google のクライアントの ID が入るまでは、画面はログインへ送らずに設定の待ちを示す
      login_ready: clientId !== undefined,
    };

    new BucketDeployment(this, "WebDeployment", {
      sources: [Source.asset(props.webDistPath), Source.jsonData("config.json", this.webConfig)],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    new CfnOutput(this, "WebUrl", { value: webRoot });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });

    applyTags(this, s);
  }
}
