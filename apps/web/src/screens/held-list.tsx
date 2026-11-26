import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/context.ts";
import { operationKey } from "../i18n/translate.ts";
import type { AuthzRecord } from "../offline/authz.ts";
import { type HeldStore, type HeldView, visibleFieldsOf } from "../offline/held-store.ts";
import type { unreadableQuarantine } from "../offline/quarantine.ts";
import { Button } from "../ui/button.tsx";
import { ConfirmDialog } from "../ui/confirm-dialog.tsx";
import { TimeText } from "../ui/time-text.tsx";

// 保留の一覧。送らなかった件と拒まれた件を出し、本人が確認のダイアログで確定した件だけを破棄する

export type HeldListProps = {
  store: HeldStore;
  // 持ち主の読めない隔離の件。access token を取り直すまでは null
  quarantined: Extract<Awaited<ReturnType<typeof unreadableQuarantine>>, object> | null;
  open: boolean;
  // 見られる対象の記録。出す項目はこれで絞る
  record: () => Promise<AuthzRecord | null>;
  onClose: () => void;
  onChanged: () => void;
  // このタブの利用者かセッションが替わっていた
  onStale: () => void;
};

type Target = { answerTag: string; quarantined: boolean };

// 利用者が入力した文と選んだ答え。入力の中の ID などは名前で分けられないため、文字列の値だけを並べる
function inputTexts(input: unknown): string[] {
  return typeof input === "object" && input !== null ? Object.values(input).filter((v) => typeof v === "string") : [];
}

function Held({ view, onDiscard }: { view: HeldView; onDiscard: () => void }) {
  const { t } = useI18n();
  return (
    <li className="nd-held-item">
      <p>{t(`held.reason.${view.holdReason}`)}</p>
      {view.operation === undefined ? (
        <p>
          {t("held.unreadable")}（{t(`held.kind.${view.unreadableKind!}`)}）
        </p>
      ) : (
        <p>
          {t(operationKey(view.operation))} <TimeText iso={new Date(view.pressedAt!).toISOString()} mode="absolute" />
        </p>
      )}
      {view.content === null ? (
        view.operation === undefined ? null : <p className="nd-note">{t("held.hidden")}</p>
      ) : (
        inputTexts(view.content.input).map((text, i) => <p key={i}>{text}</p>)
      )}
      <Button onClick={onDiscard}>{t("held.discard")}</Button>
    </li>
  );
}

function OpenList({ store, quarantined, record, onClose, onChanged, onStale }: HeldListProps) {
  const { t } = useI18n();
  const [views, setViews] = useState<HeldView[]>([]);
  const [target, setTarget] = useState<Target | null>(null);
  const [failed, setFailed] = useState(false);

  const read = useCallback(async () => {
    const items = await store.list();
    // 記録を読んでから反映するまでの間に、ほかの処理を挟まない
    const current = await record();
    setViews(items.map((item) => visibleFieldsOf(item, current)));
  }, [store, record]);
  // 件数が変わるたびに quarantined が新しくなるので、そのたびに読み直す
  useEffect(() => void read(), [read, quarantined, onChanged]);

  async function discard({ answerTag, quarantined: isolated }: Target) {
    setTarget(null);
    setFailed(false);
    try {
      if (!isolated) await store.discard(answerTag);
      else if ((await quarantined!.discard(answerTag)) === "stale") {
        onClose();
        onStale();
        return;
      }
      await read();
      onChanged();
    } catch {
      setFailed(true);
    }
  }

  return (
    <section className="nd-held" role="dialog" aria-label={t("held.title")}>
      <h2>{t("held.title")}</h2>
      {failed ? (
        <p className="nd-error" role="alert">
          {t("held.discardFailed")}
        </p>
      ) : null}
      <ul>
        {views.map((view) => (
          <Held key={view.answerTag} view={view} onDiscard={() => setTarget({ answerTag: view.answerTag, quarantined: false })} />
        ))}
        {quarantined?.items.map(({ answerTag, kind }) => (
          <li className="nd-held-item" key={answerTag}>
            <p>
              {t("held.unreadable")}（{t(`held.kind.${kind}`)}）
            </p>
            <Button onClick={() => setTarget({ answerTag, quarantined: true })}>{t("held.discard")}</Button>
          </li>
        ))}
      </ul>
      <Button onClick={onClose}>{t("common.close")}</Button>
      <ConfirmDialog
        open={target !== null}
        title={t("held.discardTitle")}
        body={t("held.discardBody")}
        confirmLabel={t("held.discard")}
        onConfirm={() => void discard(target!)}
        onClose={() => setTarget(null)}
      />
    </section>
  );
}

export function HeldListDialog(props: HeldListProps) {
  return props.open ? <OpenList {...props} /> : null;
}
