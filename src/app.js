/* =============================================================================
 * GitHub Issue 备忘录 · 纯静态前端（原生 ESM，无框架、无打包）
 * 数据源（CI 生成，全相对路径，支持子路径部署）：memos.json / memo/{number}.json
 * 路由（hash 内带 query，Pages 零配置）：
 *   #/   #/?tag=生活&month=2026-11   #/memo/12   #/memo/12?tag=生活
 * 运行时依赖 marked / dompurify，由 index.html 的 importmap 映射到 ./vendor/。
 * ========================================================================== */

import { marked } from 'marked';
import DOMPurify from 'dompurify';

const LIST_URL = 'memos.json';
const memoUrl = (number) => `memo/${number}.json`;
const FETCH_OPTIONS = { cache: 'no-cache' }; // 走 ETag 条件请求，304 零成本
const SKELETON_CARDS = 6;
const EMPTY_TITLE = '(无标题)';
const SITE_TITLE = 'Murmur'; // 兜底值；实际标题由构建侧注入 index.html 的 meta 并随 memos.json 下发
const META_SITE_TITLE = (document.querySelector('meta[name="site-title"]') || {}).content || '';

/* ------------------------------- 状态 ------------------------------- */
/* 只保存 DOM 缓存与请求令牌；筛选和路由的唯一真相仍然是 location.hash。 */
const state = {
  listData: null, // memos.json 原始对象
  memos: [], // memos[]（构建侧已排好序，前端不再排序）
  memoByNumber: new Map(),
  lightboxEnabled: true, // 构建侧未下发 lightbox 时默认启用
  siteTitle: META_SITE_TITLE || SITE_TITLE, // 构建时注入 index.html；memos.json 的 site.title 可再覆盖
  listView: null, // 列表视图根节点（只构建一次，筛选只切 hidden）
  listEl: null, filterBarEl: null, emptyEl: null, emptyTextEl: null, emptyClearBtn: null,
  cardEls: new Map(), // number -> 卡片元素
  view: 'none', // 'none' | 'list' | 'detail'
  pendingScrollY: null, // 从列表进详情时记下的滚动位置
  navToken: 0, // 路由令牌，用于丢弃过期请求的结果
};

/* ------------------------------ 工具函数 ------------------------------ */

/** 极简 hyperscript：h('div', { class: 'x', text: 'y' }, child...) */
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key === 'style' && typeof value === 'object') {
        for (const [prop, val] of Object.entries(value)) {
          // CSS 自定义属性必须走 setProperty，不能当普通属性赋值
          if (prop.startsWith('--')) node.style.setProperty(prop, val);
          else node.style[prop] = val;
        }
      }
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * 内联 SVG 图标：引用 index.html 里构建时注入的 sprite（来源 lucide-static）。
 * 用 <use> 而不是 <img>，stroke="currentColor" 才能继承文字颜色。
 */
function icon(name, className) {
  const wrap = h('span', { class: `icon${className ? ` ${className}` : ''}`, 'aria-hidden': 'true' });
  wrap.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round"><use href="#icon-${name}"></use></svg>`;
  return wrap;
}

/** 转义 HTML（标题不走 markdown，插入前必须转义） */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 取 ISO 时间串的 YYYY-MM-DD。直接切字符串，与构建侧 index_by_date 的 UTC 口径一致。 */
function isoDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function isoMonth(iso) {
  return isoDate(iso).slice(0, 7);
}

/** label.color -> '#rrggbb'（兼容 3 位、8 位、带 # 的写法） */
function normalizeHex(color) {
  let value = String(color || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) value = value.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{8}$/i.test(value)) value = value.slice(0, 6);
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : '';
}

/* ------------------------------ 筛选与路由 ------------------------------ */

function matchFilter(memo, filter) {
  if (!memo) return false;
  if (filter.tag) {
    const labels = Array.isArray(memo.labels) ? memo.labels : [];
    if (!labels.some((label) => label && label.name === filter.tag)) return false;
  }
  if (filter.month && isoMonth(memo.created_at) !== filter.month) return false;
  return true;
}

function hasFilter(filter) {
  return Boolean(filter && (filter.tag || filter.month));
}

