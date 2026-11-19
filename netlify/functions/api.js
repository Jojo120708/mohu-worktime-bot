import { getStore } from '@netlify/blobs';

const TEAMS = ['一部一课', '一部二课', '一部三课', '二部一课', '二部二课', '二部三课', '二部四课', '二部五课', '三部一课'];
const TOKEN = process.env.MOHU_TOKEN || 'f01caa8b04fdeb4a5e35f014';
const SYS_KEY = 'meta/sysdata';
const META_KEY = 'meta/info';

function pickStore(req) {
  const host = String(req.headers.get('host') || '').toLowerCase();
  const isPreview = /--/.test(host) || host.startsWith('deploy-') || /\.deploy\./.test(host);
  const name = process.env.MOHU_STORE || (isPreview ? 'mohu-preview' : 'mohu');
  return { name: name, store: getStore({ name: name, consistency: 'strong' }) };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache'
    }
  });
}

const recKey = (team, date) => 'rec/' + team + '/' + date;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function listKeys(store, prefix) {
  const all = [];
  let cursor;
  do {
    const page = await store.list({ prefix: prefix, pageSize: 1000, cursor: cursor });
    (page.blobs || []).forEach(b => all.push(b.key));
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);
  return all;
}

async function getMany(store, keys, conc) {
  const out = [], failed = [];
  let i = 0;
  const n = Math.max(1, Math.min(conc || 16, keys.length));
  const workers = [];
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (i < keys.length) {
        const k = keys[i++];
        try { const v = await store.get(k, { type: 'json' }); if (v == null) failed.push(k); else out.push(v); }
        catch (e) { failed.push(k); }
      }
    })());
  }
  await Promise.all(workers);
  return { values: out, failed: failed };
}

