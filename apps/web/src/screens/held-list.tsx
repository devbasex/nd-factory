import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/context.ts";
import { operationKey } from "../i18n/translate.ts";
import type { HeldStore, HeldView } from "../offline/held-store.ts";
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
  // 出す項目。見られる対象の記録で絞り、セッションの照合が外れたら stale
  read: () => Promise<HeldView[] | "stale">;
  // 見られる対象の記録が書き換わるたびに増える
  authzMark: number;
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

const hidden = (view: HeldView): HeldView => ({ ...view, content: null });

// 読み出した項目と、読み出しを始めたときの記録の世代
type Loaded = { mark: number; views: HeldView[] };

function OpenList({ store, quarantined, read, authzMark, onClose, onChanged, onStale }: HeldListProps) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<Loaded>({ mark: authzMark, views: [] });
  const [target, setTarget] = useState<Target | null>(null);
  const [failed, setFailed] = useState(false);
  // 後に始めた読み出しの結果だけを出す
  const latest = useRef(0);

  const stale = useCallback(() => {
    setLoaded((prev) => ({ ...prev, views: [] }));
    onClose();
    onStale();
  }, [onClose, onStale]);

  const reload = useCallback(async () => {
    const run = ++latest.current;
    const mark = authzMark;
    const next = await read().catch(() => null);
    if (run !== latest.current) return;
    if (next === "stale") return stale();
    // 読めなければ、中身を出さない
    setLoaded((prev) => (next === null ? { mark: prev.mark, views: prev.views.map(hidden) } : { mark, views: next }));
  }, [read, stale, authzMark]);
  // 記録が書き換わった（見られるプロジェクトや割り当てが変わった）後のレンダーでは、新しい世代で
  // 読み直した結果が届くまで中身を出さない。副作用で隠すのを待たず、描く時点で世代を比べる
  const views = loaded.mark === authzMark ? loaded.views : loaded.views.map(hidden);
  // 件数が変わるたびに quarantined が新しくなるので、そのたびに読み直す
  useEffect(() => void reload(), [reload, quarantined, authzMark, onChanged]);

  async function discard({ answerTag, quarantined: isolated }: Target) {
    setTarget(null);
    setFailed(false);
    try {
      const done = isolated ? await quarantined!.discard(answerTag) : await store.discard(answerTag);
      if (done === "stale") return stale();
      await reload();
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
