import { z } from "zod";

export const UsageReadingSchema = z
  .object({
    bindingId: z.string().uuid(),
    kind: z.enum(["quota", "balance", "counter"]),
    metric: z.string().min(1).max(128),
    unit: z.string().min(1).max(32),
    usedValue: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
    limitValue: z.string().regex(/^\d+(\.\d+)?$/).optional(),
    remainingValue: z.string().regex(/^-?\d+(\.\d+)?$/).optional(),
    periodStart: z.string().datetime().optional(),
    periodEnd: z.string().datetime().optional(),
    capturedAt: z.string().datetime(),
  })
  .strict(); // unknown fields rejected, not silently passed through

export type UsageReading = z.infer<typeof UsageReadingSchema>;

export class IngestError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "IngestError";
  }
}
