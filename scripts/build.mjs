#!/usr/bin/env node
/**
 * github-memos 构建脚本
 *
 * 全量重建：拉取全部 issue → 过滤 → 排序 → 截断 → 产出静态 JSON / feed / 前端产物。
 *
 * 用法：
 *   node scripts/build.mjs                                  # 从 GitHub API 拉取（需要 GITHUB_TOKEN / GITHUB_REPOSITORY）
 *   node scripts/build.mjs --fixture test/fixtures/issues.json   # 从本地 fixture 读取，离线可用
 *
 * 失败即非零退出，且不触碰 dist/（先写 dist.tmp，全部成功后才原子替换）。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { marked } from 'marked';

// ---------------------------------------------------------------- 常量

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'config.yaml');
const SRC_DIR = path.join(ROOT, 'src');
const DEFAULT_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const PER_PAGE = 100;
const MAX_PAGES = 50;

// ---------------------------------------------------------------- 日志

const log = (...args) => console.log('[build]', ...args);
const warn = (...args) => console.warn('[warn]', ...args);

// ---------------------------------------------------------------- 文本工具

/**
 * 把 markdown 压成纯文本，用于摘要和标题 fallback。
 * 顺序很重要：先干掉代码块（里面可能有 # * 等），再处理行内标记。
 */
