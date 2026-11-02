import { useCallback, useState } from "react";
import { useSetup } from "~/components/useSetup";

export interface FullDiskAccessState {
  hasAccess: boolean;
  isSkipped: boolean;
  isOpening: boolean;
  openFda: () => Promise<void>;
  refresh: () => void;
}

export function useFullDiskAccess(): FullDiskAccessState {
  const { status, refresh } = useSetup();
  const [isOpening, setIsOpening] = useState(false);

  const openFda = useCallback(async () => {
    setIsOpening(true);
    try {
      await window.leash.openFullDiskAccess();
      refresh();
    } finally {
      setIsOpening(false);
    }
  }, [refresh]);

  return {
    hasAccess: Boolean(status?.fda),
    isSkipped: status?.helper === "skipped",
    isOpening,
    openFda,
    refresh,
  };
}
