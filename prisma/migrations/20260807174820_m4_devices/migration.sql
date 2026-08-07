-- CreateTable
CREATE TABLE "collector_devices" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "keyAlgorithm" TEXT NOT NULL DEFAULT 'Ed25519',
    "lastSeenAt" TIMESTAMPTZ,
    "lastReportStatus" TEXT,
    "revokedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "collector_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collector_nonces" (
    "deviceId" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "seenAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "collector_nonces_pkey" PRIMARY KEY ("deviceId","nonce")
);

-- CreateIndex
CREATE INDEX "collector_devices_userId_idx" ON "collector_devices"("userId");

-- CreateIndex
CREATE INDEX "collector_devices_revokedAt_idx" ON "collector_devices"("revokedAt");

-- CreateIndex
CREATE INDEX "collector_nonces_seenAt_idx" ON "collector_nonces"("seenAt");

-- AddForeignKey
ALTER TABLE "collector_devices" ADD CONSTRAINT "collector_devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- M4: nonce expiry index already auto; add device public key length sanity
ALTER TABLE "collector_devices"
  ADD CONSTRAINT collector_devices_public_key_len CHECK (octet_length("publicKey") BETWEEN 32 AND 512);
