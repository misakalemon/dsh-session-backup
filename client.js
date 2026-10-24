/**
 * Session Remote Backup — settings page.
 *
 * One page, five sections, modelled on what mature backup products put in front
 * of a user: current state + next run, the destination, what to back up, when
 * to run it, and the knobs that matter when something goes wrong (retries,
 * bandwidth, version history, verification) plus the run history and restore.
 *
 * Talks to the host through `POST /session-backup/api/<method>` on the same
 * origin, so no token handling is needed here.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-session-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = '@local/dsh-session-backup'
    const API = '/session-backup/api'
    const STYLE_ID = 'dsbk-settings-style'

    const ZH = {
      nav: '远程备份',
      title: '会话远程备份',
      description:
        '把会话日志、附件与 DSH 元数据按文件镜像到远端。大小与修改时间没变的文件直接跳过，改动过的按 SHA-256 判断是否真的需要重传。',
      runNow: '立即备份',
      running: '备份中…',
      probe: '测试连接',
      probing: '连接中…',
      verify: '校验远端',
      verifying: '校验中…',
      refresh: '刷新',
      save: '保存设置',
      saving: '保存中…',
      saved: '设置已保存',
      reset: '还原改动',
      unsaved: '有未保存的改动',
      loading: '加载中…',
      idle: '空闲',
      statusOk: '正常',
      statusOff: '未配置',
      statusPaused: '已暂停',
      statusRunning: '备份中',
      lastRun: '上次运行',
      never: '还没有运行记录',
      nextRun: '下次运行',
      noNextRun: '不定时',
      trigger: '触发',
      duration: '耗时',
      uploaded: '已上传',
      skipped: '已跳过',
      failed: '失败',
      excluded: '已排除',
      versioned: '归档版本',
      pruned: '远端删除',
      bytes: '本次流量',
      total: '文件数',
      mirror: '镜像',
      files: '个文件',
      host: '主机',
      prefix: '远端前缀',
      phase: '阶段',
      skippedByLimit: '因超过大小上限跳过',
      errors: '错误',
      ok: '成功',
      bad: '有失败',
      pause: '暂停自动备份',
      resume: '恢复自动备份',
      pausedHint: '自动备份已暂停，手动备份仍可用。',
      notConfigured: '还没有配置服务器地址，自动备份不会启动。',
      server: '备份目标',
      serverHint: '保存后立即生效。设置存在本机 session-backup/config.json，密码写进 DSH 凭据库，不落配置文件。',
      serverType: '类型',
      dirTarget: '本地 / 网络目录',
      webdav: 'WebDAV',
      serverUrl: 'WebDAV 地址',
      serverUrlHint: '例如 https://dav.example.com/dav（不要带末尾斜杠）',
      serverRoot: '目录路径',
      serverRootHint: '例如 D:\\backup\\dsh 或 \\\\nas\\dsh',
      serverPrefix: '远端前缀',
      serverPrefixHint: '留空则使用 dsh-session-backup/<主机名>',
      serverUser: '用户名',
      serverPass: '密码',
      secretSaved: '已保存',
      secretEmpty: '未设置',
      secretHint: '留空表示不改动已保存的值',
      serverTimeout: '超时（秒）',
      serverTimeoutHint: '单次请求的等待上限，慢速 WebDAV 可以调大',
      probeOk: '连接正常',
      probeBad: '连接失败',
      content: '备份内容',
      contentHint: '默认三类全备份。取消勾选只是不采集，不会删除远端已有的文件。',
      scopeSessions: '会话日志',
      scopeSessionsHint: '每个会话的完整消息流（sessions/**）',
      scopeAttachments: '附件',
      scopeAttachmentsHint: '聊天里的图片与文件（attachments/**）',
      scopeStorages: '工作区元数据',
      scopeStoragesHint: '工作区索引、会话缓存等（storages/**）',
      maxAttachmentMB: '单个附件上限（MB，0 = 不限）',
      maxFileMB: '单个文件上限（MB，0 = 不限）',
      exclude: '排除规则',
      excludeHint: '每行一条，支持 *.png、**/cache/**、attachments/thumb 这类写法',
      schedule: '运行计划',
      scheduleHint: '除定时外，还可以在每轮对话结束后备份一次，或启动时补一次。',
      modeOff: '不定时',
      modeInterval: '间隔',
      modeDaily: '每天',
      intervalMinutes: '每隔（分钟）',
      dailyAt: '每天时间',
      onTurnEnd: '每轮对话后备份',
      onTurnEndHint: '一轮回答结束后触发，带去抖，避免连续工具调用触发多次。',
      debounceMs: '去抖（毫秒）',
      onStartup: '启动时补一次',
      startupDelayMinutes: '启动延迟（分钟）',
      advanced: '高级',
      advancedHint: '一般保持默认；网络差时把并发降到 1，或启用限速。',
      concurrency: '并发上传',
      retries: '单文件重试次数',
      bandwidthKBps: '限速（KB/s，0 = 不限）',
      versionsKeep: '保留历史版本（0 = 关闭）',
      versionsHint: '覆盖前把旧副本移到 versions/，可回滚被写坏的会话文件。',
      deleteMode: '镜像模式',
      deleteModeHint: '开启后本地删除的文件也会从远端删除；关闭＝只增不删，更安全。',
      archiveTitle: '备份方式',
      archiveHint: '默认逐文件上传，只传变化的文件；也可以改成每次打包成一个 ZIP。',
      archiveZip: '打包成单个压缩包（ZIP）',
      archiveZipHint: '开启后每次备份产出一个自包含的 .zip，远端最整洁、可直接双击查看；代价是内容一变就要整包重传，不再有文件级增量。',
      archiveKeep: '保留最近几个归档',
      archiveKeepHint: '超出数量的旧归档会被删除。1–50。',
      archivePath: '归档位置',
      archivePathHint: '每次备份写到这个前缀下的 archive/ 目录。',
      lastArchive: '最近归档',
      verifyAfter: '备份后抽样校验',
      verifyAfterHint: '每次备份完随机读回若干文件比对 SHA-256，最慢也最稳妥。',
      verifySample: '抽样数量',
      history: '运行历史',
      historyHint: '最近 20 次运行，保存在本机 state.json。',
      historyEmpty: '还没有运行记录',
      versionSets: '版本集',
      versions: '历史版本',
      checked: '已校验',
      restore: '恢复',
      restoreHint: '把远端镜像写回一个空目录（不要指向正在使用的 DSH 数据目录）。恢复后自行核对，再决定是否替换。',
      restoreDest: '目标目录',
      restoreOnly: '只恢复前缀（可选，例如 sessions/）',
      restoreDry: '先试算（只列出会恢复的文件，不写盘）',
      restoreRun: '开始恢复',
      restoreConfirm: '确认恢复',
      restoreResult: '恢复结果',
      restored: '已恢复',
      noData: '暂无数据',
      seconds: '秒',
    }

    const EN = {
      nav: 'Backup',
      title: 'Session Remote Backup',
      description:
        'Mirrors session logs, attachments and DSH metadata file by file. Unchanged size+mtime is skipped; changed files are compared by SHA-256 before re-uploading.',
      runNow: 'Back up now',
      running: 'Backing up…',
      probe: 'Test connection',
      probing: 'Connecting…',
      verify: 'Verify remote',
      verifying: 'Verifying…',
      refresh: 'Refresh',
      save: 'Save settings',
      saving: 'Saving…',
      saved: 'Settings saved',
      reset: 'Discard changes',
      unsaved: 'Unsaved changes',
      loading: 'Loading…',
      idle: 'Idle',
      statusOk: 'Healthy',
      statusOff: 'Not configured',
      statusPaused: 'Paused',
      statusRunning: 'Backing up',
      lastRun: 'Last run',
      never: 'No run recorded yet',
      nextRun: 'Next run',
      noNextRun: 'Not scheduled',
      trigger: 'Trigger',
      duration: 'Duration',
      uploaded: 'Uploaded',
      skipped: 'Skipped',
      failed: 'Failed',
      excluded: 'Excluded',
      versioned: 'Versioned',
      pruned: 'Pruned',
      bytes: 'Traffic',
      total: 'Files',
      mirror: 'Mirror',
      files: 'files',
      host: 'Host',
      prefix: 'Remote prefix',
      phase: 'Phase',
      skippedByLimit: 'Skipped over the size cap',
      errors: 'Errors',
      ok: 'OK',
      bad: 'Failures',
      pause: 'Pause schedule',
      resume: 'Resume schedule',
      pausedHint: 'The schedule is paused; manual runs still work.',
      notConfigured: 'No destination configured yet, so automatic backups stay off.',
      server: 'Destination',
      serverHint: 'Saved changes apply immediately. Stored in session-backup/config.json; the password goes to the DSH credentials store.',
      serverType: 'Type',
      dirTarget: 'Local / network directory',
      webdav: 'WebDAV',
      serverUrl: 'WebDAV URL',
      serverUrlHint: 'e.g. https://dav.example.com/dav (no trailing slash)',
      serverRoot: 'Directory path',
      serverRootHint: 'e.g. D:\\backup\\dsh or \\\\nas\\dsh',
      serverPrefix: 'Remote prefix',
      serverPrefixHint: 'Empty = dsh-session-backup/<hostname>',
      serverUser: 'Username',
      serverPass: 'Password',
      secretSaved: 'saved',
      secretEmpty: 'not set',
      secretHint: 'Leave empty to keep the saved value',
      serverTimeout: 'Timeout (s)',
      serverTimeoutHint: 'Upper bound for one request; raise it for slow WebDAV servers',
      probeOk: 'Connection OK',
      probeBad: 'Connection failed',
      content: 'What to back up',
      contentHint: 'All three trees by default. Unchecking only stops collecting; nothing is deleted remotely.',
      scopeSessions: 'Session logs',
      scopeSessionsHint: 'The full message stream per session (sessions/**)',
      scopeAttachments: 'Attachments',
      scopeAttachmentsHint: 'Images and files pasted in chat (attachments/**)',
      scopeStorages: 'Workspace metadata',
      scopeStoragesHint: 'Workspace index, session caches (storages/**)',
      maxAttachmentMB: 'Max attachment size (MB, 0 = unlimited)',
      maxFileMB: 'Max file size (MB, 0 = unlimited)',
      exclude: 'Exclude rules',
      excludeHint: 'One per line: *.png, **/cache/**, attachments/thumb',
      schedule: 'Schedule',
      scheduleHint: 'Besides the schedule you can back up after each turn and once on startup.',
      modeOff: 'Manual only',
      modeInterval: 'Interval',
      modeDaily: 'Daily',
      intervalMinutes: 'Every (minutes)',
      dailyAt: 'At',
      onTurnEnd: 'Back up after each turn',
      onTurnEndHint: 'Fires once an answer finishes, debounced across tool calls.',
      debounceMs: 'Debounce (ms)',
      onStartup: 'Back up on startup',
      startupDelayMinutes: 'Startup delay (minutes)',
      advanced: 'Advanced',
      advancedHint: 'Defaults are fine; drop concurrency to 1 or set a rate limit on a slow link.',
      concurrency: 'Concurrent uploads',
      retries: 'Retries per file',
      bandwidthKBps: 'Rate limit (KB/s, 0 = off)',
      versionsKeep: 'Keep versions (0 = off)',
      versionsHint: 'The previous copy is moved to versions/ before an overwrite, so a corrupted log can be rolled back.',
      deleteMode: 'Mirror mode',
      deleteModeHint: 'On = files deleted locally are deleted remotely. Off = append only, safer.',
      archiveTitle: 'Backup format',
      archiveHint: 'By default every file is uploaded individually and only changed files move; you can switch to one ZIP per run instead.',
      archiveZip: 'Pack into a single ZIP archive',
      archiveZipHint:
        'One self-contained .zip per run — tidy remote, opens in Explorer, restores without this plugin. The cost: any change re-sends the whole archive, so file-level increment is gone.',
      archiveKeep: 'Archives to keep',
      archiveKeepHint: 'Older archives beyond this count are deleted. 1–50.',
      archivePath: 'Archive location',
      archivePathHint: 'Each run writes under archive/ below this prefix.',
      lastArchive: 'Latest archive',
      verifyAfter: 'Verify a sample after each run',
      verifyAfterHint: 'Reads a few files back and compares SHA-256. Slowest, safest.',
      verifySample: 'Sample size',
      history: 'Run history',
      historyHint: 'The last 20 runs, kept in the local state.json.',
      historyEmpty: 'No runs yet',
      versionSets: 'version sets',
      versions: 'Versions',
      checked: 'checked',
      restore: 'Restore',
      restoreHint:
        'Write the mirror back into an empty directory (never the live DSH data directory). Verify the result before replacing anything.',
      restoreDest: 'Destination directory',
      restoreOnly: 'Only this prefix (optional, e.g. sessions/)',
      restoreDry: 'Dry run (list what would be restored)',
      restoreRun: 'Restore',
      restoreConfirm: 'Confirm restore',
      restoreResult: 'Restore result',
      restored: 'Restored',
      noData: 'No data',
      seconds: 's',
    }

    const STYLE = `
.dsbk-root{display:flex;flex-direction:column;gap:16px;max-width:900px;padding:2px 2px 88px;color:var(--dsw-alias-label-primary,inherit);font:var(--dsw-font-s-14,14px/22px inherit)}
.dsbk-head h2{margin:0 0 6px;font:var(--dsw-font-l-20,20px/28px inherit);font-weight:600;letter-spacing:-.01em}
.dsbk-head p{margin:0;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-secondary,inherit);max-width:72ch}

/* surfaces */
.dsbk-card,.dsbk-hero{border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1,rgba(127,127,127,.18)));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05)))}
.dsbk-card{display:flex;flex-direction:column;gap:14px;padding:16px}
.dsbk-hero{display:flex;flex-direction:column;gap:14px;padding:16px}
.dsbk-hero-top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.dsbk-hero-title{display:flex;align-items:center;gap:10px;min-width:0;font-size:13.5px;font-weight:600}
.dsbk-hero-title>span+span{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40ch}

