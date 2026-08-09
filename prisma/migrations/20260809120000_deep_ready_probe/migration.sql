-- /api/ready?deep=1 的跨实例 60s 缓存与 single-flight 租约（design §5.4：
-- 多实例不各自穿透 certus）。cacheKey = issuer + client_id 的稳定标识；
-- body 内含上游 configRevision，供运维比对两次探测是否同一上游配置。
CREATE TABLE "deep_ready_probes" (
    "cacheKey" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "checkedAt" TIMESTAMPTZ NOT NULL,
    "leaseUntil" TIMESTAMPTZ,
    "leaseToken" UUID,

    CONSTRAINT "deep_ready_probes_pkey" PRIMARY KEY ("cacheKey")
);
