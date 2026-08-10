import { createRequire } from "node:module";

/**
 * 采集器自身的版本，注册与每次上报都带上。
 *
 * 此前 CLI 从不发送版本，服务端只能用一个硬编码兜底填进设备列表 —— 那一列写的是
 * 个从未被证实过的数字，升级后也不会变。要判断「这台机器的采集器是不是太旧」，
 * 必须由采集器自己说。
 *
 * 打包后的布局是 dist/version.js，`../package.json` 正好是包根；源码运行时
 * src/version.ts 的 `../package.json` 同样指向 collector/package.json。
 */
const require = createRequire(import.meta.url);

export const AGENT_VERSION: string = (
  require("../package.json") as { version: string }
).version;
