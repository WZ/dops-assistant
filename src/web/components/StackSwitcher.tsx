import { ChevronDown, Plus } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { StackSummary } from "../../types/stack-types.js";

interface StackSwitcherProps {
  stacks: StackSummary[];
  activeStackId: string;
  onSwitch: (stackId: string) => void;
  onNewStackRequested: () => void;
}

function healthDotColor(stack: StackSummary): string {
  const h = stack.healthSummary;
  if (!h || h.total === 0) return "bg-muted-foreground/30";
  if (h.down > 0) return "bg-destructive";
  if (h.degraded > 0) return "bg-warning";
  if (h.healthy === h.total) return "bg-success";
  return "bg-muted-foreground/30";
}

// TODO(v2): When switching stacks mid-investigation, the active investigation's
// real-time WS events will stop rendering since the UI re-mounts with the new
// stack's context. Ideally we'd show a warning or block switching while an
// investigation is running. The investigation status isn't easily accessible from
// here without lifting state — deferring to v2.
export function StackSwitcher({ stacks, activeStackId, onSwitch, onNewStackRequested }: StackSwitcherProps) {
  const activeStack = stacks.find((s) => s.id === activeStackId);
  const isSingleStack = stacks.length <= 1;

  // Single stack: show name only, no dropdown
  if (isSingleStack) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1">
        <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-foreground/80">
          {activeStack?.name ?? "Default"}
        </span>
      </div>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-secondary/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-2"
            aria-label="Switch stack"
          >
            {activeStack && (
              <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${healthDotColor(activeStack)}`} />
            )}
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-foreground/80 max-w-[120px] truncate">
              {activeStack?.name ?? "Select Stack"}
            </span>
            <ChevronDown size={12} className="text-muted-foreground/60 shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[200px]">
          {stacks.map((stack) => (
            <DropdownMenuItem
              key={stack.id}
              onClick={() => onSwitch(stack.id)}
              className={`flex items-center gap-2 px-3 py-2 h-8 cursor-pointer ${
                stack.id === activeStackId
                  ? "bg-primary/8 text-primary"
                  : ""
              }`}
            >
              <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${healthDotColor(stack)}`} />
              <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] flex-1 truncate">
                {stack.name}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground/50">
                {stack.providerCount}p
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={onNewStackRequested}
            className="flex items-center gap-2 px-3 py-2 h-8 cursor-pointer text-primary"
          >
            <Plus size={12} />
            <span className="font-mono text-[10px] font-medium uppercase tracking-[0.12em]">
              New Stack
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
