import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

// tsc does not delete outputs for removed sources. A clean dist is required so
// removed collectors (notably CLI MiniMax) cannot survive in the npm package.
rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
