import { z } from "zod";

// 画面の設定の値（配信の置き場の /config.json）の形。反映のときにスタックが書き、画面が起動時に読む。
// authority は利用者プールのドメインの URL（例 https://acme-test.auth.us-west-2.amazoncognito.com）で、
// 画面はここから認可と token の端点を作る
export const webConfigSchema = z.strictObject({
  api_url: z.url(),
  authority: z.url(),
  client_id: z.string().min(1),
  // Google のクライアントの ID が設定に入るまで偽。偽の間は画面がログインへ送らない
  login_ready: z.boolean(),
});

export type WebConfig = z.infer<typeof webConfigSchema>;