export default async function (req, context) {
  const u = new URL(req.url);
  const op = u.searchParams.get('op') || 'ping';
  const picked = pickStore(req);
  const store = picked.store;
  const adminOk = String(req.headers.get('x-mohu-token') || '') === TOKEN;

  try {
    if (op === 'ping') {
      return json({ ok: true, store: picked.name, time: new Date().toISOString() });
    }

    if (op === 'records') {
      const month = u.searchParams.get('month') || '';
      const team = u.searchParams.get('team') || '';
      let prefix = 'rec/';
      if (team) prefix += team + '/';
      if (team && month) prefix += month + '-';
      let keys = await listKeys(store, prefix);
      if (!team && month) keys = keys.filter(k => /\/(\d{4}-\d{2})-\d{2}$/.test(k) && k.slice(-10, -3) === month);
      const { values, failed } = await getMany(store, keys, 16);
      values.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || TEAMS.indexOf(a.teamName) - TEAMS.indexOf(b.teamName));
      return json({ ok: true, records: values, count: values.length, failed: failed.length, store: picked.name });
    }

    if (op === 'record' && req.method === 'GET') {
      const team = u.searchParams.get('team') || '';
      const date = u.searchParams.get('date') || '';
      const v = await store.get(recKey(team, date), { type: 'json' });
      return json({ ok: true, records: v ? [v] : [], count: v ? 1 : 0 });
    }

    if (op === 'index') {
      const keys = await listKeys(store, 'rec/');
      const idx = {};
      keys.forEach(k => {
        const m = /^rec\/(.+)\/(\d{4}-\d{2})-\d{2}$/.exec(k);
        if (m) idx[m[1] + '|' + m[2]] = 'api:' + k;
      });
      return json({ ok: true, index: idx, count: keys.length, store: picked.name });
    }

    if (op === 'sysdata') {
      const v = await store.get(SYS_KEY, { type: 'json' });
      const list = (v && v.sysdata) || [];
      return json({ ok: true, sysdata: list, count: list.length });
    }

    if (req.method === 'POST' && op === 'record') {
      const rec = await req.json();
      if (!rec || !rec.teamName || !isDate(rec.date)) return json({ ok: false, error: 'bad_record' }, 400);
      await store.setJSON(recKey(rec.teamName, rec.date), rec);
      const info = await store.get(META_KEY, { type: 'json' }).catch(() => null);
      await store.setJSON(META_KEY, Object.assign({ writes: 0, updatedAt: '' }, info || {}, { writes: ((info && info.writes) || 0) + 1, lastKey: recKey(rec.teamName, rec.date), updatedAt: new Date().toISOString() }));
      return json({ ok: true, key: recKey(rec.teamName, rec.date) });
    }

    if (req.method === 'POST' && op === 'delete') {
      const body = await req.json();
      if (!body || !body.teamName || !isDate(body.date)) return json({ ok: false, error: 'bad_request' }, 400);
      await store.delete(recKey(body.teamName, body.date));
      return json({ ok: true, deleted: recKey(body.teamName, body.date) });
    }

    if (req.method === 'POST' && op === 'sysdata') {
      const body = await req.json();
      const list = (body && body.sysdata) || [];
      if (!Array.isArray(list)) return json({ ok: false, error: 'bad_sysdata' }, 400);
      await store.setJSON(SYS_KEY, { sysdata: list, savedAt: new Date().toISOString() });
      return json({ ok: true, count: list.length });
    }

    if (req.method === 'POST' && op === 'import') {
      if (!adminOk) return json({ ok: false, error: 'need_token' }, 401);
      const body = await req.json();
      const list = (body && body.records) || [];
      let n = 0; const errors = [];
      for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        if (!rec || !rec.teamName || !isDate(rec.date)) { errors.push(i); continue; }
        try { await store.setJSON(recKey(rec.teamName, rec.date), rec); n++; }
        catch (e) { errors.push(i); }
      }
      return json({ ok: true, written: n, skipped: errors.length, store: picked.name });
    }

    if (req.method === 'POST' && op === 'importsys') {
      if (!adminOk) return json({ ok: false, error: 'need_token' }, 401);
      const body = await req.json();
      const list = (body && body.sysdata) || [];
      await store.setJSON(SYS_KEY, { sysdata: list, savedAt: new Date().toISOString() });
      return json({ ok: true, count: list.length, store: picked.name });
    }

    if (req.method === 'POST' && op === 'clear') {
      if (!adminOk) return json({ ok: false, error: 'need_token' }, 401);
      const keys = await listKeys(store, 'rec/');
      let n = 0;
      for (let i = 0; i < keys.length; i++) { try { await store.delete(keys[i]); n++; } catch (e) { } }
      return json({ ok: true, cleared: n, store: picked.name });
    }

    if (op === 'stats') {
      const keys = await listKeys(store, 'rec/');
      const { values } = await getMany(store, keys, 16);
      const byMonth = {}, byTeam = {};
      let hours = 0, sys = 0;
      values.forEach(r => {
        const m = String(r.date || '').slice(0, 7);
        byMonth[m] = (byMonth[m] || 0) + 1;
        byTeam[r.teamName] = (byTeam[r.teamName] || 0) + 1;
        hours += Number(r.mohuTotal) || 0;
        sys += Number(r.sysMohu) || 0;
      });
      const sy = await store.get(SYS_KEY, { type: 'json' }).catch(() => null);
      return json({
        ok: true, store: picked.name, records: values.length,
        hours: Math.round(hours * 10) / 10, sys: Math.round(sys * 10) / 10,
        coverage: sys > 0 ? Math.round(hours / sys * 1000) / 10 : null,
        byMonth: byMonth, byTeam: byTeam, sysdataRows: ((sy && sy.sysdata) || []).length,
        maxRecordKB: Math.round(Math.max.apply(null, values.map(v => JSON.stringify(v).length)) / 1024 * 10) / 10
      });
    }

    return json({ ok: false, error: 'unknown_op', op: op }, 404);
  } catch (e) {
    if (context && context.log) context.log('api error', e && e.stack);
    return json({ ok: false, error: String((e && e.message) || e), store: picked.name }, 500);
  }
}
