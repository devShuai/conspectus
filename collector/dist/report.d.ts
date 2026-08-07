import type { CliConfig } from "./config.js";
import type { UsageReading } from "./types.js";
export interface ReportResult {
    accepted: number;
    rejected: Array<{
        index: number;
        reason: string;
    }>;
}
/**
 * Report readings to conspectus /api/collect/usage. Buffered on failure;
 * caller retries the batch later (no data loss on transient errors).
 */
export declare function reportReadings(config: CliConfig, readings: UsageReading[], deviceId?: string, signature?: string, timestamp?: string): Promise<ReportResult>;
/** Fetch the manifest of bindings this collector may write. */
export declare function fetchManifest(config: CliConfig): Promise<UsageReading["bindingId"][]>;
