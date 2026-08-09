import { afterEach, describe, expect, it, vi } from "vitest";

import { handleEmail } from "./index";
import { signInboundRequest } from "./sign";
import type { InboundEmailMessage } from "./types";

const ENV = {
  INBOUND_WEBHOOK_SECRET: "worker-secret-0123456789abcdef",
  // 末尾斜杠刻意保留：endpoint 归一化应去掉
  INBOUND_ENDPOINT: "https://app.example.test/",
};

// 真实 MIME 头只含 ASCII（非 ASCII 走 RFC 2047 编码），敏感样本用 ASCII 哨兵串
const SECRET_SUBJECT = "SECRET-SUBJECT-DO-NOT-LOG";

function makeMessage(): InboundEmailMessage {
  const raw = new TextEncoder().encode(
    `Subject: ${SECRET_SUBJECT}\r\n\r\nSECRET-BODY-DO-NOT-LOG`,
  );
  return {
    from: "sender-secret-do-not-log@vendor.test",
    to: `u-${"b".repeat(26)}@in.example.test`,
    headers: new Headers({
      "message-id": "<handler-1@mail.test>",
      subject: SECRET_SUBJECT,
    }),
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    }),
    rawSize: raw.length,
    setReject: () => undefined,
  };
}

function stubFetch(
  impl: () => Promise<Response> | Response,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(impl);
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleEmail (#59)", () => {
  it("202：按契约签名 POST，endpoint 归一化，setReject 从不调用", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 202 }));
    const message = makeMessage();
    const setRejectSpy = vi.spyOn(message, "setReject");

    await expect(handleEmail(message, ENV)).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string; method: string },
    ];
    expect(url).toBe("https://app.example.test/api/inbound/email");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["x-inbound-timestamp"]).toMatch(/^\d+$/);
    // 签名必须覆盖线上实际发送的那个 body 字符串
    const expected = await signInboundRequest(
      ENV.INBOUND_WEBHOOK_SECRET,
      init.headers["x-inbound-timestamp"],
      init.body,
    );
    expect(init.headers["x-inbound-signature"]).toBe(expected);
    expect(JSON.parse(init.body).messageId).toBe("<handler-1@mail.test>");
    expect(setRejectSpy).not.toHaveBeenCalled();
  });

  it("日志只含事件与数字，绝不泄露地址/主题/正文/secret", async () => {
    stubFetch(() => new Response(null, { status: 202 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleEmail(makeMessage(), ENV);

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("inbound_forwarded");
    for (const sensitive of [
      SECRET_SUBJECT,
      "SECRET-BODY-DO-NOT-LOG",
      "sender-secret-do-not-log",
      ENV.INBOUND_WEBHOOK_SECRET,
      "u-bbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]) {
      expect(logged).not.toContain(sensitive);
    }
  });

  it.each([429, 500, 502, 401, 404, 400])(
    "非 202（%i）：抛错交平台重试（401 覆盖 secret 轮换窗口）",
    async (status) => {
      stubFetch(() => new Response(null, { status }));
      await expect(handleEmail(makeMessage(), ENV)).rejects.toThrow(
        `status ${status}`,
      );
    },
  );

  it("网络错误/超时中断：抛错交平台重试", async () => {
    stubFetch(() => Promise.reject(new Error("socket hangup")));
    await expect(handleEmail(makeMessage(), ENV)).rejects.toThrow(
      "inbound upstream unreachable",
    );
  });

  it("缺 secret 或 endpoint：不取流不发请求，直接抛错", async () => {
    const fetchMock = stubFetch(() => new Response(null, { status: 202 }));
    await expect(
      handleEmail(makeMessage(), { INBOUND_ENDPOINT: ENV.INBOUND_ENDPOINT }),
    ).rejects.toThrow("not configured");
    await expect(
      handleEmail(makeMessage(), {
        INBOUND_WEBHOOK_SECRET: ENV.INBOUND_WEBHOOK_SECRET,
      }),
    ).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
