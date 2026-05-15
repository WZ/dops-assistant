// src/web/components/SettingsPage.tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ProvidersPage } from "./ProvidersPage";
import { AlertWebhooksTab } from "./AlertWebhooksTab";
import { SkillsPage } from "./SkillsPage";
import { StacksManagePage } from "./StacksManagePage";
import { NotificationsTab } from "./NotificationsTab";
import { ScanTab } from "./ScanTab";
import { DiscoveryTab } from "./DiscoveryTab";
import { LlmTab } from "./LlmTab";
import type { StackSummary } from "../../types/stack-types.js";

export type SettingsTab =
  | "providers"
  | "webhooks"
  | "skills"
  | "stacks"
  | "scan"
  | "discovery"
  | "notifications"
  | "llm";

interface SettingsPageProps {
  onRunDiscovery: () => void;
  activeTab: SettingsTab;
  onChangeTab: (tab: SettingsTab) => void;
  stacks: StackSummary[];
  activeStackId: string;
  onSwitchStack: (stackId: string) => void;
  onRefetchStacks: () => Promise<void>;
  onProviderSaved?: () => void;
}

// Fully parent-controlled tabs. Earlier versions used uncontrolled tabs with
// a defaultValue (and later a useEffect-resynced useState). Both let the
// internal Tabs state diverge from the parent's URL/leftPane state: clicking
// a tab inside SettingsPage moved the visible tab without updating the URL,
// so a follow-up external nav targeting the same URL-tab (e.g. "New Stack"
// while the URL already pointed at /settings/stacks) saw no prop change and
// could not snap the divergent internal state back. Making the tab fully
// owned by App.tsx removes the divergence by construction: every click flows
// through onChangeTab → setLeftPane → URL + state in lockstep.
export function SettingsPage({ onRunDiscovery, activeTab, onChangeTab, stacks, activeStackId, onSwitchStack, onRefetchStacks, onProviderSaved }: SettingsPageProps) {
  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground/90 mb-1">
        Settings
      </h1>
      <p className="text-xs font-mono text-muted-foreground/70 tracking-wide mb-5">
        Providers, skills, stacks, scans, and notifications
      </p>

      <Tabs value={activeTab} onValueChange={(v) => onChangeTab(v as SettingsTab)}>
        <TabsList className="bg-transparent border-b border-border rounded-none p-0 h-auto gap-1">
          <TabsTrigger
            value="providers"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Providers
          </TabsTrigger>
          <TabsTrigger
            value="webhooks"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Alert Webhooks
          </TabsTrigger>
          <TabsTrigger
            value="skills"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Skills
          </TabsTrigger>
          <TabsTrigger
            value="stacks"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Stacks
          </TabsTrigger>
          <TabsTrigger
            value="scan"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Scan
          </TabsTrigger>
          <TabsTrigger
            value="discovery"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Discovery
          </TabsTrigger>
          <TabsTrigger
            value="notifications"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Notifications
          </TabsTrigger>
          <TabsTrigger
            value="llm"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            LLM
          </TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="mt-4">
          <ProvidersPage onRunDiscovery={onRunDiscovery} onProviderSaved={onProviderSaved} />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-4">
          <AlertWebhooksTab />
        </TabsContent>
        <TabsContent value="skills" className="mt-4">
          <SkillsPage />
        </TabsContent>
        <TabsContent value="stacks" className="mt-4">
          <StacksManagePage
            stacks={stacks}
            activeStackId={activeStackId}
            onSwitchStack={onSwitchStack}
            onRefetch={onRefetchStacks}
          />
        </TabsContent>
        <TabsContent value="scan" className="mt-4">
          <ScanTab />
        </TabsContent>
        <TabsContent value="discovery" className="mt-4">
          <DiscoveryTab />
        </TabsContent>
        <TabsContent value="notifications" className="mt-4">
          <NotificationsTab />
        </TabsContent>
        <TabsContent value="llm" className="mt-4">
          <LlmTab stack={stacks.find((s) => s.id === activeStackId)} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
