'use strict';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}

function weekday(iso) {
  return parseISO(iso).getUTCDay();
}

function nightsBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000);
}

function isValidISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(parseISO(s)) === s;
}

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

// "2026-10-05" -> "October 5th"
function spoken(iso) {
  const d = parseISO(iso);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${ordinal(d.getUTCDate())}`;
}

// "2026-09-30" -> "Wednesday 2026-09-30"
function describeDay(iso) {
  return `${DAYS[weekday(iso)]} ${iso}`;
}

module.exports = { DAYS, MONTH_NAMES, parseISO, toISO, addDays, weekday, nightsBetween, isValidISO, ordinal, spoken, describeDay };
