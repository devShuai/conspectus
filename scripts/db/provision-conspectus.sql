-- conspectus 数据库初始化脚本（PostgreSQL 16）
-- 在数据库服务器上以超级用户（如 postgres）执行：
--   psql -U postgres -h 127.0.0.1 -f provision-conspectus.sql
-- 或直接粘贴到 psql / pgAdmin 查询窗口。

-- 1) 应用角色（请把 'CHANGE_ME' 换成强密码）
CREATE ROLE conspectus LOGIN PASSWORD 'CHANGE_ME'
  NOSUPERUSER NOCREATEDB NOCREATEROLE
  CONNECTION LIMIT -1;

-- 2) 主库与测试库（owner 即应用角色，Schema 权限随之归属）
CREATE DATABASE conspectus     OWNER conspectus ENCODING 'UTF8';
CREATE DATABASE conspectus_test OWNER conspectus ENCODING 'UTF8';

-- 3) 收紧 public 模式默认权限（PG15+ 默认已撤销 public 建表权，此处显式声明）
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO conspectus;
REVOKE ALL ON DATABASE conspectus FROM PUBLIC;
REVOKE ALL ON DATABASE conspectus_test FROM PUBLIC;
GRANT CONNECT ON DATABASE conspectus TO conspectus;
GRANT CONNECT ON DATABASE conspectus_test TO conspectus;

-- 4) 验证
\connect conspectus
\dn+
\connect conspectus_test
\dn+
