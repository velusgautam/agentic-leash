import { useEffect, useMemo, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import {
  Activity,
  Check,
  ChevronDown,
  ExternalLink,
  FileCode,
  Layers,
  Package,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { AgentId, SkillItem } from "../../../shared/types";
import { ConfirmAction } from "~/components/ConfirmAction";
import { AgentIcon } from "~/components/Icons";
import { PageContainer } from "~/components/settings";
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
import { CAPABILITY_AGENTS } from "./mcp";

type SkillFilter = "all" | "standalone" | "bundled";

interface AddSkillForm {
  id: string;
  name: string;
  description: string;
  content: string;
  enabledAgents: AgentId[];
}

const DEFAULT_SKILL_TEMPLATE = `---
name: my-new-skill
description: Brief summary of what this skill does and when an agent should use it.
---

# Instructions

1. Describe the steps and context the agent should follow.
2. Provide rules, tips, and examples.
`;

const INITIAL_ADD_FORM: AddSkillForm = {
  id: "",
  name: "",
  description: "",
  content: DEFAULT_SKILL_TEMPLATE,
  enabledAgents: ["claude-code", "antigravity", "cursor", "codex", "gemini", "hermes"],
};

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");

  // Slide-over right panel state
  const [selectedSkill, setSelectedSkill] = useState<SkillItem | null>(null);
  const [editorAgent, setEditorAgent] = useState<AgentId | "global">("global");
  const [editorContent, setEditorContent] = useState("");
  const [editorOriginalContent, setEditorOriginalContent] = useState("");
  const [editorLoading, setEditorLoading] = useState(false);
  const [savingContent, setSavingContent] = useState(false);

  // Add custom skill modal state
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm, setAddForm] = useState<AddSkillForm>(INITIAL_ADD_FORM);
  const [addError, setAddError] = useState("");

  const loadSkills = async () => {
    try {
      const data = await window.leash.listSkills();
      setSkills(data ?? []);
      // Refresh selectedSkill if panel is open
      if (selectedSkill) {
        const updated = (data ?? []).find((s) => s.id === selectedSkill.id);
        if (updated) setSelectedSkill(updated);
      }
    } catch (err) {
      toast({
        title: "Failed to load skills",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSkills();
  }, []);

  // When a skill card is selected, load its content
  const openSkillDetail = async (skill: SkillItem, agentContext: AgentId | "global" = "global") => {
    setSelectedSkill(skill);
    setEditorAgent(agentContext);
    setEditorLoading(true);
    try {
      const targetAgent = agentContext === "global" ? undefined : agentContext;
      const text = await window.leash.getSkillContent(skill.id, targetAgent);
      setEditorContent(text);
      setEditorOriginalContent(text);
    } catch (err) {
      toast({
        title: "Failed to read skill content",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setEditorLoading(false);
    }
  };

  const handleAgentContextSwitch = async (agentContext: AgentId | "global") => {
    if (!selectedSkill) return;
    setEditorAgent(agentContext);
    setEditorLoading(true);
    try {
      const targetAgent = agentContext === "global" ? undefined : agentContext;
      const text = await window.leash.getSkillContent(selectedSkill.id, targetAgent);
      setEditorContent(text);
      setEditorOriginalContent(text);
    } catch (err) {
      toast({
        title: "Failed to load override content",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setEditorLoading(false);
    }
  };

  const handleSaveContent = async () => {
    if (!selectedSkill) return;
    setSavingContent(true);
    try {
      const targetAgent = editorAgent === "global" ? undefined : editorAgent;
      await window.leash.saveSkillContent(selectedSkill.id, editorContent, targetAgent);
      setEditorOriginalContent(editorContent);
      toast({
        title: "Skill saved",
        description: `Updated ${selectedSkill.name}${targetAgent ? ` for ${targetAgent}` : ""}`,
      });
      await loadSkills();
    } catch (err) {
      toast({
        title: "Failed to save skill",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingContent(false);
    }
  };

  const handleCreateOverride = async (agentId: AgentId) => {
    if (!selectedSkill) return;
    try {
      await window.leash.overrideSkillForAgent(selectedSkill.id, agentId);
      toast({
        title: "Agent override created",
        description: `Created dedicated ${agentId} copy of ${selectedSkill.name}`,
      });
      await loadSkills();
      await handleAgentContextSwitch(agentId);
    } catch (err) {
      toast({
        title: "Error creating override",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleResetOverride = async (skillId: string, agentId: AgentId) => {
    try {
      await window.leash.resetSkillOverride(skillId, agentId);
      toast({
        title: "Reset override to global",
        description: `Removed specific override for ${agentId}`,
      });
      await loadSkills();
      if (editorAgent === agentId) {
        await handleAgentContextSwitch("global");
      }
    } catch (err) {
      toast({
        title: "Failed to reset override",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleToggleAgent = async (skillId: string, agentId: AgentId, currentEnabled: boolean) => {
    try {
      // Optimistic update
      setSkills((prev) =>
        prev.map((s) => {
          if (s.id !== skillId) return s;
          const agents = s.enabledAgents.filter((a) => a !== agentId);
          if (!currentEnabled) agents.push(agentId);
          return { ...s, enabledAgents: agents };
        }),
      );
      await window.leash.toggleSkillForAgent(skillId, agentId, !currentEnabled);
    } catch (err) {
      await loadSkills();
      toast({
        title: "Failed to toggle agent for skill",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDeleteSkill = async (skillId: string) => {
    try {
      const res = await window.leash.deleteSkill(skillId);
      if (res && !res.ok) {
        toast({
          title: "Cannot delete skill",
          description: res.error || "Failed to delete skill",
        });
        return;
      }
      toast({
        title: "Skill deleted",
        description: `Removed skill ${skillId}`,
      });
      setSelectedSkill(null);
      await loadSkills();
    } catch (err) {
      toast({
        title: "Error deleting skill",
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleAddCustomSkill = async () => {
    const trimmedName = addForm.name.trim();
    const id = addForm.id.trim() || trimmedName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!trimmedName) {
      setAddError("Skill name is required");
      return;
    }
    if (!id) {
      setAddError("Skill ID is required");
      return;
    }

    try {
      await window.leash.saveSkillContent(id, addForm.content);
      // Toggle for agents
      for (const agent of addForm.enabledAgents) {
        await window.leash.toggleSkillForAgent(id, agent, true);
      }
      toast({
        title: "Custom skill created",
        description: `Saved skill "${trimmedName}"`,
      });
      setAddModalOpen(false);
      setAddForm(INITIAL_ADD_FORM);
      await loadSkills();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : String(err));
    }
  };

  const filteredSkills = useMemo(() => {
    let result = skills;
    if (filter === "standalone") {
      result = result.filter((s) => !s.isPlugin);
    } else if (filter === "bundled") {
      result = result.filter((s) => s.isPlugin);
    }

    const q = search.toLowerCase().trim();
    if (!q) return result;

    return result.filter((s) => {
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        (s.pluginName && s.pluginName.toLowerCase().includes(q)) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [skills, filter, search]);

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Skills Hub</h1>
          <p className="text-sm text-muted-foreground">
            Manage reusable agent skills, explore bundled plugin packages, and configure per-agent overrides.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-56 sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search skills..."
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

          {/* Filter Pills */}
          <div className="flex rounded-lg border border-border/80 bg-card/60 p-0.5 text-xs">
            <button
              onClick={() => setFilter("all")}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition-all",
                filter === "all" ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              All ({skills.length})
            </button>
            <button
              onClick={() => setFilter("standalone")}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition-all",
                filter === "standalone" ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Standalone ({skills.filter((s) => !s.isPlugin).length})
            </button>
            <button
              onClick={() => setFilter("bundled")}
              className={cn(
                "rounded-md px-2.5 py-1 font-medium transition-all",
                filter === "bundled" ? "bg-primary text-primary-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              Bundled ({skills.filter((s) => s.isPlugin).length})
            </button>
          </div>

          <Button
            size="sm"
            onClick={() => {
              setAddForm(INITIAL_ADD_FORM);
              setAddError("");
              setAddModalOpen(true);
            }}
            className="gap-1.5 h-8 text-xs font-medium"
          >
            <Plus className="size-3.5" />
            Add Custom Skill
          </Button>
        </div>
      </div>

      {/* Grid of Skill Cards */}
      {loading ? (
        <div className="py-16 text-center text-sm text-muted-foreground">Loading skills...</div>
      ) : filteredSkills.length === 0 ? (
        <Empty className="my-8 rounded-xl border border-dashed border-border/80 p-8">
          <EmptyHeader>
            <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-violet-500/10 text-violet-500">
              <Sparkles className="size-6" />
            </div>
            <EmptyTitle>{search ? "No matching skills" : "No skills available"}</EmptyTitle>
            <EmptyDescription>
              {search
                ? `No skills matched your search query "${search}".`
                : "Create custom skills or install plugins to equip your agents with workflows and patterns."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredSkills.map((skill) => {
            const hasOverrides = skill.isOverriddenFor && skill.isOverriddenFor.length > 0;
            return (
              <div
                key={skill.id}
                className="group relative flex flex-col justify-between rounded-xl border border-border/60 bg-card/40 p-4.5 transition-all duration-200 hover:border-border hover:bg-card/70 shadow-xs/5"
              >
                <div>
                  {/* Badges row */}
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                    <div className="flex items-center gap-1.5">
                      {skill.isPlugin ? (
                        <Pill tone="violet" className="text-[10px]">
                          <Package className="size-3" />
                          Plugin: {skill.pluginName || "Bundled"}
                        </Pill>
                      ) : (
                        <Pill tone="amber" className="text-[10px]">
                          <FileCode className="size-3" />
                          Standalone
                        </Pill>
                      )}
                    </div>
                    <Pill tone="muted" className="text-[10px]" title="Skill usage count across agents">
                      <Activity className="size-3" />
                      Used {skill.usageCount ?? 0} {skill.usageCount === 1 ? "time" : "times"}
                    </Pill>
                  </div>

                  {/* Title & Description (clickable to inspect) */}
                  <div
                    onClick={() => void openSkillDetail(skill)}
                    className="cursor-pointer group-hover:text-primary transition-colors"
                  >
                    <h3 className="text-sm font-semibold tracking-tight text-foreground flex items-center justify-between">
                      <span>{skill.name}</span>
                      <ExternalLink className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </h3>
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                      {skill.description || "No description provided."}
                    </p>
                  </div>

                  {/* Overridden indicators */}
                  {hasOverrides && (
                    <div className="mt-3 rounded-md bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      <div className="font-medium flex items-center gap-1">
                        <Layers className="size-3" />
                        Overridden for:
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {skill.isOverriddenFor!.map((agentId) => (
                          <span
                            key={agentId}
                            className="inline-flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px]"
                          >
                            <AgentIcon agent={agentId} className="size-3" />
                            <span>{agentId}</span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleResetOverride(skill.id, agentId);
                              }}
                              title="Reset override to global version"
                              className="ml-0.5 text-muted-foreground hover:text-foreground"
                            >
                              <RotateCcw className="size-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Per-agent toggle pills */}
                <div className="mt-4 pt-3 border-t border-border/50">
                  <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground mb-1.5">
                    <span>Agent Access</span>
                    <button
                      type="button"
                      onClick={() => void openSkillDetail(skill)}
                      className="text-primary hover:underline"
                    >
                      Inspect SKILL.md
                    </button>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {CAPABILITY_AGENTS.map((agent) => {
                      const isEnabled = skill.enabledAgents.includes(agent.id);
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleToggleAgent(skill.id, agent.id, isEnabled);
                          }}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium transition-all duration-150 cursor-pointer",
                            isEnabled
                              ? "bg-primary/15 text-primary border border-primary/35 hover:bg-primary/25"
                              : "bg-muted/40 text-muted-foreground/60 border border-border/40 hover:bg-muted/70 hover:text-foreground",
                          )}
                          title={isEnabled ? `Enabled for ${agent.label}. Click to disable.` : `Disabled for ${agent.label}. Click to enable.`}
                        >
                          <AgentIcon agent={agent.id} className="size-3" />
                          <span>{agent.label}</span>
                          {isEnabled ? <Check className="size-2.5 text-primary" /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Slide-over Right Sidebar Panel for SKILL.md */}
      <Sheet open={!!selectedSkill} onOpenChange={(open) => !open && setSelectedSkill(null)}>
        <SheetPopup side="right" className="w-[calc(100%-2rem)] sm:max-w-2xl border-s border-border">
          {selectedSkill && (
            <div className="flex h-full flex-col">
              <SheetHeader className="border-b border-border/60 p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <SheetTitle className="text-lg font-semibold tracking-tight">{selectedSkill.name}</SheetTitle>
                      {selectedSkill.isPlugin ? (
                        <Pill tone="violet" className="text-xs">
                          {selectedSkill.pluginName || "Bundled Plugin"}
                        </Pill>
                      ) : (
                        <Pill tone="amber" className="text-xs">Standalone</Pill>
                      )}
                    </div>
                    <SheetDescription className="mt-1 text-xs text-muted-foreground">
                      {selectedSkill.description}
                    </SheetDescription>
                  </div>
                </div>

                {/* Sub-header controls: Agent Variant context and Actions */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/40 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">Editing variant:</span>
                    <div className="flex rounded-md border border-border bg-card/60 p-0.5">
                      <button
                        onClick={() => void handleAgentContextSwitch("global")}
                        className={cn(
                          "rounded px-2 py-0.5 text-xs font-medium transition-all",
                          editorAgent === "global"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        Global
                      </button>
                      {selectedSkill.isOverriddenFor?.map((agentId) => (
                        <button
                          key={agentId}
                          onClick={() => void handleAgentContextSwitch(agentId)}
                          className={cn(
                            "flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium transition-all",
                            editorAgent === agentId
                              ? "bg-amber-600 text-white"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <AgentIcon agent={agentId} className="size-3" />
                          <span>{agentId}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Create Override Dropdown */}
                  <div className="flex items-center gap-1.5">
                    {CAPABILITY_AGENTS.filter(
                      (a) => !selectedSkill.isOverriddenFor?.includes(a.id),
                    ).length > 0 && (
                      <div className="relative group">
                        <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
                          <Layers className="size-3" />
                          Create Override
                          <ChevronDown className="size-3 ml-0.5" />
                        </Button>
                        <div className="dropdown-glass absolute right-0 top-8 z-50 hidden group-hover:flex flex-col gap-0.5 w-44 rounded-lg border border-border p-1 shadow-lg bg-popover">
                          <div className="px-2 py-1 text-[10px] text-muted-foreground">Detach agent to custom variant:</div>
                          {CAPABILITY_AGENTS.filter(
                            (a) => !selectedSkill.isOverriddenFor?.includes(a.id),
                          ).map((agent) => (
                            <button
                              key={agent.id}
                              onClick={() => void handleCreateOverride(agent.id)}
                              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs text-foreground hover:bg-accent cursor-pointer text-left"
                            >
                              <AgentIcon agent={agent.id} className="size-3.5" />
                              <span>{agent.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {editorAgent !== "global" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 text-amber-600 hover:text-amber-700"
                        onClick={() => void handleResetOverride(selectedSkill.id, editorAgent as AgentId)}
                      >
                        <RotateCcw className="size-3" />
                        Reset Variant to Global
                      </Button>
                    )}
                  </div>
                </div>
              </SheetHeader>

              {/* Editor body */}
              <div className="flex flex-1 flex-col overflow-hidden p-5">
                <div className="flex items-center justify-between pb-2 text-xs text-muted-foreground">
                  <span className="font-mono text-[11px] truncate">{selectedSkill.path}</span>
                  {editorContent !== editorOriginalContent && (
                    <span className="text-amber-500 font-medium text-[11px]">Unsaved modifications</span>
                  )}
                </div>

                {editorLoading ? (
                  <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                    Loading SKILL.md...
                  </div>
                ) : (
                  <textarea
                    value={editorContent}
                    onChange={(e) => setEditorContent(e.target.value)}
                    placeholder="Enter markdown skill prompt instructions here..."
                    className="flex-1 w-full resize-none font-mono text-xs rounded-xl border border-border bg-card/60 p-4 leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary overflow-y-auto"
                    spellCheck={false}
                  />
                )}
              </div>

              {/* Panel Footer */}
              <div className="flex items-center justify-between border-t border-border/60 bg-muted/30 p-4">
                <div>
                  {selectedSkill.isPlugin ? (
                    <span
                      className="text-xs text-muted-foreground"
                      title="Plugin skills are managed by the plugin repo. Uninstall plugin to remove."
                    >
                      Bundled plugin skill (cannot delete individually)
                    </span>
                  ) : (
                    <ConfirmAction
                      trigger={
                        <Button size="sm" variant="destructive-outline" className="gap-1.5 text-xs h-8">
                          <Trash2 className="size-3.5" />
                          Delete Skill
                        </Button>
                      }
                      title={`Delete skill "${selectedSkill.name}"?`}
                      description="This will permanently delete this standalone skill file from disk."
                      effects={["Deletes SKILL.md from your local skills directory.", "AI agents will no longer have access to this skill."]}
                      confirmLabel="Delete Skill"
                      onConfirm={() => void handleDeleteSkill(selectedSkill.id)}
                    />
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedSkill(null)}
                    className="h-8 text-xs"
                  >
                    Close
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void handleSaveContent()}
                    disabled={savingContent || editorContent === editorOriginalContent}
                    className="gap-1.5 h-8 text-xs font-medium"
                  >
                    <Save className="size-3.5" />
                    {savingContent ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </SheetPopup>
      </Sheet>

      {/* Add Custom Skill Modal */}
      <AlertDialog.Root open={addModalOpen} onOpenChange={setAddModalOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] transition-opacity duration-150" />
          <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4 overflow-y-auto">
            <AlertDialog.Popup className="dialog-glass w-full max-w-xl rounded-2xl border border-border text-popover-foreground shadow-2xl p-6 transition-[opacity,scale] duration-150">
              <AlertDialog.Title className="text-base font-semibold tracking-tight">
                Add Custom Skill
              </AlertDialog.Title>
              <AlertDialog.Description className="text-xs text-muted-foreground mt-1">
                Define a standalone skill with custom markdown instructions and guidelines.
              </AlertDialog.Description>

              {addError && (
                <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {addError}
                </div>
              )}

              <div className="mt-4 space-y-3.5 text-xs">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block font-medium text-foreground mb-1">Skill Name</label>
                    <input
                      type="text"
                      placeholder="e.g. Code Review Assistant"
                      value={addForm.name}
                      onChange={(e) => {
                        const val = e.target.value;
                        setAddForm((prev) => ({
                          ...prev,
                          name: val,
                          id: prev.id || val.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
                        }));
                      }}
                      className="w-full rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div>
                    <label className="block font-medium text-foreground mb-1">Skill ID (slug)</label>
                    <input
                      type="text"
                      placeholder="e.g. code-review-assistant"
                      value={addForm.id}
                      onChange={(e) => setAddForm((prev) => ({ ...prev, id: e.target.value }))}
                      className="w-full font-mono rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">Description</label>
                  <input
                    type="text"
                    placeholder="Brief description of what this skill does"
                    value={addForm.description}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, description: e.target.value }))}
                    className="w-full rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1">SKILL.md Content</label>
                  <textarea
                    rows={8}
                    value={addForm.content}
                    onChange={(e) => setAddForm((prev) => ({ ...prev, content: e.target.value }))}
                    className="w-full font-mono rounded-md border border-border bg-card/60 p-2.5 text-xs leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>

                <div>
                  <label className="block font-medium text-foreground mb-1.5">Initial Enabled Agents</label>
                  <div className="flex flex-wrap gap-1.5">
                    {CAPABILITY_AGENTS.map((agent) => {
                      const checked = addForm.enabledAgents.includes(agent.id);
                      return (
                        <button
                          key={agent.id}
                          type="button"
                          onClick={() => {
                            setAddForm((prev) => ({
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
                <Button size="sm" onClick={() => void handleAddCustomSkill()}>
                  Create Skill
                </Button>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Viewport>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </PageContainer>
  );
}