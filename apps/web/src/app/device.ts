import { createOwner, deleteDeviceDb, nextSeq, openDeviceDb, readOwner } from "../offline/db.ts";
import { runMigrations } from "../offline/migrate.ts";

// 端末のデータの部品。ログインの切り替え（#4 の「サインインを確定する」呼び出し）までは、本番の起動で呼ばない

export const DEVICE_PARTS = { openDeviceDb, readOwner, createOwner, nextSeq, deleteDeviceDb, runMigrations };
