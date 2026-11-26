import type { WebConfig } from "@nd-factory/contracts/web-config";

// Service Worker を登録し、初回のページが読んだ設定の値を渡して、保存の応答を待つ。
// 初回のページは制御の前に設定を読むため、fetch の規則だけでは保存されない

export async function registerServiceWorker(config: WebConfig): Promise<void> {
  const container = (navigator as Partial<Navigator>).serviceWorker;
  if (container === undefined) throw new Error("Service Worker を使えない");
  await container.register("/sw.js", { scope: "/" });
  const registration = await container.ready;
  const channel = new MessageChannel();
  const saved = new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve();
  });
  registration.active?.postMessage({ type: "config", value: config }, [channel.port2]);
  await saved;
  channel.port1.close();
}
