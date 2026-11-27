import { type ReactNode, useId, useState } from "react";
import { Link } from "react-router";
import { useI18n } from "../i18n/context.ts";
import { type NavId, routePath } from "../routes/route-table.ts";

export type Place = { to: string; name: string };

export type AppFrameProps = {
  current: NavId | null;
  places: readonly Place[];
  // 人を待つもの（承認の依頼と問い）の数
  waiting: number;
  // 止まったオーガナイザーの数
  stopped: number;
  // 今のプロジェクトのスプリントの一覧。プロジェクトを選んでいなければ null
  sprintsPath: string | null;
  banner?: ReactNode;
  children: ReactNode;
};

// 行き先の並びはどの幅でも同じ。下の帯・細い帯・横の帯の形は CSS だけが変える
const ITEMS: { id: NavId; path: string | null; mark: string }[] = [
  { id: "organizers", path: routePath("R2"), mark: "◎" },
  { id: "approvals", path: routePath("R16"), mark: "✓" },
  { id: "sprints", path: null, mark: "▶" },
  { id: "settings", path: routePath("R14"), mark: "⚙" },
];

export function AppFrame({ current, places, waiting, stopped, sprintsPath, banner, children }: AppFrameProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const menu = useId();
  const counts: Partial<Record<NavId, number>> = { organizers: stopped, approvals: waiting };

  const item = ({ id, path, mark }: (typeof ITEMS)[number]) => {
    const count = counts[id] ?? 0;
    const described = `${menu}-${id}`;
    const common = {
      "data-nav": id,
      className: "nd-nav-item",
      "aria-label": t(`nav.${id}`),
      "aria-current": current === id ? ("page" as const) : undefined,
      "aria-describedby": count > 0 ? described : undefined,
    };
    const body = (
      <>
        <span aria-hidden="true">{mark}</span>
        <span>{t(`nav.${id}`)}</span>
        {count > 0 ? (
          <>
            <span data-count aria-hidden="true" className="nd-count">
              {count > 99 ? "99+" : count}
            </span>
            <span id={described} className="nd-visually-hidden">
              {t("nav.waiting", { count })}
            </span>
          </>
        ) : null}
      </>
    );
    const to = id === "sprints" ? sprintsPath : path;
    return (
      <li key={id}>
        {to === null ? (
          <button type="button" {...common} onClick={() => setOpen(true)}>
            {body}
          </button>
        ) : (
          <Link to={to} {...common}>
            {body}
          </Link>
        )}
      </li>
    );
  };

  return (
    <div className="nd-frame">
      <a className="nd-skip" href="#main">
        {t("app.skipToMain")}
      </a>
      <div className="nd-place">
        <button type="button" aria-expanded={open} aria-controls={menu} onClick={() => setOpen(!open)}>
          {t("nav.place")}
        </button>
        <div id={menu}>
          {open ? (
            places.length === 0 ? (
              <p className="nd-note">{t("nav.noPlaces")}</p>
            ) : (
              <ul>
                {places.map((place) => (
                  <li key={place.to}>
                    <Link className="nd-link-block" to={place.to} onClick={() => setOpen(false)}>
                      {place.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </div>
      <nav className="nd-nav" aria-label={t("nav.label")}>
        <ul>{ITEMS.map(item)}</ul>
      </nav>
      <div className="nd-body">
        {banner}
        <main id="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
