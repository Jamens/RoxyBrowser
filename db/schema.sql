-- =============================================================================
-- RoxyBrowser Clone —— 数据库建表脚本
-- =============================================================================
-- 用途：开源用户拿到本项目后，可自行创建数据库与所有数据表。
--
-- 环境要求：
--   - MySQL 5.7 及以上（已验证 5.7 / 8.0 可用）
--   - 字符集：utf8mb4 / 排序规则 utf8mb4_general_ci
--
-- 数据库连接（默认值，可在启动时用环境变量覆盖）：
--   host    : 127.0.0.1   (DB_HOST)
--   port    : 3307        (DB_PORT)
--   user    : root        (DB_USER)
--   password: 1234560     (DB_PASS)
--   database: roxy_browser(DB_NAME)
--
-- 执行方式（任选其一）：
--   1) 命令行：mysql -uroot -p1234560 < db/schema.sql
--   2) 客户端：在 MySQL Workbench / Navicat 中新建库 roxy_browser，
--              选中该库后执行本文件全部内容。
--
-- 与 synchronize:true 的关系：
--   后端 TypeORM 配置了 synchronize:true，首次启动时会自动建表。
--   本文件是「等效的手动建表脚本」，适合以下场景：
--     - 希望先建库再启动（避免 synchronize 在某些环境下的 ALTER 限制）
--     - 想看清表结构 / 交给 DBA 评审
--     - 全新空库首次启动（synchronize 也能建，二者二选一即可，不要重复执行）
--
-- 注意：
--   - 项目首次启动会自动创建默认管理员账号 admin / 123456，无需手动插入。
--   - ownerId 故意设为可空（NULL），历史数据归「管理员视角」可见，符合账户隔离设计。
-- =============================================================================

-- 1) 创建数据库（如已存在可跳过此段）
CREATE DATABASE IF NOT EXISTS `roxy_browser`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_general_ci;

USE `roxy_browser`;

-- 2) 用户表
CREATE TABLE IF NOT EXISTS `users` (
  `id`           INT          NOT NULL AUTO_INCREMENT,
  `username`     VARCHAR(64)  NOT NULL,
  `passwordHash` VARCHAR(128) NOT NULL,
  `nickname`     VARCHAR(64)  NOT NULL DEFAULT '',
  `createdAt`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 3) 团队表
CREATE TABLE IF NOT EXISTS `teams` (
  `id`        INT       NOT NULL AUTO_INCREMENT,
  `name`      VARCHAR(128) NOT NULL,
  `createdAt` DATETIME  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 4) 团队成员关系表
CREATE TABLE IF NOT EXISTS `team_members` (
  `id`       INT          NOT NULL AUTO_INCREMENT,
  `teamId`   INT          NOT NULL,
  `userId`   INT          NOT NULL,
  `role`     VARCHAR(16)  NOT NULL DEFAULT 'member', -- owner | admin | member
  `createdAt` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_team_members` (`teamId`, `userId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 5) 环境分组表
CREATE TABLE IF NOT EXISTS `groups` (
  `id`        INT          NOT NULL AUTO_INCREMENT,
  `teamId`    INT          NOT NULL,
  `ownerId`   INT          NULL,        -- 创建者用户 ID，账户级隔离
  `name`      VARCHAR(64)  NOT NULL,
  `sort`      INT          NOT NULL DEFAULT 0,
  `createdAt` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_groups_team` (`teamId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 6) 代理表
CREATE TABLE IF NOT EXISTS `proxies` (
  `id`           INT           NOT NULL AUTO_INCREMENT,
  `teamId`       INT           NOT NULL,
  `ownerId`      INT           NULL,     -- 创建者用户 ID，账户级隔离
  `name`         VARCHAR(128)  NOT NULL DEFAULT '',
  `type`         VARCHAR(16)   NOT NULL DEFAULT 'http', -- http | https | socks5
  `host`         VARCHAR(128)  NOT NULL,
  `port`         INT           NOT NULL,
  `username`     VARCHAR(128)  NOT NULL DEFAULT '',
  `password`     VARCHAR(256)  NOT NULL DEFAULT '',
  `remark`       VARCHAR(256)  NOT NULL DEFAULT '',
  `country`      VARCHAR(64)   NOT NULL DEFAULT '',
  `region`       VARCHAR(64)   NOT NULL DEFAULT '',
  `city`         VARCHAR(64)   NOT NULL DEFAULT '',
  `isp`          VARCHAR(128)  NOT NULL DEFAULT '',
  `status`       VARCHAR(16)   NOT NULL DEFAULT 'unknown',
  `latency`      INT           NULL,
  `exitIp`       VARCHAR(64)   NOT NULL DEFAULT '',
  `expiresAt`    DATETIME      NULL,
  `lastCheckAt`  DATETIME      NULL,
  `createdAt`    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_proxies_team` (`teamId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 7) 浏览器环境（指纹配置文件）表
