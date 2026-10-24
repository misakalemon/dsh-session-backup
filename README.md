# 会话远程备份（dsh-session-backup）

把 DSH 的会话数据增量备份到远端（WebDAV 或本地/网络目录），带版本历史、排除规则、
限速重试与校验，并在需要时原样恢复。

## 备份什么

| 来源 | 本机路径 | 远端 key |
| --- | --- | --- |
| 会话日志 | `$DSH_HOME/sessions/**` | `<prefix>/sessions/<相对路径>` |
| 附件 | `$DSH_HOME/attachments/**` | `<prefix>/attachments/<相对路径>` |
| 存储快照 | `$DSH_HOME/storages/**` | `<prefix>/storages/<相对路径>` |

另外每次运行会写一份 `<prefix>/manifest.json`（每个文件的 sha256、大小、mtime、上传时间），
用于下次运行判断"能不能跳过"。

- 备份单元是**物理文件**，不是事件流：字节精确、与持久化格式版本无关。
- 会话用 zstd 帧拼接存储，帧边界不可分割，所以增量粒度是**整文件**（中位 0.4 MB，最大约 15 MB）。
- 运行前会先 `ctx.sessions.flush()`，保证 live 会话的尾部已经落盘。

## 对标成熟产品的能力

| 能力 | 本插件 | 说明 |
| --- | --- | --- |
| 全量 + 增量 | ✅ | size+mtime 快路径，再按 sha256 复核，避免 mtime 抖动造成的重传 |
| 版本历史 | ✅ | `versions.keep` 保留 N 份旧版本到 `<prefix>/versions/<key>/<时间>-<sha8>` |
| 保留清理 | ✅ | 超过 N 份自动淘汰最旧的版本与状态记录 |
| 文件/目录排除 | ✅ | 支持 `*.log`、`build`、`**/scratch/**`、`a/b` 前缀四种写法 |
| 删除同步 | ✅ | `deleteMode: mirror` 让远端镜像本地（默认 `archive` 只增不删） |
| 限速 | ✅ | `transfer.bandwidthKBps`，上传前按窗口 sleep，适合家用上行带宽 |
| 失败重试 | ✅ | `transfer.retries` 次指数退避（只重试可恢复错误，认证错误立即失败） |
| 校验 | ✅ | 每次运行可选抽样回读比对 sha256；面板「校验备份」可随时手动执行 |
| 计划任务 | ✅ | 每轮对话后去抖 / 固定间隔 / 每天固定时刻 / 启动补偿，四种可组合 |
| 暂停 | ✅ | 面板「暂停自动备份」，手动备份仍可用 |
| 运行历史 | ✅ | 最近 20 次结果（触发源、耗时、文件数、上传、跳过、版本、删除、流量、错误） |
| 活动记录 | ✅ | 面板展示最近 200 条本地操作事件（触发、失败、恢复） |
| 断点续传 | ❌ | 单文件级 PUT，暂无分块续传；中断的单个文件下次整份重传 |

## 两种上传形态

`archiveMode` 决定每次备份产出什么：

| 值 | 远端形态 | 增量 | 适合 |
| --- | --- | --- | --- |
| `mirror`（默认） | 与本地同构的目录树 + `manifest.json` | 文件级，只传变化的文件 | 长期备份、想按文件回滚 |
| `zip` | 每次一个自包含 `.zip`（STORE，不二次压缩） | 整包重传；内容没变时整轮跳过上传 | 想直接双击查看、拷到 NAS/U 盘带走 |

`zip` 模式的归档写在 `<prefix>/archive/<主机名>-<时间戳>.zip`，保留份数由
`archiveKeep`（1–50，默认 3）控制，超出即删最旧的。归档内路径与 mirror 模式一致
（`sessions/…`、`attachments/…`、`storages/…`），由 `lib/zip.js` 自己实现
STORE 写入/读取：不依赖第三方库，Windows 资源管理器、`Expand-Archive`、
7-Zip 都能直接打开；恢复时按归档目录里的 CRC-32 逐条目校验。

STORE 而非 Deflate 是刻意的：会话日志本身就是 zstd 帧，附件多是 PNG/JPEG/MP4，
二次压缩没有收益，还会让归档无法流式处理。

## 目标

`target: webdav`（远程 HTTP）或 `target: dir`（本地磁盘 / UNC 共享）。

