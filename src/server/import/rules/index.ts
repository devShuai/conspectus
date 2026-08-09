import { aliyunRules } from "./aliyun";
import { appleRules } from "./apple";
import { netflixRules } from "./netflix";
import { spotifyRules } from "./spotify";
import type { EmailParseRule } from "./types";

export type { EmailParseRule } from "./types";

/**
 * 规则注册表（#60，design §7.5）：全量规则在此汇总。规则是数据，
 * 演进只新增 provider/template/version，不回改旧版本 —— 既有 Draft
 * payload 里的 evidence.matchedRule 永远能指回当时的模板版本。
 *
 * 注册表顺序即匹配优先级：provider/template 相同的多版本按 version 降序
 * （新版先尝试），不同规则间按 id 字典序保证确定性。
 */
function buildRegistry(): EmailParseRule[] {
  const all = [
    ...aliyunRules,
    ...appleRules,
    ...netflixRules,
    ...spotifyRules,
  ];
  const seen = new Set<string>();
  for (const rule of all) {
    if (seen.has(rule.id)) {
      throw new Error(`duplicate email parse rule id: ${rule.id}`);
    }
    seen.add(rule.id);
  }
  return all.sort((a, b) => {
    const key = (r: EmailParseRule) => `${r.provider}/${r.template}`;
    const byTemplate = key(a).localeCompare(key(b));
    return byTemplate !== 0 ? byTemplate : b.version - a.version;
  });
}

export const EMAIL_PARSE_RULES: readonly EmailParseRule[] = buildRegistry();
