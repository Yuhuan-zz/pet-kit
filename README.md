# pet-kit —— 给「泡泡」补上投喂、状态和看屏

一个 **DSH 插件**（不是 dsh-pet 的分支），给 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 加三样它自己没有的功能：

| 功能 | 说明 |
|---|---|
| **投喂** | 右键「更多 → 投喂」，她吃一顿：饱腹度上涨、播吃饭动画、说一句台词 |
| **状态** | 右键「更多 → 状态」，她报当前饱腹度和今天吃了什么 |
| **看眼屏幕** | 右键「更多 → 看眼屏幕」，她真的看一眼你的屏幕，说一句话；这句话**进她的对话记忆**，事后追问能答上 |

**不改上游一行代码**：只用 dsh-pet 的公开 HTTP 接口（`/menu/item`、`/menu/events`、`/lock`、`/anim`、
`/broadcast`、`/chat`）。它升级时，这里通常只需要改一个依赖版本号。

## 环境要求

- DSH（DeepSeek Harness），带桌面端或网页端
- **dsh-pet >= 0.4.8**（0.3.x 没有这些接口）
- Node.js >= 22
- **ffmpeg**（仅看屏需要；没有就自动禁用看屏并说明原因）

## 安装

```bash
# 在 DSH profile 目录里
pnpm add pet-kit
```

然后把包名登记进 profile 的 `dsh.profile.bundles`（见 profile 的 `package.json`）。

> 本机开发时可以直接 `file:` 安装 + 在 `node_modules` 里放一个 junction 指到源码目录，
> 改代码不用重新安装。

装完**完全退出 DSH 再打开**（这是宿主侧插件，重载桌面端不够）。

## 配置

**有设置页**：右键「更多 → 看屏设置」，会在浏览器打开一个本地页面（`http://127.0.0.1:<端口>/pet-kit/settings`），
改完点保存立刻生效，不用重启。

也可以直接改 `~/.dsh/pet-kit/config.json`，首次启动会自动生成：

```jsonc
{
  "look": {
    "mode": "passive",          // passive = 只有点菜单才看；active = 定时自己看
    "intervalSec": 90,          // active 模式的最小间隔
    "dailyBudget": 24,          // active 模式每天最多看几次
    "prompt": "（她抬眼看了下屏幕）",
    "ffmpeg": "ffmpeg",         // ffmpeg 可执行文件路径；不写就从 PATH 找
    "width": 1600,              // 抓帧宽度（越大越贵、越清楚）
    "quality": 4                // JPEG 质量（ffmpeg -q:v，越小越好）
  }
}
```

## 数据

| 文件 | 内容 |
|---|---|
| `~/.dsh/pet-kit/feed-state.json` | 饱腹度真值（首次启动会从 `~/.dsh/dsh-pet/feed-state.json` 续上） |
| `~/.dsh/pet-kit/config.json` | 上面的配置 |
| `~/.dsh/pet-kit/look-stat.json` | 看屏的每日计数 |

截图不进磁盘：抓一帧 JPEG 直接在内存里交给 `/chat`。

## HTTP 接口

只监听回环，写操作只接受 POST：

```
GET  /pet-kit/health                    插件状态（healthy / detail）
GET  /pet-kit/settings                  设置页（HTML）
GET  /pet-kit/config                    读当前 look 配置
POST /pet-kit/config                    写 look 配置（白名单校验，只改传了的字段）
POST /pet-kit/feed?pet=<id>             喂一顿
POST /pet-kit/status?pet=<id>           报状态
POST /pet-kit/look?pet=<id>             看一眼前屏
```

## 已知行为（不是 bug，先说清楚）

1. **看屏会出声。** 看屏走 dsh-pet 的 `/chat`，而上游把对话回复当"会念的"——开着语音时，
   看一次说一次。手动点一次念一次；`mode: "active"` 则是每次定时看都念。`/chat` 没有 `speak` 参数，
   调用侧关不掉。默认 `passive` 就是为了让这件事只在你主动点时发生。
2. **菜单项在右键「更多」下面。** dsh-pet 只给第三方这一层入口。
3. **看屏需要 ffmpeg**，且**不退回 GDI**：GDI 截视频/游戏是白屏/黑屏。
4. **游戏要无边框窗口。** 独占全屏不进桌面合成，DXGI 和 Chromium 都抓不到。
5. **每次看屏 = 一次模型调用**（一张图 + 一句），费用记在你自己的模型账上。
6. **截图进记忆但不进上下文回放**：她记得自己说过什么，但不等于还能重新看到那张图。

## 卸载

1. 从 profile 的 `dsh.profile.bundles` 和 `dependencies` 里删掉包名；
2. 删 `node_modules/pet-kit*`；
3. 想清数据就删 `~/.dsh/pet-kit/`（饱腹度会从 100% 重来）。

## 版本与兼容

- **npm 上的版本才是对外版本**；GitHub 是源码与变更记录（`CHANGELOG.md`）。
  两边不一致时，以 npm 的 `latest` 为准，见 <https://www.npmjs.com/package/pet-kit>。
- **数据只增不弃**：新版本必须能读老数据（缺字段回落默认；首次安装会从
  `~/.dsh/dsh-pet/feed-state.json` 续接）。数据文件名与位置承诺不变：
  `~/.dsh/pet-kit/{feed-state.json,config.json,look-stat.json,feed.log}`。
- **依赖上游 dsh-pet >= 0.4.8**。上游大版本变化可能让我们失效——插件启动会做行为探测
  （`GET /state` 形状 + `POST /menu/item`），不通过就整体禁用，原因写在
  `GET /pet-kit/health` 的 `detail` 里，不会静默坏掉。
- ⚠️ **0.4.2 及更早的「状态」显示有误**（会把没吃的下一顿预支进去，分数虚高）。
  请升级到 **0.4.5+**。npm 上那些旧版本无法撤回（72 小时窗口已过），只能靠升级。

### 回滚到指定版本

```bash
pnpm add pet-kit@0.4.4      # 换成你想回的那个版本号
```

然后**完全退出 DSH 再打开**。回滚不会动 `~/.dsh/pet-kit/` 里的数据，饱腹度不会重置。

### 出问题时报什么

给我三样就够定位：**版本号**、`GET /pet-kit/health` 的返回、`~/.dsh/pet-kit/feed.log` 最后十几行。

## 许可证

MIT（见 `LICENSE`）。上游 dsh-pet 也是 MIT。
