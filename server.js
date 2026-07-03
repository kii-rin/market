const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.join(__dirname, 'data');
const HIST = path.join(DATA, 'history');
const LATEST = path.join(DATA, 'latest.json');
const ECB = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

const series = [
  ['DGS2', 'US 2Y Treasury Yield'],
  ['DGS10', 'US 10Y Treasury Yield'],
  ['DFII10', 'US 10Y Real Yield'],
  ['VIXCLS', 'VIX'],
  ['SP500', 'S&P 500'],
  ['DCOILWTICO', 'WTI Crude Oil'],
  ['DCOILBRENTEU', 'Brent Crude Oil'],
  ['GOLDAMGBD228NLBM', 'Gold AM Fix'],
  ['SLVPRUSD', 'Silver Fix'],
  ['CPIAUCSL', 'US CPI'],
  ['CPILFESL', 'US Core CPI'],
  ['PAYEMS', 'US Nonfarm Payrolls'],
  ['UNRATE', 'US Unemployment Rate'],
  ['ICSA', 'US Initial Jobless Claims'],
  ['RSAFS', 'US Retail Sales'],
  ['GDPC1', 'US Real GDP']
];

const feeds = [
  ['Fed monetary policy', 'USD', 'https://www.federalreserve.gov/feeds/press_monetary.xml'],
  ['Fed speeches', 'USD', 'https://www.federalreserve.gov/feeds/speeches.xml'],
  ['ECB press', 'EUR', 'https://www.ecb.europa.eu/rss/press.html']
];

const pairs = [
  ['EUR', 'USD'], ['GBP', 'USD'], ['USD', 'JPY'], ['USD', 'CAD'],
  ['AUD', 'USD'], ['NZD', 'USD'], ['USD', 'CHF'], ['EUR', 'JPY'],
  ['GBP', 'JPY'], ['AUD', 'JPY'], ['CAD', 'JPY'], ['EUR', 'GBP'], ['USD', 'CNY']
];

const newline = String.fromCharCode(10);
const quote = String.fromCharCode(34);
const slash = String.fromCharCode(47);

function round(x, d = 4) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return null;
  const p = 10 ** d;
  return Math.round(Number(x) * p) / p;
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'market-runner/1.0' }
    });
    if (!res.ok) throw new Error(String(res.status) + ' ' + res.statusText);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function toNumber(v) {
  v = String(v || '').trim();
  if (!v || v === '.' || v.toLowerCase() === 'nan') return null;
  const n = Number(v.replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

function between(text, left, right, start = 0) {
  const a = text.indexOf(left, start);
  if (a < 0) return null;
  const b = a + left.length;
  const c = text.indexOf(right, b);
  if (c < 0) return null;
  return text.slice(b, c);
}

function clean(s) {
  return String(s || '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', quote)
    .replaceAll('&#39;', String.fromCharCode(39))
    .trim();
}

function parseFredCsv(text, id) {
  const rows = String(text).replaceAll(String.fromCharCode(13), '').trim().split(newline).slice(1);
  return rows.map(line => {
    const parts = line.split(',');
    return { date: parts[0], value: toNumber(parts[1]) };
  }).filter(row => row.date && row.value !== null);
}

async function fredOne(item) {
  const id = item[0];
  const label = item[1];
  const url = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + id;
  const rows = parseFredCsv(await fetchText(url), id);
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const change = latest && previous ? latest.value - previous.value : null;
  return {
    id,
    label,
    source: 'FRED public graph CSV',
    source_url: url,
    latest_date: latest ? latest.date : null,
    latest_value: latest ? round(latest.value, 6) : null,
    previous_date: previous ? previous.date : null,
    previous_value: previous ? round(previous.value, 6) : null,
    change: change === null ? null : round(change, 6),
    change_percent: latest && previous && previous.value !== 0 ? round((latest.value - previous.value) / Math.abs(previous.value) * 100, 4) : null,
    last_8: rows.slice(-8).map(row => ({ date: row.date, value: round(row.value, 6) }))
  };
}

async function getFred() {
  const results = [];
  const errors = [];
  for (const item of series) {
    try {
      results.push(await fredOne(item));
    } catch (error) {
      errors.push({ source: 'fred', id: item[0], message: error.message });
      results.push({ id: item[0], label: item[1], error: error.message });
    }
  }
  return { results, errors };
}

async function getEcb() {
  const xml = await fetchText(ECB);
  const time = between(xml, '<Cube time=' + String.fromCharCode(39), String.fromCharCode(39));
  const rates = { EUR: 1 };
  const chunks = xml.split('<Cube currency=' + String.fromCharCode(39)).slice(1);
  for (const chunk of chunks) {
    const cur = chunk.slice(0, 3);
    const rate = toNumber(between(chunk, 'rate=' + String.fromCharCode(39), String.fromCharCode(39)));
    if (cur && rate) rates[cur] = rate;
  }
  const fxPairs = pairs.map(pair => {
    const base = pair[0];
    const counter = pair[1];
    const val = rates[base] && rates[counter] ? rates[counter] / rates[base] : null;
    return { pair: base + slash + counter, value: val === null ? null : round(val, counter === 'JPY' ? 3 : 6) };
  });
  return { source: 'European Central Bank', source_url: ECB, as_of: time, base: 'EUR', eur_rates: rates, pairs: fxPairs };
}

function rssTag(block, tag) {
  return clean(between(block, '<' + tag + '>', '</' + tag + '>'));
}

async function getNews() {
  const items = [];
  const errors = [];
  for (const feed of feeds) {
    try {
      const xml = await fetchText(feed[2]);
      const blocks = xml.split('<item>').slice(1).map(x => x.split('</item>')[0]).slice(0, 6);
      for (const block of blocks) {
        items.push({
          feed: feed[0],
          currency: feed[1],
          title: rssTag(block, 'title'),
          link: rssTag(block, 'link'),
          published_at: rssTag(block, 'pubDate') || rssTag(block, 'dc:date')
        });
      }
    } catch (error) {
      errors.push({ source: 'rss', feed: feed[0], message: error.message });
    }
  }
  items.sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));
  return { items: items.slice(0, 20), errors };
}

