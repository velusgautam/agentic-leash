import { SetupButton } from "~/components/SetupButton";
import { Button } from "~/components/ui/button";
import { useFullDiskAccess } from "~/components/useFullDiskAccess";

export function FullDiskControl() {
  const { hasAccess, isSkipped, openFda } = useFullDiskAccess();
  if (window.leash.platform !== "darwin") return null;
  // Dev builds inherit the launching terminal's Full Disk Access, so the probe says nothing about Agentic Leash.app.
  if (isSkipped) return <Button size="sm" disabled>Available in the installed app</Button>;
  return <SetupButton kind="fda" actionKey="fda" done={hasAccess} onClick={openFda} />;
}
