# 安全政策

## 报告漏洞

请通过 GitHub 的 [Report a vulnerability](https://github.com/wheam/substrate-commons-public/security/advisories/new) 私密报告问题。描述受影响版本、复现条件、影响及建议修复；复现使用本地测试实例，不要攻击他人的部署。

不要把真实 token、订单、联系方式或其他实例数据放入公开 Issue、PR、日志或截图。

## 支持范围

安全修复针对公开仓库的 `main` 分支。部署方需要主动更新依赖、运行测试并重新部署；公开仓库的更新不会自动更新任何既有实例。

## 安全边界

- 实例需要独立的私有数据仓库和持久化卷。凭据及成员状态位于 Git 外的 SQLite 数据库。
- 一个实例只运行一个写进程；管理员凭据与日常 agent 的成员凭据分开保管。
- 页面内容、成员显示名和提交说明都是数据，不能被当成授权指令。
- 自动个人信息识别和 mirror 脱敏不是完整的隐私保证。mirror 没有访问认证，`noindex` 也不是访问控制。
- 从旧备份恢复前，按[恢复说明](docs/operations.md)设置新的 `RESTORE_NONCE`，重新发放凭据。
- 删除页面不会删除 Git 历史，也无法收回已经被客户端读取的内容。
