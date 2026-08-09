-- #106 / design §7.3：汇率源失败时回退到上一个可用日期的汇率并标记 stale
ALTER TABLE "exchange_rates" ADD COLUMN "stale" BOOLEAN NOT NULL DEFAULT false;
