import { Button } from "@mantine/core";
import { useToggle } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconTrash } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { clearAppCaches } from "@/utils/cache";
import ConfirmModal from "../common/ConfirmModal";

export default function ClearCacheButton() {
  const { t } = useTranslation();
  const [confirmOpened, toggleConfirm] = useToggle();
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    toggleConfirm();
    setLoading(true);
    try {
      const result = await clearAppCaches();
      if (result.failedIndexes > 0) {
        notifications.show({
          title: t("Settings.Directories.ClearCache"),
          message: t("Settings.Directories.ClearCache.PartialFailure", {
            count: result.failedIndexes,
          }),
          color: "yellow",
        });
      } else {
        notifications.show({
          title: t("Settings.Directories.ClearCache"),
          message: t("Settings.Directories.ClearCache.Success"),
          color: "green",
        });
      }
    } catch {
      // unwrap() already reported the error with a notification
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        variant="default"
        leftSection={<IconTrash size="1rem" />}
        loading={loading}
        onClick={() => toggleConfirm()}
      >
        {t("Settings.Directories.ClearCache.Button")}
      </Button>
      <ConfirmModal
        title={t("Settings.Directories.ClearCache")}
        description={t("Settings.Directories.ClearCache.Confirm")}
        opened={confirmOpened}
        onClose={toggleConfirm}
        onConfirm={handleConfirm}
        confirmLabel={t("Settings.Directories.ClearCache.Button")}
      />
    </>
  );
}
