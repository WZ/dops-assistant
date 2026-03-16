import type { ServiceConfig } from "../../config/schema.js";

interface ServicesSectionProps {
  services: ServiceConfig[];
  onManage: () => void;
  onRediscover: () => void;
}

export function ServicesSection({ services, onManage, onRediscover }: ServicesSectionProps) {
  if (services.length === 0) return null;

  return (
    <section className="mt-8">
      <div className="rounded-lg border bg-card/40 overflow-hidden">
        <div className="flex items-center px-4 py-3 border-b">
          <span className="font-semibold text-sm flex-1">Services</span>
          <span className="text-xs text-muted-foreground/50 mr-3">
            {services.length} service(s)
          </span>
          <button
            onClick={onManage}
            className="text-xs text-primary border border-border px-3 py-1 rounded hover:bg-accent mr-2"
          >
            Manage
          </button>
          <button
            onClick={() => {
              if (window.confirm("Re-run service discovery? This will replace your current service registry if you accept the results.")) {
                onRediscover();
              }
            }}
            className="text-xs text-muted-foreground border border-border px-3 py-1 rounded hover:bg-accent"
          >
            Re-discover
          </button>
        </div>
      </div>
    </section>
  );
}
