import type { CollectorRunStatus } from "./collectors/runner.js";

interface CollectionBinding {
  collectorId: string;
}

export interface CollectorError {
  collectorId: string;
  error: string;
}

export interface CollectionWarning {
  code: "no_local_bindings" | "no_readings";
  message: string;
}

/**
 * Explain an empty collection result without touching tokens, device keys or
 * upstream payloads. The CLI previously collapsed all of these states to
 * `readings: [], collectorErrors: []`, which made a valid Provider-only setup
 * indistinguishable from a broken local collector (#128).
 */
export function collectionDiagnostics(
  bindings: CollectionBinding[],
  statuses: CollectorRunStatus[],
  readingCount: number,
  registeredCollectorIds: string[],
): {
  manifestBindings: number;
  collectorErrors: CollectorError[];
  warnings: CollectionWarning[];
} {
  const collectorErrors: CollectorError[] = statuses
    .filter((status) => !status.ok)
    .map((status) => ({
      collectorId: status.id,
      error: status.error ?? "unknown",
    }));

  const registered = new Set(registeredCollectorIds);
  const unknown = new Set(
    bindings
      .map((binding) => binding.collectorId)
      .filter((collectorId) => !registered.has(collectorId)),
  );
  for (const collectorId of unknown) {
    collectorErrors.push({ collectorId, error: "unknown_collector" });
  }

  const warnings: CollectionWarning[] = [];
  if (bindings.length === 0) {
    warnings.push({
      code: "no_local_bindings",
      message:
        "当前账户没有本地采集绑定；Provider 连接不会出现在 CLI manifest 中，请在设置 / 用量录入中绑定受支持的本地采集器。",
    });
  } else if (readingCount === 0 && collectorErrors.length === 0) {
    warnings.push({
      code: "no_readings",
      message: "采集器已运行但没有生成读数，请检查绑定的指标名、账户能力和采集器前置条件。",
    });
  }

  return { manifestBindings: bindings.length, collectorErrors, warnings };
}
