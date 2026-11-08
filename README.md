# Murmur

> 低语、轻声说的话。复数 murmurs，就是私语。

用 GitHub Issue 当数据源的说说站。开一个带 memo label 的 issue，就是一条说说。编辑、关闭、删除 issue，站点自动跟着变。没有数据库，没有后端，产物是纯静态文件，托管在 GitHub Pages。

## 它长什么样

- 列表页：所有说说按时间倒序，支持按标签和月份筛选，筛选状态写在 URL 里，可以直接分享
- 详情页：完整正文（markdown 渲染）、作者、标签、上一条/下一条、跳转 GitHub
- 图片点击放大（`<dialog>` + top layer，不受父级样式限制）
- RSS / JSON Feed 订阅

## 怎么用

1. 在仓库里开一个 issue，打上 `memo` label（label 名由 `config.yaml` 的 `include_labels` 决定，留空表示所有 issue 都算）
2. 等一两分钟，workflow 跑完，Pages 自动更新
3. 想置顶？给它打 `置顶` label
4. 想隐藏？关闭 issue（`include_closed: false` 时关闭即消失）
5. 想改显示昵称和头像？改 `config.yaml` 的 `authors` 段（见下）

## 目录结构

```
.github/workflows/build.yml   # 触发 + 构建 + 推 pages 分支
config.yaml                   # 唯一内容配置
package.json
scripts/build.mjs             # 数据构建脚本
scripts/serve.mjs             # 本地预览服务器（零依赖）
src/                          # 前端源码
├── index.html
├── style.css
└── app.js
assets/                       # 自定义资源（可选，构建时复制进产物）
└── avatars/                  # 作者头像
test/                         # 纯函数单测 + 本地 fixture
dist/                         # 构建产物（gitignore，只存在于 pages 分支）
```

## 本地开发

```bash
npm install
npm test                      # 纯函数单测，不联网
npm run build:fixture         # 用 test/fixtures/issues.json 离线构建到 dist/
npm run serve                 # 起本地服务器，打开 http://127.0.0.1:4173/
```

真实构建需要 GitHub token：

```bash
GITHUB_TOKEN=xxx GITHUB_REPOSITORY=owner/repo npm run build
```

## 部署（一次性设置）

1. 第一次跑 workflow（`Actions → build → Run workflow`），它会创建 `pages` 分支
2. `Settings → Pages → Source: Deploy from a branch → pages / (root)`
3. 改 `config.yaml` 里的 `site.base_url` 为你的实际地址（feed 的绝对链接要用）
4. 有自定义域名的话，把 `CNAME` 放进 `src/`，构建时会复制到产物里

## config.yaml 速查

| 字段 | 作用 |
|---|---|
| `site.title` | 站点标题（注入 `index.html`，并随 `memos.json` 下发） |
| `site.base_url` | feed 绝对链接的基址，末尾不带斜杠 |
| `memos.include_labels` | 至少命中一个才收录；**空数组 = 不限** |
| `memos.exclude_labels` | 命中任意一个即排除 |
| `memos.pinned_labels` | 命中则置顶，且不出现在展示标签里 |
| `memos.allowed_associations` | 精确白名单（workflow 只做粗筛） |
| `memos.max_count` | 排序后截断，0 = 不限；pinned 优先保留 |
| `memos.include_closed` | false = 关闭即隐藏 |
| `memos.sort` | `created_desc` / `created_asc` / `updated_desc` |
| `memos.title_fallback` | 标题为空时取正文首个非空行 |
| `memos.render` | 下发给前端的 marked 配置 |
| `build.group_by_date` | 是否产出 `index_by_date` 月份索引（当前前端未用，月份从 `memos[]` 现推） |
| `feed.full_content` | true = 全文 HTML，false = 摘要 + 链接 |
| `lightbox.enabled` | 图片放大开关 |
| `authors.<login>.name` | 显示昵称，覆盖 GitHub login（key 大小写不敏感） |
| `authors.<login>.avatar` | 自定义头像：完整 URL，或仓库内路径如 `assets/avatars/qiyao.svg`（构建时复制到 `dist/avatars/`） |
| `custom.remote_css` | 远程样式表 URL，直接 `<link>` 引入（中文网字计划 / Google Fonts 这类 unicode-range 分片方案） |
| `custom.css` | 本地 CSS 文件，复制进产物 `custom/`，排在 `style.css` 之后 |
| `custom.fonts` | 本地字体文件，复制进产物 `fonts/`，自动生成 `@font-face` |
| `custom.font_family` | 覆盖正文字体族（`--font-body`） |