function buildFilterQuery(filter) {
  const parts = [];
  if (filter.tag) parts.push(`tag=${encodeURIComponent(filter.tag)}`);
  if (filter.month) parts.push(`month=${encodeURIComponent(filter.month)}`);
  return parts.join('&');
}

function listHash(filter) {
  const query = buildFilterQuery(filter || {});
  return query ? `#/?${query}` : '#/';
}

function memoHash(number, filter) {
  const query = buildFilterQuery(filter || {});
  return query ? `#/memo/${number}?${query}` : `#/memo/${number}`;
}

/** 解析 location.hash：#/memo/12?tag=生活 -> { view, number, filter } */
function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const queryIndex = raw.indexOf('?');
  const path = queryIndex === -1 ? raw : raw.slice(0, queryIndex);
  // URLSearchParams 负责解码中文与 %XX
  const params = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
  const filter = { tag: (params.get('tag') || '').trim(), month: (params.get('month') || '').trim() };
  const memoMatch = /^\/memo\/(\d+)\/?$/.exec(path);
  return memoMatch ? { view: 'memo', number: Number(memoMatch[1]), filter } : { view: 'list', number: null, filter };
}

/** 筛选用 replaceState：不产生历史记录 */
function replaceHash(hash) {
  try {
    history.replaceState(history.state, '', hash);
  } catch {
    location.hash = hash; // 极端环境兜底
  }
}

/** 改筛选：先改 URL，再手动驱动一次渲染（replaceState 不触发 hashchange） */
function setFilter(filter) {
  replaceHash(listHash({ tag: filter.tag || '', month: filter.month || '' }));
  route();
}

/* ------------------------------- 数据层 ------------------------------- */

const fetchCache = new Map(); // url -> Promise，成功常驻，失败自动清除

