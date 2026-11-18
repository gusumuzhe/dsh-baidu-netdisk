# 影视自动化：百度网盘 → NAS → 绿联影视

这套流程用于"用户说想看某部剧 → 自动补齐缺的集数 → 整理进媒体库"。

## 架构

```
pansou(搜索) → 百度网盘(转存到 /绿联下载) → 网盘工具(实时同步)
   → NAS /volume1/Downloads/BaiduNetDisk → 复制+改名 → /volume1/影视/动漫/<剧名> (年份)/
```

| 环节 | 由谁负责 |
|---|---|
| 搜索资源 | `pansou_search`（插件工具） |
| 解析分享、判重 | `baidu_share_info` + `baidu_list`（插件工具） |
| 转存 | `baidu_transfer`（插件工具，需在设置里开「允许转存」） |
| 网盘→NAS | 绿联「网盘工具」的同步任务（用户配置，实时同步） |
| 归位改名 | 本 skill 的脚本（NAS 文件 API） |
| 刮削 | 绿联影视（用户已开启「优先本地信息」） |

## 关键路径

| 用途 | 路径 |
|---|---|
| 网盘暂存 | `/绿联下载/<剧名>/` |
| NAS 暂存 | `/volume1/Downloads/BaiduNetDisk/<剧名>/` |
| 媒体库 | `/volume1/影视/动漫/<剧名> (年份)/` |
| 电影库 | `/volume1/影视/电影/<片名> (年份)/` |

## 标准补集流程

1. **先用 TMDB 定基准**：`node scripts/tmdb_season.mjs <tmdbId> <season>` 拿到"已播出集数"
   （不要用"源里有多少集"当基准——源本身可能缺集）
1b. **再算缺口**：TMDB 已播出 − 本地已有 = 真正要补的集
1c. **多源评分选源**：`baidu_rank_sources(keyword, needEpisodes="1-29,52")`
   —— 不要直接取第一条。评分含覆盖度、每集体积（码率代理）、4K/HDR 比例；
   **标题写"4K HQ"不代表高码率**，实测有源标称 4K 但每集只有 1GB
2. `baidu_share_info(shareUrl, pwd, subdir?)` — 返回 files[]（name/size/fsId）；
   若源是"整季打包"，先不传 subdir 看返回的 `subdirs`，再带上子目录名重查
3. `baidu_list("/绿联下载/<剧名>")` 和 NAS `ls` 媒体库 — 确认已有哪些集
4. `baidu_transfer(shareUrl, pwd, episodes="150,152-167", subdir="<剧名>", shareSubdir="<源内子目录>")`
   - 只传缺的 fs_id，内部还会检查目标目录已存在的集
5. 等同步完成——**不要靠人盯**：把 `wait_sync.mjs` 挂成后台任务（`run_in_background`），
   它每 60 秒轮询一次，全部就绪后退出并触发 DSH 的完成通知，届时再归位。
6. 跑 `copy_in.mjs` 复制并改名进媒体库

## 命名规范（已固化）

```
<剧名> (<首播年份>)/
    <剧名> S<SS>E<EEE>[ [2160p|1080p]].<ext>
```
- 多季剧加 `Season NN/` 子目录
- 单季剧不加 Season 目录
- 剧名用中文，画质标签用方括号
- 每部剧根目录放 `tvshow.nfo`（`<uniqueid type="tmdb">`）钉住 TMDB 条目

## 已知坑（都是实测踩过的）

1. **NAS 的"移动"其实是复制** —— `CpMovePath` 跨目录/跨共享都不删源。批量搬 20GB 会慢到 1GB/分钟且产生双份。
   → 对策：能"原地改名"就原地改名；目录合并用**目录级 rename**。
2. **NAS 文件写入只能覆盖，不能新建** —— `WriteFile` 对不存在的文件报 `1302 Path does not exist`。
   → 对策：用 `CreateFile`（可带 content，见 `scripts/create_file.mjs`）。
3. **百度分享页 `surl` 不带前导 `1`** —— 链接是 `/s/1abc`，API 参数要 `abc`。
4. **`randsk` 是 URL 编码的** —— 必须先 `decodeURIComponent`，否则二次编码导致 `errno -9`。
5. **分享 `dir` 的完整格式**：`/sharelink0-<分享根fsid>/<分享根目录名>[/<子目录>]`
   - 前缀 `sharelink0-` 实测通用（`sharelink<uk>-` 也行，但 uk 段来源不稳定）
   - 分享根路径直接写在分享页的 `"path"` 字段里，解析它最稳
   - **整季打包的源**（如 `神墓 (2022)/第 3 季 - .../`）必须再拼一层子目录；
     `baidu_share_info` 会返回 `subdirs` 列表，把它填进 `shareSubdir` 即可
