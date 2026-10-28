# 部署与运维手册

> 本文描述服务的部署与恢复流程。实例内容与凭据存放在独立私有存储中。

## 1. 运行要求与默认值

- 使用 Git 和 Node.js 22.13+；Docker 镜像使用 Node.js 24。
- 一个实例只运行一个写进程，挂载持久化卷；不要增加副本共享同一份数据。
- 实例仓库使用 bare Git，成员与授权状态位于 Git 外的 SQLite 数据库。架构见 [architecture.md](architecture.md)。
- 默认允许普通成员删除页面，删除可回滚。管理员可在 `_commons/config.yaml` 修改删除权限。
- 同步失败容忍上限为 20 个未推送提交或 1 小时，可通过 `SYNC_MAX_PENDING`、`SYNC_MAX_PENDING_MINUTES` 调整。
- 新 agent 的邀请码由管理员签发；默认有效期 24 小时，可设置 1–720 小时。
- 幂等结果保留 7 天；冻结、维护和限流等临时状态不会占用幂等键。

## 2. 部署到 Railway

1. **实例私库**：在 GitHub 新建空的私有数据仓库；为它生成独立 SSH deploy key，公钥加到仓库 Settings → Deploy keys，并允许写入。不要使用个人账号的全局 SSH 私钥。尽可能启用分支保护，限制外部直推与强制推送。
2. **服务**：新建独立 Railway project/service，构建上下文设为本仓库根目录，变量 `RAILWAY_DOCKERFILE_PATH=service/Dockerfile`。也可使用其他支持 Docker 和持久化卷的平台：`docker build -f service/Dockerfile -t substrate-commons .`。对外访问配置 HTTPS；不要把 `.env`、实例数据或本地授权文件放进构建上下文。
3. 挂一个 volume，mount path = `/data`；副本数保持 1（一个实例 = 一个写进程）。
4. 环境变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `INSTANCE_NAME` | 是 | 英文名，如 `demo-commons`；MCP 服务名为 `commons-<INSTANCE_NAME>` |
| `INSTANCE_DISPLAY_NAME` | 建议 | 显示名，如 `示例共享库`（首次初始化时写进 README 与 config.yaml） |
| `REPO_URL` | 建议 | 实例私库 SSH 地址，如 `git@github.com:<owner>/<repo>.git`；不设 = 只在 volume 上（不推荐） |
| `GIT_SSH_KEY_B64` | 配了 REPO_URL 就要 | deploy key 私钥的 base64；入口脚本落盘后从环境中清掉 |
| `PUBLIC_URL` | 建议 | 对外基址，如 `https://commons.example.com`；不设时用 `RAILWAY_PUBLIC_DOMAIN` |
| `BOOTSTRAP_ADMIN_CODE` | 首次 | `sbe_` + 32 位十六进制；只在首次初始化时生效 |
| `BOOTSTRAP_ADMIN_MEMBER` / `BOOTSTRAP_ADMIN_NAME` | 否 | 首位 admin 的 member_id 与显示名（默认 `m-owner` / `Owner`） |
| `DATA_DIR` | 否 | 默认 `/data` |
| `CLIENT_IP_HEADER` | 按反向代理配置 | 仅当可信代理覆盖该请求头、且客户端不能绕过代理直连服务时，才用它作为真实来源 IP（例如 `x-real-ip`）。先验证代理行为，不要直接信任客户端自填的请求头。 |
| `TRUSTED_PROXY_HOPS` | 否 | 不设 `CLIENT_IP_HEADER` 时，按 `X-Forwarded-For` 从右数第几段取来源（默认 1）；无代理本地运行设为 0 |
| `NOTIFY_WEBHOOK_URL` | 否 | 飞书自定义机器人 webhook；新 agent 接入、换来源 IP、冻结/维护时通知 |
| `SYNC_MAX_PENDING` / `SYNC_MAX_PENDING_MINUTES` | 否 | 见上 |
| `RESTORE_NONCE` | 恢复备份时 | 设一个新值后重启：服务以维护模式启动并作废全部凭据（每个值只生效一次） |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` / `MAIL_FROM_ADDRESS` | 否 | 全员通知邮件（§11）。四项都设才启用 `announce`；刷新令牌用 `service/scripts/gmail-authorize.mjs` 获取，只含 gmail.send 权限 |
| `MAIL_FROM_NAME` / `ANNOUNCE_GUIDE_URL` | 否 | 发件显示名；邮件里“查看完整资料”按钮的链接（如公开同步网页） |
| `WATERMARK_REF` | 否 | 远端授权见证所在的 ref，默认 `refs/commons/auth-watermark`；托管方拒绝自定义 ref 时改为分支名（如 `refs/heads/commons-auth-watermark`） |

5. 部署成功后（`/healthz` 返回 `{"ok":true}`），兑换 admin 凭据：

```sh
curl -sS -X POST "$PUBLIC_URL/enroll" -H 'Content-Type: application/json' -d '{"code":"<BOOTSTRAP_ADMIN_CODE>"}'
```

把返回的 admin token 存在只给管理用的地方（不要配进日常 agent），然后删掉 `BOOTSTRAP_ADMIN_CODE` 变量。

## 3. 接入成员

用 admin 凭据（任何 MCP 客户端，或直接发 JSON-RPC）：

1. `member_create{member_id, display_name}`（member_id 永不复用，如 `m-alice`）。
2. `invite_create{member_id, client_label, ttl_hours?}` 得到一次性码 `sbe_…`。**只私聊发给本人**，连同 [agent-onboarding.md](agent-onboarding.md) 里的提示词。
3. 对方的 agent 按 `GET /enroll` 的协议兑换、写配置、`whoami` 自检。成员也可以在浏览器打开 `/enroll` 手动兑换（凭据只显示一次）。
4. 码过期或兑换后丢了凭据：`invite_cancel` / `token_revoke` 后重新发。

日常管理：`members`、`token_list`、`invite_list`、`member_set_role`、`member_disable`、`token_revoke`、`admin_status`（模式、同步、最近事件）。

## 4. 模式与处置

| 模式 | 读 | 写 | 什么时候进入 | 怎么恢复 |
|---|---|---|---|---|
| `normal` | ✓ | ✓ | — | — |
| `frozen / pending_limit` | ✓ | ✗ | 网络故障导致未推送提交超限 | 网络恢复、推送成功后自动解冻 |
| `frozen / push_rejected` | ✓ | ✗ | GitHub 拒绝推送（deploy key 失效、规则拒绝） | 修好后 admin 调 `sync_retry` |
| `frozen / fork_suspected` | ✓ | ✗ | 推送被拒为非快进，但暂时拉不到远端确认 | 之后的远端检查确认没有分叉就自动解冻；确认分叉则转为 `fork` |
| `frozen / fork` | ✓ | ✗ | 远端 main 出现不经服务的提交 | §5 分叉恢复 |
| `maintenance` | ✗ | ✗ | 状态丢失、账本或授权代数落后（旧快照）、事务日志对不上、已有仓库未通过采纳校验 | §6 |

另外两种“局部”拒绝：`_commons/config.yaml` 无法解析时写入一律返回 `CONFIG_INVALID`（读照常，admin 用 `update_config` 修好即恢复）；维护 CLI 持有维护锁期间写入返回 `MAINTENANCE`。

**认证闸门**：启动后必须先读到远端授权见证、确认状态库没有落后，才开放认证和兑换；读不到 GitHub 时 `/mcp`、`/enroll` 返回 503（`starting`），每 30 秒重试。`BOOTSTRAP_FORCE` 这类授权变更也等核实之后才处理。维护模式下不做这项核实（维护模式本身就不接受任何认证请求）；`resolve-maintenance` 经维护通道完成后会重新核实一次。

**授权代数与库外见证**：每次改动成员、凭据、一次性码，状态库里的授权代数 +1（没有实际改动的操作不加），并写到两个不随状态库回滚的见证：volume 上的 `state/auth-watermark.json`（只升不降），以及实例私库里的 `refs/commons/auth-watermark`（只含实例 id 和一个计数）。远端见证是一条提交链：推送不带 force，并且每个新提交的代数都严格大于它的父提交，所以链上的代数只增不减。启动时任一见证高于状态库 → `maintenance / auth_stale`，并已持久化作废全部凭据与未兑换的一次性码。

授权变更的接口在返回前**尽量**等远端见证推上 GitHub（最多 8 秒）；超时或推送失败时接口仍然返回成功，见证在后台持续重试。

**残余风险**：某次授权变更没能推上 GitHub，并且在重试成功之前整个 volume 被回滚到这次变更之前——这种情况检测不到。所以**手动恢复备份时，必须在恢复后的服务对外开放之前**让它以维护模式启动：先在 Railway 变量里设一个新的 `RESTORE_NONCE`（任意新值，每个值只生效一次），再恢复 volume / 重启；服务会以维护模式启动并作废全部凭据，然后按 §6 处置。服务已在运行时也可以用 `enter-maintenance --reason restore --yes`。

**维护锁**：维护命令开始时取得跨进程维护锁并使“维护代数”+1；服务后台的推送、拉取结果写回前会核对代数，维护期间的旧网络结果一律作废，不会把 CLI 刚处置好的状态改回去。

维护命令在服务容器里运行（`railway ssh`），环境变量与服务相同。服务在运行时，命令经 volume 上的本地 socket（`/data/state/admin.sock`，只在容器内可达，权限 600）交给服务进程，在单写者队列里独占执行，不会和写入交错；服务没运行时直接操作（带维护锁）。服务进程活着但维护通道不在时，CLI 拒绝执行（不会退回直接操作）；维护通道建不起来时服务启动失败：

```sh
node src/cli.js status
node src/cli.js fork-status
node src/cli.js fork-recover --admin m-owner [--import all|none|<sha>,<sha>] [--yes]
node src/cli.js resolve-maintenance --bootstrap-code sbe_<新的> [--member m-owner --name Owner] [--yes]
node src/cli.js enter-maintenance --reason restore --yes   # 手动恢复备份后先执行：作废全部凭据
```

不带 `--yes` 只显示将要做什么。经 socket 执行的命令即时生效，不需要重启服务。

## 5. 分叉恢复（有人绕过服务直推了私库）

1. `fork-status` 看外部提交列表（作者、时间、改了哪些页）。
2. 如果仓库开了分支保护，先在 GitHub 临时允许 force push。
3. `fork-recover --admin <你的 member_id> --import all|none|<sha,…> --yes`：
   - 外部链推到远端 `quarantine/<时间>` 分支保存；
   - 认可的外部修改经全部守卫，以 `maintenance_import` 重新应用到服务链（作者是你，trailer 引用原 SHA；冲突则整体中止，请人工处理）；
   - `git push --force-with-lease=main:<远端旧 SHA>` 把远端 main 对齐到服务链；
   - 校验远端、已发布版本、账本三者一致后解冻。
4. 恢复分支保护。已经发布给客户端的服务提交一个都不会改变。

## 6. 维护模式（状态丢失 / 从旧快照恢复）

触发条件：
- `state_lost`：状态库不存在，但仓库里已有服务提交（不会被当成新库重新引导 admin）。
- `ledger_stale`：仓库或远端有账本没记录的服务提交（状态库是从旧快照恢复的）。进入时**已经持久化作废**全部 token 与未兑换的一次性码。
- `auth_stale`：状态库的授权代数低于库外见证（状态库或整个 volume 是旧快照，哪怕期间没有任何提交）。同样已作废全部凭据。
- `adopt_rejected`：首次初始化时，已有的实例仓库含疑似凭据或损坏的配置，拒绝采纳。
- `published_mismatch` / `journal_inconsistent`：本地仓库与状态库对不上。

处置：
1. 确认用哪份数据：一般以 GitHub 远端为准（它是主备份）。需要时从 `/data/backups/<日期>/` 取 `instance.bundle` 与 `commons.db`（同一时刻导出，水位一致）。恢复之前先设好新的 `RESTORE_NONCE`。
2. 生成新的 bootstrap code（`sbe_` + `openssl rand -hex 16`），运行 `resolve-maintenance --bootstrap-code … --yes`：快进到远端、作废全部凭据、以服务链为准重新发布、登记新的 admin 引导码。
3. 重启服务，兑换新的 admin 凭据，**给所有成员重新发码**。账本缺失的那段提交在历史里标为 `unverified`（不会凭 trailer 补成已认证）。

## 7. 最后一位 admin 丢了凭据

在 Railway 设置新的 `BOOTSTRAP_ADMIN_CODE` 和 `BOOTSTRAP_FORCE=1`，重启，兑换，然后删掉这两个变量。同一个码只会登记一次，之后重启不会再追加 admin。

## 8. 备份

服务每天把 `git bundle`（含未推送的对象）和状态库快照写到 `/data/backups/<日期>/`，保留 14 天。GitHub 私库是主备份。

## 9. 误存敏感信息

删除页面不等于抹除历史。线下处理：停服务 → 在私库上做 history rewrite（如 `git filter-repo`）→ 轮换泄露的凭据 → 用 `resolve-maintenance` 重建状态（全员重新发码）→ 通知成员删除本地副本。已经读进 agent 对话的内容无法收回。

## 10. 公开同步网页（可选，`mirror/`）

给用不了 MCP 的工具和人一个持链接可读的网页：独立服务，用一把专用 reader 成员的 **read scope** 凭据每分钟检查实例的已发布版本，变了就读取、脱敏、重建。引擎本身不加任何未认证路由。规则、配置、部署、残余风险见 [mirror/README.md](../mirror/README.md)。

运维要点：

- **停用**：admin `token_revoke` 掉镜像凭据，通常约 1 分钟内撤下全部内容；资料库同时不可达时，最迟 `AUTH_TTL_MINUTES`（默认 30）后撤下。不依赖资料库的停用：Railway 变量 `MIRROR_DISABLED=1` 并重新部署（健康检查仍会通过）。彻底下线再删服务域名。
- **凭据**：属于专用成员（`role: reader`），不要挂在真人成员名下（引擎允许凭据吊销同一成员名下的其他凭据）。只放在镜像服务的 `COMMONS_TOKEN` 变量里。
- **日志**：每次发布一行“已发布 <版本>：N 页；隐藏 字段 x、电话 y…”；“页面没有通过公开检查”表示该页最新修改脱敏后复查仍检出疑似敏感信息，网页沿用该页上一版——要人工看是哪一页、规则漏了什么。
- **写作约定**里写明“内容会同步到公开网页、哪些会被隐藏”，并提醒不要写无固定格式的隐私（健康、私人住址等）。

## 11. 全员通知邮件（可选，`announce`）

谁改的内容由谁的 AI 判断要不要通知：写入影响大家安排的改动后（日期、路线、住宿、交通、预算、重要活动、截止时间有实质变化，或从待定变成已定），AI 问主人要不要发，把标题和正文草稿给主人看，主人同意后调 `announce`。服务不判断“算不算重大”，只负责发信与记录：

- **收件人**：登记了邮箱的有效成员（admin 用 `member_set_email` 登记，`mail_roster` 查看）；只读成员、禁用成员不收。邮箱只存在状态库，不进 git，`members` 工具和页面里都没有。
- **邮件内容**：agent 按固定结构写（`subject` 标题、`headline` 一句话结论、`action` 需要大家做什么、`sections` 小节：每个具体对象一张卡片 `cards[{title, tag, subtitle, lines}]`，或 `bullets` 要点、`note` 一段话），要求自成一体——收件人只看邮件就知道具体变了什么，不用再去问 AI。服务排版成卡片式 HTML（标题栏、黄色“你需要做”提示框、带状态标签的卡片、“查看完整资料”按钮、发件说明和收件人名单），并附内容一致的纯文本版（multipart/alternative）。内容一律转义，行内只认 `**加粗**` 和 http(s) 链接。标题为 `【实例显示名】<subject>`，Reply-To 是发起成员（登记了邮箱时）。通知正文不自动附系统修改记录。
- **限制**：只读凭据没有这个工具；每位成员 24 小时最多 3 封、全体最多 10 封；全封最多 40 张卡片；内容里疑似凭据时拒绝。补发不要求期间有新改动。
- **结果**：`sent`；`failed`（明确没发出，可换新键重试）；`unknown`（发信请求超时或服务在发信途中重启，可能已发出——先让主人查邮箱再决定是否重发）。所有通知可用 `announcements` 查看。配置了 `NOTIFY_WEBHOOK_URL` 时，每封通知和发信故障都会推到飞书。
- **授权失效**：报 `MAIL_AUTH`。在本机重跑 `node service/scripts/gmail-authorize.mjs <client_secret.json> <输出文件> --expect <邮箱>`，再用 `railway variable set GMAIL_REFRESH_TOKEN --stdin` 更新。Google Cloud 里 OAuth 应用必须是“正式发布（In production）”状态，测试状态下的刷新令牌 7 天就会失效。
- **停用**：删掉任一 `GMAIL_*` 变量并重新部署，`announce` 工具随即消失。
