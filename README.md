# Pomodoro Timer

一个零依赖的番茄钟：专注 25 分钟，休息 5 分钟，把一天切成可以完成的小块。
A dependency-free Pomodoro timer: 25 minutes of focus, 5 minutes of rest, one day cut into finishable blocks.

纯静态文件 · 数据只存本机 · 支持系统通知 · 320px 起可用
Static files only · local-only data · system notifications · works from 320px

**中文** · [English](#en)

---

<a id="zh"></a>

## 中文

### 快速开始

| 方式 | 操作 |
| --- | --- |
| 直接打开 | 双击 `index.html` |
| 本地服务 | `python3 -m http.server 8000`，访问 `http://localhost:8000` |

> 通知需要 `https://` 或 `localhost` —— 只有这两种源允许注册 Service Worker。`file://` 打开时自动退回普通通知。

文件：`index.html`（结构）、`styles.css`（视觉）、`app.js`（逻辑）、`sw.js`（通知）、`icon-192.png` / `icon-512.png`（图标）。

### 使用

**计时**：专注 25 / 短休 5 / 长休 15 分钟，默认每完成 4 个专注进一次长休。开始、暂停、继续是同一个按钮；重置不计记录，跳过不计番茄。休息时整张卡片降级——淡染色、灰数字、墨黑按钮。

**任务**：输入标题与预估番茄数添加；点行设为“正在专注”，双击改名，悬停调预估或删除，拖动排序。实际番茄数达到预估时自动勾选。

**报告**：本周 / 本月 / 全部三个区间（跨度超 75 天自动按月聚合）。四张卡：专注时长、日均专注、最长一天、连续专注；下接每日柱状图、任务分布与单日最佳。可导出 CSV。

**设置**：时长（专注 5–120、短休 1–30、长休 5–60）、长休间隔 2–8、自动开始、滴答声、铃声与音量、纸白 / 墨黑主题、四套强调色、通知权限、备份导入导出。

**快捷键**：`空格` 开始/暂停 · `R` 重置 · `S` 跳过 · `N` 新任务 · `1/2/3` 切模式 · `Esc` 关面板

### 设计

**原则**：一屏一件事；数字等宽不跳字；状态靠层级而非颜色；数据留在本机。

**视觉**：纸与墨两套主题，配一个强调色。

| 令牌 | 纸白 | 墨黑 |
| --- | --- | --- |
| 底色 | `#f2ede1` | `#12100e` |
| 卡片 | `#fbf8f0` | `#1a1714` |
| 文字 | `#1a1613` | `#f2ebdf` |
| 强调 | `#cf4522` | `#ef6a45` |

计时数字用 Bricolage Grotesque，`clamp(82px, 12vw, 146px)`、字距 `-0.045em`，压紧成“一块”的体量感；正文 Inter，中文回退系统字体。卡片 26px 圆角、1px 描边、极柔投影，叠一层低透明度噪点模拟纸张。

**布局**：1180px 容器，左侧计时卡 sticky、右侧任务面板；≤980px 单栏，≤560px 收紧内边距，≤380px 缩字号并锁按钮单行。320 / 360 / 390 实测无横向溢出。

**技术**：无框架、无构建。计时存 `endAt` 时间戳而非每秒自减，切后台或系统休眠后不漂移，刷新可恢复；专注秒数在 tick 中实时累加（暂停也不丢），番茄数只在倒计时走到 0 时 +1。数据流单向：事件 → 改状态 → 渲染 → 落盘。

**存储**：单键 `pomodoro.v1` 存 JSON 快照（`version` / `settings` / `tasks` / `timer` / `stats` / `activeTaskId`）。写入节流 4 秒、运行中每 5 秒补写、`pagehide` 兜底；容量异常有提示，跨标签页走 `storage` 事件同步，旧键自动迁移。

**限制**：无账号与云同步；通知需要页面处于打开状态；暂不可安装为 PWA；不含 Todoist 导入、模板与项目分组。

**许可**：MIT，见 [LICENSE](LICENSE)。

---

<a id="en"></a>

## English

[中文](#zh) · **English**

### Quick start

| Option | How |
| --- | --- |
| Open directly | Double-click `index.html` |
| Local server | `python3 -m http.server 8000`, then open `http://localhost:8000` |

> Notifications require `https://` or `localhost` — the only origins where a Service Worker can be registered. On `file://` it falls back to plain notifications automatically.

Files: `index.html` (markup), `styles.css` (visuals), `app.js` (logic), `sw.js` (notifications), `icon-192.png` / `icon-512.png`.

### Usage

**Timer**: 25 min focus / 5 min short break / 15 min long break, with a long break after every 4 focus sessions by default. Start, pause and resume share one button; reset records nothing, skip records no pomodoro. During breaks the whole card steps down — tinted surface, grey digits, ink-black button.

**Tasks**: type a title and an estimated pomodoro count to add; click a row to make it the active task, double-click to rename, hover to adjust the estimate or delete, drag to reorder. A task auto-checks once it reaches its estimate.

**Report**: three ranges — this week / this month / all time (spans over 75 days switch to monthly bars). Four cards: focus time, daily average, best day, streak; followed by a daily bar chart, per-task distribution and a short observation. CSV export included.

**Settings**: durations (focus 5–120, short 1–30, long 5–60), long-break interval 2–8, auto-start, ticking, alarm sound and volume, paper/ink themes, four accents, notification permission, backup import/export.

**Shortcuts**: `Space` start/pause · `R` reset · `S` skip · `N` new task · `1/2/3` switch mode · `Esc` close panel

### Design

**Principles**: one thing per screen; tabular digits that never jitter; state expressed through hierarchy rather than colour; data stays on the device.

**Visuals**: paper and ink themes sharing a single accent.

| Token | Paper | Ink |
| --- | --- | --- |
| Surface | `#f2ede1` | `#12100e` |
| Card | `#fbf8f0` | `#1a1714` |
| Text | `#1a1613` | `#f2ebdf` |
| Accent | `#cf4522` | `#ef6a45` |

The countdown uses Bricolage Grotesque at `clamp(82px, 12vw, 146px)` with `-0.045em` tracking, packed tight to read as one solid block; body text is Inter with a system CJK fallback. Cards are 26px-radius, hairline-bordered, softly shadowed, with a faint turbulence grain on top to suggest paper.

**Layout**: a 1180px container with a sticky timer on the left and tasks on the right; a single column ≤980px, tighter padding ≤560px, smaller type and single-line buttons ≤380px. Verified at 320 / 360 / 390 with no horizontal overflow.

**Engineering**: no framework, no build step. The countdown stores an `endAt` timestamp instead of decrementing every second, so it never drifts after backgrounding or sleep and survives a reload. Focus seconds accumulate in real time (pausing keeps what you did); a pomodoro only counts when the timer reaches zero. State flows one way: event → mutate state → render → persist.

**Storage**: one key, `pomodoro.v1`, holding a JSON snapshot (`version`, `settings`, `tasks`, `timer`, `stats`, `activeTaskId`). Writes are throttled to 4s, flushed every 5s while running and on `pagehide`; quota errors surface as a toast, tabs sync through the `storage` event, and the legacy key migrates automatically.

**Limits**: no account or cloud sync; notifications need the page open; not installable as a PWA yet; no Todoist import, templates or projects.

**License**: MIT — see [LICENSE](LICENSE).
