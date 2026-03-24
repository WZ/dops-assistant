// src/web/components/Sidebar.tsx
import { LayoutGrid, Server, Settings, Sun, Moon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export type SidebarPage = "dashboard" | "services" | "settings";

interface SidebarProps {
  activePage: SidebarPage;
  onNavigate: (page: SidebarPage) => void;
  dark: boolean;
  onToggleTheme: () => void;
}

const NAV_ITEMS: { page: SidebarPage; label: string; icon: typeof LayoutGrid }[] = [
  { page: "dashboard", label: "Dashboard", icon: LayoutGrid },
  { page: "services", label: "Services", icon: Server },
  { page: "settings", label: "Settings", icon: Settings },
];

export function Sidebar({ activePage, onNavigate, dark, onToggleTheme }: SidebarProps) {
  return (
    <nav className="w-12 bg-card border-r border-border/50 flex flex-col items-center py-3 shrink-0 z-20">
      <div className="flex flex-col items-center gap-1 flex-1">
        {NAV_ITEMS.map(({ page, label, icon: Icon }) => {
          const isActive = activePage === page;
          return (
            <Tooltip key={page}>
              <TooltipTrigger asChild>
                <button
                  title={label}
                  onClick={() => onNavigate(page)}
                  className={`relative w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                    isActive
                      ? "bg-primary/8 text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}
                >
                  {isActive && (
                    <div className="absolute left-[-6px] top-1/2 -translate-y-1/2 w-[3px] h-4 bg-primary rounded-r-sm" />
                  )}
                  <Icon size={18} strokeWidth={1.8} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="font-mono text-[10px] tracking-wide">
                {label}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="pt-2 border-t border-border">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              title="Toggle theme"
              onClick={onToggleTheme}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-secondary hover:text-foreground transition-all"
            >
              {dark ? <Sun size={16} strokeWidth={1.8} /> : <Moon size={16} strokeWidth={1.8} />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono text-[10px] tracking-wide">
            {dark ? "Light mode" : "Dark mode"}
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
