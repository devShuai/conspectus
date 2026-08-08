-- #94: User.certusSub must hold certus's raw `sub` (design §6.2).
--
-- It was previously a sha256 digest, which silently disabled two contracts:
-- Back-Channel Logout matches the raw sub from the logout_token, and the
-- status endpoint takes the raw sub as a path parameter. A digest cannot be
-- reversed, so neither call site could recover the real value.
--
-- Existing rows keep their digest for now and record it in certusSubLegacy;
-- the next successful login matches on it and upgrades the row in place. This
-- avoids orphaning accounts (a straight rewrite would make JIT create a second
-- user on the next login) and avoids violating users_login_method.

ALTER TABLE "users" ADD COLUMN "certusSubLegacy" TEXT;

CREATE UNIQUE INDEX "users_certusSubLegacy_key" ON "users"("certusSubLegacy");

UPDATE "users"
   SET "certusSubLegacy" = "certusSub"
 WHERE "certusSub" LIKE 'usr\_%';
