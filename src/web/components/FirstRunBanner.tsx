import { Button } from "@/components/ui/button";

interface FirstRunBannerProps {
  onRunDiscovery: () => void;
  onDismiss: () => void;
}

export function FirstRunBanner({ onRunDiscovery, onDismiss }: FirstRunBannerProps) {
  return (
    <div className="mx-6 mt-4 p-4 rounded-lg border bg-card/40 flex items-center gap-4">
      <div className="text-2xl bg-primary/10 text-primary p-2 rounded-md">&#x1F4E1;</div>
      <div className="flex-1">
        <p className="font-semibold text-sm">No services configured</p>
        <p className="text-xs text-muted-foreground/60">
          Run service discovery to detect your monitored services, or add them manually.
        </p>
      </div>
      <Button
        onClick={onRunDiscovery}
        size="sm"
      >
        Run Discovery
      </Button>
      <Button
        onClick={onDismiss}
        variant="outline"
        size="sm"
      >
        Dismiss
      </Button>
    </div>
  );
}
