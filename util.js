'use strict';

// Normalise an Australian mobile (04xx xxx xxx, 614..., +614...) or an
// international +number to E.164. Returns null when it isn't textable.
function normaliseMobile(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (!plus && /^04\d{8}$/.test(digits)) return `+61${digits.slice(1)}`;
  if (/^614\d{8}$/.test(digits)) return `+${digits}`;
  if (plus && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) {
    return /^61/.test(digits) && !/^614/.test(digits) ? null : `+${digits}`; // AU landlines can't receive SMS
  }
  return null;
}

// Spoken-friendly: "+61412345678" -> "ending 678"
const maskPhone = (phone) => (phone ? `ending ${phone.replace(/\D/g, '').slice(-3).split('').join(' ')}` : 'unknown');

function spokenDuration(minutes) {
  if (minutes === 60) return 'an hour';
  if (minutes > 60 && minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

// Serialises async work per key inside one process. NOTE: this does not protect
// across Lambda containers; the DynamoDB store must use conditional writes.
const chains = new Map();
function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  chains.set(key, tail);
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
  return run;
}

function dateInZone(ms, timeZone) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone });
}

module.exports = { normaliseMobile, maskPhone, spokenDuration, money, withLock, dateInZone };
