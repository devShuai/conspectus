-- #102 租户外键规则兑现（design §6.2）：四处跨租户关联补 DB 兜底，
-- ArmState 主键补 userId 维度并声明组合外键。
-- 模式沿用 m2/m3 的手写触发器（RAISE EXCEPTION），与 prisma 管理的关系并存。

-- ---------- NotificationArmState：主键改 (userId, ruleId, subjectType, subjectId) ----------
ALTER TABLE "notification_arm_states" DROP CONSTRAINT "notification_arm_states_pkey";
DROP INDEX IF EXISTS "notification_arm_states_ruleId_subjectType_subjectId_key";
DROP INDEX IF EXISTS "notification_arm_states_userId_idx";
ALTER TABLE "notification_arm_states" DROP COLUMN "id";
ALTER TABLE "notification_arm_states"
  ADD CONSTRAINT "notification_arm_states_pkey"
  PRIMARY KEY ("userId", "ruleId", "subjectType", "subjectId");

-- 组合外键 (userId, ruleId) → notification_rules(userId, id)：被引用侧补唯一键
CREATE UNIQUE INDEX "notification_rules_userId_id_key" ON "notification_rules"("userId", "id");
ALTER TABLE "notification_arm_states"
  ADD CONSTRAINT "notification_arm_states_rule_tenant_fkey"
  FOREIGN KEY ("userId", "ruleId") REFERENCES "notification_rules"("userId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------- BillingRecord → Subscription 同租户 ----------
CREATE OR REPLACE FUNCTION billing_record_tenant_check() RETURNS trigger AS $$
DECLARE s subscriptions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM "subscriptions" WHERE id = NEW."subscriptionId";
  IF s IS NULL OR s."userId" != NEW."userId" THEN
    RAISE EXCEPTION 'billing record subscription must belong to same user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_record_tenant_check_trigger ON "billing_records";
CREATE TRIGGER billing_record_tenant_check_trigger
  BEFORE INSERT OR UPDATE OF "subscriptionId", "userId" ON "billing_records"
  FOR EACH ROW EXECUTE FUNCTION billing_record_tenant_check();

-- ---------- Subscription.paymentMethodId → PaymentMethod 同租户 ----------
CREATE OR REPLACE FUNCTION subscription_payment_method_tenant_check() RETURNS trigger AS $$
DECLARE pm payment_methods%ROWTYPE;
BEGIN
  IF NEW."paymentMethodId" IS NOT NULL THEN
    SELECT * INTO pm FROM "payment_methods" WHERE id = NEW."paymentMethodId";
    IF pm IS NULL OR pm."userId" != NEW."userId" THEN
      RAISE EXCEPTION 'subscription payment method must belong to same user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subscription_payment_method_tenant_check_trigger ON "subscriptions";
CREATE TRIGGER subscription_payment_method_tenant_check_trigger
  BEFORE INSERT OR UPDATE OF "paymentMethodId", "userId" ON "subscriptions"
  FOR EACH ROW EXECUTE FUNCTION subscription_payment_method_tenant_check();

-- ---------- UsageQuota.authoritativeBindingId / valueSnapshotId 同租户同 quota ----------
CREATE OR REPLACE FUNCTION usage_quota_refs_tenant_check() RETURNS trigger AS $$
DECLARE b usage_bindings%ROWTYPE;
DECLARE sn usage_snapshots%ROWTYPE;
BEGIN
  IF NEW."authoritativeBindingId" IS NOT NULL THEN
    SELECT * INTO b FROM "usage_bindings" WHERE id = NEW."authoritativeBindingId";
    IF b IS NULL OR b."quotaId" != NEW."id" OR b."userId" != NEW."userId" THEN
      RAISE EXCEPTION 'authoritative binding must belong to same quota and user';
    END IF;
  END IF;
  IF NEW."valueSnapshotId" IS NOT NULL THEN
    SELECT * INTO sn FROM "usage_snapshots" WHERE id = NEW."valueSnapshotId";
    IF sn IS NULL OR sn."quotaId" != NEW."id" OR sn."userId" != NEW."userId" THEN
      RAISE EXCEPTION 'value snapshot must belong to same quota and user';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS usage_quota_refs_tenant_check_trigger ON "usage_quotas";
CREATE TRIGGER usage_quota_refs_tenant_check_trigger
  BEFORE INSERT OR UPDATE OF "authoritativeBindingId", "valueSnapshotId", "userId" ON "usage_quotas"
  FOR EACH ROW EXECUTE FUNCTION usage_quota_refs_tenant_check();
