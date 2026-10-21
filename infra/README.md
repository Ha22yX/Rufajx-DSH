# 部署模板

默认使用 Node.js + 本地 SQLite，详细步骤见 [服务端部署](../docs/server.md)。`.env.example` 只有空凭据模板；`rufa-dsh.service` 需要按部署机器调整用户、路径与权限。

`compose.yaml` 和 `server.Dockerfile` 是可选历史草案，没有作为当前默认生产部署验证。公开仓库不包含生产主机配置、账号、数据库或私钥。

`client-update-public.pem` 是原代码的公开验证密钥，不含签名能力。自建发行渠道必须生成自己的密钥对，将私钥保留在仓库外，重新生成客户端信任源并构建；参见 [客户端构建](../docs/client.md)。
