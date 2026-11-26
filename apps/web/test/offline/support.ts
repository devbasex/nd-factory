import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { type DeviceDb, openDeviceDb } from "../../src/offline/db.ts";

// 端末のデータの単体テストの準備。テストごとに空の IndexedDB へ替える

/** 作り物の利用者の ID */
export const USER = "usr_example-a";

export function freshIndexedDb(): void {
  globalThis.indexedDB = new IDBFactory();
}

export function openDb(onClosed: () => void = () => {}): Promise<DeviceDb> {
  return openDeviceDb({ onClosed });
}