6. **`/share/list` 必须带真实 `bdstoken`**（`/api/gettemplatevariable` 获取），传 `"null"` 不行。
7. **百度官方「分享转存」是付费企业接口** —— 个人只能走网页端 `/share/transfer`（cookie 鉴权）。
8. **同名剧容易撞名** —— 《斗破苍穹》有真人版/动态漫画/Q版等多个 TMDB 条目，必须靠 `tvshow.nfo` 钉 id。
9. **绿联影视需开「优先本地信息」**，NFO 才生效；多季剧（如斗破苍穹）只靠 tvshow.nfo 可能仍拆分成两个合集。
10. **删除操作必须显式确认** —— 曾经因为一个把路径写死的 `delete.mjs`，误删了整部剧（37 集）。
    → 铁律：**不要保留写死路径的删除脚本**；任何删除前必须打印目标路径并要求 `--confirm`；
      回收站若无权访问（`#recycle` 会报 Insufficient permissions），只能由用户在 NAS 界面恢复。
11. **文件被占用时 `CpMovePath` 会失败**（`Insufficient permissions` / `context deadline exceeded`），
    但 `Rename` 仍然可用——先改名保证刮削正确，目录合并等锁释放后再做。
12. **`/app` 不是持久卷** —— 放在 `/app` 的东西容器重建可能丢；持久位置是 `/root/.dsh`。

## 脚本（在本 skill 的 scripts/ 下）

所有脚本都从 `/root/.dsh/profiles/web/cordis.patch.yml` 读 NAS endpoint/token，从
`/root/.dsh/profiles/web/node_modules/dsh-ugreen-nas/lib/protobuf.js` 取 protobuf 编解码。

| 脚本 | 用途 |
|---|---|
| `ls.mjs <目录>` | 列出 NAS 目录（含隐藏项，比 `ugreen_file_list` 可靠） |
| `scan.mjs` | 深度扫描媒体库，统计每部剧的集数 |
| `normalize.mjs [--apply]` | 批量归一化命名（改写 `SHOWS` 数组里的剧） |
| `copy_in.mjs --src <暂存> --dst <媒体> --show <剧名> --year <年> [--season 1]` | 把下载完成的集复制进媒体库并改名 |
| `write_nfos.mjs` | 给多部剧批量写 `tvshow.nfo`（改脚本里的 `SHOWS`） |
| `create_file.mjs <路径> [内容]` | 用 CreateFile 新建文件（可带内容） |
| `wait_sync.mjs --dir <目录> (--from <起> --to <止> \| --episodes "201,208-219")` | **轮询等待同步完成**（支持非连续集号；后台跑，完成即触发通知） |

## 媒体库现状：现查，不要缓存

媒体库随时在变（补集、改名、去重），**不要把集数或"待补"状态写进文档**——过期数据比没有更危险。

需要现状时现场跑：

```bash
node scripts/scan.mjs                                     # 每部剧现有多少集
node scripts/ls.mjs "/volume1/影视/动漫/<剧名> (年份)"      # 某部剧的具体集号
```

判缺集时，用"源里的集号集合"减"本地集号集合"，不要依赖任何记忆或文档。

## 改代码后必做

```bash
cd <插件目录>
npm test          # 冒烟测试：集号解析 / share 路径归一化 / skill 注册契约
```

DSH 的加载期错误（例如 skill 的 `rank` 字段缺失）**语法检查发现不了**，只有跑测试或真正加载才会暴露。

## 新会话如何接手

1. 加载本 skill，读一遍"已知坑"
2. `node scripts/scan.mjs` 看媒体库现状（不要凭记忆）
3. 问用户要补哪部 / 整理什么
4. 按"标准补集流程"执行；写操作前先给出计划让用户确认

不要假设上一个会话做到哪一步——一切以磁盘现状为准。

## TMDB 参考 ID（稳定，可直接用）

仙逆 223911 · 沧元图 229192 · 择天记 282158（2026 3D 版，26 集） · 光阴之外 281233 ·
深空彼岸 283119 · 神墓 206343 · 斗破苍穹 79481（年番=第5季，共 219 集） · 星辰变 83708 · 永生 156571

> 撞名风险：《斗破苍穹》还有真人版(81500)、动态漫画(206080)、Q版(321795)；
> 《择天记》有 2017 真人(71419)、2015 动画(104697)。写 `tvshow.nfo` 时必须核对 ID。
