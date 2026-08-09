/**
 * 生成 src/fixtures/signature-vectors.json（#59 签名对拍向量）。
 *
 * 用法：node scripts/generate-signature-vectors.mjs
 *
 * 本脚本用 node:crypto 按头注契约独立实现一遍 canonical 签名；生成后由两
 * 侧测试各自比对同一份 fixture——server-parity.test.ts 证明服务端
 * signInboundRequest/verifyInboundSignature 与 fixture 一致，sign.test.ts
 * 证明 Worker 的 WebCrypto 实现与 fixture 一致——从而间接证明双端一致。
 * 修改契约（路径/拼接顺序/算法）时必须重新生成并同时改服务端。
 */
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INBOUND_PATH = "/api/inbound/email";

function sign(secret, timestamp, bodyText) {
  const bodyHash = createHash("sha256").update(bodyText).digest("hex");
  const canonical = ["POST", INBOUND_PATH, timestamp, bodyHash].join("\n");
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return { canonical, signature };
}

const rawMime =
  "From: billing@vendor.test\r\nSubject: Your receipt\r\n\r\ncharged 68 CNY";

const cases = [
  {
    name: "basic-ascii",
    secret: "test-inbound-webhook-secret-0123456789abcdef",
    timestamp: "1754726400000",
    bodyText: JSON.stringify({
      messageId: "<m-001@mail.test>",
      from: "billing@vendor.test",
      to: `u-${"b".repeat(26)}@in.example.test`,
      subject: "Your receipt",
      receivedAt: "2026-08-09T08:00:00.000Z",
      raw: Buffer.from(rawMime, "utf8").toString("base64"),
    }),
  },
  {
    name: "unicode-subject",
    secret: "another-secret-with-unicode-密钥",
    timestamp: "1754726400123",
    bodyText: JSON.stringify({
      messageId: "<m-002@mail.test>",
      from: "billing@vendor.test",
      to: `u-${"c".repeat(26)}@in.example.test`,
      subject: "扣款通知：会员续费 ¥68",
      receivedAt: "2026-08-09T08:00:01.123Z",
      raw: Buffer.from("Subject: 扣款通知\r\n\r\n续费 ¥68", "utf8").toString("base64"),
    }),
  },
  {
    name: "no-raw-field",
    secret: "test-inbound-webhook-secret-0123456789abcdef",
    timestamp: "1754726499999",
    bodyText: JSON.stringify({
      messageId: "<m-003@mail.test>",
      from: "billing@vendor.test",
      to: `u-${"d".repeat(26)}@in.example.test`,
      subject: "",
      receivedAt: "2026-08-09T08:01:39.999Z",
    }),
  },
  {
    name: "empty-body-edge",
    secret: "x",
    timestamp: "0",
    bodyText: "",
  },
];

const vectors = cases.map(({ name, secret, timestamp, bodyText }) => ({
  name,
  secret,
  timestamp,
  bodyText,
  ...sign(secret, timestamp, bodyText),
}));

const out = {
  comment:
    "#59 双端签名对拍向量（scripts/generate-signature-vectors.mjs 生成）。canonical 与服务端 inboundSignatureMessage、Worker 端 sign.ts 逐字节对齐。",
  path: INBOUND_PATH,
  vectors,
};

const target = fileURLToPath(
  new URL("../src/fixtures/signature-vectors.json", import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${vectors.length} vectors -> ${target}`);
