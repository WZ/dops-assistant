import * as React from "react";

import { cn } from "@/lib/utils";

interface CollapsibleContextValue {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CollapsibleContext = React.createContext<CollapsibleContextValue | null>(
  null,
);

function useCollapsibleContext() {
  const context = React.useContext(CollapsibleContext);
  if (!context)
    throw new Error(
      "Collapsible components must be used within <Collapsible>",
    );
  return context;
}

function Collapsible({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const handleOpenChange = onOpenChange ?? setUncontrolledOpen;

  return (
    <CollapsibleContext.Provider value={{ open, onOpenChange: handleOpenChange }}>
      <div className={cn("", className)} data-state={open ? "open" : "closed"} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

function CollapsibleTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<"button">) {
  const { open, onOpenChange } = useCollapsibleContext();

  return (
    <button
      type="button"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      className={cn("", className)}
      onClick={() => onOpenChange(!open)}
      {...props}
    >
      {children}
    </button>
  );
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { open } = useCollapsibleContext();

  return (
    <div
      data-state={open ? "open" : "closed"}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-300 ease-out",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
      {...props}
    >
      <div className={cn("overflow-hidden", className)}>
        {children}
      </div>
    </div>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
