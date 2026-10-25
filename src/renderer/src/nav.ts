import {
  Activity,
  BarChart3,
  Bot,
  EyeOff,
  FolderLock,
  History,
  Keyboard,
  Palette,
  Radar,
  Scale,
  Settings2,
  Stethoscope,
} from "lucide-react";

export const MAIN_NAV = [
  { to: "/live", label: "Live", icon: Activity },
  { to: "/grants", label: "Access", icon: FolderLock },
  { to: "/history", label: "History", icon: History },
  { to: "/insights", label: "Insights", icon: BarChart3 },
] as const;

export const AGENT_NAV = [
  { id: "claude-code", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "codex", label: "Codex" },
  { id: "gemini", label: "Gemini" },
  { id: "antigravity", label: "Antigravity" },
  { id: "hermes", label: "Hermes" },
] as const;

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "monitoring", label: "Monitoring & storage", icon: Radar },
  { id: "ignored", label: "Hidden from history", icon: EyeOff },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
  { id: "diagnostics", label: "Diagnostics", icon: Stethoscope },
  { id: "licenses", label: "Licenses", icon: Scale },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
