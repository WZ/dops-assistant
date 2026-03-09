import { cn } from "@/lib/utils";

function Skeleton({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-secondary/40 border border-border/20", className)}
      {...props}
    />
  );
}

export { Skeleton };
