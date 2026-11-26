// 部品のカタログ。このディレクトリの *.tsx と両方向で一致することを単体テストが照合する

export const CATALOG = [
  { name: "AppFrame", file: "app-frame.tsx" },
  { name: "TopBar", file: "top-bar.tsx" },
  { name: "DataList", file: "data-list.tsx" },
  { name: "DetailList", file: "detail-list.tsx" },
  { name: "Collapsible", file: "collapsible.tsx" },
  { name: "StatusBadge", file: "status-badge.tsx" },
  { name: "EmptyState", file: "empty-state.tsx" },
  { name: "Loading", file: "loading.tsx" },
  { name: "ErrorNotice", file: "error-notice.tsx" },
  { name: "ConfirmDialog", file: "confirm-dialog.tsx" },
  { name: "OfflineBanner", file: "offline-banner.tsx" },
  { name: "PendingBadge", file: "pending-badge.tsx" },
  { name: "ActionResult", file: "action-result.tsx" },
  { name: "TimeText", file: "time-text.tsx" },
  { name: "MoneyText", file: "money-text.tsx" },
  { name: "DocumentBody", file: "document-body.tsx" },
  { name: "Button", file: "button.tsx" },
  { name: "TextField", file: "text-field.tsx" },
  { name: "SelectField", file: "select-field.tsx" },
] as const;
