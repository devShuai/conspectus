import { describe, expect, it } from "vitest";

import {
  buildPayload,
  bytesToBase64,
  RAW_MAX_BYTES,
  readRawWithLimit,
} from "./payload";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function messageOf(
  rawText: string,
  headers: Record<string, string> = {},
): {
  from: string;
  to: string;
  headers: Headers;
  raw: ReadableStream<Uint8Array>;
} {
  return {
    from: "billing@vendor.test",
    to: `u-${"b".repeat(26)}@in.example.test`,
    headers: new Headers(headers),
    raw: streamOf(new TextEncoder().encode(rawText)),
  };
}

const NOW = new Date("2026-08-09T08:00:00.000Z");

describe("buildPayload (#59)", () => {
  it("提取头字段、raw 转 base64，与服务端 schema 口径一致", async () => {
    const rawText = "From: billing@vendor.test\r\nSubject: receipt\r\n\r\n68 CNY";
    const built = await buildPayload(
      messageOf(rawText, {
        "message-id": " <m-1@mail.test> ",
        subject: "Your receipt",
      }),
      { now: NOW },
    );
    expect(built.truncated).toBe(false);
    expect(built.rawBytes).toBe(new TextEncoder().encode(rawText).length);
    expect(built.payload).toEqual({
      messageId: "<m-1@mail.test>",
      from: "billing@vendor.test",
      to: `u-${"b".repeat(26)}@in.example.test`,
      subject: "Your receipt",
      receivedAt: NOW.toISOString(),
      raw: Buffer.from(rawText, "utf8").toString("base64"),
    });
  });

  it("缺 Message-ID 时用 raw 哈希兜底，重试重放稳定", async () => {
    const a = await buildPayload(messageOf("same body"), { now: NOW });
    const b = await buildPayload(messageOf("same body"), { now: NOW });
    expect(a.payload.messageId).toMatch(/^raw-sha256-[0-9a-f]{64}$/);
    expect(a.payload.messageId).toBe(b.payload.messageId);
  });

  it("超长头字段按服务端 schema 上限截断", async () => {
    const built = await buildPayload(
      messageOf("x", {
        "message-id": `<${"m".repeat(500)}@mail.test>`,
        subject: "s".repeat(600),
      }),
      { now: NOW },
    );
    expect(built.payload.messageId).toHaveLength(200);
    expect(built.payload.subject).toHaveLength(500);
  });

  it("raw 超限截断且确定性，JSON body 始终小于服务端 1 MiB 上限", async () => {
    const big = new Uint8Array(RAW_MAX_BYTES + 4096).fill(0x61);
    const built = await buildPayload(
      {
        from: "a@b.c",
        to: `u-${"b".repeat(26)}@in.example.test`,
        headers: new Headers({ "message-id": "<big@mail.test>" }),
        raw: streamOf(big.subarray(0, 400_000), big.subarray(400_000)),
      },
      { now: NOW },
    );
    expect(built.truncated).toBe(true);
    expect(built.rawBytes).toBe(RAW_MAX_BYTES);
    expect(
      Buffer.byteLength(JSON.stringify(built.payload), "utf8"),
    ).toBeLessThanOrEqual(1024 * 1024);
  });
});

describe("readRawWithLimit", () => {
  it("跨 chunk 截断在边界上", async () => {
    const { bytes, truncated } = await readRawWithLimit(
      streamOf(
        new Uint8Array([1, 2, 3, 4]),
        new Uint8Array([5, 6, 7, 8]),
        new Uint8Array([9, 10]),
      ),
      6,
    );
    expect(truncated).toBe(true);
    expect([...bytes]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("未超限读完整流", async () => {
    const { bytes, truncated } = await readRawWithLimit(
      streamOf(new Uint8Array([1, 2]), new Uint8Array([3])),
      10,
    );
    expect(truncated).toBe(false);
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});

describe("bytesToBase64", () => {
  it("与 Node Buffer 编码逐字节一致（含大输入分片）", () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});
