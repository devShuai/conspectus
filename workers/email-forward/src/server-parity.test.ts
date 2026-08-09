import { describe, expect, it } from "vitest";

import {
  signInboundRequest as serverSign,
  verifyInboundSignature,
} from "../../../src/server/import/inbound";

import fixtures from "./fixtures/signature-vectors.json";
import { signInboundRequest as workerSign } from "./sign";

/**
 * #59 对拍（服务端侧）：直接调 src/server/import/inbound.ts 的真实函数，
 * 证明共享 fixture 与服务端实现一致；再证明服务端 verifyInboundSignature
 * 接受 Worker WebCrypto 实现算出的签名。fixture 漂移或任一端契约改动都会
 * 在这里红掉。
 */
describe("服务端签名逻辑 vs 共享对拍向量 (#59)", () => {
  for (const vector of fixtures.vectors) {
    it(`向量 ${vector.name}：服务端计算命中 fixture`, () => {
      expect(
        serverSign(vector.secret, vector.timestamp, vector.bodyText),
      ).toBe(vector.signature);
    });

    it(`向量 ${vector.name}：服务端验证接受 Worker 侧签名`, async () => {
      const workerSignature = await workerSign(
        vector.secret,
        vector.timestamp,
        vector.bodyText,
      );
      expect(
        verifyInboundSignature(
          vector.secret,
          vector.timestamp,
          vector.bodyText,
          workerSignature,
        ),
      ).toBe(true);
    });
  }

  it("动态 body：双端当场各算一次也逐字节一致", async () => {
    const bodyText = JSON.stringify({
      messageId: "<dynamic@mail.test>",
      subject: `动态-${Date.now()}`,
      raw: "AAECAwQ=",
    });
    const timestamp = String(Date.now());
    const secret = `dynamic-secret-${Math.random()}`;
    const workerSignature = await workerSign(secret, timestamp, bodyText);
    expect(workerSignature).toBe(serverSign(secret, timestamp, bodyText));
    expect(
      verifyInboundSignature(secret, timestamp, bodyText, workerSignature),
    ).toBe(true);
  });
});
