// Browser stand-in for the parts of Node's crypto the payment mock uses (HMAC-SHA256, constant-time
// compare, UUIDs), so the page runs the SAME signed-webhook code path as the server.
const { sha256 } = require('js-sha256');

exports.createHmac = (algorithm, key) => {
  const h = sha256.hmac.create(key);
  return { update(data) { h.update(data); return this; }, digest() { return h.hex(); } };
};
exports.timingSafeEqual = (a, b) => {
  if (a.length !== b.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
};
exports.randomUUID = () => globalThis.crypto.randomUUID();

// Used by the owner-portal sign-in (static portal demo): SHA-256 hashing and random codes/tokens.
exports.createHash = (algorithm) => {
  const h = sha256.create();
  return { update(data) { h.update(data); return this; }, digest() { return h.hex(); } };
};
const randomBytes = (n) => {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(n));
  b.toString = (enc) => {
    if (enc === 'hex') return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    if (enc === 'base64url') return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return Array.from(b).join(',');
  };
  return b;
};
exports.randomBytes = randomBytes;
exports.randomInt = (min, max) => min + (globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % (max - min));