/* card head */
.dsbk-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsbk-card-head h3{margin:0;font-size:14px;font-weight:600;line-height:1.4}
.dsbk-card-head p{margin:3px 0 0;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-tertiary,inherit);max-width:68ch}
.dsbk-card-extra{display:flex;align-items:center;gap:8px;flex:none}

/* key/value + grids */
.dsbk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px 16px}
.dsbk-kv{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsbk-kv span:first-child{font-size:11.5px;color:var(--dsw-alias-label-tertiary,inherit)}
.dsbk-kv span:last-child{font-size:13px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}

/* buttons */
.dsbk-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dsbk-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,inherit);font-size:13px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap;transition:background .12s ease,opacity .12s ease,border-color .12s ease}
.dsbk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsbk-btn:active:not(:disabled){transform:translateY(.5px)}
.dsbk-btn:disabled{opacity:.45;cursor:not-allowed}
.dsbk-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,currentColor);outline-offset:2px}
.dsbk-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsbk-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));opacity:.88;color:var(--dsw-alias-label-primary-foreground,#fff)}
.dsbk-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary,inherit)}
.dsbk-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 55%,transparent);color:var(--dsw-alias-state-error-primary,#d9534f)}
.dsbk-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 12%,transparent)}
.dsbk-btn-danger.is-armed{border-color:transparent;background:var(--dsw-alias-state-error-primary,#d9534f);color:#fff}

/* progress, text, alerts */
.dsbk-bar{height:5px;border-radius:999px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.16));overflow:hidden}
.dsbk-bar i{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4d6bfe));transition:width .3s ease}
.dsbk-meta{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}
.dsbk-error,.dsbk-notice{border:1px solid;border-radius:var(--dsw-radius-sm,8px);padding:9px 11px;font-size:12.5px;line-height:1.6;overflow-wrap:anywhere}
.dsbk-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d9534f) 9%,transparent)}
.dsbk-notice{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e9e5b) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2e9e5b) 9%,transparent)}

