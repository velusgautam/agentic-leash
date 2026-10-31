import { createHashHistory, createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { AppLayout } from "~/components/AppLayout";
import { AgentPage } from "~/routes/agent";
import { ApprovalPage } from "~/routes/approval";
import { GrantsPage } from "~/routes/grants";
import { HistoryPage } from "~/routes/history";
import { InsightsPage } from "~/routes/insights";
import { LivePage } from "~/routes/live";
import { McpPage } from "~/routes/mcp";
import { PluginsPage } from "~/routes/plugins";
import { SettingsPage } from "~/routes/settings";
import { SkillsPage } from "~/routes/skills";

const rootRoute = createRootRoute({ component: AppLayout });

const routeTree = rootRoute.addChildren([
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    beforeLoad: () => {
      throw redirect({ to: "/live" });
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/live", component: LivePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/grants", component: GrantsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/history", component: HistoryPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/insights", component: InsightsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/mcp", component: McpPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/skills", component: SkillsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/plugins", component: PluginsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/agents/$agentId", component: AgentPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/approval", component: ApprovalPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings",
    beforeLoad: () => {
      throw redirect({ to: "/settings/$section", params: { section: "general" } });
    },
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/$section", component: SettingsPage }),
]);

// Hash history: the packaged renderer loads from file://.
export const router = createRouter({ routeTree, history: createHashHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
