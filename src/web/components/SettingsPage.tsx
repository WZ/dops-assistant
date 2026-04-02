// src/web/components/SettingsPage.tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ProvidersPage } from "./ProvidersPage";
import { SkillsPage } from "./SkillsPage";
import { StacksManagePage } from "./StacksManagePage";
import { NotificationsTab } from "./NotificationsTab";
import type { StackSummary } from "../../types/stack-types.js";

interface SettingsPageProps {
  onRunDiscovery: () => void;
  initialTab?: "providers" | "skills" | "stacks" | "notifications";
  stacks: StackSummary[];
  activeStackId: string;
  onSwitchStack: (stackId: string) => void;
  onRefetchStacks: () => Promise<void>;
}

export function SettingsPage({ onRunDiscovery, initialTab = "providers", stacks, activeStackId, onSwitchStack, onRefetchStacks }: SettingsPageProps) {
  return (
    <div className="h-full overflow-y-auto px-4 py-5">
      <h1 className="font-display text-xl font-bold tracking-tight text-foreground/90 mb-1">
        Settings
      </h1>
      <p className="text-xs font-mono text-muted-foreground/70 tracking-wide mb-5">
        Providers, skills, and configuration
      </p>

      <Tabs defaultValue={initialTab}>
        <TabsList className="bg-transparent border-b border-border rounded-none p-0 h-auto gap-1">
          <TabsTrigger
            value="providers"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Providers
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
            value="notifications"
            className="font-mono text-[10px] font-medium px-4 py-2 rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:text-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Notifications
          </TabsTrigger>
        </TabsList>
        <TabsContent value="providers" className="mt-4">
          <ProvidersPage onRunDiscovery={onRunDiscovery} />
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
        <TabsContent value="notifications" className="mt-4">
          <NotificationsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
