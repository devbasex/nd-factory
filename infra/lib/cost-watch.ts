import { Stack } from "aws-cdk-lib";
import { CfnBudget } from "aws-cdk-lib/aws-budgets";
import { PolicyStatement, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Topic, TopicPolicy } from "aws-cdk-lib/aws-sns";
import { EmailSubscription } from "aws-cdk-lib/aws-sns-subscriptions";
import { Construct } from "constructs";
import type { BudgetScope } from "@nd-factory/contracts/settings";
import { TAG_KEYS, type AppResourceNames } from "./naming.ts";

// 費用の見張り: 運用の知らせのトピックと宛先の購読、月の予算と 3 つの知らせ

// 実績 80%・100%、見込み 100% でトピックへ送る
export const BUDGET_NOTICES = [
  { type: "ACTUAL", percent: 80 },
  { type: "ACTUAL", percent: 100 },
  { type: "FORECASTED", percent: 100 },
] as const;

export type CostWatchProps = {
  budgetUsd: number;
  budgetScope: BudgetScope;
  emails: readonly string[];
  tags: { prefix: string; env: string };
  names: AppResourceNames;
};

// タグで絞るときは、2 つのタグの両方を持つ費用だけを数える（片方だけでは同じ接頭辞のほかの環境まで数える）
function tagFilter(tags: CostWatchProps["tags"]): CfnBudget.ExpressionProperty {
  const [prefixKey, envKey] = TAG_KEYS;
  return {
    and: [
      { tags: { key: `user:${prefixKey}`, values: [tags.prefix], matchOptions: ["EQUALS"] } },
      { tags: { key: `user:${envKey}`, values: [tags.env], matchOptions: ["EQUALS"] } },
    ],
  };
}

export class CostWatch extends Construct {
  readonly topic: Topic;
  readonly topicPolicy: TopicPolicy;
  readonly budget: CfnBudget;

  constructor(scope: Construct, id: string, props: CostWatchProps) {
    super(scope, id);
    const stack = Stack.of(this);

    // KMS で暗号化しない。暗号化すると予算のサービスに鍵の許しが別に要る
    this.topic = new Topic(this, "Topic", { topicName: props.names.opsTopic });
    for (const email of props.emails) this.topic.addSubscription(new EmailSubscription(email));

    // 予算のサービスに、このアカウントの予算からの発行だけを許す
    this.topicPolicy = new TopicPolicy(this, "TopicPolicy", { topics: [this.topic] });
    this.topicPolicy.document.addStatements(
      new PolicyStatement({
        sid: "AllowBudgetsPublish",
        principals: [new ServicePrincipal("budgets.amazonaws.com")],
        actions: ["SNS:Publish"],
        resources: [this.topic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: { "aws:SourceArn": stack.formatArn({ service: "budgets", region: "", resource: "*" }) },
        },
      }),
    );

    this.budget = new CfnBudget(this, "Budget", {
      budget: {
        budgetName: props.names.budget,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.budgetUsd, unit: "USD" },
        ...(props.budgetScope === "tags" ? { filterExpression: tagFilter(props.tags) } : {}),
      },
      notificationsWithSubscribers: BUDGET_NOTICES.map((n) => ({
        notification: {
          notificationType: n.type,
          comparisonOperator: "GREATER_THAN",
          threshold: n.percent,
          thresholdType: "PERCENTAGE",
        },
        subscribers: [{ subscriptionType: "SNS", address: this.topic.topicArn }],
      })),
    });
    // 予算はトピックの ARN を参照するだけでは方針を待たない。発行を許される前に作ると、予算のサービスがトピックを無効と扱う
    this.budget.node.addDependency(this.topicPolicy);
  }
}
