import { writeFile, mkdir } from 'node:fs/promises';

const USER = process.env.GH_USER;
const TOKEN = process.env.GH_TOKEN;
const API = 'https://api.github.com';

if (!USER) {
  console.error('GH_USER is required');
  process.exit(1);
}

const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'project-shelf',
};
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;

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

/* ---------- og:image 抓取 ---------- */

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
  raw = raw.trim();
  if (!raw) return '';
  if (/^data:/i.test(raw)) return '';
  try {
    return new URL(raw, base).href;
  } catch {
    return '';
  }
}

async function fetchOgImage(siteUrl) {
  let target = siteUrl;
  if (!/^https?:\/\//i.test(target)) {
    target = 'https://' + target;
  }

  try {
    const res = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ProjectShelf/1.0; +https://github.com)',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
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

const readmes = await mapLimit(filtered, 6, (r) => getReadme(r.name));

const covers = await mapLimit(filtered, 6, async (r) => {
  if (!r.homepage) return '';
  const img = await fetchOgImage(r.homepage);
  if (img) console.log(`og:image  ${r.name}  ${img}`);
  return img;
});

const projects = filtered.map((r, i) => {
  const readme = readmes[i];
  const topics = r.topics || [];
  return {
    id: r.name,
    title: r.name,
    description: r.description || '',
    url: r.html_url,
    homepage: r.homepage || '',
    coverUrl: covers[i] || '',
    language: r.language || '',
    stars: r.stargazers_count,
    forks: r.forks_count,
    topics,
    branch: r.default_branch || 'main',
    updatedAt: r.updated_at,
    featured: topics.includes('featured'),
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
console.log(`wrote data/projects.json (${projects.length} projects, ${projects.filter(p => p.coverUrl).length} with og cover)`);