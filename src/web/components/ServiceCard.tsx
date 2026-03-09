import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function ServiceCard({ name, onClick }: { name: string; onClick: () => void }) {
  return (
    <Card className="cursor-pointer hover:border-primary transition-colors" onClick={onClick}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">{name}</CardTitle>
      </CardHeader>
      <CardContent>
        <Badge variant="outline" className="text-xs">healthy</Badge>
      </CardContent>
    </Card>
  );
}
