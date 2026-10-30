import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { useLocation, useParams } from "@tanstack/react-router";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Database, Monitor, Moon, Sun } from "lucide-react";
import licenses from "../../../../THIRD_PARTY_LICENSES.md?raw";
import type { IgnoredRow } from "../../../shared/ignored";
import type { ApprovalPrefs, HistoryCleanupResult, HistoryStorageInfo, OpenAtLoginState } from "../../../shared/bridge";
import type { ApprovalStyle } from "../../../shared/approvalStyle";
import type { AgentId, Diagnostics, ThemeSource } from "../../../shared/types";
import { ConfirmAction } from "~/components/ConfirmAction";
import { AGENT_LABELS } from "~/components/Icons";
import { PageContainer, SettingsRow, SettingsSection } from "~/components/settings";
import { FullDiskControl } from "~/components/FullDiskControl";
import { SetupButton } from "~/components/SetupButton";
import { isHookAgent } from "../../../shared/setup";
import { useSetup } from "~/components/useSetup";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { toast } from "~/components/ui/toast";
import { useAppInfo } from "~/components/useAppInfo";
import { useUpdateState } from "~/components/UpdatePill";
import { aboutText, BUILD_LABELS, runtimeLine } from "../../../shared/appInfo";
import { canCheckForUpdate, getUpdateReleaseUrl, resolveUpdateButtonAction } from "../../../shared/updater";
import { cn } from "~/lib/utils";
import { SETTINGS_SECTIONS } from "~/nav";
import { parseRetentionDays } from "../../../shared/retention";
import { CLEANUP_MODES, formatBytes, formatCap, parseCapGb, type CleanupMode, type HistoryStats } from "../../../shared/storage";
import { DEFAULT_APPEARANCE, readAppearance, saveAppearance, type AppearancePrefs } from "../appearance";
import { PALETTES, paletteSwatch } from "../../../shared/palettes";

