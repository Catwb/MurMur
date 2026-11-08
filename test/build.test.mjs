import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterIssues,
  sortIssues,
  applyMaxCount,
  buildList,
  buildDetails,
  stripMarkdown,
  resolveTitle,
  makeExcerpt,
} from '../scripts/build.mjs';

// ---------------------------------------------------------------- 构造工具

function issue(n, over = {}) {
  return {
    number: n,
    title: `memo ${n}`,
    body: `正文 ${n}`,
    state: 'open',
    author_association: 'OWNER',
    created_at: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    updated_at: `2026-01-${String((n % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    labels: [],
    user: { login: 'qiyao', avatar_url: 'a', html_url: 'u' },
    html_url: `https://github.com/o/r/issues/${n}`,
    ...over,
  };
}

const cfg = {
  memos: {
    include_labels: [],
    exclude_labels: [],
    pinned_labels: ['置顶'],
    allowed_associations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    max_count: 0,
    include_closed: false,
    sort: 'created_desc',
    title_fallback: true,
    render: { gfm: true, breaks: true },
  },
  build: { group_by_date: true },
  site: { title: 'test', base_url: 'https://example.com' },
  feed: { enabled: true, formats: ['rss', 'json'], full_content: false },
};

// ---------------------------------------------------------------- 过滤

test('include_labels 为空数组时表示不限，而不是全部排除', () => {
  const out = filterIssues([issue(1), issue(2)], cfg);
  assert.equal(out.length, 2);
});

test('排除 PR、路人 issue 和 closed issue', () => {
  const out = filterIssues(
    [
      issue(1),
      issue(2, { pull_request: { url: 'x' } }),
      issue(3, { author_association: 'NONE' }),
      issue(4, { state: 'closed' }),
    ],
    cfg
  );
  assert.deepEqual(out.map((i) => i.number), [1]);
});

// ---------------------------------------------------------------- 排序 / 截断

test('pinned 优先于 sort，且不会被 max_count 截断', () => {
  // 120 条，其中 1 条 pinned 且 created_at 最老
  const issues = Array.from({ length: 120 }, (_, i) => issue(i + 1));
  issues[0] = issue(1, {
    created_at: '2020-01-01T00:00:00Z',
    labels: [{ name: '置顶', color: 'ffd43b' }],
  });

  const sorted = sortIssues(issues, cfg);
  assert.equal(sorted[0].number, 1, 'pinned 必须排第一');

  const final = applyMaxCount(
    sorted.map((i) => ({ ...i, pinned: i.number === 1 })),
    100
  );
  assert.equal(final.length, 100);
  assert.ok(
    final.some((i) => i.number === 1),
    'pinned 条目不能被 max_count 截掉'
  );
});

// ---------------------------------------------------------------- 文本

test('stripMarkdown 去掉代码块、链接、强调，保留文字', () => {
  const md = '# 标题\n\n看这个 [链接](https://x.com) 和 **粗体**。\n\n```js\nconst a = 1;\n```';
  const out = stripMarkdown(md);
  assert.ok(!out.includes('```'));
  assert.ok(!out.includes('https://x.com'));
  assert.ok(out.includes('链接'));
  assert.ok(out.includes('粗体'));
});

test('标题为空时 fallback 取正文首个非空行（先 strip markdown）', () => {
  const it = issue(1, { title: '', body: '\n\n## 这是首行\n\n第二行' });
  assert.equal(resolveTitle(it, cfg), '这是首行');
});

test('摘要按字符截断，中文不被切断在半个字', () => {
  const long = '啊'.repeat(500);
  const out = makeExcerpt(long);
  assert.ok(out.length <= 201, `实际长度 ${out.length}`);
  assert.ok(out.endsWith('…'));
});

// ---------------------------------------------------------------- 产物结构

test('列表 JSON 不带全文，详情 JSON 带 prev/next 且不带 generated_at', () => {
  const issues = [issue(1), issue(2), issue(3)];
  const list = buildList(issues, cfg);
  assert.equal(list.version, 1);
  assert.ok(Object.hasOwn(list, 'generated_at'));
  assert.ok(!Object.hasOwn(list.memos[0], 'content'), '列表条目不应包含全文');
  assert.ok(Object.hasOwn(list, 'index_by_date'));

  const details = buildDetails(issues, cfg);
  assert.equal(details[0].prev, null);
  assert.equal(details[0].next.number, 2);
  assert.equal(details[2].next, null);
  assert.ok(!Object.hasOwn(details[0], 'generated_at'), '详情 JSON 不能带 generated_at，否则每次构建全是假 diff');
});

// ---------------------------------------------------------------- 作者展示覆盖

test('authors 覆盖昵称和头像：大小写不敏感，login 保留原值，未配置的回退 GitHub 原值', () => {
  const cfgAuthors = {
    ...cfg,
    authors: { QiYao: { name: '绮曜', avatar: 'https://example.com/me.png' } },
  };
  const list = buildList(
    [
      issue(1, { user: { login: 'qiyao', avatar_url: 'https://avatars.githubusercontent.com/u/1', html_url: 'https://github.com/qiyao' } }),
      issue(2, { user: { login: 'someone', avatar_url: 'https://avatars.githubusercontent.com/u/2', html_url: 'https://github.com/someone' } }),
    ],
    cfgAuthors
  );

  assert.equal(list.memos[0].author.name, '绮曜', '配置的昵称生效');
  assert.equal(list.memos[0].author.avatar_url, 'https://example.com/me.png', '配置的头像生效');
  assert.equal(list.memos[0].author.login, 'qiyao', 'login 保留原值，不参与展示');

  assert.equal(list.memos[1].author.name, 'someone', '未配置的作者回退到 login');
  assert.equal(list.memos[1].author.avatar_url, 'https://avatars.githubusercontent.com/u/2', '未配置的作者回退到 GitHub 头像');
});
