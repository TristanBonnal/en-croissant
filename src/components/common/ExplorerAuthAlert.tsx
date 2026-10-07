import { Alert } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export default function ExplorerAuthAlert() {
  const { t } = useTranslation();
  return (
    <Alert color="yellow">
      {t("Board.Database.ExplorerAuthRequired1")} <Link to="/accounts">Users</Link>{" "}
      {t("Board.Database.ExplorerAuthRequired2")}
    </Alert>
  );
}
