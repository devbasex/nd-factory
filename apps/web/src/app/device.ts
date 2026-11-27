import { createApiSender } from "../offline/api-transport.ts";
import { addDenied, judgeVisibility, nextAuthz, withAuthzLock } from "../offline/authz.ts";
import { createCacheStore } from "../offline/cache-store.ts";
import { createHeldStore, visibleFieldsOf } from "../offline/held-store.ts";
import { deleteDeviceData, forgetDeviceMemory, recordDiscardConfirmation, settleForSignout } from "../offline/erase.ts";
import { createOwner, deleteDeviceDb, nextSeq, openDeviceDb, readOwner } from "../offline/db.ts";
import { commitGuarded, prepareGuard } from "../offline/guarded-commit.ts";
import { runMigrations } from "../offline/migrate.ts";
import { createDeviceView } from "./device-view.ts";
import { operationClassOf } from "../offline/operation-classes.ts";
import { createLoginStore, sessionFingerprint } from "../offline/login-store.ts";
import { createOutbox } from "../offline/outbox.ts";
import { createPendingStore } from "../offline/pending-store.ts";
import { rollbackQuarantine, SIGNIN_LOCK, unreadableQuarantine } from "../offline/quarantine.ts";
import { createSender } from "../offline/send.ts";
import { createSendWait } from "../offline/send-wait.ts";
import { snapshotKindOf } from "../offline/snapshot-kinds.ts";
import { createSync, type SyncReaders } from "../offline/sync.ts";

// 端末のデータの部品。ログインの切り替え（#4 の「サインインを確定する」呼び出し）までは、本番の起動で呼ばない

// 操作の形が未定の間、本番の読み出しは一時の失敗にする。何も消さない
const temporary = async () => ({ kind: "temporary" as const });
const PENDING_READERS: SyncReaders = {
  projects: temporary,
  teams: temporary,
  transfers: temporary,
  screen: temporary,
  lists: temporary,
  target: async () => "temporary",
};

export const DEVICE_PARTS = {
  createDeviceView,
  createApiSender,
  createSendWait,
  createSender,
  createSync,
  readers: PENDING_READERS,
  openDeviceDb,
  readOwner,
  createOwner,
  nextSeq,
  deleteDeviceDb,
  runMigrations,
  snapshotKindOf,
  judgeVisibility,
  nextAuthz,
  addDenied,
  withAuthzLock,
  prepareGuard,
  commitGuarded,
  createCacheStore,
  operationClassOf,
  createOutbox,
  createHeldStore,
  visibleFieldsOf,
  rollbackQuarantine,
  unreadableQuarantine,
  recordDiscardConfirmation,
  settleForSignout,
  deleteDeviceData,
  forgetDeviceMemory,
  createLoginStore,
  sessionFingerprint,
  createPendingStore,
  signinLock: SIGNIN_LOCK,
};
