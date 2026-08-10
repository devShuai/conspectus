import { describe, expect, it } from "vitest";

import { collectionDiagnostics } from "./collection-diagnostics.js";

describe("collectionDiagnostics (#128)", () => {
  it("explains an empty Provider-only manifest", () => {
    expect(collectionDiagnostics([], [], 0, ["codex"])).toEqual({
      manifestBindings: 0,
      collectorErrors: [],
      warnings: [
        expect.objectContaining({ code: "no_local_bindings" }),
      ],
    });
  });

  it("does not hide a collector that is not installed", () => {
    const result = collectionDiagnostics(
      [{ collectorId: "codex" }],
      [{ id: "codex", ok: false, error: "not_installed", readings: 0 }],
      0,
      ["codex"],
    );
    expect(result.collectorErrors).toEqual([
      { collectorId: "codex", error: "not_installed" },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("reports a collector id that this CLI version does not know", () => {
    const result = collectionDiagnostics(
      [{ collectorId: "future-collector" }],
      [],
      0,
      ["codex"],
    );
    expect(result.collectorErrors).toEqual([
      { collectorId: "future-collector", error: "unknown_collector" },
    ]);
  });

  it("distinguishes a successful probe that yielded no matching readings", () => {
    const result = collectionDiagnostics(
      [{ collectorId: "codex" }],
      [{ id: "codex", ok: true, readings: 0 }],
      0,
      ["codex"],
    );
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "no_readings" }),
    ]);
  });
});
