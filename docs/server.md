# 服务端部署

默认运行一个 Node.js 服务，SQLite 数据库位于服务器本地磁盘。无需 Docker 或独立数据库。服务器保存账户、授权、完整会话事件、附件元数据和审计；不能据此声称员工电脑的所有文件都已云备份。

## 构建

安装 Node.js 24.16.0 或兼容的 Node 24 版本。在仓库根目录：

```sh
npm ci --workspace @rufa/server --include-workspace-root=false
npm run typecheck --workspace @rufa/server
npm test --workspace @rufa/server
npm run build --workspace @rufa/server
```

## 配置与首次启动

将 `apps/server/.env.example` 复制到仓库外的私有路径，例如 `/etc/rufa-dsh/server.env`，限制为服务账户可读。模板不含实际凭据。设置绝对路径 `SQLITE_PATH=/var/lib/rufa-dsh/company.sqlite`、服务端秘密文件目录和其他必要参数；准备相应可写本地目录。源码不会自行加载 `.env`，必须显式传 `--env-file`。

仅在账号表为空时，配置 `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_DISPLAY_NAME`、`BOOTSTRAP_ADMIN_PASSWORD`（12–128 字符），执行：

```sh
node --env-file=/etc/rufa-dsh/server.env apps/server/dist/cli.js bootstrap-admin
```

完成后从私有环境配置删除首次管理员密码；不要将它提交到 Git、写入镜像或发到日志。然后运行：

```sh
node --env-file=/etc/rufa-dsh/server.env apps/server/dist/main.js
```

默认监听 `127.0.0.1:8787`，通过自己配置的 HTTPS 反向代理对外提供服务，保持 SSE 流式响应且关闭代理缓冲。`/health/live`、`/health/ready` 可验证服务与存储，无需调用付费模型。管理员通过 HTTPS 管理中心配置上游密钥；真实上游 Key 仅保留在服务端。

`infra/rufa-dsh.service` 提供 systemd 模板，使用前调整路径、服务账号及目录权限。数据库启动自动迁移，目前 SQLite schema 为 v4。保留全部 migrations 文件；PostgreSQL 是可选路径，不是默认依赖。

## 备份与更新

```sh
node --env-file=/etc/rufa-dsh/server.env apps/server/dist/cli.js backup /var/lib/rufa-dsh/backups/company-YYYYMMDD.sqlite
```

备份、数据库及 WAL/SHM 均不得加入仓库。保存服务端私有配置，先在独立数据副本验证迁移和恢复；此源码公开不会自动更新任何现有服务器。

更新客户端下载源使用本机发行目录与签名清单，参见 [增量更新](incremental-updates.md)。公开副本中的 `dsh.example.com` 是文档占位符，需替换为自建 HTTPS 服务，并与客户端固定地址一致。

## 可选部署草案

`infra/compose.yaml` 与 `server.Dockerfile` 保留为可选历史草案，未作为本次公开版本的默认部署验收。使用前必须核对模型输出上限、数据/秘密可写目录、只读根文件系统、数据库和备份配置；不要直接视为生产即用模板。