`authors` 只影响展示，不影响 `login` 字段本身——`login` 保留原值，方便以后做逻辑判断。没配置的作者完全回退到 GitHub 原值。

```yaml
authors:
  qiyao:
    name: "绮曜"
    avatar: "assets/avatars/qiyao.svg"
```

## 自定义样式与字体

`custom` 段有三种引入方式，按这个顺序进页面：

```
style.css → custom.remote_css → fonts/fonts.css（本地字体）→ custom/*.css
```

越靠后优先级越高，所以**自定义 CSS 永远能覆盖一切**。

### 远程字体 CSS（推荐，中文站首选）

中文网字计划、Google Fonts 这类方案是「CSS + `unicode-range` 分片」，浏览器只下载当前页面用到的字形分片，比整包字体小一个数量级：

```yaml
custom:
  remote_css:
    - "https://cdn.xrbk.cn/fonts/LXGWWenKaiGB-Regular/result.css"
  font_family: "LXGW WenKai GB"
```

`remote_css` 只接受 `http(s)://` URL，不会复制进产物。字体 CSS 里已经自带 `@font-face`，`font_family` 负责把它设成正文。

### 本地字体文件

字体文件放仓库，构建时复制进 `dist/fonts/` 并自动生成 `@font-face`：

```yaml
custom:
  fonts:
    - family: "My Font"
      src: "assets/fonts/MyFont-Regular.woff2"
      weight: 400
      style: normal
  font_family: "My Font"
```

支持 `.woff2` / `.woff` / `.ttf` / `.otf` / `.eot`，`format()` 会自动对上。

### 自定义 CSS

```yaml
custom:
  css:
    - "assets/custom.css"
```

文件会被复制到 `dist/custom/`。**注意**：CSS 里的相对 `url()` 会相对 `dist/custom/` 解析，图片要么用绝对 URL，要么也放进 `assets/` 并自己算好相对路径。

`style.css` 的字体栈已经抽成 `--font-body` / `--font-mono` 两个 CSS 变量，自定义 CSS 直接改变量就行：

```css
:root {
  --font-body: "My Font", system-ui, sans-serif;
  --accent: #d946ef;
}
```

## 设计上的几个决定

**全量重建，不做增量。** issue 数量是个人量级，全量最简单也最不容易错。删除的 issue 在 API 结果里自然消失。

**详情 JSON 不放 `generated_at`。** 否则每次构建所有详情文件都变，git 里几百个假 diff。去掉之后，内容没变的文件字节一致，不进 diff。

**pinned 优先在构建侧排序。** 如果放到前端，`max_count` 截断会先把「老但置顶」的条目裁掉，前端再想置顶也没机会。

**产物先写 `dist.tmp`，成功后才替换 `dist/`。** 构建中途失败时，`dist/` 保持上一次的完整快照，不会推一个残缺站点。

**workflow 只做粗筛（`author_association != 'NONE'`），精确白名单只在 config。** 两处硬编码同一个白名单，迟早不一致；而「workflow 拦了但 config 允许」会导致数据静默过期，没人发现。粗筛不追求精确，只要不误杀。

**推 `pages` 分支，不推 `main`。** `main` 保持干净，只有源码；产物是派生的，不进版本历史。

**前端不打包。** `app.js` 以 ESM 原样发布，`marked` / `dompurify` 由 `index.html` 的 importmap 指向 `dist/vendor/` 下的本地副本。产物自包含、零 CDN，也不需要构建期启动子进程。

## 已知限制

- 正文里的 `#tag` 不解析，标签只从 label 取（正则容易误伤代码块和标题）
- 图片不镜像，国内直连 GitHub 图床可能慢
- 列表一次性渲染全部条目，适合几百条以内
- 外部投稿需要先加成 collaborator（或者改 `allowed_associations`）
- 详情页翻页用 `location.hash`，会产生历史记录；「返回列表」按钮直接改 hash，不走 `history.back()`，所以不会退到上一条

## 测试

`npm test` 只跑纯函数单测，不联网、不碰文件系统。覆盖的是「错了不会报错、只会静默产出错误数据」的那几处：pinned 截断、过滤规则、标题 fallback、摘要截断、详情 JSON 结构。

注意：在部分受限环境里 `node --test test/` 会因 spawn 被拦而失败，可以直接 `node test/build.test.mjs`（同进程运行，不 spawn）。
