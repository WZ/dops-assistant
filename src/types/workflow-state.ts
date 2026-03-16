import { z } from "zod";

export const PrefetchedContextSchema = z.object({
  datasourceHints: z.string(),
  dashboardContext: z.string(),
  panelQueryHints: z.string(),
  logLabelHints: z.string(),
  workingLogSelectors: z.array(z.string()),
});

export type PrefetchedContext = z.infer<typeof PrefetchedContextSchema>;
