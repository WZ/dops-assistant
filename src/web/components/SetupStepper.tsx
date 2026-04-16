import { Check } from "lucide-react";
import type { SetupStage } from "../hooks/useSetupStage";
import type { SidebarPage } from "./Sidebar";

interface SetupStepperProps {
  stage: SetupStage;
  onNavigate: (page: SidebarPage) => void;
  onSkip: () => void;
}

interface StepDef {
  number: number;
  title: string;
  description: string;
  page: SidebarPage;
}

const STEPS: StepDef[] = [
  { number: 1, title: "Connect Provider", description: "Add your Grafana or monitoring MCP server", page: "settings" },
  { number: 2, title: "Discover Services", description: "Scan your monitoring stack for services", page: "services" },
  { number: 3, title: "Monitor", description: "Your operations desk goes live", page: "dashboard" },
];

function getActiveIndex(stage: SetupStage): number {
  switch (stage) {
    case "needs-provider":
    case "needs-provider-connected":
      return 0;
    case "needs-discovery":
      return 1;
    case "complete":
      return 2;
  }
}

function getStatusText(stage: SetupStage): string | null {
  switch (stage) {
    case "needs-provider":
      return null;
    case "needs-provider-connected":
      return "Connecting...";
    case "needs-discovery":
      return null;
    case "complete":
      return null;
  }
}

export function SetupStepper({ stage, onNavigate, onSkip }: SetupStepperProps) {
  const activeIndex = getActiveIndex(stage);
  const statusText = getStatusText(stage);

  return (
    <nav
      role="navigation"
      aria-label="Setup progress"
      className="h-14 bg-card/60 border-b border-border/50 flex items-center px-4 gap-2 shrink-0"
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {STEPS.map((step, i) => {
          const isCompleted = i < activeIndex;
          const isActive = i === activeIndex;

          return (
            <button
              key={step.number}
              onClick={() => onNavigate(step.page)}
              aria-current={isActive ? "step" : undefined}
              className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg transition-all min-w-0 flex-1 ${
                isActive
                  ? "bg-primary/8 border border-primary/20"
                  : isCompleted
                  ? "bg-muted/30 border border-border/30"
                  : "border border-transparent opacity-50"
              }`}
            >
              <div
                className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-mono font-semibold ${
                  isCompleted
                    ? "bg-primary/20 text-primary"
                    : isActive
                    ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                    : "bg-muted/40 text-muted-foreground/50"
                }`}
              >
                {isCompleted ? <Check size={12} strokeWidth={2.5} /> : step.number}
              </div>
              <div className="min-w-0 text-left hidden sm:block">
                <div
                  className={`font-body text-[12px] font-semibold leading-tight truncate ${
                    isActive ? "text-foreground" : isCompleted ? "text-foreground/70" : "text-muted-foreground/50"
                  }`}
                >
                  {step.title}
                </div>
                <div className="font-body text-[10px] text-muted-foreground/50 leading-tight truncate">
                  {isActive && statusText ? (
                    <span className="text-primary/70">{statusText}</span>
                  ) : (
                    step.description
                  )}
                </div>
              </div>
              <span className="font-mono text-[10px] text-muted-foreground/40 sm:hidden">
                {step.number}/3
              </span>
            </button>
          );
        })}
      </div>
      <button
        onClick={onSkip}
        className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors whitespace-nowrap ml-2"
      >
        Skip setup
      </button>
      <div aria-live="polite" className="sr-only">
        {statusText && `Step ${activeIndex + 1}: ${statusText}`}
      </div>
    </nav>
  );
}