两者写入同一套 key 布局，恢复时无差别。新增目标类型只需实现
`lib/targets.js` 里的契约（`kind/label/address/put/getText/putText/getTo/remove/move/probe`），
在 `createTarget()` 里加一个分支即可——这是为以后接 S3 / SFTP / 对象存储预留的接口。

WebDAV 地址按"文件夹"填即可，插件自己处理三件事：

- **自动补全根前缀**：填 `https://host/DSH/backup` 而服务端把 WebDAV 挂在
  `/webdav` 下时，会探测 `/webdav`、`/dav`、`/remote.php/dav` 以及根目录里名字带
  dav 的集合，采用第一个能 `PROPFIND` 成功的路径；
- **自动建目录**：目标文件夹不存在时按层 `MKCOL`，再重试原来的操作；
- **MOVE 降级**：服务端不支持 `MOVE`（`rclone serve webdav` 就是，返回 502）时，
  改用 GET→PUT 流式复制来保存旧版本，日志里留一条警告。

## 配置

设置页 →「会话远程备份」，所有字段都能在面板里改、保存即生效。也可以直接改
`cordis.patch.yml` 中 `id: session-backup` 的 `config`（面板保存的值优先）：

```yaml
- id: session-backup
  name: '@local/dsh-session-backup'
  config:
    enabled: true
    target: webdav
    archiveMode: mirror                    # mirror | zip（zip = 每次一个压缩包）
    archiveKeep: 3                         # zip 模式下保留几份归档
    prefix: dsh-session-backup/my-pc      # 远端根目录下的前缀，默认按主机名自动生成
    remote:
      url: https://dav.example.com/dav    # WebDAV 端点（不带末尾斜杠）
      root: ''                            # target=dir 时填目录，例如 D:\backup\dsh
      usernameRef: DSH_BACKUP_USERNAME
      passwordRef: DSH_BACKUP_PASSWORD
      timeoutSeconds: 30
    scope:
      sessions: true
      attachments: true
      storages: true
      maxAttachmentMB: 64                 # 单个附件上限，超过就跳过并计数
      maxFileMB: 512                      # 任意单文件硬上限
    exclude: ['*.log', '**/scratch/**']
    deleteMode: archive                   # archive | mirror
    versions:
      keep: 5                             # 每个文件保留的历史版本数
    transfer:
      retries: 2
      bandwidthKBps: 0                    # 0 = 不限速
    verifyAfter: false
    verifySample: 10
    schedule:
      mode: interval                      # off | interval | daily
      onTurnEnd: true                     # 每轮对话结束后触发（去抖）
      debounceMs: 20000
      intervalMinutes: 0                  # mode=interval 时生效
      dailyAt: '03:00'                    # mode=daily 时生效（本地时间）
      onStartup: true
      startupDelayMinutes: 3
```

**凭据**：`usernameRef` / `passwordRef` 指向 DSH 的凭据存储（默认
`DSH_BACKUP_USERNAME` / `DSH_BACKUP_PASSWORD`），密码不落进配置文件。
设置页里填好用户名密码后点保存即可写入；也可以用环境变量同名覆盖。

## 触发时机

- 每轮对话结束（`session/event` 里过滤 `turn/end`）→ 去抖 `debounceMs` 后跑一次；
- `schedule.mode = interval` 时按 `intervalMinutes` 跑；`daily` 时每天 `dailyAt` 跑；
- 启动后 `startupDelayMinutes` 补跑一次；
- 设置页「立即备份」按钮 / `POST /session-backup/api/run`。

未配置目标、或面板里暂停时，所有自动触发都会静默跳过（日志里只有一行提示）。

## 状态

- 锁文件、状态文件与面板配置在 `$DSH_HOME/session-backup/`
  （`state.json`、`backup.lock`、`config.json`）。
- `state.json` 记录每个文件的 sha256、版本列表、上次运行结果、最近 20 次运行历史。
- 同一时刻只允许一个备份在跑；抢不到锁就等下一次触发（不排队）。

## 恢复

设置页「恢复」卡片：填目标目录 → 可选按前缀过滤 → 勾「干跑」先看清单 → 确认执行。

- 会逐文件校验 sha256，不匹配的不写。
- `archiveMode: zip` 时下载整包 → 校验归档 sha256 → 按 CRC-32 逐条目解包，
  一次失败只跳过该条目并计数。
