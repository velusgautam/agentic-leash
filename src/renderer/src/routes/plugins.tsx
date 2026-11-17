import { useEffect, useMemo, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  Blocks,
  Check,
  Download,
  FolderGit2,
  Info,
  Search,
  Server,
  Shield,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import type { AgentId, PluginItem } from "../../../shared/types";
import { ConfirmAction } from "~/components/ConfirmAction";
import { AgentIcon } from "~/components/Icons";
import { PageContainer, PageHeader } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Pill } from "~/components/ui/pill";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { toast } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { AgentFilterBar, CAPABILITY_AGENTS } from "./mcp";
import { FOCUS_PLUGIN_STORAGE_KEY } from "./skills";

type DiscoveredPluginItem = PluginItem & {
  agents?: AgentId[];
  sourceAgent?: AgentId;
};

let cachedPlugins: DiscoveredPluginItem[] | null = null;

function pluginMatchesAgent(plugin: DiscoveredPluginItem, agent: AgentId): boolean {
  return (
    plugin.enabledAgents.includes(agent) ||
    Boolean(plugin.agents?.includes(agent)) ||
    plugin.sourceAgent === agent
  );
}

export function PluginsPage() {
  const [plugins, setPlugins] = useState<DiscoveredPluginItem[]>(() => cachedPlugins ?? []);
  const [loading, setLoading] = useState(() => cachedPlugins === null);
  const [search, setSearch] = useState("");
  const [selectedAgent, setSelectedAgent] = useState<AgentId | "all">("all");
  const [focusedPlugin, setFocusedPlugin] = useState<string | null>(null);

  // Install modal
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState("");

  // Inspect drawer
  const [inspectedPlugin, setInspectedPlugin] = useState<DiscoveredPluginItem | null>(null);

  const loadPlugins = async () => {
    try {
      const data = await window.leash.listPlugins();
      const list = data ?? [];
      cachedPlugins = list;
      setPlugins(list);
      setInspectedPlugin((prev) => (prev ? (list.find((p) => p.name === prev.name) ?? prev) : null));
    } catch (err) {
      toast({
        title: "Failed to load plugins",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    try {
      const focus = window.sessionStorage.getItem(FOCUS_PLUGIN_STORAGE_KEY);
      if (focus) {
        window.sessionStorage.removeItem(FOCUS_PLUGIN_STORAGE_KEY);
        setSearch(focus);
        setSelectedAgent("all");
        setFocusedPlugin(focus);
      }
    } catch {
      /* ignore sessionStorage errors */
    }
    void loadPlugins();
  }, []);

  const handleInstallPlugin = async () => {
    const url = gitUrl.trim();
    if (!url) {
      setInstallError("Git repository URL is required");
      return;
    }

    setInstalling(true);
    setInstallError("");
    try {
      const res = await window.leash.installPlugin(url);
      if (res && !res.ok) {
        setInstallError(res.error || "Failed to install plugin");
        return;
      }
      toast({
        title: "Plugin installed successfully",
        description: res.name ? `Installed ${res.name}` : `Cloned ${url}`,
      });
      setInstallModalOpen(false);
      setGitUrl("");
      await loadPlugins();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleUninstallPlugin = async (pluginName: string) => {
    try {
      const res = await window.leash.uninstallPlugin(pluginName);
      if (res && !res.ok) {
        toast({
          title: "Uninstall failed",
          description: res.error || "Could not uninstall plugin",
        });
        return;
      }
      toast({
        title: "Plugin uninstalled",
        description: `Removed ${pluginName}`,
      });
      if (inspectedPlugin?.name === pluginName) {
        setInspectedPlugin(null);
      }
      await loadPlugins();
    } catch (err) {
      toast({
        title: "Error uninstalling plugin",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleToggleAgent = async (pluginName: string, agentId: AgentId, currentEnabled: boolean) => {
    try {
      setPlugins((prev) => {
        const next = prev.map((p) => {
          if (p.name !== pluginName) return p;
          const agents = p.enabledAgents.filter((a) => a !== agentId);
          if (!currentEnabled) agents.push(agentId);
          return { ...p, enabledAgents: agents };
        });
        cachedPlugins = next;
        return next;
      });
      await window.leash.togglePluginForAgent(pluginName, agentId, !currentEnabled);
    } catch (err) {
      await loadPlugins();
      toast({
        title: "Failed to toggle plugin for agent",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const countsByAgent = useMemo(() => {
    const counts: Partial<Record<AgentId, number>> = {};
    for (const agent of CAPABILITY_AGENTS) {
      counts[agent.id] = plugins.filter((p) => pluginMatchesAgent(p, agent.id)).length;
    }
    return counts;
  }, [plugins]);

  const filteredPlugins = useMemo(() => {
    let result = plugins;
    if (selectedAgent !== "all") {
      result = result.filter((p) => pluginMatchesAgent(p, selectedAgent));
    }
    const q = search.toLowerCase().trim();
    if (!q) return result;
    return result.filter((p) => {
      return (
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.author && p.author.toLowerCase().includes(q)) ||
        p.skills.some((s) => s.toLowerCase().includes(q))
      );
    });
  }, [plugins, selectedAgent, search]);

  const hasFilter = Boolean(search.trim()) || selectedAgent !== "all";
  const selectedAgentLabel = CAPABILITY_AGENTS.find((a) => a.id === selectedAgent)?.label ?? selectedAgent;

  return (
    <PageContainer>
      {/* Header */}
      <PageHeader
        title="Plugins"
        subtitle="Install and manage modular agent capability plugins containing bundled skills, rules, and MCP servers."
        actions={
          <Button
            size="sm"
            onClick={() => {
              setGitUrl("");
              setInstallError("");
              setInstallModalOpen(true);
            }}
            className="gap-1.5 h-8 rounded-lg text-xs font-medium"
          >
            <Download className="size-3.5" />
            Install Plugin
          </Button>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <AgentFilterBar
          selectedAgent={selectedAgent}
          onSelectAgent={setSelectedAgent}
          totalCount={plugins.length}
          countsByAgent={countsByAgent}
        />
        <div className="relative w-56">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <input
            type="text"
            aria-label="Search plugins"
            placeholder="Search plugins..."
            value={search}
            onChange={(e) => {
              const val = e.target.value;
              setSearch(val);
              if (focusedPlugin && val !== focusedPlugin) {
                setFocusedPlugin(null);
              }
            }}
            className="h-8 w-full rounded-lg border border-border/70 bg-card/60 pl-8 pr-7 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setSearch("");
                setFocusedPlugin(null);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {focusedPlugin ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="violet" className="text-xs">
              Filtered to plugin: {focusedPlugin}
            </Pill>
            <span className="text-muted-foreground">
              Toggle agents below or click Uninstall to remove this plugin and its bundled skills.
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setFocusedPlugin(null);
              setSearch("");
              setSelectedAgent("all");
            }}
          >
            Show all plugins
          </Button>
        </div>
      ) : null}

      {/* Grid of Plugins */}
      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading plugins...</div>
      ) : filteredPlugins.length === 0 ? (
        <Empty className="rounded-xl border border-dashed border-border/80 p-8">
          <EmptyHeader>
            <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-pink-500/10 text-pink-500">
              <Blocks className="size-6" />
            </div>
            <EmptyTitle>{hasFilter ? "No matching plugins" : "No plugins installed"}</EmptyTitle>
            <EmptyDescription>
              {hasFilter
                ? selectedAgent !== "all" && !search.trim()
                  ? `No plugins belong to or are enabled for ${selectedAgentLabel}.`
                  : "No plugins matched your current filters."
                : "Install a plugin from a Git repo (like mattpocock/skills) to bundle skills, rules, and MCP configurations together."}
            </EmptyDescription>
          </EmptyHeader>
          {hasFilter ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setFocusedPlugin(null);
                setSelectedAgent("all");
                setSearch("");
              }}
              className="mt-4"
            >
              Show all plugins
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                setGitUrl("https://github.com/mattpocock/skills");
                setInstallError("");
                setInstallModalOpen(true);
              }}
              className="mt-4 gap-1.5"
            >
              <Download className="size-4" />
              Install example plugin
            </Button>
          )}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filteredPlugins.map((plugin) => (
            <div
              key={plugin.name}
              className="flex flex-col justify-between rounded-xl border border-border/60 bg-card/40 p-4.5 transition-all duration-200 hover:border-border hover:bg-card/70 shadow-xs/5"
            >
              <div>
                {/* Header row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-10 items-center justify-center rounded-lg border border-border/70 bg-muted/40 text-pink-500">
                      <Blocks className="size-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold tracking-tight text-foreground">{plugin.name}</h3>
                        {plugin.version && (
                          <span className="rounded bg-muted/70 px-1.5 py-0.2 text-[10px] font-mono text-muted-foreground">
                            v{plugin.version}
                          </span>
                        )}
                      </div>
                      {plugin.author && (
                        <p className="flex items-center gap-1 text-xs text-muted-foreground">
                          <User className="size-3" />
                          <span>{plugin.author}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => setInspectedPlugin(plugin)}
                    >
                      <Info className="size-3" />
                      Inspect
                    </Button>
                    <ConfirmAction
                      trigger={
                        <Button size="icon-sm" variant="ghost" title="Uninstall Plugin">
                          <Trash2 className="size-3.5 text-destructive/80 hover:text-destructive" />
                        </Button>
                      }
                      title={`Uninstall plugin "${plugin.name}"?`}
                      description="This will remove the plugin folder and unbundle its skills and rules."
                      effects={[
                        `Removes ${plugin.skillsCount} bundled skills from your agent workflows.`,
                        "Deletes the plugin repository clone from your plugins directory.",
                      ]}
                      confirmLabel="Uninstall"
                      onConfirm={() => void handleUninstallPlugin(plugin.name)}
                    />
                  </div>
                </div>

                {/* Description */}
                {plugin.description && (
                  <p className="mt-2 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                    {plugin.description}
                  </p>
                )}

                {/* Bundle Stats Pills */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {plugin.sourceAgent && (
                    <Pill tone="muted" className="text-[11px]" title={`Discovered in ${plugin.sourceAgent} plugins directory`}>
                      <AgentIcon agent={plugin.sourceAgent} className="size-3" />
                      {CAPABILITY_AGENTS.find((a) => a.id === plugin.sourceAgent)?.label ?? plugin.sourceAgent}
                    </Pill>
                  )}
                  <Pill tone="violet" className="text-[11px]">
                    <Sparkles className="size-3" />
                    {plugin.skillsCount} {plugin.skillsCount === 1 ? "skill" : "skills"}
                  </Pill>
                  <Pill tone="sky" className="text-[11px]">
                    <Shield className="size-3" />
                    {plugin.rulesCount} {plugin.rulesCount === 1 ? "rule" : "rules"}
                  </Pill>
                  {plugin.mcpServersCount > 0 && (
                    <Pill tone="cyan" className="text-[11px]">
                      <Server className="size-3" />
                      {plugin.mcpServersCount} MCP {plugin.mcpServersCount === 1 ? "server" : "servers"}
                    </Pill>
                  )}
                </div>
              </div>

              {/* Agent Toggles */}
              <div className="mt-4 pt-3.5 border-t border-border/50">
                <div className="text-[11px] font-medium text-muted-foreground mb-2">Enabled for Agents:</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {CAPABILITY_AGENTS.map((agent) => {
                    const isEnabled = plugin.enabledAgents.includes(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => void handleToggleAgent(plugin.name, agent.id, isEnabled)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-all duration-150 cursor-pointer",
                          isEnabled
                            ? "bg-primary/15 text-primary border border-primary/35 hover:bg-primary/25 shadow-xs/5"
                            : "bg-muted/40 text-muted-foreground/60 border border-border/40 hover:bg-muted/70 hover:text-foreground",
                        )}
                        title={isEnabled ? `Enabled for ${agent.label}. Click to disable.` : `Disabled for ${agent.label}. Click to enable.`}
                      >
                        <AgentIcon agent={agent.id} className="size-3.5" />
                        <span>{agent.label}</span>
                        {isEnabled ? <Check className="size-3 text-primary ml-0.5" /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inspect Plugin Sheet */}
      <Sheet open={!!inspectedPlugin} onOpenChange={(open) => !open && setInspectedPlugin(null)}>
        <SheetPopup side="right" className="w-[calc(100%-2rem)] sm:max-w-xl border-s border-border">
          {inspectedPlugin && (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/60 p-5">
                <div className="flex items-center gap-2.5">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-pink-500/10 text-pink-500">
                    <Blocks className="size-5" />
                  </div>
                  <div>
                    <SheetTitle className="text-base font-semibold">{inspectedPlugin.name}</SheetTitle>
                    <SheetDescription className="text-xs text-muted-foreground">
                      {inspectedPlugin.version ? `v${inspectedPlugin.version} · ` : ""}
                      {inspectedPlugin.author || "Community Plugin"}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
                {inspectedPlugin.description && (
                  <div>
                    <h4 className="font-semibold text-foreground mb-1">About</h4>
                    <p className="text-muted-foreground leading-relaxed">{inspectedPlugin.description}</p>
                  </div>
                )}

                <div>
                  <h4 className="font-semibold text-foreground mb-1">Location</h4>
                  <div className="rounded-md border border-border bg-card/60 p-2 font-mono text-[11px] text-muted-foreground break-all">
                    {inspectedPlugin.path}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-semibold text-foreground">Bundled Skills ({inspectedPlugin.skills.length})</h4>
                  </div>
                  {inspectedPlugin.skills.length === 0 ? (
                    <p className="text-muted-foreground italic">No skills listed in plugin manifest.</p>
                  ) : (
                    <div className="grid grid-cols-1 gap-1.5">
                      {inspectedPlugin.skills.map((skillName) => (
                        <div
                          key={skillName}
                          className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-foreground font-mono"
                        >
                          <Sparkles className="size-3.5 text-violet-500 shrink-0" />
                          <span>{skillName}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between border-t border-border/60 bg-muted/30 p-4">
                <Button size="sm" variant="ghost" onClick={() => setInspectedPlugin(null)} className="h-8 text-xs">
                  Close
                </Button>
                <ConfirmAction
                  trigger={
                    <Button size="sm" variant="destructive-outline" className="gap-1.5 h-8 text-xs">
                      <Trash2 className="size-3.5" />
                      Uninstall Plugin
                    </Button>
                  }
                  title={`Uninstall plugin "${inspectedPlugin.name}"?`}
                  description="Are you sure you want to remove this plugin?"
                  effects={["Removes bundled skills and configurations from all agents."]}
                  confirmLabel="Uninstall"
                  onConfirm={() => void handleUninstallPlugin(inspectedPlugin.name)}
                />
              </div>
            </div>
          )}
        </SheetPopup>
      </Sheet>

      {/* Install Plugin Modal */}
      <AlertDialog.Root open={installModalOpen} onOpenChange={setInstallModalOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] transition-opacity duration-150" />
          <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4 overflow-y-auto">
            <AlertDialog.Popup className="dialog-glass w-full max-w-lg rounded-2xl border border-border text-popover-foreground shadow-2xl p-6 transition-[opacity,scale] duration-150">
              <AlertDialog.Title className="text-base font-semibold tracking-tight">
                Install Capability Plugin
              </AlertDialog.Title>
              <AlertDialog.Description className="text-xs text-muted-foreground mt-1">
                Enter a Git repository URL containing plugin skills, rules, or manifests.
              </AlertDialog.Description>

              {installError && (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {installError}
                </div>
              )}

              <div className="mt-4 space-y-3 text-xs">
                <div>
                  <label className="block font-medium text-foreground mb-1">Git Repository URL</label>
                  <div className="relative">
                    <FolderGit2 className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                    <input
                      type="url"
                      placeholder="https://github.com/mattpocock/skills"
                      value={gitUrl}
                      onChange={(e) => setGitUrl(e.target.value)}
                      disabled={installing}
                      className="w-full font-mono rounded-md border border-border bg-card/60 pl-8.5 pr-3 py-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                    />
                  </div>
                </div>

                <div className="rounded-lg bg-muted/40 p-3 text-[11px] text-muted-foreground space-y-1">
                  <p className="font-medium text-foreground/80">Popular community plugins:</p>
                  <p className="font-mono">
                    <button
                      type="button"
                      className="text-primary hover:underline"
                      onClick={() => setGitUrl("https://github.com/mattpocock/skills")}
                    >
                      https://github.com/mattpocock/skills
                    </button>
                  </p>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <AlertDialog.Close render={<Button size="sm" variant="ghost" disabled={installing} />}>
                  Cancel
                </AlertDialog.Close>
                <Button size="sm" onClick={() => void handleInstallPlugin()} disabled={installing} className="gap-1.5">
                  <Download className="size-3.5" />
                  {installing ? "Cloning & Installing..." : "Install"}
                </Button>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </PageContainer>
  );
}