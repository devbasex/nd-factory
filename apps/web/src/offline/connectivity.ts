// つながりの判定。navigator.onLine と online・offline のイベントを 1 つの値にする。
// onLine が真でも通信が失敗することは、そろえ方が一時の失敗として扱う

export type Connectivity = { online(): boolean; subscribe(listener: () => void): () => void };

export function createConnectivity(win: Window): Connectivity {
  return {
    online: () => win.navigator.onLine,
    subscribe(listener) {
      win.addEventListener("online", listener);
      win.addEventListener("offline", listener);
      return () => {
        win.removeEventListener("online", listener);
        win.removeEventListener("offline", listener);
      };
    },
  };
}
