-- 梵小说（FanXiaoshuo）数据库初始化脚本
-- 由 docker-entrypoint-initdb.d 在数据卷首次创建时执行（幂等）。
-- pgvector 扩展为后续「设定集语义记忆检索」预留能力。

CREATE EXTENSION IF NOT EXISTS vector;
