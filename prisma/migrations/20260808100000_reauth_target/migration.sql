-- #98: keep the post-reauth target server-side.
--
-- It used to travel in an unsigned base64 cookie, so a client could rewrite it
-- to an absolute URL and the callback would 303 there -- an open redirect. The
-- cookie now carries only the opaque token; the target lives on the row and is
-- never client-writable.
ALTER TABLE "reauth_transactions" ADD COLUMN "targetPath" TEXT;