/* badges */
.dsbk-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));font-size:11.5px;font-weight:500;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit)}
.dsbk-badge::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.dsbk-badge.is-ok{color:var(--dsw-alias-state-success-primary,#2e9e5b)}
.dsbk-badge.is-bad{color:var(--dsw-alias-state-error-primary,#d9534f)}
.dsbk-badge.is-warn{color:var(--dsw-alias-state-warn-primary,#c98b1b)}

/* fields */
.dsbk-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsbk-field>label{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}
.dsbk-hint{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-tertiary,inherit)}
.dsbk-input,.dsbk-select{height:34px;padding:0 10px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:13px;min-width:0;width:100%;box-sizing:border-box;transition:border-color .12s ease,box-shadow .12s ease}
.dsbk-input:hover,.dsbk-select:hover{border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.45))}
.dsbk-input:focus,.dsbk-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent)}
.dsbk-input::placeholder{color:var(--dsw-alias-label-quaternary,var(--dsw-alias-label-tertiary,#9aa0a6))}
.dsbk-textarea{min-height:68px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary,inherit);font-size:12.5px;line-height:1.6;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Consolas,monospace);width:100%;box-sizing:border-box;resize:vertical}
.dsbk-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent)}

/* segmented control */
.dsbk-seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));background:transparent}
.dsbk-seg button{height:28px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,inherit);font-size:12.5px;font-weight:500;cursor:pointer;transition:background .12s ease,color .12s ease}
.dsbk-seg button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsbk-seg button[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);font-weight:600;box-shadow:inset 0 0 0 1px var(--dsw-alias-label-tertiary,rgba(127,127,127,.5))}

