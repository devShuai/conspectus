-- #109：凭证从 envelope 单包迁移为分列存储（design §7.4「密文、IV、authTag、keyId 分列存储」）。
-- envelope 布局：[keyIdLen:2B BE][version:1B=1][keyId][iv:12B][tag:16B][ciphertext]
-- 迁移后 credentialCipher 只含密文，keyId/iv/tag 各归其列。

DO $$
DECLARE
  r RECORD;
  key_id_len INT;
BEGIN
  FOR r IN
    SELECT id, "credentialCipher"
    FROM provider_connections
    WHERE octet_length("credentialCipher") > 30
      AND get_byte("credentialCipher", 2) = 1
  LOOP
    key_id_len := get_byte(r."credentialCipher", 0) * 256 + get_byte(r."credentialCipher", 1);

    UPDATE provider_connections
    SET
      "credentialKeyId" = convert_from(substring(r."credentialCipher" FROM 4 FOR key_id_len), 'UTF8'),
      "credentialIv" = substring(r."credentialCipher" FROM 4 + key_id_len FOR 12),
      "credentialTag" = substring(r."credentialCipher" FROM 4 + key_id_len + 12 FOR 16),
      "credentialCipher" = substring(r."credentialCipher" FROM 4 + key_id_len + 28)
    WHERE id = r.id;
  END LOOP;
END $$;