function General() {
  const [login, setLogin] = useState<OpenAtLoginState | null>(null);
  const [style, setStyle] = useState<ApprovalStyle>("popup");
  const [prefs, setPrefs] = useState<ApprovalPrefs | null>(null);
  const info = useAppInfo();
  const update = useUpdateState();
  const updateAction = update ? resolveUpdateButtonAction(update) : "none";
  const releaseUrl = getUpdateReleaseUrl(update?.downloadedVersion ?? update?.availableVersion ?? null);
  const updateDescription = (() => {
    if (!update) return "…";
    if (!update.enabled) return update.message ?? "Automatic updates are off for this build.";
    if (update.status === "downloaded" && update.downloadedVersion) return `v${update.downloadedVersion} is ready. Restart to finish installing.`;
    if (update.status === "available" && update.availableVersion) return `v${update.availableVersion} is available.`;
    if (update.status === "downloading") return `Downloading${update.availableVersion ? ` v${update.availableVersion}` : ""} (${Math.floor(update.downloadPercent ?? 0)}%)`;
    if (update.status === "checking") return "Checking for updates…";
    if (update.status === "up-to-date") return "You're on the latest version.";
    if (update.status === "error" && update.message) return update.message;
    return "Agentic Leash checks for updates automatically.";
  })();
  const { hash, key } = useLocation({ select: (location) => ({ hash: location.hash, key: location.state.__TSR_key }) });
  useEffect(() => {
    if (hash === "updates") document.getElementById("updates")?.scrollIntoView({ block: "start" });
  }, [hash, key]);
  useEffect(() => {
    void window.leash.getOpenAtLogin().then(setLogin);
    void window.leash.getApprovalStyle().then(setStyle);
    void window.leash.approvalPrefs().then(setPrefs);
  }, []);
  return (
    <>
    <SettingsSection title="Startup">
      <SettingsRow
        title="Open at login"
        description={
          login?.available === false
            ? "Available in the installed app."
            : "Starts hidden in the menu bar when you log in."
        }
        control={
          <Switch
            aria-label="Open at login"
            checked={login?.enabled ?? false}
            disabled={!login?.available}
            onCheckedChange={(enabled) => void window.leash.setOpenAtLogin(enabled).then(setLogin)}
          />
        }
      />
    </SettingsSection>
    <SettingsSection title="Approvals">
      <SettingsRow
        title="Ask for approval with"
        description="Popup takes focus so you can answer right away. Notification waits in the corner with Allow 15 min and Deny buttons. Quiet uses notifications but still opens the popup for high-risk requests like secrets or startup files. Requests time out and are denied after 2 minutes. macOS must allow alerts from Agentic Leash for the buttons to show."
        control={
          <div className="flex gap-1" role="group" aria-label="Ask for approval with">
            {(["popup", "quiet", "notification"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={style === value ? "default" : "outline"}
                aria-pressed={style === value}
                onClick={() => {
                  setStyle(value);
                  void window.leash.setApprovalStyle(value);
                }}
              >
                {value === "popup" ? "Popup" : value === "quiet" ? "Quiet" : "Notification"}
              </Button>
            ))}
          </div>
        }
      />
    </SettingsSection>
    <SettingsSection title="Temporary access">
      <SettingsRow
        title="Locking or sleeping your Mac ends"
        description="Personal folders only: passes for Documents, Downloads, Desktop and cloud drives end; work in your projects keeps going. All temporary access: every timed pass ends, so agents ask again when you're back. Always in repo is never affected."
        control={
          <div className="flex gap-1" role="group" aria-label="Locking or sleeping your Mac ends">
            {(["personal", "all"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={prefs?.lockEnds === value ? "default" : "outline"}
                aria-pressed={prefs?.lockEnds === value}
                onClick={() => void window.leash.setApprovalPrefs({ lockEnds: value }).then(setPrefs)}
              >
                {value === "personal" ? "Personal folders only" : "All temporary access"}
              </Button>
            ))}
          </div>
        }
      />
      <SettingsRow
        title="End of day"
        description="When an approval for Today ends. After this time, Today lasts until midnight."
        control={
          <select
            aria-label="End of day"
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={prefs?.endOfDayHour ?? 19}
            onChange={(event) => void window.leash.setApprovalPrefs({ endOfDayHour: Number(event.target.value) }).then(setPrefs)}
          >
            {Array.from({ length: 12 }, (_, index) => index + 12).map((hour) => (
              <option key={hour} value={hour}>{new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" })}</option>
            ))}
          </select>
        }
      />
    </SettingsSection>
    <SettingsSection title="Updates" id="updates">
      <SettingsRow
        title="Software update"
        description={updateDescription}
        control={
          <span className="flex items-center gap-2">
            {releaseUrl ? (
              <Button size="sm" variant="ghost" onClick={() => void window.leash.openExternal?.(releaseUrl)}>
                Release notes
              </Button>
            ) : null}
            {updateAction === "install" ? (
              <Button size="sm" onClick={() => void window.leash.installUpdate?.()}>
                Restart to update
              </Button>
            ) : updateAction === "download" ? (
              <Button size="sm" onClick={() => void window.leash.downloadUpdate?.()}>
                Download v{update?.availableVersion}
              </Button>
            ) : update?.status === "downloading" ? (
              <Button size="sm" variant="outline" disabled>
                Downloading ({Math.floor(update.downloadPercent ?? 0)}%)
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={!canCheckForUpdate(update)}
                onClick={() => void window.leash.checkForUpdates?.()}
              >
                {update?.status === "checking" ? "Checking…" : "Check for updates"}
              </Button>
            )}
          </span>
        }
      />
    </SettingsSection>
    <SettingsSection title="About">
      <SettingsRow title="Version" description={info?.version ?? "…"} />
      <SettingsRow title="Build" description={info ? BUILD_LABELS[info.build] : "…"} />
      <SettingsRow
        title="Runtime"
        description={info ? runtimeLine(info) : "…"}
        control={
          <Button
            size="sm"
            variant="ghost"
            disabled={!info}
            onClick={() => {
              if (info) void navigator.clipboard.writeText(aboutText(info)).then(() => toast({ title: "Copied version info" }));
            }}
          >
            Copy
          </Button>
        }
      />
    </SettingsSection>
    </>
  );
}

const UNINSTALL_EFFECTS = [
  "Removes this app's hooks from Claude, Cursor, Codex, Gemini, Antigravity, and Hermes.",
  "Deletes the backup (.bak) files next to those agent configs.",
  "Removes the login item and the sweep agent.",
  "In the installed app, removes the history helper with its history database and log. macOS asks for your password.",
  "Deletes grants, settings, caches, logs, and preferences for this app.",
  "In the installed app, moves Agentic Leash to the Trash and quits.",
];

function UninstallApp() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <SettingsSection title="Uninstall">
      <SettingsRow
        title="Uninstall Agentic Leash"
        description={error ?? "Removes hooks, the helper, and this app's data, then quits."}
        control={
          <ConfirmAction
            trigger={<Button size="sm" variant="destructive" disabled={busy}>Uninstall</Button>}
            title="Uninstall Agentic Leash?"
            description="This app's hooks and data are removed. Your other hook settings stay."
            effects={UNINSTALL_EFFECTS}
            confirmLabel="Uninstall"
            onConfirm={() => {
              setBusy(true);
              setError(null);
              void window.leash.uninstallApp().catch((caught: unknown) => {
                setBusy(false);
                setError(caught instanceof Error ? caught.message : "Uninstall stopped.");
              });
            }}
          />
        }
      />
    </SettingsSection>
  );
}

