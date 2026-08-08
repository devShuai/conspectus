-- Multi-instance fixed-window counters for public authentication endpoints.
-- Identifiers are SHA-256 fingerprints; raw IP addresses and emails are not stored.
CREATE TABLE "rate_limit_counters" (
    "scope" TEXT NOT NULL,
    "keyHash" CHAR(64) NOT NULL,
    "windowStart" TIMESTAMPTZ NOT NULL,
    "windowEndsAt" TIMESTAMPTZ NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "rate_limit_counters_pkey" PRIMARY KEY ("scope", "keyHash"),
    CONSTRAINT "rate_limit_counters_attempt_count_positive" CHECK ("attemptCount" > 0),
    CONSTRAINT "rate_limit_counters_window_order" CHECK ("windowEndsAt" > "windowStart")
);

CREATE INDEX "rate_limit_counters_windowEndsAt_idx"
    ON "rate_limit_counters"("windowEndsAt");