CREATE TABLE IF NOT EXISTS `profiles` (
  `id`            INT            NOT NULL AUTO_INCREMENT,
  `teamId`        INT            NOT NULL,
  `ownerId`       INT            NULL,    -- 创建者用户 ID，账户级隔离
  `groupId`       INT            NULL,
  `name`          VARCHAR(128)   NOT NULL,
  `seq`           INT            NOT NULL,  -- 环境序号，如 1001
  `remark`        VARCHAR(512)   NOT NULL DEFAULT '',
  `platform`      VARCHAR(64)    NOT NULL DEFAULT '',
  `startUrl`      VARCHAR(512)   NOT NULL DEFAULT '',
  `proxyId`       INT            NULL,
  `fingerprint`   JSON           NOT NULL,
  `isTemplate`    TINYINT(1)     NOT NULL DEFAULT 0,
  `status`        VARCHAR(16)    NOT NULL DEFAULT 'idle', -- idle | running
  `lastOpenedAt`  DATETIME       NULL,
  `createdBy`     INT            NOT NULL,
  `createdAt`     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt`     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_profiles_team` (`teamId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 8) Cookie 表
CREATE TABLE IF NOT EXISTS `cookies` (
  `id`              INT            NOT NULL AUTO_INCREMENT,
  `teamId`          INT            NOT NULL,
  `ownerId`         INT            NULL,   -- 创建者用户 ID，账户级隔离
  `profileId`       INT            NOT NULL,
  `domain`          VARCHAR(255)   NOT NULL DEFAULT '',
  `name`            VARCHAR(255)   NOT NULL DEFAULT '',
  `value`           TEXT           NOT NULL,
  `path`            VARCHAR(512)   NOT NULL DEFAULT '/',
  `secure`          TINYINT(1)     NOT NULL DEFAULT 0,
  `httpOnly`        TINYINT(1)     NOT NULL DEFAULT 0,
  `sameSite`        VARCHAR(16)    NOT NULL DEFAULT 'unspecified',
  `expirationDate`  DATETIME       NULL,
  `hostOnly`        TINYINT(1)     NOT NULL DEFAULT 1,
  `createdAt`       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_cookies_team` (`teamId`),
  KEY `idx_cookies_profile` (`profileId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 9) 平台账号表（某个环境下的业务账号）
CREATE TABLE IF NOT EXISTS `accounts` (
  `id`        INT           NOT NULL AUTO_INCREMENT,
  `profileId` INT           NOT NULL,
  `ownerId`   INT           NULL,   -- 创建者用户 ID，账户级隔离
  `platform`  VARCHAR(64)   NOT NULL DEFAULT '',
  `username`  VARCHAR(128)  NOT NULL,
  `password`  VARCHAR(256)  NOT NULL DEFAULT '',
  `remark`    VARCHAR(256)  NOT NULL DEFAULT '',
  `createdAt` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_accounts_profile` (`profileId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 10) 操作日志表
CREATE TABLE IF NOT EXISTS `operation_logs` (
  `id`        INT          NOT NULL AUTO_INCREMENT,
  `teamId`    INT          NOT NULL,
  `userId`    INT          NOT NULL,
  `username`  VARCHAR(64)  NOT NULL,
  `action`    VARCHAR(64)  NOT NULL,
  `detail`    TEXT         NOT NULL,
  `createdAt` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_operation_logs_team` (`teamId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 11) API Token 表（自动化接口鉴权）
CREATE TABLE IF NOT EXISTS `api_tokens` (
  `id`        INT           NOT NULL AUTO_INCREMENT,
  `teamId`    INT           NOT NULL,
  `ownerId`   INT           NULL,    -- 创建者用户 ID，账户级隔离
  `name`      VARCHAR(128)  NOT NULL,
  `token`     VARCHAR(128)  NOT NULL,
  `createdAt` DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_api_tokens_team` (`teamId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- 12) 应用设置表（单例，key 固定为 'global'）
CREATE TABLE IF NOT EXISTS `app_settings` (
  `id`        INT            NOT NULL AUTO_INCREMENT,
  `key`       VARCHAR(32)    NOT NULL DEFAULT 'global',
  `settings`  JSON           NOT NULL,
  `updatedAt` DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