function Agents() {
  const { status, run } = useSetup();
  const rows = (status?.agents ?? []).filter((agent) => agent.installed);
  if (!rows.length) return <SettingsSection title="Agents"><SettingsRow title="No agents on this Mac" description="Claude, Cursor, Codex, Gemini, Antigravity, or Hermes shows up here once it is installed." /></SettingsSection>;
  return (
    <SettingsSection title="Agents">
      {rows.map((agent) => {
        const name = AGENT_LABELS[agent.id] ?? agent.id;
        const hookId = isHookAgent(agent.id) ? agent.id : null;
        const description = agent.id === "codex"
          ? "Off hides this agent and removes its hooks. After install, run /hooks in Codex and trust Agentic Leash."
          : agent.id === "hermes"
            ? "Off hides this agent and removes its hooks. Hermes asks once to allow this hook."
            : hookId ? "Off hides this agent and removes its hooks." : "Off hides this agent. It has no hook install yet.";
        return (
          <SettingsRow
            key={agent.id}
            title={name}
            description={description}
            control={
              <span className="flex items-center gap-2">
                {hookId ? <SetupButton kind="hook" actionKey={agent.id} done={agent.hooks === true} onClick={() => window.leash.installHooks(hookId)} /> : null}
                {hookId && agent.hooks ? <Button size="sm" variant="outline" onClick={() => run(`${agent.id}:off`, () => window.leash.uninstallHooks(hookId))}>Uninstall</Button> : null}
                <Switch aria-label={`Show ${name}`} checked={agent.enabled} onCheckedChange={(enabled) => run(`show:${agent.id}`, () => window.leash.setAgentEnabled(agent.id as AgentId, enabled))} />
              </span>
            }
          />
        );
      })}
    </SettingsSection>
  );
}

