import { db } from "@/server/db";

const DEFAULT_RULES = [
  { type: "renewal_due", config: { daysBefore: [7, 1] } },
  { type: "trial_ending", config: { daysBefore: [3, 1] } },
  { type: "usage_threshold", config: { percent: [80, 95] } },
] as const;

/**
 * Seed default notification rules for a user on first activation
 * (design §7.6). Idempotent: skips when any default rule already exists.
 */
export async function seedDefaultNotificationRules(userId: string): Promise<number> {
  const existing = await db.notificationRule.count({ where: { userId } });
  if (existing > 0) return 0;
  let created = 0;
  for (const rule of DEFAULT_RULES) {
    await db.notificationRule.create({
      data: { userId, type: rule.type, config: rule.config },
    });
    created++;
  }
  return created;
}
