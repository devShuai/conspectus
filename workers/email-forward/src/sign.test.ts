import { describe, expect, it } from "vitest";

import fixtures from "./fixtures/signature-vectors.json";
import { INBOUND_PATH, inboundSignatureMessage, signInboundRequest } from "./sign";

/**
 * #59 对拍（Worker 侧）：WebCrypto 实现 vs 共享 fixture 向量。
 * 服务端侧比对见 server-parity.test.ts；两侧命中同一份 fixture 即双端一致。
 */
describe("Worker 签名 vs 共享对拍向量 (#59)", () => {
  it("fixture 声明的路径与 Worker 常量一致", () => {
    expect(fixtures.path).toBe(INBOUND_PATH);
  });

  for (const vector of fixtures.vectors) {
    it(`向量 ${vector.name}：canonical 与签名逐字节一致`, async () => {
      await expect(
        inboundSignatureMessage(vector.timestamp, vector.bodyText),
      ).resolves.toBe(vector.canonical);
      await expect(
        signInboundRequest(vector.secret, vector.timestamp, vector.bodyText),
      ).resolves.toBe(vector.signature);
    });
  }
});
