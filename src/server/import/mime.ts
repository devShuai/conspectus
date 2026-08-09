/**
 * 最小 RFC 822/MIME 纯文本提取（#60，design §7.5 解析管线）。
 *
 * 安全边界（与 #58 入站契约同源）：
 * - 只产出纯文本：text/plain 优先；text/html 只做字符串级标签剥离，绝不渲染、
 *   不拉取远程内容、不执行脚本；附件（非 text/* part）结构性忽略。
 * - 输出长度有硬上限，给下游正则限定输入规模（ReDoS 缓解）。
 * - 所有解码（base64 / quoted-printable / RFC 2047 / charset）失败时降级为
 *   原样/UTF-8，绝不抛异常 —— 畸形邮件走「可诊断失败」而不是拖垮解析管线。
 */

export interface MimeText {
  /** RFC 2047 解码后的 Subject；缺头时为 null。 */
  subject: string | null;
  /** RFC 2047 解码后的 From 头原值（含显示名）。 */
  from: string | null;
  /** Date 头解析结果；缺失或非法为 null。 */
  dateHeader: Date | null;
  /** 正文纯文本（text/plain 优先，否则 HTML 转文本）。 */
  text: string;
}

export const MIME_TEXT_MAX_CHARS = 100_000;

interface ContentType {
  type: string;
  params: Record<string, string>;
}

function splitHeadersBody(raw: string): { head: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return { head: raw, body: "" };
  return { head: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

/** 头部展开（续行折回）+ 按名收集（同名头可多值）。 */
function parseHeaders(head: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = headers.get(name) ?? [];
    list.push(value);
    headers.set(name, list);
  }
  return headers;
}

function firstHeader(headers: Map<string, string[]>, name: string): string | undefined {
  return headers.get(name)?.[0];
}

function parseContentType(value: string | undefined): ContentType {
  if (!value) return { type: "text/plain", params: {} }; // RFC 822 缺省
  const [typePart, ...paramParts] = value.split(";");
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    params[key] = val;
  }
  return { type: (typePart ?? "").trim().toLowerCase(), params };
}

/** WHATWG 编码标签直传；未知标签降级 UTF-8（fatal:false 永不抛）。 */
function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/** quoted-printable 解码为字节流（=XX 转义 + 软换行）。 */
function decodeQuotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "=") {
      const hex = text.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
      // 软换行：= 后紧跟行尾
      if (text.slice(i + 1, i + 3) === "\r\n") {
        i += 2;
        continue;
      }
      if (text[i + 1] === "\n") {
        i += 1;
        continue;
      }
    }
    const code = ch.codePointAt(0)!;
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      // QP 原文中的非 Latin-1 字符：按 UTF-8 字节保留
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes);
}

/** Content-Transfer-Encoding + charset 两级解码。 */
function decodePartBody(body: string, headers: Map<string, string[]>, ct: ContentType): string {
  const cte = (firstHeader(headers, "content-transfer-encoding") ?? "")
    .trim()
    .toLowerCase();
  let bytes: Buffer;
  if (cte === "base64") {
    bytes = Buffer.from(body.replace(/\s+/g, ""), "base64");
  } else if (cte === "quoted-printable") {
    bytes = decodeQuotedPrintable(body);
  } else {
    // 7bit/8bit/binary/未知：按原文 UTF-8 读
    bytes = Buffer.from(body, "utf8");
  }
  return decodeCharset(bytes, ct.params.charset);
}

/** RFC 2047 encoded-word 解码（Subject/From 等短语头）。 */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, text: string) => {
      try {
        let bytes: Buffer;
        if (encoding.toUpperCase() === "B") {
          bytes = Buffer.from(text, "base64");
        } else {
          // Q-encoding：_ 为空格，=XX 为字节
          const raw = text
            .replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            );
          bytes = Buffer.from(raw, "binary");
        }
        return decodeCharset(bytes, charset);
      } catch {
        return whole;
      }
    },
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  yen: "¥",
  euro: "€",
  pound: "£",
  copy: "©",
  reg: "®",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  middot: "·",
  times: "×",
  deg: "°",
};

function decodeEntities(html: string): string {
  return html.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (whole, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = parseInt(entity.slice(2), 16);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      if (entity.startsWith("#")) {
        const code = parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
}

/**
 * HTML → 纯文本：删注释/head/script/style，块级标签折行，其余标签剥离，
 * 实体解码。纯字符串操作，不构造 DOM、不请求任何资源。
 */
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<head[\s\S]*?<\/head\s*>/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
  s = s.replace(
    /<\s*(br|\/p|\/div|\/tr|\/table|\/li|\/ul|\/ol|\/h[1-6]|\/blockquote|\/section|\/article|\/header|\/footer)[^>]*>/gi,
    "\n",
  );
  s = s.replace(/<[^>]*>/g, " ");
  return decodeEntities(s);
}

interface CollectedParts {
  plain: string[];
  html: string[];
}

const MAX_MULTIPART_DEPTH = 5;

function walkParts(raw: string, out: CollectedParts, depth: number): void {
  if (depth > MAX_MULTIPART_DEPTH) return;
  const { head, body } = splitHeadersBody(raw);
  const headers = parseHeaders(head);
  const ct = parseContentType(firstHeader(headers, "content-type"));

  if (ct.type.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary) return;
    // boundary 按字面串切分（split 非正则，无需转义）
    const segments = body.split(`--${boundary}`);
    for (let i = 1; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment.startsWith("--")) break; // 结束边界后的 epilogue 忽略
      // 边界分隔符前的一个 CRLF 属于分隔符本身（RFC 2046），连同段首 CRLF 剥掉
      walkParts(segment.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), out, depth + 1);
    }
    return;
  }
  if (ct.type === "text/plain") {
    out.plain.push(decodePartBody(body, headers, ct));
  } else if (ct.type === "text/html") {
    out.html.push(decodePartBody(body, headers, ct));
  }
  // 其余类型（附件、图片、application/*）结构性忽略 —— 没有进入解析层的通道
}

/**
 * 从 RFC 822 原文提取解析层所需的全部纯文本。畸形输入返回可诊断的空结果，
 * 绝不抛异常。
 */
export function extractMimeText(raw: string): MimeText {
  try {
    const { head } = splitHeadersBody(raw);
    const headers = parseHeaders(head);
    const parts: CollectedParts = { plain: [], html: [] };
    walkParts(raw, parts, 0);

    const text =
      parts.plain.length > 0
        ? parts.plain.join("\n")
        : htmlToText(parts.html.join("\n"));

    const dateRaw = firstHeader(headers, "date");
    const dateParsed = dateRaw ? new Date(dateRaw) : null;
    const subjectRaw = firstHeader(headers, "subject");
    const fromRaw = firstHeader(headers, "from");

    return {
      subject: subjectRaw !== undefined ? decodeEncodedWords(subjectRaw) : null,
      from: fromRaw !== undefined ? decodeEncodedWords(fromRaw) : null,
      dateHeader:
        dateParsed && !Number.isNaN(dateParsed.getTime()) ? dateParsed : null,
      text: text.replace(/^﻿/, "").slice(0, MIME_TEXT_MAX_CHARS),
    };
  } catch {
    return { subject: null, from: null, dateHeader: null, text: "" };
  }
}
