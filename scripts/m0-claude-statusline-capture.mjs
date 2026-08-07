import fs from "node:fs";

const outputPath = process.env.CONSPECTUS_M0_CLAUDE_CAPTURE;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function inspectWindow(value) {
  const window = value && typeof value === "object" ? value : null;

  return {
    present: window !== null,
    usedPercentageIsNumber: isFiniteNumber(window?.used_percentage),
    usedPercentageInRange:
      isFiniteNumber(window?.used_percentage) &&
      window.used_percentage >= 0 &&
      window.used_percentage <= 100,
    resetsAtIsNumber: isFiniteNumber(window?.resets_at),
  };
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
}

let parsed;
try {
  parsed = JSON.parse(input);
} catch {
  parsed = null;
}

const rateLimits =
  parsed?.rate_limits && typeof parsed.rate_limits === "object"
    ? parsed.rate_limits
    : null;

const result = {
  schemaVersion: 1,
  inputParsed: parsed !== null,
  rateLimitsPresent: rateLimits !== null,
  fiveHour: inspectWindow(rateLimits?.five_hour),
  sevenDay: inspectWindow(rateLimits?.seven_day),
};

if (outputPath) {
  fs.writeFileSync(outputPath, `${JSON.stringify(result)}\n`, "utf8");
}