function DayField({ label, value, onCommit, parse = parseRetentionDays }: { label: string; value: number; onCommit: (days: number) => void; parse?: (text: string) => number | null }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const days = parse(text.trim());
    if (days === null) {
      setText(String(value));
      return;
    }
    if (days !== value) onCommit(days);
  };
  return (
    <input
      aria-label={label}
      className="h-8 w-20 rounded-lg border border-border bg-background/60 px-2 text-right font-mono text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
      inputMode="numeric"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

function EditIgnoredModal({
  row,
  open,
  onOpenChange,
  onSaved,
}: {
  row: IgnoredRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (rows: IgnoredRow[]) => void;
}) {
  const [prefix, setPrefix] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (row && open) {
      setPrefix(row.prefix);
      setError("");
      setSubmitting(false);
    }
  }, [row, open]);

  const handleSave = async () => {
    if (!row) return;
    const cleaned = prefix.trim();
    if (!cleaned.startsWith("/") || cleaned === "/" || /[\0\n\r]/.test(cleaned)) {
      setError("Use a full path, such as /tmp/scratch.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await window.leash.updateIgnored(row.id, cleaned);
      if (result.updated) {
        onSaved(result.rows);
        onOpenChange(false);
        toast({ title: "Hidden path updated", description: cleaned });
      } else {
        setError("Could not update this path. It may already be in the list or invalid.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-6">
          <AlertDialog.Popup className="dialog-glass w-full max-w-md overflow-hidden rounded-2xl border border-border text-popover-foreground shadow-2xl transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
            <div className="flex gap-3.5 px-6 pt-6 pb-4">
              <div className="min-w-0 space-y-1.5">
                <AlertDialog.Title className="text-base font-semibold tracking-tight">Edit hidden path</AlertDialog.Title>
                <AlertDialog.Description className="text-sm leading-normal text-muted-foreground">
                  Activity under this path is excluded from history.
                </AlertDialog.Description>
              </div>
            </div>

            <form
              className="px-6 pb-5 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
            >
              <label htmlFor="edit-hidden-path-input" className="block text-xs font-medium text-foreground">
                Path
              </label>
              <input
                id="edit-hidden-path-input"
                aria-label="Edit hidden path"
                className="w-full h-8 rounded-lg border border-border bg-background/60 px-2.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={prefix}
                onChange={(e) => {
                  setPrefix(e.target.value);
                  if (error) setError("");
                }}
                autoFocus
              />
              {error ? <p className="text-xs text-destructive">{error}</p> : null}

              <div className="flex justify-end gap-2 pt-3 border-t border-border/60 -mx-6 px-6 -mb-5 py-3.5 bg-muted/50 mt-4">
                <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={submitting}>
                  Save
                </Button>
              </div>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function IgnoredNoises() {
  const [rows, setRows] = useState<IgnoredRow[]>([]);
  const [editingRow, setEditingRow] = useState<IgnoredRow | null>(null);
  const [prefix, setPrefix] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void window.leash.listIgnored().then(setRows);
  }, []);

  const userRows = rows
    .filter((row) => !row.builtin)
    .sort((a, b) => (b.createdAt ?? b.id) - (a.createdAt ?? a.id));
  const builtinRows = rows.filter((row) => row.builtin);

  return (
    <div className="space-y-6">
      <SettingsSection title="User-added hidden paths">
        <div className="px-3 py-3 sm:px-4">
          <p className="mb-3 text-xs leading-normal text-muted-foreground/80">Activity under these paths is left out of history. Agents still ask before using them. To stop prompts, add a folder under Access → Always.</p>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void window.leash.addIgnored(prefix).then((result) => {
                setRows(result.rows);
                if (result.added) {
                  setPrefix("");
                  setError("");
                } else setError("Use a full path, such as /tmp/scratch.");
              });
            }}
          >
            <input
              aria-label="Hidden path"
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background/60 px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder="/tmp/scratch"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
            />
            <Button size="sm" type="submit">Add</Button>
          </form>
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </div>
        {userRows.length === 0 ? (
          <p className="px-4 py-4 text-xs text-muted-foreground">No user-added hidden paths yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border/50 bg-muted/30 text-xs font-medium text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5">Path</th>
                  <th className="px-4 py-2.5 whitespace-nowrap">Date added</th>
                  <th className="px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {userRows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs break-all">{row.prefix}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                      {row.createdAt ? new Date(row.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditingRow(row)}>Edit</Button>
                        <ConfirmAction
                          trigger={<Button size="sm" variant="destructive-outline">Delete</Button>}
                          title="Delete hidden path?"
                          description={row.prefix}
                          effects={[
                            "Activity under this path will no longer be hidden from history.",
                            "Future activity will be recorded in history logs."
                          ]}
                          confirmLabel="Delete"
                          onConfirm={() => void window.leash.deleteIgnored(row.id).then((nextRows) => {
                            setRows(nextRows);
                            toast({ title: "Deleted hidden path", description: row.prefix });
                          })}
                        />
                        <Switch aria-label={row.prefix} checked={row.enabled} onCheckedChange={(enabled) => void window.leash.setIgnored(row.id, enabled).then(setRows)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
      <EditIgnoredModal
        row={editingRow}
        open={Boolean(editingRow)}
        onOpenChange={(open) => { if (!open) setEditingRow(null); }}
        onSaved={setRows}
      />

      <SettingsSection title="Built-in hidden paths">
        {builtinRows.map((row) => (
          <SettingsRow
            key={row.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs whitespace-pre">{row.prefix}</span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{row.category}</span>
              </span>
            }
            description="Built in"
            control={
              <Switch aria-label={row.prefix} checked={row.enabled} onCheckedChange={(enabled) => void window.leash.setIgnored(row.id, enabled).then(setRows)} />
            }
          />
        ))}
      </SettingsSection>
    </div>
  );
}

function Monitoring() {
  const [days, setDays] = useState<{ main: number; noise: number } | null>(null);
  useEffect(() => {
    void window.leash.historyRetention().then(setDays);
  }, []);
  const save = (which: "main" | "noise", value: number) => {
    void window.leash.setHistoryRetention(which, value).then(setDays);
  };
  const { status, run, busy } = useSetup();
  const skipped = status?.helper === "skipped";
  return (
    <>
      <SettingsSection title="Helper">
        <SettingsRow
          title="File-activity helper"
          description={skipped ? "Available in the installed app." : "Installs a root LaunchDaemon that runs eslogger. macOS will ask for an administrator password."}
          control={
            skipped ? (
              <Button size="sm" disabled>Available in the installed app</Button>
            ) : (
              <span className="flex items-center gap-2">
                <SetupButton kind="helper" actionKey="helper" done={status?.helper === "running"} onClick={() => window.leash.installHelper()} />
                {status?.helper === "running" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === "helper-restart"}
                    onClick={() => run("helper-restart", () => window.leash.restartHelper())}
                  >
                    {busy === "helper-restart" ? "Restarting…" : "Restart"}
                  </Button>
                ) : null}
              </span>
            )
          }
        />
        <SettingsRow title="Full Disk Access" description="If Agentic Leash is missing from the list, click + and add Agentic Leash.app." control={<FullDiskControl />} />
        <SettingsRow title="Main history" description="Days to keep project files, network, and sensitive paths. From 5 to 365." control={days ? <DayField label="Main history days" value={days.main} onCommit={(value) => save("main", value)} /> : null} />
        <SettingsRow title="Noise history" description="Days to keep scratch-path writes and temporary reads. From 5 to 365." control={days ? <DayField label="Noise history days" value={days.noise} onCommit={(value) => save("noise", value)} /> : null} />
      </SettingsSection>
      <Storage />
    </>
  );
}

const GB = 1024 ** 3;

const BREAKDOWN: [string, (row: HistoryStats["counts"][number]) => boolean][] = [
  ["Scratch reads", (row) => !row.sensitive && row.table === "noise" && row.kind === "read"],
  ["Project reads", (row) => !row.sensitive && row.table === "events" && row.kind === "read"],
  ["Sensitive", (row) => row.sensitive],
  ["Writes and other changes", (row) => !row.sensitive && !["read", "net", "exec"].includes(row.kind)],
  ["Network", (row) => !row.sensitive && row.kind === "net"],
  ["Exec", (row) => !row.sensitive && row.kind === "exec"],
];

const CLEANUP: Record<CleanupMode, { label: string; effects: (days: number) => string[] }> = {
  compact: { label: "Compact history", effects: () => ["Removes existing process execution rows.", "Removes duplicate snapshot storage.", "Keeps file changes, network activity, and tool decisions."] },
  reads: { label: "Remove reads", effects: () => ["Deletes every read except reads of sensitive files.", "Keeps file changes, network activity, and tool decisions.", "Rebuilds the history file to free the space."] },
  noise: { label: "Remove noise and exec", effects: () => ["Deletes everything recorded under scratch paths such as /tmp, logs, and caches.", "Deletes every process execution row.", "Rebuilds the history file to free the space."] },
  older: { label: "Remove older than…", effects: (days) => [`Deletes everything older than ${days} days, including sensitive files.`, "Rebuilds the history file to free the space."] },
  all: { label: "Delete all history", effects: () => ["Deletes the history database and starts an empty one.", "Removes every file change, read, network event, and sensitive path record.", "This can't be undone."] },
};

const totalClass = "font-medium text-foreground";

function SizeList({ title, rows }: { title: string; rows: { label: string; value: string; hint?: string; total?: boolean }[] }) {
  return (
    <div className="px-3 py-3 sm:px-4">
      <h3 className="mb-2 text-sm font-medium text-foreground">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 text-xs text-muted-foreground/80">
        {rows.map((row) => (
          <Fragment key={row.label}>
            {row.total ? <div className="col-span-2 mt-1 border-t border-border/50" /> : null}
            <dt className={cn("truncate", row.total && totalClass)} title={row.hint}>{row.label}</dt>
            <dd className={cn("text-right font-mono tabular-nums", row.total && totalClass)}>{row.value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

function Storage() {
  const [info, setInfo] = useState<HistoryStorageInfo | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [pendingCap, setPendingCap] = useState<number | null>(null);
  const [capField, setCapField] = useState(0);
  const [mode, setMode] = useState<CleanupMode>("compact");
  const [olderDays, setOlderDays] = useState(30);
  const [result, setResult] = useState<HistoryCleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const { hash, key } = useLocation({ select: (location) => ({ hash: location.hash, key: location.state.__TSR_key }) });
  const ready = info !== null && cap !== null;
  useEffect(() => {
    if (ready && hash === "storage") document.getElementById("storage")?.scrollIntoView({ block: "start" });
  }, [ready, hash, key]);
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = () => {
      const request = ++latest;
      void Promise.all([window.leash.historyStorage(), window.leash.historyCap()]).then(([next, value]) => {
        if (!live || request !== latest) return;
        setInfo(next);
        setCap(value.gb);
      }).catch(() => {});
    };
    load();
    const off = window.leash.onStorage(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  const stats = info?.stats ?? null;
  const used = stats?.usedBytes ?? 0;
  const saveCap = (gb: number) => void window.leash.setHistoryCap(gb).then((value) => setCap(value.gb));
  const commitCap = (gb: number) => {
    if (gb * GB < used * 2) setPendingCap(gb);
    else saveCap(gb);
  };
  const run = () => {
    setRunning(true);
    setResult(null);
    setError(null);
    void window.leash.purgeHistory(mode, mode === "older" ? olderDays : undefined).then((value) => {
      setResult(value);
      return window.leash.historyStorage();
    }).then(setInfo).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : "History cleanup stopped.");
    }).finally(() => setRunning(false));
  };
  const historyBytes = info?.files[0]?.bytes ?? 0;
  const capB = (cap ?? 0) * GB || stats?.capBytes || 0;
  const percent = capB ? Math.floor((used * 100) / capB) : 0;
  const capText = formatCap(capB);
  const usage = !stats
    ? "No usage recorded yet. The history helper records it every minute."
    : stats.hardCap
      ? `${formatBytes(used)} used of ${capText}. At the limit: the oldest history, including sensitive files, is being deleted.`
      : `${formatBytes(used)} used of ${capText}`;
  const cleanupDescription = error
    ?? (result ? `Reduced history from ${formatBytes(result.beforeBytes)} to ${formatBytes(result.afterBytes)}.${result.deleted === null ? "" : ` Removed ${result.deleted.toLocaleString()} ${result.deleted === 1 ? "row" : "rows"}.`}`
      : historyBytes ? `History database is ${formatBytes(historyBytes)}. Cleanup needs up to ${formatBytes(info!.requiredBytes)} free; ${formatBytes(info!.freeBytes)} is available.`
        : "No history database yet.");
  const lowSpace = mode !== "all" && (info?.freeBytes ?? 0) < (info?.requiredBytes ?? 0);
  return (
    <SettingsSection title="Storage" id="storage">
      <SettingsRow
        title="History size limit"
        description="Automatic cleanup starts at half this size. Default 10 GB."
        control={
          cap ? (
            <>
              <DayField key={capField} label="History size limit in GB" value={cap} parse={parseCapGb} onCommit={commitCap} />
              <span className="text-sm text-muted-foreground">GB</span>
              <ConfirmAction
                open={pendingCap !== null}
                onOpenChange={(open) => {
                  if (open) return;
                  setPendingCap(null);
                  setCapField((key) => key + 1);
                }}
                title={`Lower the limit to ${pendingCap ?? 0} GB?`}
                description={`History already uses ${formatBytes(used)}, more than half of the new limit.`}
                effects={["Automatic cleanup starts within a minute.", "Scratch reads older than 1 day go first, then project reads older than 7 days, including sensitive ones.", "If that isn't enough, scratch file changes go next, then project file changes and network activity, oldest first.", "If history reaches the limit, the oldest history is deleted, including sensitive files."]}
                icon={Database}
                confirmLabel="Lower limit"
                onConfirm={() => {
                  if (pendingCap !== null) saveCap(pendingCap);
                }}
              />
            </>
          ) : null
        }
      />
      <SettingsRow
        title="History usage"
        description={usage}
        control={
          stats ? (
            <div role="meter" aria-label="History usage" aria-valuenow={Math.min(percent, 100)} aria-valuemin={0} aria-valuemax={100} className="relative h-1.5 w-40 overflow-hidden rounded-full bg-foreground/10">
              <div className={cn("h-full rounded-full", percent >= 100 || stats.hardCap ? "bg-destructive" : percent >= 50 ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.min(percent, 100)}%` }} />
              <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/50" />
            </div>
          ) : null
        }
      />
      {stats ? <SizeList title="Breakdown" rows={BREAKDOWN.map(([label, match]) => ({ label, value: `${stats.counts.filter(match).reduce((total, row) => total + row.rows, 0).toLocaleString()} rows` }))} /> : null}
      {info ? <SizeList title="Files on disk" rows={[...info.files.map((file) => ({ label: file.label, value: formatBytes(file.bytes), hint: file.path })), { label: "Total", value: formatBytes(info.files.reduce((total, file) => total + file.bytes, 0)), total: true }]} /> : null}
      <SettingsRow
        title="Last automatic cleanup"
        description={stats?.prunedAt ? `${new Date(stats.prunedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${stats.prunedRows.toLocaleString()} rows removed` : "None yet."}
      />
      <SettingsRow
        title="Clean up"
        description={<span aria-live="polite">{cleanupDescription}</span>}
        control={
          <>
            <select aria-label="Cleanup" className="h-8 rounded-lg border border-border bg-background px-2 text-sm text-foreground" value={mode} onChange={(event) => setMode(event.target.value as CleanupMode)}>
              {CLEANUP_MODES.map((value) => <option key={value} value={value}>{CLEANUP[value].label}</option>)}
            </select>
            {mode === "older" ? <DayField label="Remove older than days" value={olderDays} onCommit={setOlderDays} /> : null}
            {mode === "older" ? <span className="text-sm text-muted-foreground">days</span> : null}
            <ConfirmAction
              trigger={<Button size="sm" variant={mode === "all" ? "destructive" : "outline"} disabled={running || !historyBytes || lowSpace}>{running ? "Cleaning up…" : mode === "all" ? "Delete all…" : "Clean up"}</Button>}
              title={mode === "older" ? `Remove history older than ${olderDays} days?` : mode === "all" ? "Delete all history?" : `${CLEANUP[mode].label}?`}
              icon={Database}
              description="Agent monitoring pauses while History is cleaned up. In the installed app, macOS asks for your password."
              effects={CLEANUP[mode].effects(olderDays)}
              confirmLabel={mode === "all" ? "Delete all" : "Clean up"}
              onConfirm={run}
            />
          </>
        }
      />
    </SettingsSection>
  );
}

const THEMES = [
  { value: "system", label: "System", icon: Monitor, preview: "bg-[linear-gradient(135deg,#f5f5f4_50%,#18181b_50%)]" },
  { value: "light", label: "Light", icon: Sun, preview: "bg-[#f5f5f4]" },
  { value: "dark", label: "Dark", icon: Moon, preview: "bg-[#18181b]" },
] as const;

function Slider({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  const ratio = (value - min) / (max - min);
  const style = { "--settings-slider-progress": `${ratio * 100}%`, "--settings-slider-fill-offset": `${0.5 - ratio}rem` } as CSSProperties;
  return (
    <div className="flex w-full items-center gap-3 sm:w-52">
      <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums">{value}%</output>
      <input aria-label={label} className="settings-slider min-w-0 flex-1" type="range" min={min} max={max} step={5} value={value} style={style} onChange={(event) => onChange(Number(event.currentTarget.value))} />
    </div>
  );
}

function Appearance() {
  const [theme, setTheme] = useState<ThemeSource>("system");
  const [prefs, setPrefs] = useState<AppearancePrefs>(readAppearance);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    void window.leash.getTheme().then(setTheme);
    const sync = () => setDark(document.documentElement.classList.contains("dark"));
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  const update = (next: Partial<AppearancePrefs>) => {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    saveAppearance(merged);
  };
  const mode = dark ? "dark" : "light";
  return (
    <>
      <SettingsSection title="Theme">
        <div className="grid grid-cols-3 gap-3 p-3 sm:p-4">
          {THEMES.map(({ value, label, icon: Icon, preview }) => (
            <button
              key={value}
              type="button"
              aria-label={label}
              aria-pressed={theme === value}
              onClick={() => void window.leash.setTheme(value).then(setTheme)}
              className={cn("overflow-hidden rounded-lg border text-left transition-colors", theme === value ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-foreground/30")}
            >
              <div className={cn("flex h-16 items-end gap-1 p-2", preview)}>
                <span className="h-8 w-6 rounded-sm bg-[#ff8a5c]/80" />
                <span className="h-5 flex-1 rounded-sm bg-zinc-500/30" />
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-2 text-sm">
                <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                {label}
              </div>
            </button>
          ))}
        </div>
        <div className="p-3 sm:p-4">
          <p className="mb-3 text-xs text-muted-foreground">Palette</p>
          <div className="grid grid-cols-3 gap-3" role="group" aria-label="Palette">
            {PALETTES.map(({ id, label }) => {
              const swatch = paletteSwatch(id, mode);
              const selected = prefs.palette === id;
              return (
                <button
                  key={id}
                  type="button"
                  aria-label={label}
                  aria-pressed={selected}
                  onClick={() => update({ palette: id })}
                  className={cn("overflow-hidden rounded-lg border text-left transition-colors", selected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-foreground/30")}
                >
                  <div className={cn("flex h-16 items-end gap-1 p-2", !swatch && "bg-muted")} style={swatch ? { background: swatch.canvas } : undefined}>
                    <span className={cn("h-8 w-6 rounded-sm", !swatch && "bg-foreground/20")} style={swatch ? { background: swatch.accent } : undefined} />
                    <span className="h-5 flex-1 rounded-sm bg-zinc-500/30" />
                  </div>
                  <div className="px-2.5 py-2 text-sm">{label}</div>
                </button>
              );
            })}
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title="Interface">
        <SettingsRow title="Contrast" description="Adjust the contrast of text and borders across the app." control={<Slider label="Contrast" value={prefs.contrast} min={50} max={200} onChange={(contrast) => update({ contrast })} />} />
        <SettingsRow title="Transparency" description="Higher values make the sidebar, menus and dialogs more solid." control={<Slider label="Glass opacity" value={prefs.glass} min={40} max={100} onChange={(glass) => update({ glass })} />} />
        <SettingsRow
          title="Density"
          description="Compact fits more rows on screen."
          control={
            <div className="inline-flex rounded-lg border border-border p-0.5">
              {(["compact", "comfortable"] as const).map((density) => (
                <button key={density} type="button" aria-pressed={prefs.density === density} onClick={() => update({ density })} className={cn("rounded-md px-2.5 py-1 text-xs capitalize", prefs.density === density ? "bg-accent font-medium" : "text-muted-foreground")}>
                  {density}
                </button>
              ))}
            </div>
          }
        />
        <SettingsRow title="Reset" description="Back to the default contrast, transparency, density and palette." control={<Button size="sm" variant="outline" onClick={() => update(DEFAULT_APPEARANCE)}>Reset</Button>} />
      </SettingsSection>
    </>
  );
}

function Keybindings() {
  const rows = [["Hide to menu bar", "⌘Q"], ["Command palette", "⌘K"], ["Approval: pick duration", "1–4"], ["Approval: allow", "Return"], ["Approval: deny", "Esc"], ["Revoke all, no confirm", "⌃⌥⌘L"], ["Go to Live", "⌘1"], ["Go to Access", "⌘2"], ["Go to History", "⌘3"], ["Search history", "⌘F"]];
  return (
    <SettingsSection title="Keybindings">
      {rows.map(([action, keys]) => <SettingsRow key={action} title={action} control={<span className="font-mono text-xs">{keys}</span>} />)}
    </SettingsSection>
  );
}

const HOOK_STATUS = { installed: "Installed", missing: "Missing", none: "No hook" };
const VERDICT_LABEL: Record<string, string> = { pass: "Allowed", deny: "Denied", timeout: "Timed out" };

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function Diagnostics() {
  const [info, setInfo] = useState<Diagnostics | null>(null);
  useEffect(() => {
    void window.leash.diagnostics().then(setInfo);
  }, []);
  if (!info) return <SettingsSection title="Diagnostics"><SettingsRow title="Checking" /></SettingsSection>;
  const decision = info.lastDecision;
  const decisionText = decision
    ? `${AGENT_LABELS[decision.agent] ?? decision.agent} · ${decision.tool} · ${VERDICT_LABEL[decision.verdict] ?? decision.verdict}${decision.reason ? ` · ${decision.reason}` : ""} · ${when(new Date(decision.ts).toISOString())}`
    : "None yet";
  return (
    <>
      <SettingsSection title="Hooks">
        {info.hooks.map((hook) => <SettingsRow key={hook.agent} title={hook.label} description={HOOK_STATUS[hook.status]} />)}
      </SettingsSection>
      <SettingsSection title="Health">
        <SettingsRow title="Helper" description={info.helperStatus} />
        <SettingsRow title="Hook latency" description={`p50 ${info.hookP50Ms ?? "—"} ms · p95 ${info.hookP95Ms ?? "—"} ms`} />
        <SettingsRow title="Last sweep" description={info.lastSweep ? when(info.lastSweep) : "No sweep recorded"} />
        <SettingsRow title="Last decision" description={decisionText} />
      </SettingsSection>
      <SettingsSection title="Errors">
        {info.errors.length ? info.errors.map((error) => <SettingsRow key={error} title={error} />) : <SettingsRow title="None" description="Hooks and the helper are fine." />}
      </SettingsSection>
    </>
  );
}

function Licenses() {
  return (
    <SettingsSection title="Third-party licenses">
      <pre className="overflow-auto px-4 py-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{licenses}</pre>
    </SettingsSection>
  );
}

export function SettingsPage() {
  const { section } = useParams({ from: "/settings/$section" });
  const entry = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  return (
    <PageContainer>
      <h1 className="text-xl font-semibold tracking-tight">{entry.label}</h1>
      {entry.id === "general" ? <><General /><UninstallApp /></> : entry.id === "agents" ? <Agents /> : entry.id === "monitoring" ? <Monitoring /> : entry.id === "ignored" ? <IgnoredNoises /> : entry.id === "appearance" ? <Appearance /> : entry.id === "keybindings" ? <Keybindings /> : entry.id === "diagnostics" ? <Diagnostics /> : <Licenses />}
    </PageContainer>
  );
}
