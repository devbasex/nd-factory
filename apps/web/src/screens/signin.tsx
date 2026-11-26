import { useI18n } from "../i18n/context.ts";
import { Button } from "../ui/button.tsx";
import { TopBar } from "../ui/top-bar.tsx";

export type SigninProps = { onSignin: () => void; offline: boolean };

export function SigninScreen({ onSignin, offline }: SigninProps) {
  const { t } = useI18n();
  return (
    <section data-state="signin">
      <TopBar title={t("signin.title")} description={t("signin.description")} />
      <Button variant="primary" needsConnection={offline} onClick={onSignin}>
        {t("signin.action")}
      </Button>
    </section>
  );
}
