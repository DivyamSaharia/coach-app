// Coach rest alerts: the phone tells this Worker when a rest ends; a Durable Object alarm sends a Web Push at that moment,
// so the "Rest is over" notification reaches the lock screen even while iOS has the app paused.
// One Durable Object per phone (named from its push endpoint) holds at most one pending alert. Another one, "__keys__",
// makes and keeps the VAPID key pair the first time it's needed. Nothing else is stored: no training data comes here.
import { DurableObject } from 'cloudflare:workers';
import { newVapidKeys, sendPush } from './webpush.js';

const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];
const MAX_AHEAD = 30 * 60 * 1000; // a rest is never longer than this

export class Timer extends DurableObject {
  async keys() {
    let k = await this.ctx.storage.get('vapid');
    if (!k) { k = await newVapidKeys(); await this.ctx.storage.put('vapid', k); }
    return k;
  }
  async schedule(job) {
    const now = job.now; delete job.now;
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.setAlarm(job.at);
    // option A: a "Resting – back at …" notification right away; the alarm's "Rest over" replaces it (same tag)
    let sent = null;
    if (now) {
      try {
        const keys = await this.env.TIMER.get(this.env.TIMER.idFromName('__keys__')).keys();
        const r = await sendPush(job.sub, { title: now.title, body: now.body, tag: 'coach-rest', kind: 'resting' }, keys, this.env.SUBJECT);
        sent = r.status; if (r.status >= 400) console.log('resting push failed', r.status, r.text);
      } catch (e) { sent = 0; }
    }
    return { ok: true, at: job.at, resting: sent };
  }
  async cancel() {
    await this.ctx.storage.deleteAll();
    return { ok: true };
  }
  async alarm() {
    const job = await this.ctx.storage.get('job');
    await this.ctx.storage.deleteAll();
    if (!job || Date.now() - job.at > 60 * 1000) return; // came far too late to be any use
    const keys = await this.env.TIMER.get(this.env.TIMER.idFromName('__keys__')).keys();
    const r = await sendPush(job.sub, { title: job.title, body: job.body, tag: 'coach-rest', kind: 'over' }, keys, this.env.SUBJECT);
    if (r.status >= 400) console.log('push failed', r.status, r.text);
  }
}

const cors = (req, env) => {
  const o = req.headers.get('Origin') || '';
  const ok = (env.ALLOW_ORIGINS || '').split(',').map(s => s.trim()).includes(o);
  return { 'Access-Control-Allow-Origin': ok ? o : 'null', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' };
};
const json = (data, status, headers) => new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
function validSub(sub, env) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return false;
  let u; try { u = new URL(sub.endpoint); } catch (e) { return false; }
  if (u.protocol !== 'https:' && !(env.TEST_PUSH_HOST && u.host === env.TEST_PUSH_HOST)) return false;
  return PUSH_HOSTS.some(rx => rx.test(u.hostname)) || (!!env.TEST_PUSH_HOST && u.host === env.TEST_PUSH_HOST);
}
const clip = (s, n) => String(s || '').slice(0, n);

export default {
  async fetch(req, env) {
    const h = cors(req, env); const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    try {
      if (req.method === 'GET' && url.pathname === '/key') {
        const k = await env.TIMER.get(env.TIMER.idFromName('__keys__')).keys();
        return json({ key: k.pub }, 200, h);
      }
      if (req.method !== 'POST') return json({ error: 'not found' }, 404, h);
      const body = await req.json().catch(() => null);
      if (!body) return json({ error: 'bad json' }, 400, h);
      const endpoint = body.sub ? body.sub.endpoint : body.endpoint;
      if (typeof endpoint !== 'string' || endpoint.length > 1000) return json({ error: 'bad endpoint' }, 400, h);
      const stub = env.TIMER.get(env.TIMER.idFromName('sub:' + endpoint));
      if (url.pathname === '/schedule') {
        if (!validSub(body.sub, env)) return json({ error: 'bad subscription' }, 400, h);
        const now = Date.now(); const at = Number(body.at);
        if (!Number.isFinite(at) || at < now - 5000 || at > now + MAX_AHEAD) return json({ error: 'bad time' }, 400, h);
        const sub = { endpoint, keys: { p256dh: clip(body.sub.keys.p256dh, 200), auth: clip(body.sub.keys.auth, 100) } };
        const nowMsg = body.now && typeof body.now === 'object' && body.now.title ? { title: clip(body.now.title, 60), body: clip(body.now.body, 160) } : null;
        return json(await stub.schedule({ sub, at: Math.max(at, now), title: clip(body.title, 60) || 'Rest over', body: clip(body.body, 160) || 'Time for your next set.', ...(nowMsg ? { now: nowMsg } : {}) }), 200, h);
      }
      if (url.pathname === '/cancel') return json(await stub.cancel(), 200, h);
      return json({ error: 'not found' }, 404, h);
    } catch (e) {
      return json({ error: 'server error' }, 500, h);
    }
  },
};
