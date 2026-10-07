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
