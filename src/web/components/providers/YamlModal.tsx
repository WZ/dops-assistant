import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { YamlImportTab } from "./YamlImportTab";
import { YamlExportTab } from "./YamlExportTab";

interface YamlModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function YamlModal({ open, onOpenChange, onImported }: YamlModalProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="font-display text-base font-semibold tracking-tight">
            YAML Providers
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground/70">
            Import or export provider configurations as YAML
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="import">
          <TabsList className="mb-2">
            <TabsTrigger value="import" className="font-mono text-xs">
              Import
            </TabsTrigger>
            <TabsTrigger value="export" className="font-mono text-xs">
              Export
            </TabsTrigger>
          </TabsList>
          <TabsContent value="import">
            <YamlImportTab
              onImported={onImported}
              onCancel={() => onOpenChange(false)}
            />
          </TabsContent>
          <TabsContent value="export">
            <YamlExportTab />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
