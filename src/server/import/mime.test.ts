import { describe, expect, it } from "vitest";

import {
  decodeEncodedWords,
  extractMimeText,
  htmlToText,
} from "./mime";

/** #60：MIME 纯文本提取的单元测试（畸形输入一律降级不抛）。 */
describe("extractMimeText (#60)", () => {
  it("text/plain 8bit 直接取正文与头", () => {
    const raw =
      "From: Vendor <billing@vendor.test>\r\n" +
      "Subject: Your receipt\r\n" +
      "Date: Sat, 01 Aug 2026 18:02:11 +0000\r\n" +
      "Content-Type: text/plain; charset=\"utf-8\"\r\n" +
      "\r\n" +
      "charged USD 68.00";
    const mime = extractMimeText(raw);
    expect(mime.subject).toBe("Your receipt");
    expect(mime.from).toBe("Vendor <billing@vendor.test>");
    expect(mime.text).toBe("charged USD 68.00");
    expect(mime.dateHeader?.toISOString()).toBe("2026-08-01T18:02:11.000Z");
  });

  it("multipart/alternative 优先 text/plain，忽略附件 part", () => {
    const raw = [
      "From: a@b.c",
      'Content-Type: multipart/mixed; boundary="mix"',
      "",
      "--mix",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "plain body",
      "--alt",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>html body</p>",
      "--alt--",
      "--mix",
      'Content-Type: application/pdf',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0xLjQ=",
      "--mix--",
    ].join("\r\n");
    const mime = extractMimeText(raw);
    expect(mime.text).toBe("plain body");
  });

  it("无 text/plain 时 HTML 转文本（不渲染、脚本样式剔除）", () => {
    const raw = [
      "From: a@b.c",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<html><head><title>t</title><style>p{color:red}</style></head>",
      '<body><script>alert(1)</script><p>金额&nbsp;¥21.00</p></body></html>',
    ].join("\r\n");
    const mime = extractMimeText(raw);
    expect(mime.text).not.toContain("alert");
    expect(mime.text).not.toContain("color");
    expect(mime.text).not.toContain("<title>");
    expect(mime.text).toContain("金额 ¥21.00");
  });

  it("base64 + charset 解码（CJK）", () => {
    const body = Buffer.from("扣款金额：¥68.00", "utf8").toString("base64");
    const raw = [
      "From: a@b.c",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].join("\r\n");
    expect(extractMimeText(raw).text).toBe("扣款金额：¥68.00");
  });

  it("quoted-printable 解码（转义字节 + 软换行）", () => {
    const raw = [
      "From: a@b.c",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "f=C3=BCr 10,99 =E2=82=AC soft=\r\nwrap",
    ].join("\r\n");
    expect(extractMimeText(raw).text).toBe("für 10,99 € softwrap");
  });

  it("RFC 2047 encoded-word 主题解码", () => {
    const encoded = `=?UTF-8?B?${Buffer.from("您的 Apple 收据", "utf8").toString("base64")}?=`;
    expect(decodeEncodedWords(encoded)).toBe("您的 Apple 收据");
    expect(decodeEncodedWords("=?UTF-8?Q?Rechnung_f=C3=BCr?=")).toBe("Rechnung für");
    const raw = `From: a@b.c\r\nSubject: ${encoded}\r\n\r\nbody`;
    expect(extractMimeText(raw).subject).toBe("您的 Apple 收据");
  });

  it("头部续行展开", () => {
    const raw = "From: a@b.c\r\nSubject: Your\r\n\tNetflix receipt\r\n\r\nbody";
    expect(extractMimeText(raw).subject).toBe("Your Netflix receipt");
  });

  it("畸形输入降级为空结果而非抛异常", () => {
    expect(extractMimeText("").text).toBe("");
    expect(extractMimeText("no headers at all").subject).toBeNull();
    expect(extractMimeText("From: a@b.c\r\nDate: not-a-date\r\n\r\nx").dateHeader).toBeNull();
  });
});

describe("htmlToText (#60)", () => {
  it("块级标签折行、其余剥离、实体解码", () => {
    expect(htmlToText("<p>a</p><p>b<br>c</p>")).toBe(" a\n b\nc\n");
    expect(htmlToText("&amp; &lt; &#65; &#x41;")).toBe("& < A A");
  });
});
