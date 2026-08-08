/** 通知邮件模板（design §7.6「Resend 发送，模板化」——不再把 payload JSON 直接塞给用户）。 */

type JsonRecord = Record<string, unknown>;

function str(payload: JsonRecord, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function line(label: string, value: string): string {
  return value ? `${label}：${value}` : "";
}

export function renderNotificationEmail(input: {
  ruleType: string;
  payload: JsonRecord;
}): { subject: string; text: string } {
  const { ruleType, payload } = input;
  const name = str(payload, "name") || str(payload, "subscriptionName") || "（未命名）";
  const amount = str(payload, "amount");
  const currency = str(payload, "currency");
  const price = amount && currency ? `${currency} ${amount}` : amount;

  switch (ruleType) {
    case "renewal_due": {
      const days = str(payload, "daysBefore");
      const due = str(payload, "dueDate");
      return {
        subject: `[conspectus] 续费提醒：${name} ${days} 天后续费`,
        text: [
          `订阅「${name}」将在 ${due} 续费（${days} 天后）。`,
          line("金额", price),
          "",
          "如不打算续费，请提前到服务商处取消。",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "trial_ending": {
      const days = str(payload, "daysBefore");
      const due = str(payload, "dueDate");
      return {
        subject: `[conspectus] 试用到期提醒：${name} ${days} 天后结束试用`,
        text: [
          `订阅「${name}」的试用将在 ${due} 结束（${days} 天后）。`,
          line("转正价格", price),
          "",
          "到期后将按转正价格计费；不需要请提前取消。",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    case "usage_threshold": {
      const percent = str(payload, "percent");
      const metric = str(payload, "metric");
      return {
        subject: `[conspectus] 用量提醒：${name} 已达 ${percent}%`,
        text: [
          `订阅「${name}」的 ${metric} 用量已达额度的 ${percent}%。`,
          "",
          "接近上限时可能需要升级套餐或控制用量。",
        ].join("\n"),
      };
    }
    case "balance_low": {
      const remaining = str(payload, "remainingValue");
      return {
        subject: `[conspectus] 余额提醒：${name} 余额不足`,
        text: [
          `「${name}」的余额只剩 ${remaining}。`,
          "",
          "按当前消耗速度可能很快耗尽，建议提前充值。",
        ].join("\n"),
      };
    }
    case "connection_failed": {
      const displayName = str(payload, "displayName") || name;
      return {
        subject: `[conspectus] 连接失效：${displayName}`,
        text: [
          `服务商连接「${displayName}」同步失败（凭证失效或连续网络错误）。`,
          "",
          "请在设置页更新凭证或检查服务商状态。",
        ].join("\n"),
      };
    }
    case "collector_stale": {
      const deviceName = str(payload, "deviceName") || name;
      return {
        subject: `[conspectus] 采集器离线：${deviceName}`,
        text: [
          `设备「${deviceName}」已超过 ${str(payload, "days") || "3"} 天没有上报用量。`,
          "",
          "请检查 conspectus-collect 是否仍在运行；页面上的数字可能已过期。",
        ].join("\n"),
      };
    }
    case "price_change": {
      return {
        subject: `[conspectus] 涨价提醒：${name}`,
        text: [
          `订阅「${name}」的价格发生变动：${str(payload, "oldPrice")} → ${str(payload, "newPrice")} ${currency}。`,
          "",
          "请确认是否为预期调整。",
        ].join("\n"),
      };
    }
    default:
      return {
        subject: `[conspectus] 通知：${name}`,
        text: `订阅「${name}」有新的通知事件（${ruleType}）。`,
      };
  }
}
