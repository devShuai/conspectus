import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parseImportDraftPayload } from "./draft-payload";
import { EMAIL_PARSE_RULES } from "./rules";
import {
  DRAFT_ACCEPT_PRESELECT_THRESHOLD,
  addrSpec,
  nameFromFromAddr,
  normalizeAmountToken,
  normalizeBodyText,
  normalizeSubject,
  parseEmail,
  parseRuleDate,
  suggestSubscription,
  type EmailParseInput,
  type ParseOutcome,
} from "./parse";

/**
 * #60：解析规则引擎单测。vendor 用例由 fixtures/*.eml（全脱敏样例邮件）
 * 驱动 —— 覆盖多语言（zh/de/en）、转发头、HTML/text、币种小数（千分位、
 * 逗号小数）、模板漂移；fail-closed 分支用内联合成文本。
 */

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

const RECEIVED_AT = new Date("2026-08-06T00:00:00Z");

interface OkExpectation {
  ok: true;
  matchedRule: string | null;
  candidate: Record<string, string>;
  confidenceAtLeast: number;
  confidenceBelow?: number;
}

interface FailExpectation {
  ok: false;
  reason: string;
  matchedRule: string | null;
}

const CASES: {
  name: string;
  file?: string;
  input: Omit<EmailParseInput, "raw">;
  expect: OkExpectation | FailExpectation;
}[] = [
  {
    name: "netflix 正常收据（EN 点分金额 + en-long 日期）",
    file: "netflix-receipt.eml",
    input: { fromAddr: "info@mailer.netflix.com", subject: "Your Netflix receipt", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "netflix/receipt/v1",
      candidate: {
        vendorSlug: "netflix",
        name: "Netflix",
        planName: "Standard",
        amount: "15.49",
        currency: "USD",
        billedAt: "2026-08-01",
        billingCycle: "monthly",
        reference: "NF-2026-0801-ABC123",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "netflix 人工转发（Fwd: 前缀 + 转发头块取真实来源）",
    file: "netflix-receipt-forwarded.eml",
    input: { fromAddr: "jane.doe@example.com", subject: "Fwd: Your Netflix receipt", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "netflix/receipt/v1",
      candidate: {
        vendorSlug: "netflix",
        name: "Netflix",
        planName: "Standard",
        amount: "15.49",
        currency: "USD",
        billedAt: "2026-08-01",
        billingCycle: "monthly",
        reference: "NF-2026-0801-ABC123",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "netflix 模板漂移 → template_drift（可诊断失败，不猜值）",
    file: "netflix-receipt-drift.eml",
    input: { fromAddr: "info@mailer.netflix.com", subject: "Your Netflix receipt", receivedAt: RECEIVED_AT },
    expect: { ok: false, reason: "template_drift", matchedRule: "netflix/receipt/v1" },
  },
  {
    name: "spotify DE 收据（quoted-printable + 逗号小数 + de-long 日期）",
    file: "spotify-receipt-de.eml",
    input: { fromAddr: "no-reply@spotify.com", subject: "Deine Spotify Rechnung", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "spotify/receipt-de/v1",
      candidate: {
        vendorSlug: "spotify",
        name: "Spotify",
        planName: "Spotify Premium",
        amount: "10.99",
        currency: "EUR",
        billedAt: "2026-08-01",
        billingCycle: "monthly",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "spotify DE 变体（Family 套餐，模板同版）",
    file: "spotify-receipt-de-family.eml",
    input: { fromAddr: "no-reply@spotify.com", subject: "Deine Spotify Rechnung", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "spotify/receipt-de/v1",
      candidate: {
        vendorSlug: "spotify",
        name: "Spotify",
        planName: "Spotify Premium Family",
        amount: "17.99",
        currency: "EUR",
        billedAt: "2026-09-03",
        billingCycle: "monthly",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "apple zh 收据（HTML-only + RFC2047 主题 + ¥ 模板固定 CNY）",
    file: "apple-receipt-zh.eml",
    input: { fromAddr: "no_reply@email.apple.com", subject: "您的 Apple 收据", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "apple/receipt-zh/v1",
      candidate: {
        vendorSlug: "apple",
        name: "iCloud+ 200GB",
        amount: "21.00",
        currency: "CNY",
        billedAt: "2026-08-05",
        reference: "MQ8XYZ1234",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "apple en 收据（同 provider 第二模板，text/plain）",
    file: "apple-receipt-en.eml",
    input: { fromAddr: "no_reply@email.apple.com", subject: "Your receipt from Apple", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "apple/receipt-en/v1",
      candidate: {
        vendorSlug: "apple",
        name: "Apple Music Individual",
        amount: "10.99",
        currency: "USD",
        billedAt: "2026-08-05",
        reference: "MX12345678",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "阿里云续费（zh + 千分位金额 + 包年→yearly）",
    file: "aliyun-renewal.eml",
    input: { fromAddr: "service@notice.aliyun.com", subject: "【阿里云】续费扣款成功通知", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "aliyun/renewal/v1",
      candidate: {
        vendorSlug: "aliyun",
        name: "云服务器ECS",
        planName: "包年",
        amount: "1080.00",
        currency: "CNY",
        billedAt: "2026-08-05",
        billingCycle: "yearly",
        reference: "2026080512345678",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "阿里云变体（域名产品线，同一模板抽取）",
    file: "aliyun-renewal-domain.eml",
    input: { fromAddr: "service@notice.aliyun.com", subject: "【阿里云】域名续费成功通知", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: "aliyun/renewal/v1",
      candidate: {
        vendorSlug: "aliyun",
        name: "域名 example.cn",
        planName: "包年",
        amount: "69.00",
        currency: "CNY",
        billedAt: "2026-08-06",
        billingCycle: "yearly",
        reference: "2026080600012345",
      },
      confidenceAtLeast: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
  {
    name: "未知 vendor 走启发式（ISO 币种 + 标签锚定），置信度低于预选线",
    file: "heuristic-unknown-vendor.eml",
    input: { fromAddr: "billing@acme-saas.io", subject: "Your Acme receipt", receivedAt: RECEIVED_AT },
    expect: {
      ok: true,
      matchedRule: null,
      candidate: {
        name: "Acme-saas",
        amount: "42.50",
        currency: "USD",
        billedAt: "2026-08-05",
      },
      confidenceAtLeast: 0.5,
      confidenceBelow: DRAFT_ACCEPT_PRESELECT_THRESHOLD,
    },
  },
];

function runCase(testCase: (typeof CASES)[number]): ParseOutcome {
  return parseEmail({ ...testCase.input, raw: testCase.file ? fixture(testCase.file) : undefined });
}

describe("parseEmail fixture 驱动 (#60)", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const outcome = runCase(testCase);
      expect(outcome.ok).toBe(testCase.expect.ok);
      expect(outcome.matchedRule).toBe(testCase.expect.matchedRule);
      if (!testCase.expect.ok) {
        if (outcome.ok) throw new Error("expected failure");
        expect(outcome.reason).toBe(testCase.expect.reason);
        return;
      }
      if (!outcome.ok) throw new Error(`expected success, got ${outcome.reason}`);
      // 引擎产物必须过版本化 schema（与落库闸门同一校验）
      const payload = parseImportDraftPayload(outcome.payload);
      for (const [key, value] of Object.entries(testCase.expect.candidate)) {
        expect(payload.candidate).toMatchObject({ [key]: value });
      }
      expect(outcome.confidence).toBeGreaterThanOrEqual(testCase.expect.confidenceAtLeast);
      if (testCase.expect.confidenceBelow !== undefined) {
        expect(outcome.confidence).toBeLessThan(testCase.expect.confidenceBelow);
      }
    });
  }

  it("规则路径全部达到预选阈值；启发式永远够不到（人工过目）", () => {
    for (const testCase of CASES) {
      const outcome = runCase(testCase);
      if (!outcome.ok) continue;
      if (outcome.matchedRule !== null) {
        expect(outcome.confidence).toBeGreaterThanOrEqual(DRAFT_ACCEPT_PRESELECT_THRESHOLD);
      } else {
        expect(outcome.confidence).toBeLessThan(DRAFT_ACCEPT_PRESELECT_THRESHOLD);
      }
    }
  });
});

describe("parseEmail fail-closed (#60 验收：不可模糊时不产草稿)", () => {
  const base = { fromAddr: "billing@acme-saas.io", subject: "receipt", receivedAt: RECEIVED_AT };

  it("只有 $ 金额（币种多义）→ amount_missing，不猜 USD", () => {
    const outcome = parseEmail({
      ...base,
      raw: "From: billing@acme-saas.io\r\n\r\nYour card was charged $9.99 on August 5, 2026.",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "amount_missing", matchedRule: null });
  });

  it("多个不同金额且无唯一标签锚定 → amount_ambiguous", () => {
    const outcome = parseEmail({
      ...base,
      raw: "From: billing@acme-saas.io\r\n\r\nPlan USD 8.00 plus add-on USD 2.00. Charged on 2026-08-05.",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "amount_ambiguous" });
  });

  it("同一金额对两个币种 → currency_ambiguous", () => {
    const outcome = parseEmail({
      ...base,
      raw: "From: billing@acme-saas.io\r\n\r\nPrice USD 8.00 (EUR 8.00). Invoiced 2026-08-05.",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "currency_ambiguous" });
  });

  it("账期区间两个日期且无标签 → date_ambiguous", () => {
    const outcome = parseEmail({
      ...base,
      raw: "From: billing@acme-saas.io\r\n\r\nInvoice for period 2026-08-01 to 2026-08-31. Total USD 8.00.",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "date_ambiguous" });
  });

  it("正文无日期 → date_missing（不用 receivedAt 编造扣费日）", () => {
    const outcome = parseEmail({
      ...base,
      raw: "From: billing@vendor.test\r\n\r\ncharged 68 CNY",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "date_missing" });
  });

  it("无主题无正文 → no_text", () => {
    expect(parseEmail({ fromAddr: "a@b.c", subject: "", receivedAt: RECEIVED_AT })).toMatchObject({
      ok: false,
      reason: "no_text",
    });
  });

  it("傍名域名不命中规则（evilnetflix.com），也不产出模板草稿", () => {
    const outcome = parseEmail({
      fromAddr: "info@evilnetflix.com",
      subject: "Your Netflix receipt",
      receivedAt: RECEIVED_AT,
      raw: "From: info@evilnetflix.com\r\nSubject: Your Netflix receipt\r\n\r\nYour payment of $15.49 was received on August 1, 2026.",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.matchedRule).toBeNull();
  });

  it("未声明逗号小数的模板外金额一律不解读（12,99 → 不是金额）", () => {
    const outcome = parseEmail({
      ...base,
      raw: "From: billing@acme-saas.io\r\n\r\nTotal: 12,99 EUR. Paid on 2026-08-05.",
    });
    // "12,99" 不符合英美点分格式 → 唯一候选消失 → amount_missing
    expect(outcome).toMatchObject({ ok: false, reason: "amount_missing" });
  });
});

describe("规则回退与细节 (#60)", () => {
  it("正文无日期时回退 Date 头（置信度低于正文日期路径）", () => {
    const raw =
      "From: Netflix <info@mailer.netflix.com>\r\n" +
      "Subject: Your Netflix receipt\r\n" +
      "Date: Sat, 01 Aug 2026 18:02:11 +0000\r\n" +
      "Content-Type: text/plain; charset=\"utf-8\"\r\n" +
      "\r\n" +
      "Hi Jane,\n\nYour payment of $15.49 was received.\n\nPlan: Standard\nInvoice: NF-2026-0801-ABC123\n";
    const outcome = parseEmail({
      fromAddr: "info@mailer.netflix.com",
      subject: "Your Netflix receipt",
      receivedAt: RECEIVED_AT,
      raw,
    });
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.payload.candidate.billedAt).toBe("2026-08-01");
    expect(outcome.confidence).toBe(0.9); // 0.45+0.20+0.10+0.10(头回退)+0.05
  });
});

describe("规范化与原语 (#60)", () => {
  it("normalizeSubject 剥多层转发/回复前缀", () => {
    expect(normalizeSubject("Re: Fwd: 转发: Your receipt")).toBe("Your receipt");
    expect(normalizeSubject("您的 Apple 收据")).toBe("您的 Apple 收据");
  });

  it("normalizeBodyText 剥引用前缀并回收转发头", () => {
    const { text, forwarded } = normalizeBodyText(
      "> ---------- Forwarded message ---------\n> From: Netflix <info@mailer.netflix.com>\n> Subject: Your Netflix receipt\n> \n> Hi Jane,\n> charged USD 15.49",
    );
    expect(forwarded.from).toBe("Netflix <info@mailer.netflix.com>");
    expect(forwarded.subject).toBe("Your Netflix receipt");
    expect(text).toContain("Hi Jane,");
    expect(text).toContain("charged USD 15.49");
    expect(text).not.toContain("From: Netflix");
  });

  it("normalizeAmountToken 千分位/逗号小数的双面", () => {
    expect(normalizeAmountToken("1,234.56")).toBe("1234.56");
    expect(normalizeAmountToken("68")).toBe("68");
    expect(normalizeAmountToken("68.5")).toBe("68.5");
    expect(normalizeAmountToken("12,99")).toBeNull(); // 未声明 locale 的逗号小数 fail closed
    expect(normalizeAmountToken("12,99", { decimalComma: true })).toBe("12.99");
    expect(normalizeAmountToken("1.234,56", { decimalComma: true })).toBe("1234.56");
    expect(normalizeAmountToken("abc")).toBeNull();
  });

  it("parseRuleDate 各格式与非法日历日", () => {
    expect(parseRuleDate("2026-08-05", "iso")).toBe("2026-08-05");
    expect(parseRuleDate("August 5, 2026", "en-long")).toBe("2026-08-05");
    expect(parseRuleDate("5 August 2026", "en-long")).toBe("2026-08-05");
    expect(parseRuleDate("2026年8月5日", "zh")).toBe("2026-08-05");
    expect(parseRuleDate("5. August 2026", "de-long")).toBe("2026-08-05");
    expect(parseRuleDate("2026-02-30", "iso")).toBeNull(); // 不存在的日期
    expect(parseRuleDate("08/05/2026", "iso")).toBeNull(); // 歧义数字序不收
  });

  it("addrSpec / nameFromFromAddr", () => {
    expect(addrSpec("Netflix <Info@Mailer.Netflix.com>")).toBe("info@mailer.netflix.com");
    expect(nameFromFromAddr("billing@acme-saas.io")).toBe("Acme-saas");
    expect(nameFromFromAddr("no-reply@mailer.example.co.uk")).toBe("Example");
    expect(nameFromFromAddr("a@测试.cn")).toBeNull();
  });
});

describe("规则注册表 (#60)", () => {
  it("id 唯一、provider/template/vN 形态、长度在 evidence.matchedRule 上限内", () => {
    const ids = EMAIL_PARSE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of EMAIL_PARSE_RULES) {
      expect(rule.id).toBe(`${rule.provider}/${rule.template}/v${rule.version}`);
      expect(rule.id.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("suggestSubscription (#60, design §7.5 管线 G 步)", () => {
  const subs = [
    {
      id: "sub-1",
      name: "Netflix Standard",
      price: "15.49",
      currency: "USD",
      billingCycle: "monthly",
      vendor: { name: "Netflix", slug: "netflix" },
    },
    {
      id: "sub-2",
      name: "Netflix 合租",
      price: "15.49",
      currency: "USD",
      billingCycle: "monthly",
      vendor: { name: "Netflix", slug: "netflix" },
    },
    {
      id: "sub-3",
      name: "iCloud+",
      price: "21.00",
      currency: "CNY",
      billingCycle: "monthly",
      vendor: null,
    },
  ];

  it("恰好一条命中才建议：vendor slug + 金额 + 币种 + 周期", () => {
    const id = suggestSubscription(
      { name: "iCloud+ 200GB", amount: "21.00", currency: "CNY", billedAt: "2026-08-05" },
      subs,
    );
    expect(id).toBeNull(); // name 不等（iCloud+ vs iCloud+ 200GB），不模糊匹配
    expect(
      suggestSubscription(
        { name: "iCloud+", amount: "21.00", currency: "CNY", billedAt: "2026-08-05" },
        subs,
      ),
    ).toBe("sub-3");
  });

  it("多条命中 → 不建议（宁缺毋滥）", () => {
    expect(
      suggestSubscription(
        {
          vendorSlug: "netflix",
          name: "Netflix",
          amount: "15.49",
          currency: "USD",
          billedAt: "2026-08-01",
          billingCycle: "monthly",
        },
        subs,
      ),
    ).toBeNull();
  });

  it("金额/币种不一致不命中", () => {
    expect(
      suggestSubscription(
        { name: "iCloud+", amount: "22.00", currency: "CNY", billedAt: "2026-08-05" },
        subs,
      ),
    ).toBeNull();
  });
});