- **拒绝**写入 `$DSH_HOME` 及其子目录（避免覆盖正在使用的数据）。
- 恢复到干净目录后，把它整体拷回 `$DSH_HOME` 即可；建议先在别处恢复核对。

## 管理 API

前缀 `/session-backup/api`，需要 DSH 连接鉴权（只能同源页面调用）：

| 方法 | 作用 |
| --- | --- |
| `POST status` | 配置、暂停态、上次运行、运行历史、活动记录、待上传数 |
| `POST saveConfig` | 保存服务器/范围/策略/计划设置（凭据写进凭据库） |
| `POST run` | 立即备份（`{trigger: 'manual'}`） |
| `POST probe` | 连通性自检（写—读—删一个探针文件） |
| `POST verify` | 抽样回读校验（`{sample: 10}`） |
| `POST restore` | 恢复（`{to, prefixFilter, dryRun}`） |
| `POST pause` | `{paused: true/false}` 暂停或恢复自动备份 |
| `POST setPassword` | 写入 WebDAV 凭据 |

## 已知限制

- 增量是文件级；会话文件每次追加都会整份重传（16 万条消息之后才会变得明显）。
- `deleteMode: archive`（默认）不删远端：`scope` 只控制采集范围；要镜像删除需显式切换。
- 版本历史按 `<prefix>/versions/<key>/…` 平铺存放，不占用 manifest 的跳过判定。
- 不做端到端加密：隐私依赖 WebDAV 自身的传输加密（HTTPS）与服务端权限。
  加密钩子预留在目标契约之外，接入时把 `put` 前的字节流包一层即可。
- WebDAV 的 `MOVE` 用于归档旧版本；不支持 MOVE 的服务端会自动降级为"下载后重传"
  （多一次往返，旧版本内容不变）。

## 自测

```powershell
cd D:\Project\DeepSeekHarness\dsh-session-backup
node test\smoke.mjs   # 引擎端到端（进程内极简 WebDAV + 目录目标，含 zip 模式）
node test\host.mjs    # 宿主半侧（apply + 管理 API，无需 DSH）
node test\zip.mjs     # ZIP 容器：往返 + 与 PowerShell Expand-Archive 互认
```

冒烟测试覆盖：首传、二次跳过、单文件改动、同字节不同 mtime 不重传、附件上限、
版本归档（WebDAV MOVE）、抽样校验、排除规则、镜像删除、恢复往返字节一致、
自动探测 WebDAV 前缀、目标目录按需创建、
拒绝恢复到数据目录、dir 目标、连通性自检，以及 zip 模式（单对象上传、内容未变
时跳过、内容变化后新增归档并按 `archiveKeep` 淘汰、归档校验、整包恢复与干跑）。

宿主测试覆盖：初始未配置 → 保存地址/账号密码 → 状态立即生效 → 计划模式与策略往返 →
暂停开关 → 切到目录目标 → 清空后拒绝运行与校验，并断言 `config.json` 里没有密码和用户名。

## 面板

设置 →「远程备份」：

- **服务器设置**：目标类型、地址/目录、前缀、用户名、密码、超时，保存后立即生效；
- **计划与策略**：触发方式（关闭/间隔/每天）、间隔或时刻、每轮后触发、启动补偿，
  版本保留数、删除模式（归档/镜像）、重试次数、限速、排除规则多行文本、备份后抽样校验；
- **备份方式**：逐文件镜像 / 打包成单个 ZIP（ZIP 时显示归档位置与保留份数）；
- **状态**：阶段、进度条、待上传文件数、上次运行（耗时/触发源/文件数/上传/跳过/版本/删除/流量/错误）；
- **最近运行**：时间、触发源、上传/跳过、耗时、错误数；
- **活动记录**：本地操作事件；
- **恢复**：目标目录、前缀过滤、干跑。

优先级：面板保存的值 > `cordis.patch.yml` 里的 `config` > 内置默认值。保存内容写在
`<DSH_HOME>/session-backup/config.json`；密码和用户名走 DSH 凭据库
（`DSH_BACKUP_USERNAME` / `DSH_BACKUP_PASSWORD`），不落配置文件。输入框留空＝保留已保存的值。

> 为什么最初改不了服务器地址：插件最初把配置放在 profile 的 `cordis.patch.yml` 里，而
> `link:` 安装的插件无法 import `@deepseek-ai/schemastery`，因此不能声明 `export const Config`
> ——宿主"插件配置"表单里自然没有字段，面板当时也只有只读状态。
