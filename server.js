/**
 * 정보 수집 에이전트 서버
 * - 정적 파일 서빙
 * - POST /api/collect → SSE 스트림으로 진행률 전송 + MD 파일 생성
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT        = 3000;
const ROOT        = path.resolve(__dirname);
const REPORTS_DIR = path.join(ROOT, 'reports');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
};

// ── HTTP 헬퍼 ─────────────────────────────────────────────────────
function request(method, urlStr, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u      = new URL(urlStr);
    const client = u.protocol === 'https:' ? https : http;
    const bodyBuf = body
      ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf-8')
      : null;

    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept':          'application/json, text/html, */*',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
        ...extraHeaders,
      },
    };

    const req = client.request(opts, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${u.protocol}//${u.host}${res.headers.location}`;
        return request(method, next, body, extraHeaders).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${urlStr}`)); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

const httpGet  = (url, h)    => request('GET',  url, null, h);
const httpPost = (url, body) => request('POST', url, body);

// ── 날짜 유틸 ─────────────────────────────────────────────────────
function getToday() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}
function getTimestamp() {
  const d = new Date();
  return `${getToday()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')} KST`;
}
function getNextRun(date) {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  let n = 1;
  while (fs.existsSync(path.join(REPORTS_DIR, `${date}_${String(n).padStart(2,'0')}.md`))) n++;
  return String(n).padStart(2, '0');
}

// ── 수집 함수들 ───────────────────────────────────────────────────
async function collectVelog() {
  try {
    const query = `query trendingPosts($input: TrendingPostsInput!) {
      trendingPosts(input: $input) { id title short_description likes user { username } url_slug }
    }`;
    const res  = await httpPost('https://v3.velog.io/graphql', {
      query,
      variables: { input: { limit: 5, offset: 0, timeframe: 'week' } },
    });
    const posts = JSON.parse(res.body)?.data?.trendingPosts || [];
    return posts.slice(0, 5).map((p, i) => ({
      rank: i+1, title: p.title || '(제목 없음)',
      author: `@${p.user?.username || 'unknown'}`,
      summary: (p.short_description || '').slice(0, 120),
      url: `https://velog.io/@${p.user?.username}/${p.url_slug}`,
    }));
  } catch (e) { console.error('Velog:', e.message); return []; }
}

async function collectYozmIT() {
  try {
    const res  = await httpGet('https://yozm.wishket.com/magazine/');
    const html = res.body;
    const items = [], seen = new Set();
    const re = /href="(\/magazine\/detail\/\d+\/)"[^>]*>([\s\S]{1,600}?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) !== null && items.length < 5) {
      const url   = 'https://yozm.wishket.com' + m[1];
      const title = m[2].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,120);
      if (!seen.has(url) && title.length > 10) {
        seen.add(url);
        items.push({ rank: items.length+1, title, summary: '', url });
      }
    }
    return items;
  } catch (e) { console.error('요즘IT:', e.message); return []; }
}

