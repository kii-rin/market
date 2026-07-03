const { spawn } = require('node:child_process');

const PORT = Number(process.env.SMOKE_PORT || 3123);
const BASE = 'http://127.0.0.1:' + PORT;
const LIVE = process.env.LIVE_SMOKE === 'true';

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getJson(path) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(path + ' returned ' + res.status);
  return await res.json();
}

async function waitForServer() {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 20000) {
    try {
      const health = await getJson('/api/health');
      if (health && health.ok && health.endpoint === '/api/all') return;
    } catch (error) {
      lastError = error;
    }
    await wait(500);
  }
  throw lastError || new Error('server did not become ready');
}

async function run() {
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      UPDATE_INTERVAL_MINUTES: '0',
      AUTO_UPDATE_ON_START: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', data => process.stdout.write('[server] ' + data));
  child.stderr.on('data', data => process.stderr.write('[server] ' + data));

  try {
    await waitForServer();

    const allPath = LIVE ? '/api/all?refresh=true' : '/api/all';
    const all = await getJson(allPath);

    if (!all || typeof all !== 'object') throw new Error('/api/all did not return an object');
    if (all.api_endpoint !== '/api/all') throw new Error('api_endpoint missing or wrong');
    if (!all.quick_view || typeof all.quick_view !== 'object') throw new Error('quick_view missing');

    if (LIVE) {
      if (!all.generated_at) throw new Error('generated_at missing after live refresh');
      if (!all.fx || !Array.isArray(all.fx.pairs)) throw new Error('fx.pairs missing after live refresh');
      if (!Array.isArray(all.series) || all.series.length < 5) throw new Error('not enough public series returned');
    }

    console.log(JSON.stringify({ ok: true, live: LIVE, endpoint: '/api/all' }, null, 2));
  } finally {
    child.kill('SIGTERM');
  }
}

run().catch(error => {
  fail(error.stack || error.message);
});
