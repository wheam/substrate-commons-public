# Substrate Commons

Versioned shared knowledge for small groups and their AI agents.

一个面向小团体的共享资料库引擎：成员通过 MCP 读写同一份 Markdown 资料，每个 agent 使用独立、可吊销的凭据，每次修改形成带成员身份和说明的 Git 提交。

## 能做什么

- **共同维护**：读取、搜索、创建、修改、移动和删除页面；用版本校验避免覆盖别人刚做的修改。
- **追溯变化**：查看提交、diff 和未读变更，按提交回滚。
- **按人和 agent 授权**：管理员、成员、只读三类角色，一次性邀请兑换专属凭据。
- **集中校验**：路径、凭据、个人信息策略、页面格式、容量和请求频率检查。
- **可选组件**：Gmail 全员通知；独立的公开网页镜像。

支持能为 Streamable HTTP MCP 设置 `Authorization` 请求头的客户端。服务不实现 OAuth 登录。

## 快速开始

需要 Git 和 Node.js 22.13+；Docker 镜像使用 Node.js 24。实例数据独立存放，生产环境请使用持久化目录。

```sh
git clone https://github.com/wheam/substrate-commons-public.git
cd substrate-commons-public/service
npm ci
npm test

export DATA_DIR="$(mktemp -d)"
export INSTANCE_NAME=demo
export PUBLIC_URL=http://localhost:8080
export TRUSTED_PROXY_HOPS=0
export BOOTSTRAP_ADMIN_CODE="sbe_$(openssl rand -hex 16)"
printf '本机一次性管理引导码：%s\n' "$BOOTSTRAP_ADMIN_CODE"
npm start
```

在本机打开 `http://localhost:8080/enroll`，使用刚生成的引导码兑换管理员凭据，再按页面说明配置 MCP。引导码和凭据不要提交到仓库或发到公开讨论中。管理员凭据用于创建成员和发邀请，日常 agent 使用成员凭据。

此演示使用临时目录，不连接 GitHub 数据仓库。正式部署请参照[部署与运维](docs/operations.md)，配置 HTTPS、持久化卷和独立的私有实例仓库。

## 文档

- [架构与安全边界](docs/architecture.md)
- [部署、备份和恢复](docs/operations.md)
- [成员接入模板](docs/agent-onboarding.md)
- [公开网页镜像](mirror/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全问题报告](SECURITY.md)

## 数据边界

这个仓库只发布引擎、模板和合成测试数据，不包含运行实例、成员凭据或部署配置。代码开源不会让独立的实例私库变成公开。

一个实例中的成员共享资料访问范围，没有逐页隔离。可选的 mirror 服务会把处理后的内容公开给任何持链接的人；自动脱敏无法识别所有隐私，启用前必须让成员了解这一点。

## 开发与验证

```sh
npm --prefix service ci
npm --prefix service test
npm --prefix service audit --omit=dev
npm --prefix mirror ci
npm --prefix mirror test
npm --prefix mirror audit --omit=dev
```

测试使用临时目录、本地 Git 远端和模拟邮件服务，不需要生产凭据。

## License

[MIT](LICENSE)，Copyright (c) 2026 wheam。