export function stripMarkdown(md) {
  let s = String(md ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ');
  s = s.replace(/`[^`\n]*`/g, ' ');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, '');
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
  s = s.replace(/(\*|_)(.*?)\1/g, '$2');
  s = s.replace(/~~(.*?)~~/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/^[ \t]*([-*_])[ \t]*\1[ \t]*\1[ \t]*$/gm, '');
  s = s.replace(/^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$/gm, '');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function truncateText(s, n) {
  const str = String(s ?? '');
  if (str.length <= n) return str;
  return str.slice(0, n).trimEnd() + '…';
}

export function escapeXml(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    "'": '&apos;',
    '"': '&quot;',
  })[c]);
}

function cdata(s) {
  return '<![CDATA[' + String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

function rfc822(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toUTCString();
}

// ---------------------------------------------------------------- issue 工具

function labelName(l) {
  return typeof l === 'string' ? l : (l?.name ?? '');
}

export function isPinned(issue, cfg) {
  const pinned = new Set(cfg?.memos?.pinned_labels ?? []);
  return (issue.labels ?? []).some((l) => pinned.has(labelName(l)));
}

/** 在 cfg.authors 里找 login 对应的覆盖项（GitHub login 大小写不敏感） */
function findAuthorOverride(login, cfg) {
  const authors = cfg?.authors;
  if (!authors || typeof authors !== 'object') return null;
  const target = String(login ?? '').toLowerCase();
  const key = Object.keys(authors).find((k) => k.toLowerCase() === target);
  return key ? authors[key] : null;
}

/**
 * 解析头像：完整 URL 原样返回；本地路径登记到 assets 待复制，返回产物内的相对路径。
 * 文件不存在时告警并回退到 GitHub 头像。
 */
function resolveAvatar(login, value, assets) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^(https?:|data:)/i.test(raw)) return raw;
  const src = path.resolve(ROOT, raw);
  if (!fs.existsSync(src)) {
    warn(`头像文件不存在：${raw}（author ${login}），回退到 GitHub 头像`);
    return '';
  }
  const ext = path.extname(src).toLowerCase() || '.png';
  const filename = `${String(login ?? 'ghost').replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`;
  const to = `avatars/${filename}`;
  if (assets) assets.set(src, to);
  return to;
}

function pickAuthor(user, cfg, assets) {
  const login = user?.login ?? 'ghost';
  const override = findAuthorOverride(login, cfg);
  const overrideName = String(override?.name ?? '').trim();
  const overrideAvatar = String(override?.avatar ?? '').trim();
  const avatarUrl = overrideAvatar ? resolveAvatar(login, overrideAvatar, assets) : (user?.avatar_url ?? '');
  return {
    login,
    name: overrideName || login, // 前端优先显示 name，没配就是 login
    avatar_url: avatarUrl,
    url: user?.html_url ?? '',
  };
}

function pickLabels(labels, cfg) {
  const pinned = new Set(cfg?.memos?.pinned_labels ?? []);
  return (labels ?? [])
    .map((l) => ({
      name: labelName(l),
      color: typeof l === 'string' ? '' : (l?.color ?? ''),
    }))
    .filter((l) => l.name && !pinned.has(l.name));
}

export function resolveTitle(issue, cfg) {
  const t = String(issue.title ?? '').trim();
  if (t) return t;
  if (cfg?.memos?.title_fallback === false) return '';
  const first = stripMarkdown(issue.body ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return truncateText(first ?? '', 80);
}

export function makeExcerpt(body) {
  return truncateText(stripMarkdown(body ?? '').replace(/\s+/g, ' ').trim(), 200);
}

// ---------------------------------------------------------------- 过滤 / 排序 / 截断

export function filterIssues(issues, cfg) {
  const assoc = new Set(cfg?.memos?.allowed_associations ?? DEFAULT_ASSOCIATIONS);
  const include = cfg?.memos?.include_labels ?? [];
  const exclude = cfg?.memos?.exclude_labels ?? [];
  const includeClosed = cfg?.memos?.include_closed ?? false;

  return (issues ?? []).filter((issue) => {
    if (issue.pull_request) return false;
    if (!includeClosed && issue.state === 'closed') return false;
    if (!assoc.has(issue.author_association)) return false;

    const names = (issue.labels ?? []).map(labelName);
    if (exclude.length > 0 && names.some((n) => exclude.includes(n))) return false;
    if (include.length > 0 && !names.some((n) => include.includes(n))) return false;
    return true;
  });
}

const SORTERS = {
  created_desc: (a, b) => new Date(b.created_at) - new Date(a.created_at),
  created_asc: (a, b) => new Date(a.created_at) - new Date(b.created_at),
  updated_desc: (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
};

/**
 * pinned 优先必须在构建侧完成 —— 否则 max_count 截断会把「老但置顶」的条目裁掉，
 * 前端再想置顶也没有机会。
 */
export function sortIssues(issues, cfg) {
  const cmp = SORTERS[cfg?.memos?.sort] ?? SORTERS.created_desc;
  return [...(issues ?? [])].sort((a, b) => {
    const pa = isPinned(a, cfg);
    const pb = isPinned(b, cfg);
    if (pa !== pb) return pa ? -1 : 1;
    return cmp(a, b);
  });
}

export function applyMaxCount(issues, maxCount) {
  if (!maxCount || maxCount <= 0) return issues;
  if (issues.length <= maxCount) return issues;
  const kept = issues.slice(0, maxCount);
  const droppedPinned = issues.slice(maxCount).filter((i) => i.pinned).length;
  if (droppedPinned > 0) {
    warn(`max_count=${maxCount} 截断了 ${droppedPinned} 条 pinned memo（pinned 数量超过 max_count）`);
  }
  return kept;
}

// ---------------------------------------------------------------- 产物构造（纯函数）

export function buildList(issues, cfg, assets) {
  const render = cfg?.memos?.render ?? { gfm: true, breaks: true };
  const memos = (issues ?? []).map((issue) => ({
    number: issue.number,
    title: resolveTitle(issue, cfg),
    excerpt: makeExcerpt(issue.body),
    author: pickAuthor(issue.user, cfg, assets),
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    labels: pickLabels(issue.labels, cfg),
    pinned: isPinned(issue, cfg),
    url: issue.html_url,
    state: issue.state,
  }));

  const out = {
    version: 1,
    generated_at: new Date().toISOString(),
    // 站点标题随数据下发，前端用它设置 document.title 和页头，保证 config 是唯一内容配置
    site: {
      title: cfg?.site?.title ?? 'Murmur',
    },
    render,
    memos,
  };

  if (cfg?.build?.group_by_date) {
    const index = {};
    for (const m of memos) {
      const key = String(m.created_at ?? '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(key)) continue;
      (index[key] ??= []).push(m.number);
    }
    out.index_by_date = index;
  }

  return out;
}

/**
 * 详情 JSON 刻意不放 generated_at —— 内容未变时字节一致，不进 git diff。
 */
export function buildDetails(issues, cfg, assets) {
  const render = cfg?.memos?.render ?? { gfm: true, breaks: true };
  const list = issues ?? [];
  return list.map((issue, i) => {
    const prev = i > 0 ? list[i - 1] : null;
    const next = i < list.length - 1 ? list[i + 1] : null;
    return {
      number: issue.number,
      title: resolveTitle(issue, cfg),
      content: issue.body ?? '',
      author: pickAuthor(issue.user, cfg, assets),
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      labels: pickLabels(issue.labels, cfg),
      pinned: isPinned(issue, cfg),
      url: issue.html_url,
      state: issue.state,
      render,
      prev: prev ? { number: prev.number, title: resolveTitle(prev, cfg) } : null,
      next: next ? { number: next.number, title: resolveTitle(next, cfg) } : null,
    };
  });
}

// ---------------------------------------------------------------- feed

function feedItems(issues, cfg) {
  const base = String(cfg?.site?.base_url ?? '').replace(/\/+$/, '');
  const full = cfg?.feed?.full_content === true;
  return (issues ?? []).map((issue) => {
    const title = resolveTitle(issue, cfg);
    const url = issue.html_url;
    const body = issue.body ?? '';
    const contentHtml = full
      ? marked.parse(body, { gfm: cfg?.memos?.render?.gfm !== false, breaks: cfg?.memos?.render?.breaks !== false })
      : null;
    return {
      id: String(issue.number),
      url,
      title,
      summary: makeExcerpt(body),
      contentHtml,
      published: issue.created_at,
      modified: issue.updated_at,
      author: issue.user?.login ?? '',
      link: base ? `${base}/#/memo/${issue.number}` : url,
    };
  });
}