/* checkbox rows */
.dsbk-switch{display:flex;gap:10px;align-items:flex-start;padding:6px 0}
.dsbk-switch input{margin:3px 0 0;width:15px;height:15px;flex:none;accent-color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer}
.dsbk-switch div{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsbk-switch strong{font-size:12.5px;font-weight:500}

/* table */
.dsbk-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.dsbk-table th,.dsbk-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14));white-space:nowrap}
.dsbk-table th{font-size:11.5px;font-weight:500;color:var(--dsw-alias-label-tertiary,inherit)}
.dsbk-table tbody tr:last-child td{border-bottom:0}
.dsbk-table tbody tr:hover td{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}
.dsbk-table td.num{text-align:right}

/* sticky save bar */
.dsbk-savebar{position:sticky;bottom:0;z-index:2;display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:2px;padding:10px 14px;border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l1,rgba(127,127,127,.2)));border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-1,Canvas);box-shadow:0 -6px 20px rgba(0,0,0,.10)}
.dsbk-savebar .dsbk-meta{margin-right:auto}
.dsbk-list{margin:0;padding-left:18px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,inherit);display:flex;flex-direction:column;gap:4px}
`

    function createTranslator(ctx) {
      const table = () => {
        const lang = String(ctx.get('settings')?.locale ?? '') || String(navigator?.language ?? '')
        return lang.toLowerCase().startsWith('en') ? EN : ZH
      }
      return (key) => table()[key] ?? key
    }

    function formatDuration(ms) {
      const value = Number(ms) || 0
      if (value < 1000) return `${value} ms`
      if (value < 60000) return `${(value / 1000).toFixed(1)} s`
      return `${Math.round(value / 60000)} min`
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return value
      return date.toLocaleString()
    }

    function formatRelative(target, now) {
      const at = typeof target === 'string' ? Date.parse(target) : NaN
      if (Number.isNaN(at)) return '—'
      const diff = at - now
      const abs = Math.abs(diff)
      const minutes = Math.round(abs / 60000)
      const label = abs < 60000 ? '<1 min' : minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
      return diff >= 0 ? label : `-${label}`
    }

    async function callApi(method, payload) {
      const response = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const text = await response.text()
      let parsed
      try {
        parsed = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）`)
      }
      if (parsed?.ok !== true) throw new Error(parsed?.error?.message ?? `请求失败（HTTP ${response.status}）`)
      return parsed.value
    }

    function useStatus() {
      const [state, setState] = React.useState({ loading: true, data: null, error: '' })
      const load = React.useCallback(async () => {
        try {
          const value = await callApi('status')
          setState({ loading: false, data: value, error: '' })
        } catch (error) {
          setState({ loading: false, data: null, error: String(error?.message ?? error) })
        }
      }, [])
      React.useEffect(() => {
        void load()
      }, [load])
      const running = state.data?.running === true
      React.useEffect(() => {
        if (!running) return undefined
        const handle = setInterval(() => void load(), 1500)
        return () => clearInterval(handle)
      }, [running, load])
      return { ...state, load, running }
    }

    function kv(label, value) {
      return h('div', { className: 'dsbk-kv', key: label }, h('span', null, label), h('span', null, value))
    }

    function Card({ title, hint, extra, children }) {
      return h(
        'section',
        { className: 'dsbk-card' },
        h(
          'div',
          { className: 'dsbk-card-head' },
          h('div', null, h('h3', null, title), hint === undefined ? null : h('p', null, hint)),
          extra === undefined || extra === null ? null : h('div', { className: 'dsbk-card-extra' }, extra),
        ),
        children,
      )
    }

    function Field({ label, hint, children }) {
      return h(
        'div',
        { className: 'dsbk-field' },
        h('label', null, label),
        children,
        hint === undefined ? null : h('span', { className: 'dsbk-hint' }, hint),
      )
    }

    function Toggle({ label, hint, checked, onChange, disabled }) {
      return h(
        'label',
        { className: 'dsbk-switch' },
        h('input', { type: 'checkbox', checked: checked === true, disabled: disabled === true, onChange: (event) => onChange(event.target.checked) }),
        h('div', null, h('strong', null, label), hint === undefined ? null : h('span', { className: 'dsbk-hint' }, hint)),
      )
    }

    function Segmented({ value, options, onChange }) {
      return h(
        'div',
        { className: 'dsbk-seg' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              'data-active': option.value === value ? 'true' : 'false',
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      )
    }

    function toForm(settings) {
      const scope = settings.scope ?? {}
      const schedule = settings.schedule ?? {}
      const transfer = settings.transfer ?? {}
      return {
        target: settings.target ?? 'webdav',
        url: settings.url ?? '',
        root: settings.root ?? '',
        prefix: settings.prefix ?? '',
        timeoutSeconds: settings.timeoutSeconds ?? 30,
        username: '',
        password: '',
        scope: {
          sessions: scope.sessions !== false,
          attachments: scope.attachments !== false,
          storages: scope.storages !== false,
          maxAttachmentMB: scope.maxAttachmentMB ?? 64,
          maxFileMB: scope.maxFileMB ?? 512,
        },
        exclude: Array.isArray(settings.exclude) ? settings.exclude.join('\n') : '',
        deleteMode: settings.deleteMode === 'mirror' ? 'mirror' : 'archive',
        archiveMode: settings.archiveMode === 'zip' ? 'zip' : 'mirror',
        archiveKeep: settings.archiveKeep ?? 3,
        versionsKeep: settings.versions?.keep ?? 0,
        verifyAfter: settings.verifyAfter === true,
        verifySample: settings.verifySample ?? 10,
        transfer: {
          concurrency: transfer.concurrency ?? 2,
          retries: transfer.retries ?? 2,
          bandwidthKBps: transfer.bandwidthKBps ?? 0,
        },
        schedule: {
          mode: schedule.mode ?? 'interval',
          intervalMinutes: schedule.intervalMinutes ?? 30,
          dailyAt: schedule.dailyAt ?? '03:00',
          onTurnEnd: schedule.onTurnEnd !== false,
          debounceMs: schedule.debounceMs ?? 20000,
          onStartup: schedule.onStartup !== false,
          startupDelayMinutes: schedule.startupDelayMinutes ?? 3,
        },
      }
    }

    function BackupPage(props) {
      const t = props.t
      const { data, error, loading, load, running } = useStatus()
      const [busy, setBusy] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [probeResult, setProbeResult] = React.useState(null)
      const [verifyResult, setVerifyResult] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [baseline, setBaseline] = React.useState(null)
      const [now, setNow] = React.useState(Date.now())
      const [dest, setDest] = React.useState('')
      const [only, setOnly] = React.useState('')
      const [dryRun, setDryRun] = React.useState(true)
      const [restoreArmed, setRestoreArmed] = React.useState(false)
      const [restoreResult, setRestoreResult] = React.useState(null)

      React.useEffect(() => {
        const handle = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(handle)
      }, [])

      React.useEffect(() => {
        if (!data?.settings || baseline !== null) return
        const initial = toForm(data.settings)
        setForm(initial)
        setBaseline(initial)
      }, [data, baseline])

      const dirty = form !== null && baseline !== null && JSON.stringify(form) !== JSON.stringify(baseline)

      const withBusy = async (name, work) => {
        setBusy(name)
        setNotice('')
        setActionError('')
        try {
          await work()
        } catch (problem) {
          setActionError(String(problem?.message ?? problem))
        } finally {
          setBusy('')
        }
      }

      const patch = (changes) => setForm((current) => ({ ...current, ...changes }))
      const patchScope = (changes) => setForm((current) => ({ ...current, scope: { ...current.scope, ...changes } }))
      const patchTransfer = (changes) => setForm((current) => ({ ...current, transfer: { ...current.transfer, ...changes } }))
      const patchSchedule = (changes) => setForm((current) => ({ ...current, schedule: { ...current.schedule, ...changes } }))

      const status = data ?? {}
      const settings = status.settings ?? {}
      const badState = status.configured !== true ? 'off' : status.paused === true ? 'paused' : running ? 'running' : 'ok'
      const stateLabel = badState === 'off' ? t('statusOff') : badState === 'paused' ? t('statusPaused') : badState === 'running' ? t('statusRunning') : t('statusOk')
      const stateClass = badState === 'ok' ? 'is-ok' : badState === 'off' ? 'is-bad' : 'is-warn'
      const lastRun = status.lastRun ?? null
      const history = Array.isArray(status.history) ? status.history : []

      if (loading) return h('div', { className: 'dsbk-root' }, h('div', { className: 'dsbk-meta' }, t('loading')))
      if (error !== '') return h('div', { className: 'dsbk-root' }, h('div', { className: 'dsbk-error' }, error))
      if (form === null) return h('div', { className: 'dsbk-root' }, h('div', { className: 'dsbk-meta' }, t('loading')))

      const progressPercent = status.running === true && status.total > 0 ? Math.min(100, Math.round((status.done / status.total) * 100)) : 0

      const hero = h(
        'section',
        { className: 'dsbk-hero' },
        h(
          'div',
          { className: 'dsbk-hero-top' },
          h(
            'div',
            { className: 'dsbk-hero-title' },
            h('span', { className: `dsbk-badge ${stateClass}` }, stateLabel),
            h('span', null, status.prefix ?? ''),
          ),
          h(
            'div',
            { className: 'dsbk-row' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsbk-btn dsbk-btn-primary',
                disabled: running || busy !== '' || status.configured !== true,
                onClick: () => void withBusy('run', async () => {
                  await callApi('run')
                  await load()
                }),
              },
              running ? t('running') : t('runNow'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsbk-btn',
                disabled: busy !== '' || status.configured !== true,
                onClick: () => void withBusy('pause', async () => {
                  const value = await callApi('pause', { paused: status.paused !== true })
                  setNotice(value.paused ? t('pausedHint') : '')
                  await load()
                }),
              },
              status.paused === true ? t('resume') : t('pause'),
            ),
            h('button', { type: 'button', className: 'dsbk-btn dsbk-btn-ghost', disabled: busy !== '', onClick: () => void load() }, t('refresh')),
          ),
        ),
        status.configured !== true ? h('div', { className: 'dsbk-error' }, t('notConfigured')) : null,
        status.paused === true ? h('div', { className: 'dsbk-meta' }, t('pausedHint')) : null,
        h(
          'div',
          { className: 'dsbk-grid' },
          kv(t('lastRun'), lastRun ? `${formatTime(lastRun.finishedAt)} · ${lastRun.ok ? t('ok') : t('bad')}` : t('never')),
          kv(t('nextRun'), status.nextRunAt ? `${formatRelative(status.nextRunAt, now)} · ${formatTime(status.nextRunAt)}` : t('noNextRun')),
          kv(t('mirror'), `${(status.mirror?.files ?? 0).toLocaleString()} ${t('files')} · ${formatBytes(status.mirror?.bytes ?? 0)}`),
          kv(t('versions'), `${status.versions?.files ?? 0}`),
        ),
        running
          ? h(
              'div',
              null,
              h('div', { className: 'dsbk-meta' }, `${t('phase')}: ${status.phase} · ${status.done}/${status.total} · ${formatBytes(status.bytes)}`),
              h('div', { className: 'dsbk-bar', style: { marginTop: '6px' } }, h('i', { style: { width: `${progressPercent}%` } })),
            )
          : null,
        notice !== '' ? h('div', { className: 'dsbk-notice' }, notice) : null,
        actionError !== '' ? h('div', { className: 'dsbk-error' }, actionError) : null,
      )

      const destinationCard = h(
        Card,
        {
          title: t('server'),
          hint: t('serverHint'),
          extra: h(
            'button',
            {
              type: 'button',
              className: 'dsbk-btn',
              disabled: busy !== '',
              onClick: () => void withBusy('probe', async () => {
                setProbeResult(await callApi('probe'))
              }),
            },
            busy === 'probe' ? t('probing') : t('probe'),
          ),
        },
        h(
          Field,
          { label: t('serverType') },
          h(
            Segmented,
            {
              value: form.target,
              options: [
                { value: 'webdav', label: t('webdav') },
                { value: 'dir', label: t('dirTarget') },
              ],
              onChange: (value) => patch({ target: value }),
            },
          ),
        ),
        form.target === 'dir'
          ? h(Field, { label: t('serverRoot'), hint: t('serverRootHint') }, h('input', {
              className: 'dsbk-input',
              value: form.root,
              placeholder: 'D:\\backup\\dsh',
              onChange: (event) => patch({ root: event.target.value }),
            }))
          : h(Field, { label: t('serverUrl'), hint: t('serverUrlHint') }, h('input', {
              className: 'dsbk-input',
              value: form.url,
              placeholder: 'https://dav.example.com/dav',
              onChange: (event) => patch({ url: event.target.value }),
            })),
        h(
          'div',
          { className: 'dsbk-grid' },
          h(Field, { label: t('serverPrefix'), hint: t('serverPrefixHint') }, h('input', {
            className: 'dsbk-input',
            value: form.prefix,
            onChange: (event) => patch({ prefix: event.target.value }),
          })),
          h(Field, { label: t('serverTimeout'), hint: t('serverTimeoutHint') }, h('input', {
            className: 'dsbk-input',
            inputMode: 'numeric',
            value: form.timeoutSeconds,
            onChange: (event) => patch({ timeoutSeconds: event.target.value }),
          })),
        ),
        form.target === 'webdav'
          ? h(
              'div',
              { className: 'dsbk-grid' },
              h(Field, { label: `${t('serverUser')} · ${status.hasUsername ? t('secretSaved') : t('secretEmpty')}`, hint: t('secretHint') }, h('input', {
                className: 'dsbk-input',
                autoComplete: 'off',
                value: form.username,
                placeholder: status.hasUsername ? '••••••' : '',
                onChange: (event) => patch({ username: event.target.value }),
              })),
              h(Field, { label: `${t('serverPass')} · ${status.hasPassword ? t('secretSaved') : t('secretEmpty')}`, hint: t('secretHint') }, h('input', {
                className: 'dsbk-input',
                type: 'password',
                autoComplete: 'new-password',
                value: form.password,
                placeholder: status.hasPassword ? '••••••' : '',
                onChange: (event) => patch({ password: event.target.value }),
              })),
            )
          : null,
        probeResult === null
          ? null
          : h(
              'div',
              { className: probeResult.ok === true ? 'dsbk-notice' : 'dsbk-error' },
              `${probeResult.ok === true ? t('probeOk') : t('probeBad')} · ${probeResult.detail ?? ''}`,
            ),
      )

      const contentCard = h(
        Card,
        { title: t('content'), hint: t('contentHint') },
        h(
          'div',
          null,
          h(Toggle, {
            label: t('scopeSessions'),
            hint: t('scopeSessionsHint'),
            checked: form.scope.sessions,
            onChange: (value) => patchScope({ sessions: value }),
          }),
          h(Toggle, {
            label: t('scopeAttachments'),
            hint: t('scopeAttachmentsHint'),
            checked: form.scope.attachments,
            onChange: (value) => patchScope({ attachments: value }),
          }),
          h(Toggle, {
            label: t('scopeStorages'),
            hint: t('scopeStoragesHint'),
            checked: form.scope.storages,
            onChange: (value) => patchScope({ storages: value }),
          }),
        ),
        h(
          'div',
          { className: 'dsbk-grid' },
          h(Field, { label: t('maxAttachmentMB') }, h('input', {
            className: 'dsbk-input',
            inputMode: 'numeric',
            value: form.scope.maxAttachmentMB,
            onChange: (event) => patchScope({ maxAttachmentMB: event.target.value }),
          })),
          h(Field, { label: t('maxFileMB') }, h('input', {
            className: 'dsbk-input',
            inputMode: 'numeric',
            value: form.scope.maxFileMB,
            onChange: (event) => patchScope({ maxFileMB: event.target.value }),
          })),
        ),
        h(Field, { label: t('exclude'), hint: t('excludeHint') }, h('textarea', {
          className: 'dsbk-textarea',
          value: form.exclude,
          spellCheck: false,
          placeholder: '*.tmp\n**/cache/**\nattachments/thumbs',
          onChange: (event) => patch({ exclude: event.target.value }),
        })),
      )

      const scheduleCard = h(
        Card,
        { title: t('schedule'), hint: t('scheduleHint') },
        h(
          'div',
          { className: 'dsbk-row', style: { justifyContent: 'space-between' } },
          h(Segmented, {
            value: form.schedule.mode,
            options: [
              { value: 'off', label: t('modeOff') },
              { value: 'interval', label: t('modeInterval') },
              { value: 'daily', label: t('modeDaily') },
            ],
            onChange: (value) => patchSchedule({ mode: value }),
          }),
          h('span', { className: 'dsbk-meta' }, `${t('nextRun')}: ${status.nextRunAt ? formatTime(status.nextRunAt) : t('noNextRun')}`),
        ),
        form.schedule.mode === 'interval'
          ? h(Field, { label: t('intervalMinutes') }, h('input', {
              className: 'dsbk-input',
              inputMode: 'numeric',
              value: form.schedule.intervalMinutes,
              onChange: (event) => patchSchedule({ intervalMinutes: event.target.value }),
            }))
          : null,
        form.schedule.mode === 'daily'
          ? h(Field, { label: t('dailyAt') }, h('input', {
              className: 'dsbk-input',
              type: 'time',
              value: form.schedule.dailyAt,
              onChange: (event) => patchSchedule({ dailyAt: event.target.value }),
            }))
          : null,
        h(Toggle, {
          label: t('onTurnEnd'),
          hint: t('onTurnEndHint'),
          checked: form.schedule.onTurnEnd,
          onChange: (value) => patchSchedule({ onTurnEnd: value }),
        }),
        form.schedule.onTurnEnd
          ? h(Field, { label: t('debounceMs') }, h('input', {
              className: 'dsbk-input',
              inputMode: 'numeric',
              value: form.schedule.debounceMs,
              onChange: (event) => patchSchedule({ debounceMs: event.target.value }),
            }))
          : null,
        h(Toggle, {
          label: t('onStartup'),
          checked: form.schedule.onStartup,
          onChange: (value) => patchSchedule({ onStartup: value }),
        }),
        form.schedule.onStartup
          ? h(Field, { label: t('startupDelayMinutes') }, h('input', {
              className: 'dsbk-input',
              inputMode: 'numeric',
              value: form.schedule.startupDelayMinutes,
              onChange: (event) => patchSchedule({ startupDelayMinutes: event.target.value }),
            }))
          : null,
      )

      const archiveCard = h(
        Card,
        { title: t('archiveTitle'), hint: t('archiveHint') },
        h(Toggle, {
          label: t('archiveZip'),
          hint: t('archiveZipHint'),
          checked: form.archiveMode === 'zip',
          onChange: (value) => patch({ archiveMode: value ? 'zip' : 'mirror' }),
        }),
        form.archiveMode === 'zip'
          ? h(
              'div',
              { className: 'dsbk-grid' },
              h(Field, { label: t('archiveKeep'), hint: t('archiveKeepHint') }, h('input', {
                className: 'dsbk-input',
                inputMode: 'numeric',
                value: form.archiveKeep,
                onChange: (event) => patch({ archiveKeep: event.target.value }),
              })),
              h(Field, { label: t('archivePath'), hint: t('archivePathHint') }, h('input', {
                className: 'dsbk-input',
                value: `${status.prefix}/archive/`,
                readOnly: true,
              })),
            )
          : null,
        form.archiveMode === 'zip' && status.archive?.last
          ? h(
              'div',
              { className: 'dsbk-meta' },
              `${t('lastArchive')}: ${status.archive.last.fileName ?? status.archive.last.name} · ${formatBytes(status.archive.last.size ?? 0)} · ${(status.archive.last.entries ?? 0).toLocaleString()} ${t('files')}`,
            )
          : null,
      )

      const advancedCard = h(
        Card,
        { title: t('advanced'), hint: t('advancedHint') },
        h(
          'div',
          { className: 'dsbk-grid' },
          h(Field, { label: t('concurrency') }, h('input', {
            className: 'dsbk-input',
            inputMode: 'numeric',
            value: form.transfer.concurrency,
            onChange: (event) => patchTransfer({ concurrency: event.target.value }),
          })),
          h(Field, { label: t('retries') }, h('input', {
            className: 'dsbk-input',
            inputMode: 'numeric',
            value: form.transfer.retries,
            onChange: (event) => patchTransfer({ retries: event.target.value }),
          })),
          h(Field, { label: t('bandwidthKBps') }, h('input', {
            className: 'dsbk-input',
            inputMode: 'numeric',
            value: form.transfer.bandwidthKBps,
            onChange: (event) => patchTransfer({ bandwidthKBps: event.target.value }),
          })),
          h(Field, { label: t('versionsKeep'), hint: t('versionsHint') }, h('input', {
            className: 'dsbk-input',
            inputMode: 'numeric',
            value: form.versionsKeep,
            onChange: (event) => patch({ versionsKeep: event.target.value }),
          })),
        ),
        h(Toggle, {
          label: t('deleteMode'),
          hint: t('deleteModeHint'),
          checked: form.deleteMode === 'mirror',
          onChange: (value) => patch({ deleteMode: value ? 'mirror' : 'archive' }),
        }),
        h(Toggle, {
          label: t('verifyAfter'),
          hint: t('verifyAfterHint'),
          checked: form.verifyAfter,
          onChange: (value) => patch({ verifyAfter: value }),
        }),
        form.verifyAfter
          ? h(Field, { label: t('verifySample') }, h('input', {
              className: 'dsbk-input',
              inputMode: 'numeric',
              value: form.verifySample,
              onChange: (event) => patch({ verifySample: event.target.value }),
            }))
          : null,
      )

      const historyCard = h(
        Card,
        {
          title: t('history'),
          hint: t('historyHint'),
          extra: h(
            'button',
            {
              type: 'button',
              className: 'dsbk-btn',
              disabled: busy !== '' || status.configured !== true,
              onClick: () => void withBusy('verify', async () => {
                setVerifyResult(await callApi('verify', { sample: 10 }))
              }),
            },
            busy === 'verify' ? t('verifying') : t('verify'),
          ),
        },
        verifyResult === null
          ? null
          : h(
              'div',
              { className: verifyResult.ok === true ? 'dsbk-notice' : 'dsbk-error' },
              `${verifyResult.ok === true ? '✓' : '✗'} ${verifyResult.checked}/${verifyResult.totalKeys} · ${t('checked')}` ,
            ),
        history.length === 0
          ? h('div', { className: 'dsbk-meta' }, t('historyEmpty'))
          : h(
              'table',
              { className: 'dsbk-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ['#', t('lastRun'), t('trigger'), t('duration'), t('uploaded'), t('skipped'), t('failed'), t('bytes')].map((label) =>
                    h('th', { key: label }, label),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                history.slice(0, 8).map((run, index) =>
                  h(
                    'tr',
                    { key: `${run.startedAt}-${index}` },
                    h('td', null, run.ok ? '✓' : '✗'),
                    h('td', null, formatTime(run.finishedAt)),
                    h('td', null, run.trigger ?? '—'),
                    h('td', null, formatDuration(run.durationMs)),
                    h('td', { className: 'num' }, run.uploaded ?? 0),
                    h('td', { className: 'num' }, run.skipped ?? 0),
                    h('td', { className: 'num' }, run.failed ?? 0),
                    h('td', { className: 'num' }, formatBytes(run.bytes ?? 0)),
                  ),
                ),
              ),
            ),
        lastRun?.errors?.length
          ? h(
              'ul',
              { className: 'dsbk-list' },
              lastRun.errors.slice(0, 5).map((item) => h('li', { key: item.key }, `${item.key}: ${item.message}`)),
            )
          : null,
      )

      const restoreCard = h(
        Card,
        { title: t('restore'), hint: t('restoreHint') },
        h(Field, { label: t('restoreDest') }, h('input', {
          className: 'dsbk-input',
          value: dest,
          placeholder: 'D:\\restore\\dsh',
          onChange: (event) => setDest(event.target.value),
        })),
        h(Field, { label: t('restoreOnly') }, h('input', {
          className: 'dsbk-input',
          value: only,
          placeholder: 'sessions/',
          onChange: (event) => setOnly(event.target.value),
        })),
        h(Toggle, { label: t('restoreDry'), checked: dryRun, onChange: (value) => setDryRun(value) }),
        h(
          'div',
          { className: 'dsbk-row' },
          h(
            'button',
            {
              type: 'button',
              className: `dsbk-btn dsbk-btn-danger${restoreArmed && dryRun !== true ? ' is-armed' : ''}`,
              disabled: busy !== '' || dest.trim() === '' || status.configured !== true,
              onClick: () => {
                if (dryRun !== true && !restoreArmed) {
                  setRestoreArmed(true)
                  return
                }
                setRestoreArmed(false)
                void withBusy('restore', async () => {
                  setRestoreResult(await callApi('restore', { dest: dest.trim(), only: only.trim(), dryRun }))
                })
              },
            },
            restoreArmed && dryRun !== true ? t('restoreConfirm') : t('restoreRun'),
          ),
        ),
        restoreResult === null
          ? null
          : h(
              'div',
              { className: restoreResult.ok === true ? 'dsbk-notice' : 'dsbk-error' },
              `${t('restoreResult')}: ${t('restored')} ${restoreResult.restored}/${restoreResult.total}${restoreResult.dryRun ? ' (dry run)' : ''}`,
            ),
      )

      const saveBar = dirty
        ? h(
            'div',
            { className: 'dsbk-savebar' },
            h('span', { className: 'dsbk-meta' }, t('unsaved')),
        h(
          'button',
          {
            type: 'button',
            className: 'dsbk-btn',
            disabled: !dirty || busy !== '',
            onClick: () => {
              setForm(baseline)
              setProbeResult(null)
            },
          },
          t('reset'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dsbk-btn dsbk-btn-primary',
            disabled: !dirty || busy !== '',
            onClick: () =>
              void withBusy('save', async () => {
                await callApi('saveConfig', {
                  ...form,
                  timeoutSeconds: Number(form.timeoutSeconds) || 30,
                  exclude: form.exclude,
                  versionsKeep: Number(form.versionsKeep) || 0,
                  archiveMode: form.archiveMode === 'zip' ? 'zip' : 'mirror',
                  archiveKeep: Number(form.archiveKeep) || 3,
                  verifySample: Number(form.verifySample) || 10,
                  scope: {
                    ...form.scope,
                    maxAttachmentMB: Number(form.scope.maxAttachmentMB) || 0,
                    maxFileMB: Number(form.scope.maxFileMB) || 0,
                  },
                  transfer: {
                    concurrency: Number(form.transfer.concurrency) || 2,
                    retries: Number(form.transfer.retries) || 0,
                    bandwidthKBps: Number(form.transfer.bandwidthKBps) || 0,
                  },
                  schedule: {
                    ...form.schedule,
                    intervalMinutes: Number(form.schedule.intervalMinutes) || 0,
                    debounceMs: Number(form.schedule.debounceMs) || 20000,
                    startupDelayMinutes: Number(form.schedule.startupDelayMinutes) || 0,
                  },
                })
                const fresh = await callApi('status')
                const next = toForm(fresh.settings)
                setForm(next)
                setBaseline(next)
                setNotice(t('saved'))
                await load()
              }),
          },
          busy === 'save' ? t('saving') : t('save'),
            ),
          )
        : null

      return h(
        'div',
        { className: 'dsbk-root' },
        h('div', { className: 'dsbk-head' }, h('h2', null, t('title')), h('p', null, t('description'))),
        hero,
        destinationCard,
        contentCard,
        archiveCard,
        scheduleCard,
        advancedCard,
        historyCard,
        restoreCard,
        saveBar,
      )
    }

    function apply(ctx) {
      const t = createTranslator(ctx)

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const existing = document.getElementById(STYLE_ID)
        if (existing !== null) return () => {}
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE
        document.head.appendChild(style)
        return () => {
          style.remove()
        }
      }, 'session-backup: settings styles')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'session-backup',
            order: 38,
            label: () => t('nav'),
          },
          (props) => h(BackupPage, { ...props, t }),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})
