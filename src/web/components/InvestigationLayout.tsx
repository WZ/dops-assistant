import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";

interface InvestigationLayoutProps {
  leftPanel: React.ReactNode;
  centerPanel: React.ReactNode;
  rightPanel: React.ReactNode;
}

export function InvestigationLayout({ leftPanel, centerPanel, rightPanel }: InvestigationLayoutProps) {
  return (
    <ResizablePanelGroup orientation="horizontal" className="h-full">
      <ResizablePanel defaultSize={20} minSize={15} maxSize={30}>
        <div className="h-full overflow-y-auto">{leftPanel}</div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50} minSize={30}>
        <div className="h-full overflow-hidden">{centerPanel}</div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={30} minSize={20}>
        <div className="h-full overflow-hidden">{rightPanel}</div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