export function buildRss(issues, cfg) {
  const site = cfg?.site ?? {};
  const items = feedItems(issues, cfg);
  // lastBuildDate 用最新一条的 updated_at，而不是构建时间 —— 否则每次构建都变，阅读器会误判更新
  const latest = items
    .map((i) => new Date(i.modified).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];

  const body = items
    .map((item) => {
      const desc = item.contentHtml != null ? cdata(item.contentHtml) : cdata(item.summary);
      return [
        '    <item>',
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(item.link)}</link>`,
        `      <guid isPermaLink="false">${escapeXml(item.id)}</guid>`,
        item.published ? `      <pubDate>${rfc822(item.published)}</pubDate>` : '',
        `      <description>${desc}</description>`,
        '    </item>',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    '  <channel>',
    `    <title>${escapeXml(site.title ?? 'Murmur')}</title>`,
    `    <link>${escapeXml(site.base_url ?? '')}</link>`,
    `    <description>${escapeXml(site.title ?? 'Murmur')}</description>`,
    '    <language>zh-CN</language>',
    latest ? `    <lastBuildDate>${rfc822(latest)}</lastBuildDate>` : '',
    body,
    '  </channel>',
    '</rss>',
    '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

export function buildJsonFeed(issues, cfg) {
  const site = cfg?.site ?? {};
  const base = String(site.base_url ?? '').replace(/\/+$/, '');
  const items = feedItems(issues, cfg).map((item) => ({
    id: item.id,
    url: item.link,
    title: item.title,
    content_html: item.contentHtml ?? undefined,
    content_text: item.contentHtml == null ? item.summary : undefined,
    date_published: item.published,
    date_modified: item.modified,
    authors: item.author ? [{ name: item.author }] : undefined,
  }));

  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: site.title ?? 'Murmur',
      home_page_url: base || undefined,
      feed_url: base ? `${base}/feed.json` : undefined,
      items,
    },
    null,
    2
  );
}

// ---------------------------------------------------------------- 拉取

export async function fetchAllIssues({ token, repo }) {
  if (!token) throw new Error('缺少 GITHUB_TOKEN');
  if (!repo) throw new Error('缺少 GITHUB_REPOSITORY');

  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://api.github.com/repos/${repo}/issues` +
      `?state=all&per_page=${PER_PAGE}&page=${page}&sort=created&direction=desc`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-memos-build',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 500)}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return all;
}

// ---------------------------------------------------------------- 输出

async function writeFileSafe(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, content, 'utf8');
}

async function copyIfExists(from, to) {
  if (!fs.existsSync(from)) return false;
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.copyFile(from, to);
  return true;
}

/** 复制模板并替换占位符（index.html 里的 {{SITE_TITLE}} 等） */
async function copyTemplate(from, to, replacements) {
  if (!fs.existsSync(from)) return false;
  let content = await fsp.readFile(from, 'utf8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.split(key).join(value);
  }
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.writeFile(to, content, 'utf8');
  return true;
}

/**
 * 前端不打包：app.js 以 ESM 原样发布，marked / dompurify 由 index.html 里的
 * importmap 指向本地 vendor 文件。这样产物自包含、不依赖 CDN，也不需要构建期
 * 启动子进程（某些受限环境里 spawn 会被拦）。
 */
const VENDOR_FILES = [
  ['node_modules/marked/lib/marked.esm.js', 'marked.esm.js'],
  ['node_modules/dompurify/dist/purify.es.mjs', 'purify.es.mjs'],
];

async function copyVendor(outDir) {
  const vendorDir = path.join(outDir, 'vendor');
  await fsp.mkdir(vendorDir, { recursive: true });
  for (const [from, to] of VENDOR_FILES) {
    const src = path.join(ROOT, from);
    if (!fs.existsSync(src)) {
      warn(`vendor 文件缺失，跳过：${from}（先跑 npm install）`);
      continue;
    }
    await fsp.copyFile(src, path.join(vendorDir, to));
  }
}

async function emit({ issues, cfg, outDir }) {
  const jsonPath = cfg?.build?.json_path ?? 'memos.json';
  const detailDir = cfg?.build?.detail_dir ?? 'memo';
  const assets = new Map(); // 本地资源：绝对源路径 -> 产物内相对路径（如 avatars/qiyao.png）

  // 列表
  const list = buildList(issues, cfg, assets);
  await writeFileSafe(path.join(outDir, jsonPath), JSON.stringify(list, null, 2));

  // 详情（每次全量重建，目录天然是干净的）
  const details = buildDetails(issues, cfg, assets);
  const detailRoot = path.join(outDir, detailDir);
  await fsp.mkdir(detailRoot, { recursive: true });
  for (const detail of details) {
    await writeFileSafe(path.join(detailRoot, `${detail.number}.json`), JSON.stringify(detail, null, 2));
  }

  // feed
  if (cfg?.feed?.enabled !== false) {
    const formats = cfg?.feed?.formats ?? ['rss', 'json'];
    if (formats.includes('rss')) {
      await writeFileSafe(path.join(outDir, 'feed.xml'), buildRss(issues, cfg));
    }
    if (formats.includes('json')) {
      await writeFileSafe(path.join(outDir, 'feed.json'), buildJsonFeed(issues, cfg));
    }
  }

  // 前端静态文件
  const siteTitle = cfg?.site?.title ?? 'Murmur';
  const copiedHtml = await copyTemplate(
    path.join(SRC_DIR, 'index.html'),
    path.join(outDir, 'index.html'),
    { '{{SITE_TITLE}}': escapeXml(siteTitle) }
  );
  const copiedCss = await copyIfExists(path.join(SRC_DIR, 'style.css'), path.join(outDir, 'style.css'));
  const copiedJs = await copyIfExists(path.join(SRC_DIR, 'app.js'), path.join(outDir, 'app.js'));
  if (!copiedHtml) warn('src/index.html 不存在');
  if (!copiedCss) warn('src/style.css 不存在');
  if (!copiedJs) warn('src/app.js 不存在');
  await copyIfExists(path.join(SRC_DIR, 'CNAME'), path.join(outDir, 'CNAME'));

  // 关掉 Jekyll，避免 Pages 处理耗时和 `_` 前缀文件被忽略
  await writeFileSafe(path.join(outDir, '.nojekyll'), '');

  // 作者自定义头像等本地资源
  for (const [from, to] of assets) {
    await copyIfExists(from, path.join(outDir, to));
  }

  await copyVendor(outDir);
}

// ---------------------------------------------------------------- main

async function main() {
  const args = process.argv.slice(2);
  const fixtureIdx = args.indexOf('--fixture');
  const fixturePath = fixtureIdx >= 0 ? args[fixtureIdx + 1] : null;

  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`找不到 ${CONFIG_PATH}`);
  const cfg = yaml.load(await fsp.readFile(CONFIG_PATH, 'utf8')) ?? {};
  if (!cfg.memos) cfg.memos = {};

  const raw = fixturePath
    ? JSON.parse(await fsp.readFile(path.resolve(fixturePath), 'utf8'))
    : await fetchAllIssues({
        token: process.env.GITHUB_TOKEN,
        repo: process.env.GITHUB_REPOSITORY,
      });

  log(`拉取 ${raw.length} 条 issue${fixturePath ? '（fixture）' : ''}`);

  const filtered = filterIssues(raw, cfg);
  const sorted = sortIssues(filtered, cfg);
  const final = applyMaxCount(
    sorted.map((i) => ({ ...i, pinned: isPinned(i, cfg) })),
    cfg.memos.max_count
  );

  log(`过滤后 ${filtered.length} 条，截断后 ${final.length} 条`);

  const outDir = path.resolve(ROOT, cfg?.build?.output_dir ?? 'dist');
  const tmpDir = `${outDir}.tmp`;

  // 先构建到临时目录，全部成功后才替换 —— 失败时 dist/ 保持上一次的完整快照
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await emit({ issues: final, cfg, outDir: tmpDir });

  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.rename(tmpDir, outDir);

  log(`完成：${final.length} 条 memo → ${outDir}`);
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  main().catch((err) => {
    console.error('[build] 失败：', err);
    process.exit(1);
  });
}