async function collectGithubTrending() {
  try {
    const res  = await httpGet('https://github.com/trending');
    const html = res.body;
    const repos = [];
    const re = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
    let m;
    while ((m = re.exec(html)) !== null && repos.length < 10) {
      const block     = m[1];
      const pathMatch = block.match(/href="\/([\w.-]+\/[\w.-]+)"\s/);
      if (!pathMatch || pathMatch[1].split('/').length !== 2) continue;
      const descMatch = block.match(/<p[^>]*color-fg-muted[^>]*>([\s\S]*?)<\/p>/i);
      const langMatch = block.match(/itemprop="programmingLanguage"[^>]*>\s*([^<]+)\s*<\/span>/i);
      const starMatch = block.match(/\/stargazers"[^>]*>[\s\S]*?([0-9,]+)/i);
      repos.push({
        rank:  repos.length+1,
        name:  pathMatch[1],
        desc:  descMatch ? descMatch[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim() : '',
        lang:  langMatch ? langMatch[1].trim() : '-',
        stars: starMatch ? starMatch[1] : '?',
        url:   `https://github.com/${pathMatch[1]}`,
      });
    }
    return repos;
  } catch (e) { console.error('GitHub:', e.message); return []; }
}

async function collectStocks() {
  try {
    const [kp, kq] = await Promise.all([
      httpGet('https://m.stock.naver.com/api/index/KOSPI/basic'),
      httpGet('https://m.stock.naver.com/api/index/KOSDAQ/basic'),
    ]);
    const p = JSON.parse(kp.body), q = JSON.parse(kq.body);
    const fmt = v => (parseFloat(v) >= 0 ? `+${v}` : `${v}`);
    return {
      kospi:  { value: p.closePrice||'조회 실패', change: fmt(p.compareToPreviousClosePrice||0), rate: fmt(p.fluctuationsRatio||0)+'%' },
      kosdaq: { value: q.closePrice||'조회 실패', change: fmt(q.compareToPreviousClosePrice||0), rate: fmt(q.fluctuationsRatio||0)+'%' },
    };
  } catch (e) {
    console.error('Stocks:', e.message);
    return { kospi: { value:'조회 실패', change:'', rate:'' }, kosdaq: { value:'조회 실패', change:'', rate:'' } };
  }
}

async function collectExchangeRate() {
  try {
    const res = await httpGet('https://open.er-api.com/v6/latest/USD');
    const krw = JSON.parse(res.body)?.rates?.KRW;
    return krw ? krw.toFixed(2) : '조회 실패';
  } catch (e) { console.error('FX:', e.message); return '조회 실패'; }
}

async function collectNews() {
  // RSS XML 파싱 헬퍼 — CDATA 포함 처리
  function parseRSS(xml, max = 3) {
    const items = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    let m;
    while ((m = itemRe.exec(xml)) !== null && items.length < max) {
      const block = m[1];
      // title: CDATA 또는 plain text 모두 처리
      const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
      // link: CDATA wrapping 여부 무관하게 URL만 추출
      const linkMatch  = block.match(/<link>(?:<!\[CDATA\[)?\s*(https?:\/\/[^<\]\s]+)/i)
                      || block.match(/<guid[^>]*>(?:<!\[CDATA\[)?\s*(https?:\/\/[^<\]\s]+)/i);
      if (!titleMatch || !linkMatch) continue;
      const title = titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const url   = linkMatch[1].trim();
      if (title.length > 5) items.push({ title, url });
    }
    return items;
  }

  // 1차: 한국경제 경제 RSS (금융/증시 특화)
  try {
    const res   = await httpGet('https://www.hankyung.com/feed/economy');
    const items = parseRSS(res.body);
    if (items.length > 0) { console.log('뉴스: 한국경제 경제 RSS'); return items; }
  } catch (e) { console.error('한국경제 경제 RSS:', e.message); }

  // 2차: 한국경제 금융 RSS
  try {
    const res   = await httpGet('https://www.hankyung.com/feed/finance');
    const items = parseRSS(res.body);
    if (items.length > 0) { console.log('뉴스: 한국경제 금융 RSS'); return items; }
  } catch (e) { console.error('한국경제 금융 RSS:', e.message); }

  // 3차: 매일경제 헤드라인 RSS
  try {
    const res   = await httpGet('https://www.mk.co.kr/rss/30000001/');
    const items = parseRSS(res.body);
    if (items.length > 0) { console.log('뉴스: 매일경제 헤드라인 RSS'); return items; }
  } catch (e) { console.error('매일경제 헤드라인 RSS:', e.message); }

  return [];
}

// ── MD 파일 작성 ──────────────────────────────────────────────────
function writeReport(date, run, ts, { velog, yozmit, github, stocks, usdkrw, news }, overwriteFilename = null) {
  const velogMd = velog.length
    ? `| # | 제목 | 작성자 | 요약 |\n|---|------|--------|------|\n`
      + velog.map(p => `| ${p.rank} | [${p.title}](${p.url}) | ${p.author} | ${p.summary||'-'} |`).join('\n')
    : '> ⚠️ Velog 데이터 수집 실패';

  const yozmMd = yozmit.length
    ? yozmit.map(a => `${a.rank}. **[${a.title}](${a.url})**\n   - 요약: ${a.summary||'본문 참조'}`).join('\n\n')
    : '> ⚠️ 요즘IT 데이터 수집 실패';

  const githubMd = github.length
    ? `| # | 저장소 | 설명 | 언어 | 스타 |\n|---|--------|------|------|------|\n`
      + github.map(r => `| ${r.rank} | [${r.name}](${r.url}) | ${r.desc||'-'} | ${r.lang} | ⭐ ${r.stars} |`).join('\n')
    : '> ⚠️ GitHub Trending 수집 실패';

  const newsMd = news.length
    ? news.map((n,i) => `${i+1}. **[${n.title}](${n.url})**`).join('\n')
    : '> ⚠️ 마켓 뉴스 수집 실패';

  const filename = overwriteFilename || `${date}_${run}.md`;
  const content  = `# 정보 수집 보고서 — ${date} (Run ${run})

---

## 기술 정보

### Velog 트렌드 (상위 5개)
> 취득 시각: ${ts}

${velogMd}

---

### 요즘IT 인기 기사 (상위 5개)
> 취득 시각: ${ts}

${yozmMd}

---

### GitHub Trending (${date} 당일)
> 취득 시각: ${ts}

${githubMd}

---

## 경제 정보

> 취득 시각: ${ts}

### 코스피 / 코스닥 지수

| 지수 | 현재값 | 전일 대비 | 변동률 |
|------|--------|-----------|--------|
| 코스피 (KOSPI)  | **${stocks.kospi.value}**  | ${stocks.kospi.change}  | **${stocks.kospi.rate}**  |
| 코스닥 (KOSDAQ) | **${stocks.kosdaq.value}** | ${stocks.kosdaq.change} | **${stocks.kosdaq.rate}** |

### USD/KRW 환율

| 통화쌍 | 현재값 |
|--------|--------|
| USD/KRW | **${usdkrw} 원** |

### 주요 마켓 뉴스

${newsMd}

---
`;
  fs.writeFileSync(path.join(REPORTS_DIR, filename), content, 'utf-8');
  return filename;
}

// ── SSE 수집 핸들러 (overwriteFilename 지정 시 해당 파일 덮어쓰기) ──
async function handleCollect(res, overwriteFilename = null) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (progress, step, extra = {}) => {
    res.write(`data: ${JSON.stringify({ progress, step, ...extra })}\n\n`);
  };

  const date = overwriteFilename ? overwriteFilename.slice(0, 10) : getToday();
  const run  = overwriteFilename ? overwriteFilename.slice(11, 13) : getNextRun(date);
  const ts   = getTimestamp();

  try {
    send(0,  overwriteFilename ? `${overwriteFilename} 업데이트 중...` : '수집을 시작합니다...');

    send(5,  'Velog 트렌드 수집 중...');
    const velog = await collectVelog();
    send(22, `Velog 수집 완료 (${velog.length}건)`);

    send(25, '요즘IT 인기 기사 수집 중...');
    const yozmit = await collectYozmIT();
    send(42, `요즘IT 수집 완료 (${yozmit.length}건)`);

    send(45, 'GitHub Trending 수집 중...');
    const github = await collectGithubTrending();
    send(62, `GitHub Trending 수집 완료 (${github.length}건)`);

    send(65, '코스피/코스닥 지수 수집 중...');
    const stocks = await collectStocks();
    send(75, `주가 수집 완료 — KOSPI ${stocks.kospi.value}`);

    send(78, 'USD/KRW 환율 수집 중...');
    const usdkrw = await collectExchangeRate();
    send(85, `환율 수집 완료 — ${usdkrw} 원`);

    send(88, '마켓 뉴스 수집 중...');
    const news = await collectNews();
    send(95, `뉴스 수집 완료 (${news.length}건)`);

    send(97, '파일 저장 중...');
    const filename = writeReport(date, run, ts, { velog, yozmit, github, stocks, usdkrw, news }, overwriteFilename);

    send(100, overwriteFilename ? '업데이트 완료!' : '수집 완료!', { done: true, filename });
    console.log(`[완료] reports/${filename}`);
  } catch (e) {
    console.error('수집 오류:', e);
    send(0, '오류 발생: ' + e.message, { error: true });
  }
  res.end();
}

// ── 정적 파일 서빙 ────────────────────────────────────────────────
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.resolve(ROOT, '.' + urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end('Not Found'); return; }

  const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(fs.readFileSync(filePath));
}

// ── 서버 기동 ─────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/api/collect') {
    await handleCollect(res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/update') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      const { filename } = JSON.parse(body || '{}');
      await handleCollect(res, filename || null);
    });
    return;
  }

  serveStatic(req, res);

}).listen(PORT, () => {
  console.log(`\n🚀 서버 실행: http://localhost:${PORT}`);
  console.log(`   수집 API : POST /api/collect`);
  console.log(`   업데이트 API: POST /api/update\n`);
});
