import { ActionResult } from "./action-result.tsx";
import { AppFrame } from "./app-frame.tsx";
import { Button } from "./button.tsx";
import { Collapsible } from "./collapsible.tsx";
import { ConfirmDialog } from "./confirm-dialog.tsx";
import { DataList } from "./data-list.tsx";
import { DetailList } from "./detail-list.tsx";
import { DocumentBody } from "./document-body.tsx";
import { EmptyState } from "./empty-state.tsx";
import { ErrorNotice } from "./error-notice.tsx";
import { Loading } from "./loading.tsx";
import { MoneyText } from "./money-text.tsx";
import { OfflineBanner } from "./offline-banner.tsx";
import { PendingBadge } from "./pending-badge.tsx";
import { SelectField } from "./select-field.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { TextField } from "./text-field.tsx";
import { TimeText } from "./time-text.tsx";
import { TopBar } from "./top-bar.tsx";

// 部品のカタログ。このディレクトリの *.tsx と両方向で一致することを単体テストが照合する

export const CATALOG = [
  { name: "AppFrame", file: "app-frame.tsx", component: AppFrame },
  { name: "TopBar", file: "top-bar.tsx", component: TopBar },
  { name: "DataList", file: "data-list.tsx", component: DataList },
  { name: "DetailList", file: "detail-list.tsx", component: DetailList },
  { name: "Collapsible", file: "collapsible.tsx", component: Collapsible },
  { name: "StatusBadge", file: "status-badge.tsx", component: StatusBadge },
  { name: "EmptyState", file: "empty-state.tsx", component: EmptyState },
  { name: "Loading", file: "loading.tsx", component: Loading },
  { name: "ErrorNotice", file: "error-notice.tsx", component: ErrorNotice },
  { name: "ConfirmDialog", file: "confirm-dialog.tsx", component: ConfirmDialog },
  { name: "OfflineBanner", file: "offline-banner.tsx", component: OfflineBanner },
  { name: "PendingBadge", file: "pending-badge.tsx", component: PendingBadge },
  { name: "ActionResult", file: "action-result.tsx", component: ActionResult },
  { name: "TimeText", file: "time-text.tsx", component: TimeText },
  { name: "MoneyText", file: "money-text.tsx", component: MoneyText },
  { name: "DocumentBody", file: "document-body.tsx", component: DocumentBody },
  { name: "Button", file: "button.tsx", component: Button },
  { name: "TextField", file: "text-field.tsx", component: TextField },
  { name: "SelectField", file: "select-field.tsx", component: SelectField },
] as const;