function fetchJSON(url) {
  if (fetchCache.has(url)) return fetchCache.get(url);
  const task = (async () => {
    const response = await fetch(url, FETCH_OPTIONS);
    if (!response.ok) {
      const message = response.status === 404 ? '资源不存在（404）' : `请求失败（HTTP ${response.status}）`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return response.json();
  })();
  task.catch(() => fetchCache.delete(url)); // 失败不缓存，方便重试
  fetchCache.set(url, task);
  return task;
}

function clearCache() {
  fetchCache.clear();
  Object.assign(state, {
    listData: null, memos: [], memoByNumber: new Map(), listView: null, listEl: null,
    filterBarEl: null, emptyEl: null, cardEls: new Map(), view: 'none',
  });
}

async function loadList() {
  if (state.listData) return state.listData;
  const data = (await fetchJSON(LIST_URL)) || {};
  state.listData = data;
  state.memos = Array.isArray(data.memos) ? data.memos : [];
  state.memoByNumber = new Map(state.memos.filter((m) => m && m.number != null).map((m) => [m.number, m]));
  state.lightboxEnabled = data.lightbox !== false; // 构建侧不一定会下发开关，只有显式 false 才关闭
  state.siteTitle = (data.site && data.site.title) || SITE_TITLE;
  applySiteTitle();
  return state.listData;
}

/** 站点标题由构建侧下发，保证 config.yaml 是唯一内容配置 */
function applySiteTitle() {
  const title = state.siteTitle || SITE_TITLE;
  document.title = title;
  const brand = document.querySelector('.brand span');
  if (brand) brand.textContent = title;
}

function loadMemo(number) {
  return fetchJSON(memoUrl(number));
}

/* ------------------------------ 渲染：通用件 ------------------------------ */

function avatarImg(author, className) {
  const img = h('img', {
    class: `avatar ${className}`, src: (author && author.avatar_url) || '', alt: '',
    loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
  });
  img.addEventListener('error', () => img.classList.add('is-broken'));
  return img;
}

function authorLink(author, avatarClass) {
  // 显示名优先用构建侧下发的 name（config.yaml 的 authors 覆盖），没配就是 GitHub login
  const display = String((author && (author.name || author.login)) || '');
  const avatar = avatarImg(author, avatarClass);
  if (display) avatar.alt = display;
  const inner = [avatar, h('span', { class: 'author-login', text: display })];
  const url = String((author && author.url) || '');
  if (!url) return h('span', { class: 'author' }, ...inner);
  return h('a', { class: 'author', href: url, target: '_blank', rel: 'noopener noreferrer' }, ...inner);
}

/**
 * 标签 chips。interactive=false 用于列表卡片（纯展示，避免和整卡点击链接打架）；
 * interactive=true 用于详情页（点标签直接筛这个 tag）。
 */
function buildLabelChips(labels, filter, interactive) {
  const list = (Array.isArray(labels) ? labels : []).filter((label) => label && label.name);
  if (!list.length) return null;
  const wrap = h('div', { class: 'chips' });
  for (const label of list) {
    const name = String(label.name);
    const background = normalizeHex(label.color);
    // 只下发颜色变量，浅底/彩字由 CSS 的 color-mix 派生，深色模式自动跟着走
    const style = background ? { '--label-color': background } : {};
    const className = `chip chip-label${background ? ' is-colored' : ''}`;
    wrap.append(
      interactive
        ? h('a', { class: className, href: listHash({ tag: name, month: filter.month }), style, text: name })
        : h('span', { class: className, style, text: name }),
    );
  }
  return wrap;
}

function chipButton(label, active, onClick, count) {
  const button = h('button', {
    class: `chip${active ? ' is-active' : ''}`, type: 'button',
    'aria-pressed': active ? 'true' : 'false', text: label, onClick,
  });
  if (count != null) button.append(h('span', { class: 'chip-count', text: String(count) }));
  return button;
}

/** 一行筛选 chips：全部 + 若干选项（items 形如 { label, count? }） */
function chipRow(labelText, allActive, onAll, items, isActive, onPick, kind) {
  return h('div', { class: `filter-row${kind ? ` filter-row-${kind}` : ''}` },
    h('span', { class: 'filter-row-label', text: labelText }),
    h('div', { class: 'chips' },
      chipButton('全部', allActive, onAll),
      items.map((item) => chipButton(item.label, isActive(item), () => onPick(item), item.count))));
}

/* ------------------------------ 渲染：骨架 ------------------------------ */

function buildSkeletonCard() {
  return h('article', { class: 'card card-skeleton', 'aria-hidden': 'true' },
    h('div', { class: 'sk sk-title' }), h('div', { class: 'sk sk-meta' }),
    h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line short' }));
}

function buildListSkeleton() {
  const list = h('div', { class: 'memo-list' });
  for (let i = 0; i < SKELETON_CARDS; i += 1) list.append(buildSkeletonCard());
  const bar = h('div', { class: 'filter-bar' },
    h('div', { class: 'filter-row' }, h('div', { class: 'chips' }, h('div', { class: 'sk sk-chip' }))));
  return h('section', { class: 'list-view', 'aria-busy': 'true' }, bar, list);
}

function buildDetailSkeleton() {
  return h('article', { class: 'memo-detail', 'aria-busy': 'true' },
    h('div', { class: 'sk sk-back' }), h('div', { class: 'sk sk-h1' }), h('div', { class: 'sk sk-meta' }),
    h('div', { class: 'sk sk-block' }), h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line short' }));
}

/* ------------------------------ 渲染：列表 ------------------------------ */

function buildCard(memo) {
  const number = memo.number;
  const card = h('article', { class: `card${memo.pinned ? ' is-pinned' : ''}`, dataset: { number: String(number) } });
  const head = h('div', { class: 'card-head' },
    h('a', { class: 'card-title', href: memoHash(number, {}), text: String(memo.title || '').trim() || EMPTY_TITLE }));
  card.append(head);
  // 置顶角标固定在卡片右上角，比标题旁的小图标更显眼
  if (memo.pinned) {
    card.append(h('span', { class: 'pin-flag', title: '置顶' }, icon('pin'), h('span', { text: '置顶' })));
  }
  const meta = h('div', { class: 'card-meta' },
    h('time', { datetime: memo.created_at || '', text: isoDate(memo.created_at) }));
  if (memo.author && memo.author.login) {
    meta.append(h('span', { class: 'meta-sep', text: '·' }), authorLink(memo.author, 'avatar-sm'));
  }
  card.append(meta);
  const chips = buildLabelChips(memo.labels, { tag: '', month: '' }, false);
  if (chips) card.append(chips);
  const excerpt = String(memo.excerpt || '').trim();
  if (excerpt) card.append(h('p', { class: 'card-excerpt', text: excerpt }));
  return card;
}

function collectTags() {
  const map = new Map();
  for (const memo of state.memos) {
    for (const label of Array.isArray(memo.labels) ? memo.labels : []) {
      const name = label && typeof label.name === 'string' ? label.name : '';
      if (!name) continue;
      const item = map.get(name) || { label: name, count: 0 };
      item.count += 1;
      map.set(name, item);
    }
  }
  return [...map.values()];
}

function collectMonths() {
  const months = new Set();
  for (const memo of state.memos) {
    const month = isoMonth(memo.created_at);
    if (month) months.add(month);
  }
  return [...months].sort().reverse(); // 新的在前
}

function buildListView() {
  state.filterBarEl = h('div', { class: 'filter-bar' });
  state.listEl = h('div', { class: 'memo-list' });
  state.emptyTextEl = h('p', { class: 'empty-text', text: '没有匹配的说说' });
  state.emptyClearBtn = h('button', {
    class: 'btn', type: 'button', text: '清除筛选', onClick: () => setFilter({ tag: '', month: '' }),
  });
  state.emptyEl = h('div', { class: 'empty', hidden: true },
    h('div', { class: 'empty-icon' }, icon('leaf')), state.emptyTextEl, state.emptyClearBtn);

  state.cardEls = new Map();
  for (const memo of state.memos) {
    if (!memo || memo.number == null) continue;
    const card = buildCard(memo);
    state.cardEls.set(memo.number, card);
    state.listEl.append(card);
  }

  // 普通左键点标题走 location.hash（产生历史记录，浏览器返回能回列表）；
  // 中键 / 组合键保留浏览器默认行为（新标签页打开）。
  state.listEl.addEventListener('click', (event) => {
    const link = event.target.closest ? event.target.closest('a.card-title') : null;
    if (!link || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    location.hash = link.getAttribute('href');
  });

  state.listView = h('section', { class: 'list-view' }, state.filterBarEl, state.listEl, state.emptyEl);
  return state.listView;
}

function renderFilterBar(filter) {
  const bar = state.filterBarEl;
  if (!bar) return;
  const children = [
    chipRow('标签', !filter.tag, () => setFilter({ ...filter, tag: '' }), collectTags(),
      (tag) => filter.tag === tag.label,
      (tag) => setFilter({ ...filter, tag: filter.tag === tag.label ? '' : tag.label }), 'tag'),
  ];

  const months = collectMonths();
  if (months.length) {
    children.push(chipRow('月份', !filter.month, () => setFilter({ ...filter, month: '' }),
      months.map((month) => ({ label: month })),
      (item) => filter.month === item.label,
      (item) => setFilter({ ...filter, month: filter.month === item.label ? '' : item.label }), 'month'));
  }

  // 筛选栏与详情页共用同一个「当前筛选 + 清除」组件
  if (hasFilter(filter)) children.push(buildFilterNote(filter));
  bar.replaceChildren(...children);
}

/** 筛选只切 hidden，不重建 DOM，滚动位置自然保留 */
function applyFilterToList(filter) {
  if (!state.listView) return;
  let visible = 0;
  for (const [number, card] of state.cardEls) {
    const ok = matchFilter(state.memoByNumber.get(number), filter);
    card.hidden = !ok;
    if (!ok) continue;
    visible += 1;
    const link = card.querySelector('a.card-title');
    if (link) link.setAttribute('href', memoHash(number, filter));
  }
  state.listEl.hidden = visible === 0;
  state.emptyEl.hidden = visible > 0;
  state.emptyTextEl.textContent = state.memos.length === 0 ? '还没有任何说说' : '没有匹配的说说';
  state.emptyClearBtn.hidden = !hasFilter(filter);
  renderFilterBar(filter);
  updateSiteSub();
}

function updateSiteSub() {
  const sub = document.getElementById('site-sub');
  if (!sub || !state.listData) return;
  const generated = isoDate(state.listData.generated_at);
  const total = state.memos.length;
  sub.textContent = generated ? `共 ${total} 条 · 更新于 ${generated}` : `共 ${total} 条`;
}

/* ------------------------------ 渲染：详情 ------------------------------ */

function renderMarkdown(markdown, renderConfig) {
  const gfm = !renderConfig || renderConfig.gfm !== false;
  const breaks = !renderConfig || renderConfig.breaks !== false;
  try {
    return DOMPurify.sanitize(marked.parse(String(markdown || ''), { gfm, breaks, async: false }));
  } catch (error) {
    console.error('[memo] markdown 渲染失败', error);
    return '<p class="render-error">正文渲染失败</p>';
  }
}

function decorateBody(body) {
  body.querySelectorAll('a[href]').forEach((link) => {
    if (/^https?:/i.test(link.getAttribute('href') || '')) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
  });
  body.querySelectorAll('img').forEach((img) => {
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    if (!img.getAttribute('alt')) img.setAttribute('alt', '');
  });
  // 宽表格包一层滚动容器（table 自身保持表格布局）
  body.querySelectorAll('table').forEach((table) => {
    if (table.parentElement && table.parentElement.classList.contains('table-wrap')) return;
    const wrap = h('div', { class: 'table-wrap' });
    table.replaceWith(wrap);
    wrap.append(table);
  });
}

function buildFilterNote(filter) {
  const parts = [];
  if (filter.tag) parts.push(`标签「${filter.tag}」`);
  if (filter.month) parts.push(`月份 ${filter.month}`);
  return h('p', { class: 'filter-note' },
    h('span', { text: `当前筛选：${parts.join(' · ')}` }),
    h('button', { class: 'link-btn', type: 'button', text: '清除筛选', onClick: () => setFilter({ tag: '', month: '' }) }));
}

function buildPager(nav, filter) {
  if (!nav) return null;
  if (nav.outsideFilter) return h('p', { class: 'pager-note', text: '当前说说不在此筛选结果内，翻页已隐藏。' });

  const side = (item, isPrev) => {
    const label = isPrev ? '上一条' : '下一条';
    const className = `pager-link ${isPrev ? 'pager-prev' : 'pager-next'}`;
    const labelEl = h('span', { class: 'pager-label' },
      icon(isPrev ? 'arrow-left' : 'arrow-right'), h('span', { text: label }));
    if (!item) {
      return h('span', { class: `${className} is-disabled` },
        labelEl,
        h('span', { class: 'pager-title', text: isPrev ? '已经是第一条' : '已经是最后一条' }));
    }
    return h('a', { class: className, href: memoHash(item.number, filter) },
      labelEl,
      h('span', { class: 'pager-title', text: String(item.title || '').trim() || EMPTY_TITLE }));
  };
  return h('nav', { class: 'pager', 'aria-label': '说说翻页' }, side(nav.prev, true), side(nav.next, false));
}

function buildDetailView(memo, filter, nav) {
  const article = h('article', { class: 'memo-detail' });

  // 顶部工具条：返回列表在左，GitHub 链接在右，同一行、同一套按钮样式
  const toolbar = h('div', { class: 'detail-toolbar' },
    h('button', { class: 'tool-btn back-link', type: 'button', onClick: backToList },
      icon('arrow-left'), h('span', { text: '返回列表' })));
  if (memo.url) {
    toolbar.append(h('a', { class: 'tool-btn', href: memo.url, target: '_blank', rel: 'noopener noreferrer' },
      h('span', { text: '在 GitHub 查看' }), icon('external-link')));
  }
  article.append(toolbar);

  const head = h('header', { class: 'detail-head' });
  // 标题不走 markdown：先 escapeHtml 再插入
  const titleEl = h('h1', { class: 'memo-title' });
  titleEl.innerHTML = escapeHtml(String(memo.title || '').trim() || EMPTY_TITLE);
  head.append(titleEl);
  const meta = h('div', { class: 'detail-meta' },
    h('time', { datetime: memo.created_at || '', text: isoDate(memo.created_at) }));
  const updated = isoDate(memo.updated_at);
  if (updated && updated !== isoDate(memo.created_at)) {
    meta.append(h('span', { class: 'meta-sep', text: '·' }), h('span', { class: 'updated', text: `更新于 ${updated}` }));
  }
  if (memo.author && memo.author.login) {
    meta.append(h('span', { class: 'meta-sep', text: '·' }), authorLink(memo.author, 'avatar-md'));
  }
  if (memo.pinned) meta.append(h('span', { class: 'pin-badge' }, icon('pin'), h('span', { text: '置顶' })));
  if (memo.state && memo.state !== 'open') {
    meta.append(h('span', { class: 'state-badge', text: memo.state === 'closed' ? '已关闭' : String(memo.state) }));
  }
  head.append(meta);
  const chips = buildLabelChips(memo.labels, filter, true);
  if (chips) head.append(chips);
  if (hasFilter(filter)) head.append(buildFilterNote(filter));

  const body = h('div', { class: 'memo-body' });
  body.innerHTML = renderMarkdown(memo.content, memo.render); // 已过 DOMPurify
  decorateBody(body);

  // 标题 + 正文包进一张卡片，让详情页有边界感；翻页和操作按钮留在卡片外
  article.append(h('div', { class: 'detail-card' }, head, body));

  const pager = buildPager(nav, filter);
  if (pager) article.append(pager);

  return article;
}

/* ------------------------------ lightbox ------------------------------ */

let lightboxDialog = null;

function closeLightbox() {
  if (lightboxDialog && lightboxDialog.open) lightboxDialog.close();
  lightboxDialog = null;
}

function openLightbox(src, alt) {
  if (!src) return;
  closeLightbox();
  const dialog = h('dialog', { class: 'lightbox', 'aria-label': alt || '图片预览' }, h('img', { src, alt: alt || '' }));
  dialog.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (lightboxDialog === dialog) lightboxDialog = null;
  });
  // 必须挂到 document.body：避免被 .memo-body 的样式 / 层叠上下文裁掉
  document.body.append(dialog);
  lightboxDialog = dialog;
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/** 给容器内所有正文图片绑定点击放大；列表页没有 .memo-body img，调用是安全的空操作 */
function bindLightbox(root) {
  if (!root || !state.lightboxEnabled) return;
  root.querySelectorAll('.memo-body img').forEach((img) => {
    if (img.dataset.zoomBound === '1') return;
    img.dataset.zoomBound = '1';
    img.classList.add('zoomable');
    img.addEventListener('click', (event) => {
      const link = img.closest('a');
      if (link) event.preventDefault(); // 图片在链接里时先阻止跳转
      openLightbox(img.currentSrc || img.src, img.alt || '');
    });
  });
}

/* ------------------------------ 渲染：错误 ------------------------------ */

function buildErrorView(title, message, retry) {
  const actions = h('div', { class: 'error-actions' });
  if (retry) actions.append(h('button', { class: 'btn primary', type: 'button', onClick: retry },
    icon('refresh-cw'), h('span', { text: '重试' })));
  actions.append(h('button', { class: 'btn', type: 'button', text: '返回列表', onClick: backToList }));
  return h('section', { class: 'state-box error-box' },
    h('div', { class: 'state-icon' }, icon('triangle-alert')),
    h('h2', { class: 'state-title', text: title }),
    message ? h('p', { class: 'state-text', text: message }) : null,
    actions);
}

/* ------------------------------ 进度条 ------------------------------ */

function setProgress(active) {
  const bar = document.getElementById('progress');
  if (!bar) return;
  bar.hidden = !active;
  bar.classList.toggle('is-active', active);
}

/* ------------------------------ 视图渲染 ------------------------------ */

function restoreListScroll() {
  if (state.pendingScrollY == null) return;
  const y = state.pendingScrollY;
  state.pendingScrollY = null;
  requestAnimationFrame(() => window.scrollTo(0, y));
}

async function renderList(filter, token) {
  const app = document.getElementById('app');

  // 已有列表 DOM：直接复用，只切 hidden（不重建、不丢滚动位置）
  if (state.listView) {
    if (state.view !== 'list') app.replaceChildren(state.listView);
    state.view = 'list';
    applyFilterToList(filter);
    restoreListScroll();
    bindLightbox(state.listView);
    document.title = state.siteTitle;
    return;
  }

  state.view = 'list';
  app.replaceChildren(buildListSkeleton());
  try {
    await loadList();
    if (token !== state.navToken) return;
    app.replaceChildren(buildListView());
    applyFilterToList(filter);
    restoreListScroll();
    bindLightbox(state.listView);
    document.title = state.siteTitle;
  } catch (error) {
    if (token !== state.navToken) return;
    console.error('[memo] 列表加载失败', error);
    app.replaceChildren(buildErrorView('加载失败', '无法读取说说列表，请检查网络后重试。', () => {
      clearCache();
      route();
    }));
  }
}

/** 无筛选用详情预生成的 prev/next；有筛选必须拉列表，在筛选结果内重算 */
async function resolveNav(memo, filter) {
  if (!hasFilter(filter)) return { prev: memo.prev || null, next: memo.next || null };
  try {
    await loadList();
    const list = state.memos.filter((item) => matchFilter(item, filter));
    const index = list.findIndex((item) => item.number === memo.number);
    if (index < 0) return { prev: null, next: null, outsideFilter: true };
    return { prev: list[index - 1] || null, next: list[index + 1] || null };
  } catch (error) {
    // 列表拉取失败时退回预生成值，至少还能翻页
    console.warn('[memo] 筛选翻页需要列表数据，拉取失败，退回预生成 prev/next', error);
    return { prev: memo.prev || null, next: memo.next || null };
  }
}

async function renderDetail(number, filter, token) {
  const app = document.getElementById('app');
  const sameView = state.view === 'detail'; // 详情 -> 详情：保留旧内容，只显示进度条

  if (!sameView) {
    if (state.view === 'list') state.pendingScrollY = window.scrollY;
    app.replaceChildren(buildDetailSkeleton());
    window.scrollTo(0, 0);
  }
  state.view = 'detail';
  setProgress(true);

  try {
    const memo = await loadMemo(number);
    if (token !== state.navToken) return;
    const nav = await resolveNav(memo, filter);
    if (token !== state.navToken) return;
    app.replaceChildren(buildDetailView(memo, filter, nav));
    bindLightbox(app);
    document.title = `${String(memo.title || '').trim() || EMPTY_TITLE} · ${state.siteTitle}`;
    if (sameView) window.scrollTo(0, 0);
  } catch (error) {
    if (token !== state.navToken) return;
    if (error && error.status === 404) {
      app.replaceChildren(buildErrorView('该说说不存在', '它可能已经被删除，或者链接里的编号不对。', null));
      document.title = `说说不存在 · ${state.siteTitle}`;
    } else {
      console.error('[memo] 详情加载失败', error);
      app.replaceChildren(buildErrorView('加载失败', (error && error.message) || '网络异常，请稍后重试。', () => {
        clearCache();
        route();
      }));
    }
    window.scrollTo(0, 0);
  } finally {
    if (token === state.navToken) setProgress(false);
  }
}

/* ------------------------------ 路由层 ------------------------------ */

async function route() {
  const info = parseHash();
  const token = (state.navToken += 1);
  if (info.view === 'memo') {
    await renderDetail(info.number, info.filter, token);
  } else {
    await renderList(info.filter, token);
  }
}

/**
 * 返回列表：直接改 hash，而不是 history.back()。
 * 原因：列表 → 详情 A → 点「下一条」到 B → 点「返回列表」，back() 只退一格会回到 A。
 * 浏览器后退键仍保留原生语义（回到上一条详情），两套行为各自符合直觉。
 */
function backToList() {
  location.hash = listHash(parseHash().filter);
}

/* ------------------------------ 启动 ------------------------------ */

function boot() {
  window.addEventListener('hashchange', () => {
    route();
  });
  if (!location.hash) replaceHash('#/'); // 地址栏没有 hash 时补一个，保证分享链接形态一致
  route();
}

boot();
