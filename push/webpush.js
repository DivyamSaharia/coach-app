// Web Push with nothing but WebCrypto: VAPID signing (RFC 8292) and payload encryption (RFC 8291, aes128gcm).
const enc = new TextEncoder();

export const b64u = {
  enc(buf) { let s = ''; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4)); return Uint8Array.from(s, c => c.charCodeAt(0)); },
};
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }

/* A new VAPID key pair: the private key as a JWK (kept by the server), the public key as base64url (given to the app). */
export async function newVapidKeys() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey));
  return { jwk, pub };
}

/* The Authorization header for one push service (aud is the endpoint's origin). */
export async function vapidAuth(endpoint, keys, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${body}`)); // raw r||s, which is what JWS wants
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${keys.pub}`;
}

/* Encrypts a payload for one subscription: one aes128gcm record, the sender's public key as the key id. */
export async function encryptPayload(sub, plaintext) {
  const uaPublic = b64u.dec(sub.keys.p256dh), authSecret = b64u.dec(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(plaintext), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

/* Sends one push. Returns the push service's status (201 = accepted; 404/410 = the subscription is gone). */
export async function sendPush(sub, payload, keys, subject, opts = {}) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST', body,
    headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(opts.ttl ?? 120), Urgency: 'high',
      Topic: opts.topic || 'coach-rest', Authorization: await vapidAuth(sub.endpoint, keys, subject) },
  });
  return { status: res.status, text: res.ok ? '' : (await res.text()).slice(0, 300) };
}
