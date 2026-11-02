import { useEffect, useMemo, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  Check,
  Edit2,
  Globe,
  Plus,
  Search,
  Server,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { AgentId, McpServerConfig } from "../../../shared/types";
import { ConfirmAction } from "~/components/ConfirmAction";
import { AgentIcon } from "~/components/Icons";
import { PageContainer, PageHeader } from "~/components/settings";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { toast } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

export const CAPABILITY_AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude-code", label: "Claude" },
  { id: "antigravity", label: "Antigravity" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
];

function formatArgsInput(args: string[]): string {
  return args
    .map((arg) => (/\s|"/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}

function parseArgsInput(input: string): string[] {
  const result: string[] = [];
  const regex = /"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g;
  for (const match of input.matchAll(regex)) {
    const token = match[0];
    if (token.startsWith('"') && token.endsWith('"')) {
      try {
        result.push(JSON.parse(token) as string);
        continue;
      } catch {
        /* fall through */
      }
    }
    if (token.startsWith("'") && token.endsWith("'")) {
      result.push(token.slice(1, -1));
    } else {
      result.push(token);
    }
  }
  return result;
}

interface ServerFormState {
  name: string;
  type: "command" | "url";
  command: string;
  args: string;
  env: string;
  url: string;
  enabledAgents: AgentId[];
}

const EMPTY_FORM: ServerFormState = {
  name: "",
  type: "command",
  command: "",
  args: "",
  env: "{}",
  url: "",
  enabledAgents: ["claude-code", "antigravity", "cursor"],
};

export function McpPage() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [form, setForm] = useState<ServerFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState("");

  const loadServers = async () => {
    try {
      const data = await window.leash.listMcpServers();
      setServers(data ?? []);
    } catch (err) {
      toast({
        title: "Failed to load MCP servers",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadServers();
  }, []);

  const openAddModal = () => {
    setEditingServer(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setModalOpen(true);
  };

  const openEditModal = (server: McpServerConfig) => {
    setEditingServer(server.name);
    setForm({
      name: server.name,
      type: server.url ? "url" : "command",
      command: server.command ?? "",
      args: formatArgsInput(server.args ?? []),
      env: server.env ? JSON.stringify(server.env, null, 2) : "{}",
      url: server.url ?? "",
      enabledAgents: server.enabledAgents ?? [],
    });
    setFormError("");
    setModalOpen(true);
  };

  const handleSaveServer = async () => {
    const trimmedName = form.name.trim();
    if (!trimmedName) {
      setFormError("Server name is required");
      return;
    }

    let parsedEnv: Record<string, string> | undefined = undefined;
    if (form.env.trim()) {
      try {
        const parsed = JSON.parse(form.env);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setFormError("Env must be a valid JSON object of key-value string pairs");
          return;
        }
        parsedEnv = parsed as Record<string, string>;
      } catch (e) {
        setFormError("Invalid JSON in Environment variables");
        return;
      }
    }

    const payload: McpServerConfig = {
      name: trimmedName,
      enabledAgents: form.enabledAgents,
    };

    if (form.type === "url") {
      if (!form.url.trim()) {
        setFormError("URL is required for remote server");
        return;
      }
      payload.url = form.url.trim();
    } else {
      if (!form.command.trim()) {
        setFormError("Command is required for stdio server");
        return;
      }
      payload.command = form.command.trim();
      const splitArgs = parseArgsInput(form.args);
      if (splitArgs.length > 0) {
        payload.args = splitArgs;
      }
      if (parsedEnv && Object.keys(parsedEnv).length > 0) {
        payload.env = parsedEnv;
      }
    }

    try {
      await window.leash.saveMcpServer(payload);
      toast({
        title: editingServer ? "MCP Server updated" : "MCP Server added",
        description: `Successfully configured ${payload.name}`,
      });
      setModalOpen(false);
      await loadServers();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteServer = async (serverName: string) => {
    try {
      await window.leash.deleteMcpServer(serverName);
      toast({
        title: "MCP Server deleted",
        description: `Removed ${serverName} configuration`,
      });
      await loadServers();
    } catch (err) {
      toast({
        title: "Error deleting server",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleToggleAgent = async (serverName: string, agentId: AgentId, currentEnabled: boolean) => {
    try {
      // Optimistic update
      setServers((prev) =>
        prev.map((s) => {
          if (s.name !== serverName) return s;
          const agents = s.enabledAgents.filter((a) => a !== agentId);
          if (!currentEnabled) agents.push(agentId);
          return { ...s, enabledAgents: agents };
        }),
      );
      await window.leash.toggleMcpForAgent(serverName, agentId, !currentEnabled);
    } catch (err) {
      await loadServers();
      toast({
        title: "Failed to toggle agent",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const filteredServers = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return servers;
    return servers.filter((s) => {
      return (
        s.name.toLowerCase().includes(q) ||
        (s.command && s.command.toLowerCase().includes(q)) ||
        (s.url && s.url.toLowerCase().includes(q)) ||
        s.enabledAgents.some((a) => a.toLowerCase().includes(q))
      );
    });
  }, [servers, search]);

  return (
    <PageContainer>
      {/* Header */}
      <PageHeader
        title="MCP Servers"
        subtitle="Configure Model Context Protocol servers and control which agents can use them."
        actions={
          <div className="flex items-center gap-3">
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search servers..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-full rounded-lg border border-border bg-card/60 pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {search ? (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
            <Button size="sm" onClick={openAddModal} className="gap-1.5 h-8 text-xs font-medium">
              <Plus className="size-3.5" />
              Add Server
            </Button>
          </div>
        }
      />

      {/* Grid of Servers */}
      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading MCP servers...</div>
      ) : filteredServers.length === 0 ? (
        <Empty className="my-8 rounded-xl border border-dashed border-border/80 p-8">
          <EmptyHeader>
            <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Server className="size-6" />
            </div>
            <EmptyTitle>{search ? "No matching MCP servers" : "No MCP servers configured"}</EmptyTitle>
            <EmptyDescription>
              {search
                ? `No servers matched "${search}". Clear the search query to see all servers.`
                : "Add an MCP server to provide external context, tools, and resources to your AI agents."}
            </EmptyDescription>
          </EmptyHeader>
          {!search && (
            <Button size="sm" onClick={openAddModal} className="mt-4 gap-1.5">
              <Plus className="size-4" />
              Add your first MCP server
            </Button>
          )}
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filteredServers.map((server) => (
            <div
              key={server.name}
              className="flex flex-col justify-between rounded-xl border border-border/60 bg-card/40 p-4.5 transition-all duration-200 hover:border-border hover:bg-card/70 shadow-xs/5"
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-primary">
                      {server.url ? <Globe className="size-4.5" /> : <Terminal className="size-4.5" />}
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground tracking-tight">{server.name}</h3>
                      <p className="font-mono text-xs text-muted-foreground truncate max-w-[260px]">
                        {server.url || `${server.command} ${(server.args || []).join(" ")}`}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => openEditModal(server)}
                      title="Edit MCP Server"
                    >
                      <Edit2 className="size-3.5 text-muted-foreground" />
                    </Button>
                    <ConfirmAction
                      trigger={
                        <Button size="icon-sm" variant="ghost" title="Delete MCP Server">
                          <Trash2 className="size-3.5 text-destructive/80 hover:text-destructive" />
                        </Button>
                      }
                      title={`Delete MCP Server "${server.name}"?`}
                      description="This will remove the server from all AI agent configurations."
                      effects={[
                        "Deletes the server configuration from agent config files.",
                        "Connected agents will no longer load this server's tools and prompts.",
                      ]}
                      confirmLabel="Delete"
                      onConfirm={() => void handleDeleteServer(server.name)}
                    />
                  </div>
                </div>

                {server.env && Object.keys(server.env).length > 0 && (
                  <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="font-medium text-foreground/70">Env vars:</span>
                    <span className="font-mono">{Object.keys(server.env).join(", ")}</span>
                  </div>
                )}
              </div>

              {/* Agent Toggles */}
              <div className="mt-4 pt-3.5 border-t border-border/50">
                <div className="text-[11px] font-medium text-muted-foreground mb-2">Agent Access:</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {CAPABILITY_AGENTS.map((agent) => {
                    const isEnabled = server.enabledAgents.includes(agent.id);
                    return (
                      <button
                        key={agent.id}
                        type="button"
                        onClick={() => void handleToggleAgent(server.name, agent.id, isEnabled)}
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

      {/* Add / Edit Server Modal */}
      <AlertDialog.Root open={modalOpen} onOpenChange={setModalOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] transition-opacity duration-150" />
          <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4 overflow-y-auto">
            <AlertDialog.Popup className="dialog-glass w-full max-w-lg rounded-2xl border border-border text-popover-foreground shadow-2xl p-6 transition-[opacity,scale] duration-150">
              <AlertDialog.Title className="text-base font-semibold tracking-tight">
                {editingServer ? `Edit MCP Server: ${editingServer}` : "Add MCP Server"}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-xs text-muted-foreground mt-1">
                Configure command or SSE/HTTP transport settings and enable agents.
              </AlertDialog.Description>

              {formError && (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {formError}
                </div>
              )}

              <div className="mt-4 space-y-3.5 text-xs">
                <div>
                  <label className="block font-medium text-foreground mb-1">Server Name</label>
                  <input
                    type="text"
                    placeholder="e.g. filesystem or github"
                    value={form.name}
                    disabled={!!editingServer}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="w-full rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                  />
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">Transport Type</label>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={form.type === "command" ? "default" : "outline"}
                      onClick={() => setForm((prev) => ({ ...prev, type: "command" }))}
                      className="gap-1.5 flex-1"
                    >
                      <Terminal className="size-3.5" />
                      Stdio Command
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={form.type === "url" ? "default" : "outline"}
                      onClick={() => setForm((prev) => ({ ...prev, type: "url" }))}
                      className="gap-1.5 flex-1"
                    >
                      <Globe className="size-3.5" />
                      Remote URL (SSE / HTTP)
                    </Button>
                  </div>
                </div>

                {form.type === "command" ? (
                  <>
                    <div>
                      <label className="block font-medium text-foreground mb-1">Command</label>
                      <input
                        type="text"
                        placeholder="e.g. npx or uvx or python3"
                        value={form.command}
                        onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
                        className="w-full font-mono rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-foreground mb-1">Arguments</label>
                      <input
                        type="text"
                        placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path/to/dir"
                        value={form.args}
                        onChange={(e) => setForm((prev) => ({ ...prev, args: e.target.value }))}
                        className="w-full font-mono rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-foreground mb-1">Environment JSON</label>
                      <textarea
                        rows={3}
                        placeholder='{ "API_KEY": "secret" }'
                        value={form.env}
                        onChange={(e) => setForm((prev) => ({ ...prev, env: e.target.value }))}
                        className="w-full font-mono rounded-md border border-border bg-card/60 p-2.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </>
                ) : (
                  <div>
                    <label className="block font-medium text-foreground mb-1">Server URL</label>
                    <input
                      type="url"
                      placeholder="e.g. http://localhost:8000/sse"
                      value={form.url}
                      onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                      className="w-full font-mono rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                )}

                <div>
                  <label className="block font-medium text-foreground mb-1.5">Enabled on Agents</label>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPABILITY_AGENTS.map((agent) => {
                      const checked = form.enabledAgents.includes(agent.id);
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => {
                            setForm((prev) => ({
                              ...prev,
                              enabledAgents: checked
                                ? prev.enabledAgents.filter((a) => a !== agent.id)
                                : [...prev.enabledAgents, agent.id],
                            }));
                          }}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium cursor-pointer transition-all",
                            checked
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground hover:bg-muted/80",
                          )}
                        >
                          <AgentIcon agent={agent.id} className="size-3.5" />
                          <span>{agent.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <AlertDialog.Close render={<Button size="sm" variant="ghost" />}>Cancel</AlertDialog.Close>
                <Button size="sm" onClick={() => void handleSaveServer()}>
                  {editingServer ? "Save Changes" : "Add Server"}
                </Button>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </PageContainer>
  );
}