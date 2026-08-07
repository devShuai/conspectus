import { spawn } from "node:child_process";
import readline from "node:readline";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error(
    "Usage: node scripts/m0-probe-codex-app-server.mjs <codex-command> [args...]",
  );
  process.exit(2);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function inspectRateLimits(result) {
  const bucketsById =
    result?.rateLimitsByLimitId &&
    typeof result.rateLimitsByLimitId === "object"
      ? Object.values(result.rateLimitsByLimitId)
      : [];
  const buckets = bucketsById.length > 0 ? bucketsById : [result?.rateLimits];
  const windows = buckets
    .filter((bucket) => bucket && typeof bucket === "object")
    .flatMap((bucket) => [bucket.primary, bucket.secondary])
    .filter((window) => window && typeof window === "object");

  return {
    resultPresent: result !== null && typeof result === "object",
    singleBucketPresent:
      result?.rateLimits !== null && typeof result?.rateLimits === "object",
    multiBucketPresent:
      result?.rateLimitsByLimitId !== null &&
      typeof result?.rateLimitsByLimitId === "object",
    bucketCountPositive: bucketsById.length > 0 || windows.length > 0,
    allWindowsHaveNumericUsedPercent:
      windows.length > 0 && windows.every((window) => isFiniteNumber(window.usedPercent)),
    allUsedPercentInRange:
      windows.length > 0 &&
      windows.every(
        (window) => window.usedPercent >= 0 && window.usedPercent <= 100,
      ),
    allWindowsHavePositiveDuration:
      windows.length > 0 &&
      windows.every(
        (window) =>
          isFiniteNumber(window.windowDurationMins) &&
          window.windowDurationMins > 0,
      ),
    allWindowsHaveNumericReset:
      windows.length > 0 && windows.every((window) => isFiniteNumber(window.resetsAt)),
  };
}

function inspectUsage(result) {
  const summary =
    result?.summary && typeof result.summary === "object" ? result.summary : null;
  const buckets = Array.isArray(result?.dailyUsageBuckets)
    ? result.dailyUsageBuckets
    : null;
  const summaryValues = summary ? Object.values(summary) : [];

  return {
    resultPresent: result !== null && typeof result === "object",
    summaryPresent: summary !== null,
    summaryValuesAreNumbersOrNull:
      summaryValues.length > 0 &&
      summaryValues.every((value) => value === null || isFiniteNumber(value)),
    dailyBucketsPresent: buckets !== null,
    dailyBucketShapeValid:
      buckets !== null &&
      buckets.every(
        (bucket) =>
          bucket &&
          typeof bucket.startDate === "string" &&
          isFiniteNumber(bucket.tokens),
      ),
  };
}

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let initializeCompleted = false;
let rateLimitsResponse;
let usageResponse;
let stderrObserved = false;
let finished = false;

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(exitCode = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);

  const rateLimitsError = Boolean(rateLimitsResponse?.error);
  const usageError = Boolean(usageResponse?.error);
  const output = {
    probe: "codex_app_server_account_usage",
    processStarted: true,
    initializeCompleted,
    rateLimitsRequestSucceeded:
      rateLimitsResponse !== undefined && !rateLimitsError,
    usageRequestSucceeded: usageResponse !== undefined && !usageError,
    rateLimitsErrorCodeType: rateLimitsError
      ? typeof rateLimitsResponse.error?.code
      : null,
    usageErrorCodeType: usageError ? typeof usageResponse.error?.code : null,
    rateLimits: inspectRateLimits(rateLimitsResponse?.result),
    usage: inspectUsage(usageResponse?.result),
    stderrObserved,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  child.stdin.end();
  child.kill();
  process.exitCode = exitCode;
}

child.stderr.on("data", () => {
  stderrObserved = true;
});

child.on("error", (error) => {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  process.stdout.write(
    `${JSON.stringify(
      {
        probe: "codex_app_server_account_usage",
        processStarted: false,
        errorKind: error.constructor.name,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 1;
});

const lines = readline.createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id === 0) {
    initializeCompleted = !message.error;
    if (!initializeCompleted) {
      finish(1);
      return;
    }

    send({ method: "initialized", params: {} });
    send({ method: "account/rateLimits/read", id: 1 });
    send({ method: "account/usage/read", id: 2 });
    return;
  }

  if (message.id === 1) rateLimitsResponse = message;
  if (message.id === 2) usageResponse = message;
  if (rateLimitsResponse !== undefined && usageResponse !== undefined) finish();
});

child.on("exit", () => {
  if (!finished) finish(1);
});

const timeout = setTimeout(() => finish(1), 20_000);

send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: {
      name: "conspectus_m0_probe",
      title: "Conspectus M0 Probe",
      version: "0.1.0",
    },
  },
});
