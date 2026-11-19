# dsh-baidu-netdisk

[![test](https://github.com/gusumuzhe/dsh-baidu-netdisk/actions/workflows/test.yml/badge.svg)](https://github.com/gusumuzhe/dsh-baidu-netdisk/actions/workflows/test.yml)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的**百度网盘 + PanSou 搜索**连接器，带能力白名单。

装上之后，可以在对话里让我：搜片源 → 解析分享 → 对比你网盘里已有的集 → 只转存缺的那几集。

## 为什么需要它

想自动化「网盘追剧」这条链路，会遇到三个硬限制：

| 路径 | 能转存吗 | 说明 |
|---|---|---|
| 官方开放平台「分享文件转存」 | ❌ | **企业开发者专属 + 付费能力**，个人拿不到 |
| 百度网盘官方 MCP / OAuth | ❌ | 只提供文件管理，不暴露转存接口 |
| 网页端 `/share/transfer` | ✅ | cookie 鉴权，无资质门槛 |

所以本插件走第三条路：用 BDUSS 调网页端接口。代价是要接受网页接口无文档、可能随百度改动而失效。

## 安全模型

这不是"提示词约束"，是**代码层的白名单**：

| 层 | 机制 |
|---|---|
| 能力 | 只有 8 个工具；`delete` / `move` / `create_share` **方法根本没实现** |
| 路径 | 转存目标必须落在配置的暂存目录（默认 `/绿联下载`）之下：拒绝绝对路径与 `..`，规范化后再校验前缀 |
| 参数 | 转存必须显式列出集号，**不提供"全转"开关** |
| 凭据 | BDUSS/STOKEN/PanSou 密码都是 `secret` 字段：只存设置页、不回传模型、不进对话 |
| 写开关 | `allowTransfer` 默认关闭，关着时转存工具直接拒绝 |

## 安装

```bash
# 从本地目录
dsh plugin --profile web add link:/path/to/dsh-baidu-netdisk

# 或从 npm（若已发布）
dsh plugin --profile web add dsh-baidu-netdisk
```

安装后重载插件（关闭再打开开关，或重启 DSH）。

## 配置

设置 → 插件 → `dsh-baidu-netdisk`：

| 字段 | 必填 | 说明 |
|---|---|---|
| `bduss` | ✅ | 浏览器登录 pan.baidu.com → F12 → Application → Cookies → `BDUSS` |
| `stoken` | 建议 | 同一处 Cookie 的 `STOKEN`，解析分享链接需要 |
| `pansouUrl` | 可选 | 自建 PanSou 地址，如 `http://192.168.1.10:9080`（不要填 `127.0.0.1`） |
| `pansouUser` / `pansouPass` | 可选 | PanSou 登录凭据 |
| `inboxRoot` | ✅ | 转存暂存目录，默认 `/绿联下载` |
| `allowTransfer` | ✅ | 是否允许转存（写操作），默认关闭 |

## 工具

| 工具 | 写操作 | 说明 |
|---|---|---|
| `baidu_whoami` | | 验证 BDUSS，返回昵称/uk |
| `baidu_quota` | | 容量 |
| `baidu_list(dir)` | | 列目录 |
| `baidu_search(keyword, dir)` | | 按文件名搜索 |
| `baidu_share_info(shareUrl, pwd, subdir?)` | | 解析分享，列出内部全部文件；整季打包的源用 `subdir` 钻入季目录 |
| `baidu_rank_sources(keyword, needEpisodes, limit?)` | | 多源横向评分（覆盖度 / 每集体积 / 4K / HDR），选出最该用的源 |
| `baidu_transfer(shareUrl, pwd, episodes, subdir, shareSubdir?)` | ✅ | 只转存指定集到暂存目录 |
| `pansou_search(keyword, limit)` | | 搜索资源，只返回百度网盘链接 |

## 自带 Skill：media-ops

插件在 `skills/media-ops/` 里带了一套操作手册与脚本，安装后自动注册为 DSH skill，新会话可以直接接手：

- 完整流程（搜源 → 判重 → 转存 → 同步 → 归档命名）
- 命名规范（`<剧名> (年份)/<剧名> SxxExx [画质].ext`）
- **12 条实测踩坑记录**（见 `skills/media-ops/SKILL.md`）
- 10 个辅助脚本（列目录 / 体检 / 归一化 / 归位 / 等同步 / 清暂存 / 一条龙 / TMDB / 写 NFO / 建文件）

## 稳定性

- **请求重试**：网络错误 / 超时 / HTTP 5xx 自动重试 3 次（指数退避 400ms→800ms→1600ms）。
  业务错误（errno、参数、风控）不重试，避免加重风控。
- **错误可读**：常见 errno 翻译成人话（如 `-6` → "BDUSS 很可能已过期，请重新填写"）。
- **冒烟测试**：

```bash
npm test          # node --test，覆盖集号解析、share 路径归一化、skill 注册契约
```

测的是"不依赖 DSH 运行时"的纯逻辑，能在任何机器上跑。

## 已知限制

- 网页端接口无官方文档，百度改版会失效；本仓库的协议细节均来自实测
- BDUSS 过期不会主动通知，只会在调用时报 `errno=-6`（错误信息已提示重新填写）
- 高频转存可能触发百度风控（验证码/限流）
- BDUSS 等价于账号级权限，请自行评估风险；建议定期更换
- `baidu_share_info` 对「单文件分享」或部分风控分享可能解析为空

## 协议要点（实测）

想自己复现的话，这几条是必须的：

1. `surl` 参数**不含**分享链接 `/s/` 后的前导 `1`
2. `/share/verify` 返回的 `randsk` 是 **URL 编码**的，需先 `decodeURIComponent`
3. 浏览分享目录时 `dir` 必须是 `/sharelink0-<分享根fsid>/<分享根目录名>[/<子目录>]`
   （分享根路径直接可从分享页的 `"path"` 字段取到；整季打包的源要多拼一层子目录）
4. `/share/list` 必须带**真实 `bdstoken`**（`/api/gettemplatevariable` 获取），传 `"null"` 返回 `errno 2`

## 许可

MIT
