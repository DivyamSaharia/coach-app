// Coach rest alerts: the phone tells this Worker when a rest ends; a Durable Object alarm sends a Web Push at that moment,
// so the "Rest is over" notification reaches the lock screen even while iOS has the app paused.
// One Durable Object per phone (named from its push endpoint) holds at most one pending alert. Another one, "__keys__",
// makes and keeps the VAPID key pair the first time it's needed. Nothing else is stored: no training data comes here.
// Round 4: if the PUSHWARD_KEY secret is set, each rest also runs a live countdown (an iOS Live Activity) on the lock screen through
// PushWard (pushward.app), one activity with the slug "coach-rest". PushWard gets only the next-set line, the end time and the
// rest-over line. When that works, the quiet "Resting" push is skipped; "Rest over" still comes from the alarm below for the buzz.
// When it fails (no key, no quota, PushWard down), the rest falls back to option A: the "Resting" push as before.
import { DurableObject } from 'cloudflare:workers';
import { newVapidKeys, sendPush } from './webpush.js';

const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9.-]+\.notify\.windows\.com$/];
const MAX_AHEAD = 30 * 60 * 1000; // a rest is never longer than this
const PW = 'https://api.pushward.app/activities';
const PW_SLUG = 'coach-rest';
const PW_LINGER = 60; // seconds the ended "Rest over" card stays on the lock screen
async function pw(env, method, path, body) {
  const r = await fetch(PW + path, { method, headers: { Authorization: 'Bearer ' + env.PUSHWARD_KEY, 'Content-Type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  if (r.status >= 400) console.log('pushward', method, path, r.status, (await r.text().catch(() => '')).slice(0, 200));
  return r.status;
}
/* Starts the countdown, or moves its end time if one is already running (the next set ticked early, +15 s). Returns the HTTP status (0 = no call). */
async function liveStart(env, at, la) {
  if (!env.PUSHWARD_KEY || !la) return 0;
  const now = Date.now();
  const patch = { state: 'ongoing', priority: 8, dismissal_ttl: PW_LINGER, content: {
    template: 'timer', progress: 0, icon: 'dumbbell.fill', accent_color: '#FF6A2B',
    state: la.state, subtitle: la.subtitle, completion_message: la.done,
    start_date: Math.floor(Math.min(now, at) / 1000), end_date: Math.ceil(at / 1000) } };
  let st = await pw(env, 'PATCH', '/' + PW_SLUG, patch);
  if (st === 404) { // first ever rest: make the activity once, then start it
    st = await pw(env, 'POST', '', { slug: PW_SLUG, name: 'Coach rest', priority: 8, dismissal_ttl: PW_LINGER });
    if (st < 300) st = await pw(env, 'PATCH', '/' + PW_SLUG, patch);
  }
  return st;
}
const liveEnd = env => pw(env, 'PATCH', '/' + PW_SLUG, { state: 'ended', dismissal_ttl: 0 });

export class Timer extends DurableObject {
  async keys() {
    let k = await this.ctx.storage.get('vapid');
    if (!k) { k = await newVapidKeys(); await this.ctx.storage.put('vapid', k); }
    return k;
  }
  async schedule(job) {
    const now = job.now; delete job.now; const la = job.la; delete job.la;
    await this.ctx.storage.put('job', job);
    await this.ctx.storage.setAlarm(job.at);
    // round 4: the live countdown first; if PushWard takes it, the "Resting" push isn't needed
    const prev = await this.ctx.storage.get('liveUntil');
    let live = 0;
    try { live = await liveStart(this.env, job.at, la); } catch (e) { live = -1; console.log('pushward failed', String(e)); }
    const liveOk = live >= 200 && live < 300;
    if (liveOk) await this.ctx.storage.put('liveUntil', job.at);
    else {
      await this.ctx.storage.delete('liveUntil');
      // live countdown turned off (or failing) while one is still on screen: don't leave it counting a rest that has moved
      if (prev && Date.now() < prev && this.env.PUSHWARD_KEY) { try { await liveEnd(this.env); } catch (e) {} }
    }
    // option A: a "Resting – back at …" notification right away; the alarm's "Rest over" replaces it (same tag)
    let sent = null;
    if (now && !liveOk) {
      try {
        const keys = await this.env.TIMER.get(this.env.TIMER.idFromName('__keys__')).keys();
        const r = await sendPush(job.sub, { title: now.title, body: now.body, tag: 'coach-rest', kind: 'resting' }, keys, this.env.SUBJECT);
        sent = r.status; if (r.status >= 400) console.log('resting push failed', r.status, r.text);
      } catch (e) { sent = 0; }
    }
    return { ok: true, at: job.at, resting: sent, live };
  }
  async cancel() {
    // a skipped or finished rest: take the countdown off the lock screen too, if one is still running
    const until = await this.ctx.storage.get('liveUntil');
    await this.ctx.storage.deleteAll();
    let live = 0;
    if (until && Date.now() < until && this.env.PUSHWARD_KEY) { try { live = await liveEnd(this.env); } catch (e) { live = -1; } }
    return { ok: true, live };
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
        return json({ key: k.pub, live: !!env.PUSHWARD_KEY }, 200, h);
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
        const la = body.la && typeof body.la === 'object' && body.la.state ? { state: clip(body.la.state, 80), subtitle: clip(body.la.subtitle, 80), done: clip(body.la.done, 80) || 'Rest over' } : null;
        return json(await stub.schedule({ sub, at: Math.max(at, now), title: clip(body.title, 60) || 'Rest over', body: clip(body.body, 160) || 'Time for your next set.', ...(nowMsg ? { now: nowMsg } : {}), ...(la ? { la } : {}) }), 200, h);
      }
      if (url.pathname === '/cancel') return json(await stub.cancel(), 200, h);
      return json({ error: 'not found' }, 404, h);
    } catch (e) {
      return json({ error: 'server error' }, 500, h);
    }
  },
};
