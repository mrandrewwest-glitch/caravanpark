'use strict';

// Safety net: callers sometimes read out card numbers. Strip anything that looks
// like a card number (13-19 digits passing the Luhn check) BEFORE it is stored,
// logged or sent to Claude. Limitation: digits spoken as words ("four two...")
// reach us only if the transcriber writes them as words, which this won't catch.
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function redactCardNumbers(text) {
  let redacted = false;
  const out = text.replace(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      redacted = true;
      return '[card number removed]';
    }
    return m;
  });
  return { text: out, redacted };
}

module.exports = { redactCardNumbers, luhn };
