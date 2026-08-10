-- 设备版本改为「采集器自报，没报就留空」。
--
-- 此前注册路由用 `body.agentVersion ?? '0.1.0'` 兜底，而 CLI 从不发送该字段，所以
-- 这一列里的每个值都是服务端编的：装了新版本也照旧显示 0.1.0。用户拿它判断采集器
-- 是否过旧时会被直接误导 —— 显示一个错的版本比留空更糟。
ALTER TABLE "collector_devices" ALTER COLUMN "agentVersion" DROP NOT NULL;

-- 现存的值没有一个来自采集器上报（CLI 直到本次改动才开始发送），全部清空而不是
-- 留着假数字。真实版本会在下一次 login 注册或 run 上报时写入。
UPDATE "collector_devices" SET "agentVersion" = NULL;