function quickView(fx, fred) {
  const byId = Object.fromEntries(fred.map(x => [x.id, x]));
  return {
    fx_pairs: fx.pairs,
    rate_context: { us_2y: byId.DGS2, us_10y: byId.DGS10, real_10y: byId.DFII10 },
    risk_context: { sp500: byId.SP500, vix: byId.VIXCLS },
    commodities: { wti: byId.DCOILWTICO, brent: byId.DCOILBRENTEU, gold: byId.GOLDAMGBD228NLBM, silver: byId.SLVPRUSD },
    us_macro: { cpi: byId.CPIAUCSL, core_cpi: byId.CPILFESL, payrolls: byId.PAYEMS, unemployment: byId.UNRATE, jobless_claims: byId.ICSA, retail_sales: byId.RSAFS, gdp: byId.GDPC1 }
  };
}

async function build() {
  const errors = [];
  const fred = await getFred();
  errors.push(...fred.errors);
  let fx;
  try {
    fx = await getEcb();
  } catch (error) {
    errors.push({ source: 'ecb', message: error.message });
    fx = { source: 'European Central Bank', error: error.message, pairs: [] };
  }
  const news = await getNews();
  errors.push(...news.errors);
  return {
    generated_at: new Date().toISOString(),
    mode: 'free-no-account',
    api_endpoint: '/api/all',
    sources: { fx: 'ECB daily reference XML', macro_market: 'FRED public graph CSV', news: 'official RSS feeds' },
    limitations: ['No account or key is used.', 'No consensus forecast data is included.', 'ECB FX is daily reference data, not tick data.', 'FRED data can lag source releases.'],
    quick_view: quickView(fx, fred.results),
    fx,
    series: fred.results,
    central_bank_news: news.items,
    errors
  };
}

async function update() {
  await fs.mkdir(HIST, { recursive: true });
  const snap = await build();
  await fs.writeFile(LATEST, JSON.stringify(snap, null, 2) + newline);
  const hist = path.join(HIST, snap.generated_at.replaceAll(':', '-').replaceAll('.', '-') + '.json');
  await fs.writeFile(hist, JSON.stringify(snap, null, 2) + newline);
  return { snapshot: snap, paths: { latest: LATEST, history: hist } };
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'update') {
    const result = await update();
    console.log(JSON.stringify({ ok: true, generated_at: result.snapshot.generated_at, errors: result.snapshot.errors, paths: result.paths }, null, 2));
    return;
  }
  if (cmd === 'summary') {
    const data = JSON.parse(await fs.readFile(LATEST, 'utf8'));
    console.log(JSON.stringify({ generated_at: data.generated_at, quick_view: data.quick_view, errors: data.errors }, null, 2));
    return;
  }
  const app = express();
  app.get('/', (req, res) => res.type('text/plain').send('market runner alive. Use /api/all'));
  app.get('/api/health', (req, res) => res.json({ ok: true, endpoint: '/api/all' }));
  app.get('/api/all', async (req, res) => {
    try {
      let data;
      try { data = JSON.parse(await fs.readFile(LATEST, 'utf8')); } catch {}
      if (!data || req.query.refresh === 'true') data = (await update()).snapshot;
      res.json(data);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
  app.get('/api/latest.json', async (req, res) => {
    try { res.json(JSON.parse(await fs.readFile(LATEST, 'utf8'))); }
    catch { res.status(404).json({ ok: false, error: 'run npm run update first' }); }
  });
  app.post('/api/update', async (req, res) => {
    try {
      const result = await update();
      res.json({ ok: true, generated_at: result.snapshot.generated_at, errors: result.snapshot.errors, paths: result.paths });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
  app.listen(PORT, HOST, () => {
    console.log('market API on http://' + HOST + ':' + PORT);
    if (process.env.AUTO_UPDATE_ON_START === 'true') update().catch(console.error);
    const min = Number(process.env.UPDATE_INTERVAL_MINUTES || 360);
    if (min > 0) setInterval(() => update().catch(console.error), min * 60000).unref();
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
