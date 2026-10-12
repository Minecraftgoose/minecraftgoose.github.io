import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const USER = process.env.GH_USER;
const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com';

const FEATURED_REPOS = (process.env.FEATURED_REPOS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const COVERS_DIR = 'data/covers';
const COVERS_PUBLIC = 'data/covers';

if (!USER) {
  console.error('GH_USER is required');
  process.exit(1);
}

let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.warn('sharp 未安装，封面将不会转换为 webp');
}

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'project-shelf',
};
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${url}\n${text}`);
  }
  return res.json();
}

async function listRepos() {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await gh(
      `${API}/users/${USER}/repos?per_page=100&page=${page}&sort=updated&type=owner`
    );
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

async function getReadme(repo) {
  try {
    const data = await gh(`${API}/repos/${USER}/${repo}/readme`);
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    return { text, path: data.path || 'README.md' };
  } catch {
    return { text: '', path: '' };
  }
}

/* ---------- og:image 解析 ---------- */

const OG_PATTERNS = [
  /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
  /<meta[^>]+property=["']og:image:url["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:url["']/i,
  /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image:src["']/i,
  /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
  /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
];

function normalizeUrl(raw, base) {
  if (!raw) return '';
  raw = String(raw).trim();
  if (!raw || /^data:/i.test(raw)) return '';
  try { return new URL(raw, base).href; } catch { return ''; }
}

async function fetchOgImage(siteUrl) {
  let target = siteUrl;
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;

  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProjectShelf/1.0; +https://github.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return '';
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('html')) return '';

    const html = await res.text();
    const end = html.search(/<\/head>/i);
    const head = end > -1 ? html.slice(0, end) : html.slice(0, 200000);

    for (const p of OG_PATTERNS) {
      const m = head.match(p);
      if (m && m[1]) {
        const url = normalizeUrl(m[1], res.url || target);
        if (url) return url;
      }
    }
    return '';
  } catch {
    return '';
  }
}

/* ---------- 图片下载与转换 ---------- */

async function downloadImage(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProjectShelf/1.0; +https://github.com)',
        Accept: 'image/*,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!/image\//i.test(ct) && !/octet-stream/i.test(ct)) {
      // 有些站点 content-type 不标准，继续尝试
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 20 * 1024 * 1024) return null;
    return buf;
  } catch {
    return null;
  }
}

async function downloadGithubOg(user, repo) {
  const url = `https://opengraph.githubassets.com/1/${user}/${repo}`;
  for (let i = 0; i < 3; i++) {
    const buf = await downloadImage(url);
    if (buf) return buf;
    await sleep(1500 * (i + 1));
  }
  return null;
}

async function saveCoverAsWebp(repoName, buffer) {
  if (!buffer || !sharp) return '';

  const safe = repoName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filename = safe + '.webp';
  const out = path.join(COVERS_DIR, filename);

  try {
    await sharp(buffer)
      .resize({ width: 880, height: 880, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toFile(out);
    return COVERS_PUBLIC + '/' + filename;
  } catch (e) {
    console.warn(`sharp failed for ${repoName}: ${e.message}`);
    return '';
  }
}

/* ---------- 有限并发 ---------- */

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const n = Math.min(limit, items.length) || 1;
  const workers = Array.from({ length: n }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------- 主流程 ---------- */

const repos = await listRepos();
const filtered = repos.filter((r) => !r.fork && !r.archived);

console.log(`repos: ${filtered.length}`);

// 清空并重建封面目录，避免遗留已删除仓库的封面
await rm(COVERS_DIR, { recursive: true, force: true });
await mkdir(COVERS_DIR, { recursive: true });

const readmes = await mapLimit(filtered, 6, (r) => getReadme(r.name));

const coverResults = await mapLimit(filtered, 4, async (r) => {
  // 1. 优先抓 homepage 的 og:image
  if (r.homepage) {
    const og = await fetchOgImage(r.homepage);
    if (og) {
      const buf = await downloadImage(og);
      if (buf) {
        const saved = await saveCoverAsWebp(r.name, buf);
        if (saved) {
          console.log(`cover(homepage)  ${r.name}  ${og}`);
          return { coverUrl: saved, coverSource: og };
        }
      }
    }
  }
  // 2. 回退到 GitHub og
  const buf = await downloadGithubOg(USER, r.name);
  if (buf) {
    const saved = await saveCoverAsWebp(r.name, buf);
    if (saved) {
      console.log(`cover(github)    ${r.name}`);
      return { coverUrl: saved, coverSource: 'github' };
    }
  }
  console.log(`cover(none)      ${r.name}`);
  return { coverUrl: '', coverSource: '' };
});

function isFeatured(r) {
  const topics = r.topics || [];
  if (topics.includes('featured')) return true;
  if (FEATURED_REPOS.includes(r.name)) return true;
  if (r.homepage) return true;
  return false;
}

const projects = filtered.map((r, i) => {
  const readme = readmes[i];
  const cover = coverResults[i] || { coverUrl: '', coverSource: '' };
  return {
    id: r.name,
    title: r.name,
    description: r.description || '',
    url: r.html_url,
    homepage: r.homepage || '',
    coverUrl: cover.coverUrl,
    coverSource: cover.coverSource,
    language: r.language || '',
    stars: r.stargazers_count,
    forks: r.forks_count,
    topics: r.topics || [],
    branch: r.default_branch || 'main',
    updatedAt: r.updated_at,
    featured: isFeatured(r),
    readme: readme.text,
    readmePath: readme.path,
  };
});

const payload = {
  user: USER,
  generatedAt: new Date().toISOString(),
  count: projects.length,
  projects,
};

await mkdir('data', { recursive: true });
await writeFile('data/projects.json', JSON.stringify(payload, null, 2), 'utf8');
console.log(
  `wrote data/projects.json ` +
  `(${projects.length} projects, ${projects.filter((p) => p.coverUrl).length} covers, ` +
  `${projects.filter((p) => p.featured).length} featured)`
);