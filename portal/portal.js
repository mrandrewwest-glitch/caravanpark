/* OnSite owner portal. Plain JavaScript, no libraries. Every piece of text from the server is inserted with
   textContent / createTextNode (never as HTML), so a caller's name cannot inject script. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var state = { me: null, tz: 'Australia/Sydney' };

  // ---------- small helpers ----------
  function h(tag, props) {
    var node = document.createElement(tag);
    var kids = Array.prototype.slice.call(arguments, 2);
    Object.keys(props || {}).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    kids.forEach(function add(c) {
      if (Array.isArray(c)) c.forEach(add);
      else if (c !== null && c !== undefined && c !== false) node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function money(n, cur) { return new Intl.NumberFormat('en-AU', { style: 'currency', currency: cur || 'AUD', minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n); }
  function when(ms) { return ms ? new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: state.tz }).format(new Date(ms)) : ''; }
  function day(iso) { return iso ? new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z')) : ''; }
  function monthName(m) { var p = m.split('-'); return new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(+p[0], +p[1] - 1, 1))); }
  function dur(s) { if (s === null || s === undefined) return ''; return s >= 60 ? Math.floor(s / 60) + ' min ' + (s % 60) + ' s' : s + ' s'; }
  function telHref(n) { return 'tel:' + String(n || '').replace(/[^0-9+]/g, ''); }
  var OUTCOME = { in_progress: 'In progress', answered: 'Answered', booking: 'Booking made', message: 'Message taken', transferred: 'Transferred to staff', hung_up: 'Hung up quickly', spam: 'Spam', problem: 'Technical problem' };
  var STATUS = { held: 'Held, unpaid', confirmed: 'Confirmed', expired: 'Expired, released', released: 'Released', refunded: 'Refunded', open: 'To call back', done: 'Called back' };
  function pill(kind, text) { return h('span', { class: 'pill ' + kind, text: text }); }
  function recentMonths(n) { var out = []; var d = new Date(); var y = +new Intl.DateTimeFormat('en-CA', { year: 'numeric', timeZone: state.tz }).format(d); var m = +new Intl.DateTimeFormat('en-CA', { month: 'numeric', timeZone: state.tz }).format(d); for (var i = 0; i < n; i++) { out.push(y + '-' + (m < 10 ? '0' : '') + m); m -= 1; if (m === 0) { m = 12; y -= 1; } } return out; }

  async function api(method, path, body) {
    var res;
    try {
      res = await fetch('/portal/api' + path, { method: method, credentials: 'same-origin', headers: { 'x-requested-with': 'onsite-portal', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) { throw { message: 'Could not reach the server. Check your connection and try again.' }; }
    var json = null;
    try { json = await res.json(); } catch (e) { /* no body */ }
    if (res.status === 401 && json && json.error === 'signed_out') { state.me = null; showLogin('You have been signed out. Please sign in again.'); throw { signedOut: true, message: 'Signed out' }; }
    if (!res.ok) throw { status: res.status, message: (json && (json.error || (json.errors && json.errors.join(' ')))) || 'Something went wrong.', errors: json && json.errors };
    return json;
  }

  // ---------- sign in ----------
  function showLogin(notice) {
    clear(app);
    var email = h('input', { type: 'email', id: 'email', autocomplete: 'username', required: true, maxlength: '120', placeholder: 'you@yourpark.com.au' });
    var msg = h('div', { role: 'status' });
    var card = h('form', { class: 'login-card', novalidate: true });
    var step = 'email';
    function say(kind, text) { clear(msg); if (text) msg.appendChild(h('div', { class: 'banner ' + kind, text: text })); }
    function renderEmail() {
      clear(card);
      card.appendChild(h('div', { class: 'brand' }, h('span', { text: 'On' }), 'Site'));
      card.appendChild(h('h1', { text: 'Park owner sign-in' }));
      card.appendChild(h('p', { class: 'muted', text: 'Enter the email address your park is registered with. We will email you a 6-digit code. No password needed.' }));
      card.appendChild(h('div', { class: 'field' }, h('label', { for: 'email', text: 'Email address' }), email));
      card.appendChild(msg);
      card.appendChild(h('button', { class: 'btn primary', type: 'submit', text: 'Email me a code' }));
      email.focus();
    }
    function renderCode() {
      clear(card);
      var code = h('input', { type: 'text', id: 'code', class: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '8', pattern: '[0-9 ]*', required: true });
      card.appendChild(h('div', { class: 'brand' }, h('span', { text: 'On' }), 'Site'));
      card.appendChild(h('h1', { text: 'Enter your code' }));
      card.appendChild(h('p', { class: 'muted', text: 'If ' + email.value.trim() + ' is registered, a code is on its way. It lasts 10 minutes.' }));
      card.appendChild(h('div', { class: 'field' }, h('label', { for: 'code', text: '6-digit code' }), code));
      card.appendChild(msg);
      card.appendChild(h('button', { class: 'btn primary', type: 'submit', text: 'Sign in' }));
      card.appendChild(h('button', { class: 'btn link', type: 'button', text: 'Use a different email, or send a new code', onclick: function () { step = 'email'; say('', ''); renderEmail(); } }));
      code.focus();
    }
    card.addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = card.querySelector('button[type="submit"]'); btn.disabled = true;
      try {
        if (step === 'email') {
          var r = await api('POST', '/auth/request', { email: email.value });
          if (r.devCode) { step = 'code'; renderCode(); say('info', 'Demo mode: your code is ' + r.devCode); }
          else { step = 'code'; renderCode(); }
        } else {
          await api('POST', '/auth/verify', { email: email.value, code: card.querySelector('#code').value });
          await boot();
          return;
        }
      } catch (err) { if (!err.signedOut) say('bad', err.message); }
      btn.disabled = false;
    });
    renderEmail();
    if (notice) say('info', notice);
    app.appendChild(h('div', { class: 'login' }, card));
  }

  // ---------- shell and routing ----------
  var ROUTES = [['overview', 'Overview'], ['calls', 'Calls'], ['bookings', 'Bookings'], ['messages', 'Call-backs'], ['billing', 'Billing'], ['settings', 'Settings'], ['activity', 'Activity']];

  function shell() {
    clear(app);
    var content = h('main', { id: 'content', tabindex: '-1' });
    var nav = h('nav', { class: 'tabs', 'aria-label': 'Sections' }, ROUTES.map(function (r) { return h('a', { href: '#/' + r[0], 'data-route': r[0], text: r[1] }); }));
    app.appendChild(h('div', { class: 'shell' },
      h('header', { class: 'topbar' },
        h('div', {}, h('div', { class: 'brand' }, h('span', { text: 'On' }), 'Site'), h('div', { class: 'muted small', text: state.me.park.name })),
        h('div', { class: 'who' }, h('span', { text: state.me.email }), h('button', { class: 'btn small', type: 'button', text: 'Sign out', onclick: signOut }))),
      nav, content));
    return { nav: nav, content: content };
  }

  async function signOut() { try { await api('POST', '/auth/logout', {}); } catch (e) { /* already signed out */ } state.me = null; showLogin('You have signed out.'); }

  function route() {
    if (!state.me) return;
    var parts = (location.hash || '#/overview').replace(/^#\//, '').split('/');
    var name = ROUTES.some(function (r) { return r[0] === parts[0]; }) ? parts[0] : 'overview';
    document.querySelectorAll('nav.tabs a').forEach(function (a) { if (a.getAttribute('data-route') === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    var content = document.getElementById('content');
    clear(content);
    content.appendChild(h('p', { class: 'muted', text: 'Loading...' }));
    var view = VIEWS[name];
    view(content, parts.slice(1)).catch(function (err) { if (err && err.signedOut) return; clear(content); content.appendChild(h('div', { class: 'banner bad', role: 'alert', text: (err && err.message) || 'Something went wrong.' })); });
    document.title = 'OnSite Owner Portal';
  }

  // ---------- views ----------
  var VIEWS = {};

  function callsTable(calls, withDetail) {
    if (!calls.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: 'No calls to show.' }));
    var body = h('tbody');
    calls.forEach(function (c) {
      var row = h('tr', withDetail ? { class: 'clickable', tabindex: '0', 'aria-expanded': 'false' } : {},
        h('td', { text: when(c.started_ms) }),
        h('td', {}, h('div', { text: c.caller_name || 'Unknown' }), h('div', { class: 'muted small mono', text: c.caller_phone || '' })),
        h('td', {}, pill(c.outcome, OUTCOME[c.outcome] || c.outcome), c.test ? h('div', { class: 'muted small', text: 'test call' }) : null),
        h('td', { text: c.summary }),
        h('td', { class: 'num', text: dur(c.duration_seconds) }),
        h('td', { text: c.billable ? 'Billed' : 'Not billed' }));
      body.appendChild(row);
      if (withDetail) {
        var det = null;
        var toggle = function () {
          if (det) { det.remove(); det = null; row.setAttribute('aria-expanded', 'false'); return; }
          det = h('tr', { class: 'detail' }, h('td', { colspan: '6' }, h('dl', {},
            h('dt', { text: 'Call ID' }), h('dd', { class: 'mono', text: c.id }),
            h('dt', { text: 'What happened' }), h('dd', { text: c.summary || 'No summary.' }),
            c.handoff ? [h('dt', { text: c.handoff.strategy === 'take_message' ? 'Message left' : 'Transferred' }), h('dd', { text: c.handoff.reason })] : null,
            c.bookings.length ? [h('dt', { text: 'Bookings' }), h('dd', { class: 'mono', text: c.bookings.join(', ') })] : null,
            h('dt', { text: 'Length' }), h('dd', { text: dur(c.duration_seconds) + (c.duration_source === 'estimated' ? ' (estimated)' : '') }),
            h('dt', { text: 'Billing' }), h('dd', { text: c.billable ? 'An answered call: counts towards this month\'s bill.' : 'Not billed (calls under 15 seconds, spam and tests are free).' }),
            h('dt', { text: 'Texts sent' }), h('dd', { text: String(c.texts_sent) + ' message part' + (c.texts_sent === 1 ? '' : 's') }),
            h('dt', { text: 'Recording' }), h('dd', { class: 'muted', text: 'Transcripts are not kept in the portal.' }))));
          row.after(det); row.setAttribute('aria-expanded', 'true');
        };
        row.addEventListener('click', toggle);
        row.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      }
    });
    return h('div', { class: 'table-wrap' }, h('table', {}, h('caption', { class: 'muted small', text: '' }),
      h('thead', {}, h('tr', {}, ['When', 'Caller', 'Outcome', 'What happened', 'Length', 'Billing'].map(function (t, i) { return h('th', { class: i === 4 ? 'num' : '', text: t }); }))), body));
  }

  VIEWS.overview = async function (el) {
    var o = await api('GET', '/overview');
    clear(el);
    el.appendChild(h('div', { class: 'head' }, h('h2', { text: 'This month so far' }), h('span', { class: 'muted', text: monthName(o.month) })));
    var tile = function (n, l, link) { return h('div', { class: 'tile' }, h('div', { class: 'n', text: n }), h('div', { class: 'l', text: l }), link ? h('a', { href: link[0], text: link[1] }) : null); };
    el.appendChild(h('div', { class: 'tiles' },
      tile(String(o.calls_this_month), 'Calls answered', ['#/calls', 'See the call log']),
      tile(String(o.bookings_this_month), 'Bookings made by OnSite', ['#/bookings', 'See bookings']),
      tile(money(o.confirmed_value, o.currency), 'Paid and confirmed', null),
      tile(String(o.unpaid_holds), 'Held, waiting for payment', ['#/bookings', 'See bookings']),
      tile(String(o.open_messages), 'People waiting for a call back', ['#/messages', 'Open call-backs']),
      tile(money(o.bill_so_far, o.currency), 'Your bill so far (before GST)', ['#/billing', 'Billing history'])));
    if (o.open_messages) el.appendChild(h('div', { class: 'banner info', text: o.open_messages + (o.open_messages === 1 ? ' person is' : ' people are') + ' waiting for you to call them back.' }));
    el.appendChild(h('h3', { text: 'Latest calls' }));
    el.appendChild(callsTable(o.recent_calls, false));
  };

  VIEWS.calls = async function (el) {
    var months = recentMonths(12);
    var monthSel = h('select', { id: 'month' }, months.map(function (m) { return h('option', { value: m, text: monthName(m) }); }));
    var outSel = h('select', { id: 'outcome' }, [h('option', { value: '', text: 'All outcomes' })].concat(Object.keys(OUTCOME).map(function (k) { return h('option', { value: k, text: OUTCOME[k] }); })));
    var holder = h('div');
    async function load() {
      clear(holder); holder.appendChild(h('p', { class: 'muted', text: 'Loading...' }));
      try {
        var r = await api('GET', '/calls?month=' + encodeURIComponent(monthSel.value) + (outSel.value ? '&outcome=' + encodeURIComponent(outSel.value) : ''));
        clear(holder);
        holder.appendChild(h('p', { class: 'muted', text: r.calls.length + (r.calls.length === 1 ? ' call' : ' calls') + ' in ' + monthName(r.month) + '. Select a call for details.' }));
        holder.appendChild(callsTable(r.calls, true));
      } catch (e) { if (!e.signedOut) { clear(holder); holder.appendChild(h('div', { class: 'banner bad', role: 'alert', text: e.message })); } }
    }
    monthSel.addEventListener('change', load); outSel.addEventListener('change', load);
    clear(el);
    el.appendChild(h('div', { class: 'head' }, h('h2', { text: 'Call log' }), h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'month', text: 'Month' }), monthSel), h('div', { class: 'field' }, h('label', { for: 'outcome', text: 'Outcome' }), outSel))));
    el.appendChild(holder);
    await load();
  };

  VIEWS.bookings = async function (el) {
    var r = await api('GET', '/bookings');
    clear(el);
    el.appendChild(h('div', { class: 'head' }, h('h2', { text: 'Bookings made by OnSite' }), h('span', { class: 'muted', text: 'Held bookings are released automatically if they are not paid in time.' })));
    if (!r.bookings.length) { el.appendChild(h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: 'No bookings yet.' }))); return; }
    var body = h('tbody');
    r.bookings.forEach(function (b) {
      body.appendChild(h('tr', {},
        h('td', { class: 'mono', text: b.ref }),
        h('td', {}, h('div', { text: b.guest || '' }), h('div', { class: 'muted small mono', text: b.mobile || '' })),
        h('td', { text: b.site }),
        h('td', { text: day(b.check_in) + ' to ' + day(b.check_out) + (b.guests ? ' · ' + b.guests + ' guests' : '') }),
        h('td', { class: 'num', text: money(b.total) }),
        h('td', {}, pill(b.status, STATUS[b.status] || b.status), b.hold_expires_ms ? h('div', { class: 'muted small', text: 'until ' + when(b.hold_expires_ms) }) : null),
        h('td', { text: when(b.created_ms) })));
    });
    el.appendChild(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Ref', 'Guest', 'Site', 'Stay', 'Total', 'Status', 'Booked'].map(function (t, i) { return h('th', { class: i === 4 ? 'num' : '', text: t }); }))), body)));
  };

  VIEWS.messages = async function (el) {
    var r = await api('GET', '/messages');
    clear(el);
    var open = r.messages.filter(function (m) { return m.status === 'open'; });
    var done = r.messages.filter(function (m) { return m.status !== 'open'; });
    function card(m) {
      var btn = h('button', { class: 'btn small' + (m.status === 'open' ? ' primary' : ''), type: 'button', text: m.status === 'open' ? 'Mark as called back' : 'Reopen', onclick: async function () {
        btn.disabled = true;
        try { await api('PATCH', '/messages/' + encodeURIComponent(m.id), { done: m.status === 'open' }); route(); } catch (e) { if (!e.signedOut) { btn.disabled = false; btn.after(h('span', { class: 'banner bad', role: 'alert', text: e.message })); } }
      } });
      return h('div', { class: 'card' },
        h('div', { class: 'row' }, h('strong', { text: m.name || 'Name not given' }), pill(m.status, STATUS[m.status])),
        h('div', {}, h('a', { href: telHref(m.number), text: m.number || 'No number' })),
        h('div', { text: m.reason }),
        m.summary ? h('div', { class: 'muted small', text: m.summary }) : null,
        h('div', { class: 'muted small', text: 'Left ' + when(m.created_ms) + (m.done_ms ? ' · called back ' + when(m.done_ms) + (m.done_by ? ' by ' + m.done_by : '') : '') }),
        h('div', { class: 'actions' }, btn));
    }
    el.appendChild(h('div', { class: 'head' }, h('h2', { text: 'Call-backs' }), h('span', { class: 'muted', text: 'People OnSite took a message for while your team was busy.' })));
    el.appendChild(open.length ? h('div', { class: 'cards' }, open.map(card)) : h('div', { class: 'panel' }, h('div', { class: 'empty', text: 'Nobody is waiting for a call back.' })));
    if (done.length) { el.appendChild(h('h3', { text: 'Called back' })); el.appendChild(h('div', { class: 'cards' }, done.map(card))); }
  };

  VIEWS.billing = async function (el, rest) {
    if (rest && rest[0]) return billingMonth(el, rest[0]);
    var r = await api('GET', '/billing');
    clear(el);
    el.appendChild(h('div', { class: 'head' }, h('h2', { text: 'Billing history' })));
    el.appendChild(h('div', { class: 'panel' },
      h('div', {}, h('strong', { text: money(r.terms.monthly_fee, r.terms.currency) + ' a month' }), ' plus ', h('strong', { text: money(r.terms.per_call, r.terms.currency) + ' for each call OnSite answers' }), '.'),
      h('div', { class: 'muted small', text: 'Amounts are before GST. A call counts when OnSite answers it and the caller stays on for at least ' + r.terms.min_call_seconds + ' seconds. Spam and test calls are free. These are statements, not tax invoices.' })));
    var body = h('tbody');
    r.statements.forEach(function (s) {
      body.appendChild(h('tr', {},
        h('td', {}, h('a', { href: '#/billing/' + s.month, text: monthName(s.month) }), s.in_progress ? h('div', { class: 'muted small', text: 'in progress' }) : null),
        h('td', { class: 'num', text: String(s.billable_calls) }),
        h('td', { class: 'num', text: money(s.usage_charges, s.currency) }),
        h('td', { class: 'num', text: money(s.monthly_fee, s.currency) }),
        h('td', { class: 'num' }, h('strong', { text: money(s.total, s.currency) })),
        h('td', {}, h('a', { href: '/portal/api/billing/' + s.month + '.csv', text: 'Download CSV' }))));
    });
    el.appendChild(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Month', 'Answered calls', 'Call charges', 'Monthly fee', 'Total', ''].map(function (t, i) { return h('th', { class: i > 0 && i < 5 ? 'num' : '', text: t }); }))), body)));
  };

  async function billingMonth(el, month) {
    var s = await api('GET', '/billing/' + encodeURIComponent(month));
    clear(el);
    el.appendChild(h('div', { class: 'head' }, h('div', {}, h('a', { href: '#/billing', text: '< All months' }), h('h2', { text: 'Statement: ' + monthName(s.month) })), h('a', { class: 'btn primary', href: '/portal/api/billing/' + s.month + '.csv', text: 'Download CSV' })));
    el.appendChild(h('div', { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 'n', text: money(s.monthly_fee, s.currency) }), h('div', { class: 'l', text: 'Monthly fee' })),
      h('div', { class: 'tile' }, h('div', { class: 'n', text: money(s.usage_charges, s.currency) }), h('div', { class: 'l', text: s.billable_calls + ' answered calls at ' + money(s.per_call_fee, s.currency) })),
      h('div', { class: 'tile' }, h('div', { class: 'n', text: money(s.total, s.currency) }), h('div', { class: 'l', text: 'Total before GST' }))));
    var nb = Object.keys(s.not_billed || {}).map(function (k) { return s.not_billed[k] + ' ' + ({ abandoned: 'hung up quickly', spam: 'spam', test: 'test', failed: 'technical problem' }[k] || k); });
    if (nb.length) el.appendChild(h('p', { class: 'muted', text: 'Not billed: ' + nb.join(', ') + '.' }));
    if (!s.lines.length) { el.appendChild(h('div', { class: 'table-wrap' }, h('div', { class: 'empty', text: 'No billable calls in this month.' }))); return; }
    var body = h('tbody');
    s.lines.forEach(function (l) { body.appendChild(h('tr', {}, h('td', { text: l.date }), h('td', { class: 'mono', text: l.call_sid }), h('td', { class: 'num', text: dur(l.duration_seconds) + (l.duration_source === 'estimated' ? ' (est.)' : '') }), h('td', { text: l.bookings ? 'Booking made' : l.handoff === 'take_message' ? 'Message taken' : l.handoff === 'live_transfer' ? 'Transferred' : 'Answered' }))); });
    el.appendChild(h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Call', 'Length', 'Outcome'].map(function (t, i) { return h('th', { class: i === 2 ? 'num' : '', text: t }); }))), body)));
  }

  VIEWS.settings = async function (el) {
    var s = await api('GET', '/settings');
    var e = s.editable;
    clear(el);
    var msg = h('div', { role: 'status' });
    var f = {
      name: h('input', { type: 'text', id: 's-name', maxlength: '60', value: e.name }),
      mode: h('select', { id: 's-mode' }, [h('option', { value: 'diversion', text: 'My team is busy: take a message and call back' }), h('option', { value: 'full', text: 'My team can take it: transfer to a person' })]),
      booking_mode: h('select', { id: 's-booking' }, [h('option', { value: 'ai_booking', text: 'OnSite books the site and sends a payment link' }), h('option', { value: 'handoff', text: 'Pass booking requests to my team' })]),
      hold: h('input', { type: 'number', id: 's-hold', min: '15', max: '1440', step: '5', value: String(e.hold_minutes) }),
      deposit: h('input', { type: 'number', id: 's-deposit', min: '10', max: '100', step: '5', value: String(e.deposit_percent) }),
      nights: h('input', { type: 'number', id: 's-nights', min: '1', max: '27', step: '1', value: String(e.max_nights) }),
      promise: h('input', { type: 'text', id: 's-promise', maxlength: '60', value: e.callback_promise }),
      numbers: h('textarea', { id: 's-numbers', rows: '3' }),
      emails: h('textarea', { id: 's-emails', rows: '3' }),
    };
    f.mode.value = e.mode; f.booking_mode.value = e.booking_mode;
    f.numbers.value = e.staff_alert_numbers.join('\n'); f.emails.value = e.staff_alert_emails.join('\n');
    var field = function (label, input, hint, cls) { return h('div', { class: 'field ' + (cls || '') }, h('label', { for: input.id, text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null); };
    var lines = function (t) { return t.split(/[\n,]/).map(function (x) { return x.trim(); }).filter(Boolean); };
    var save = h('button', { class: 'btn primary', type: 'submit', text: 'Save changes' });
    var form = h('form', { class: 'panel', novalidate: true },
      h('h3', { text: 'How OnSite handles your calls' }),
      h('div', { class: 'form' },
        field('Park name', f.name, 'Used in the texts callers receive.'),
        field('When your team cannot take a call', f.mode),
        field('Booking requests', f.booking_mode),
        field('Hold an unpaid booking for (minutes)', f.hold, 'Between 15 and 1440. Applies to the next booking.'),
        field('Payment needed now (% of the total)', f.deposit, '100 means the full amount.'),
        field('Longest stay OnSite will book itself (nights)', f.nights, 'Longer stays go to your team.'),
        field('"We will call you back..." promise', f.promise, 'Callers are told: "the team will call you back ' + e.callback_promise + '". Plain words only.', 'wide')),
      h('h3', { text: 'Who is told about bookings and call-backs' }),
      h('div', { class: 'form' },
        field('Mobile numbers for text alerts', f.numbers, 'One per line, up to 5. They receive customer names and numbers.'),
        field('Email addresses for alerts', f.emails, 'One per line, up to 5.')),
      msg, h('div', { class: 'actions' }, save));
    form.addEventListener('submit', async function (ev) {
      ev.preventDefault(); save.disabled = true; clear(msg);
      try {
        var r = await api('PATCH', '/settings', { name: f.name.value, mode: f.mode.value, booking_mode: f.booking_mode.value, hold_minutes: Number(f.hold.value), deposit_percent: Number(f.deposit.value), max_nights: Number(f.nights.value), callback_promise: f.promise.value, staff_alert_numbers: lines(f.numbers.value), staff_alert_emails: lines(f.emails.value) });
        msg.appendChild(h('div', { class: 'banner ok', text: r.changed.length ? 'Saved. The changes apply from the next call.' : 'Nothing was different, so nothing changed.' }));
        f.numbers.value = r.editable.staff_alert_numbers.join('\n'); f.emails.value = r.editable.staff_alert_emails.join('\n');
      } catch (err) {
        if (err.signedOut) return;
        var box = h('div', { class: 'banner bad', role: 'alert' }, h('strong', { text: 'Not saved. Please fix:' }), h('ul', { class: 'errors' }, (err.errors || [err.message]).map(function (x) { return h('li', { text: x }); })));
        msg.appendChild(box);
      }
      save.disabled = false;
    });
    el.appendChild(h('div', { class: 'head' }, h('h2', { text: 'Settings' })));
    el.appendChild(form);
    var fx = s.fixed;
    el.appendChild(h('div', { class: 'panel' }, h('h3', { text: 'Fixed details (contact us to change these)' }), h('dl', { class: 'facts' },
      h('dt', { text: 'Your phone number' }), h('dd', { text: fx.phone_numbers.join(', ') }),
      h('dt', { text: 'Texts are sent from' }), h('dd', { text: fx.texts_sent_from }),
      h('dt', { text: 'Time zone' }), h('dd', { text: fx.timezone }),
      h('dt', { text: 'Price' }), h('dd', { text: money(fx.monthly_fee, fx.currency) + ' a month plus ' + money(fx.per_call_fee, fx.currency) + ' per answered call, before GST' }),
      h('dt', { text: 'Park ID' }), h('dd', { class: 'mono', text: fx.park_id }))));
  };

  VIEWS.activity = async function (el) {
    var r = await api('GET', '/activity');
    clear(el);
    el.appendChild(h('div', { class: 'head' }, h('h2', { text: 'Activity' }), h('span', { class: 'muted', text: 'Sign-ins and changes made by anyone with access to this park.' })));
    if (!r.activity.length) { el.appendChild(h('div', { class: 'panel' }, h('div', { class: 'empty', text: 'Nothing yet.' }))); return; }
    var label = { name: 'Park name', mode: 'When staff are busy', booking_mode: 'Booking requests', hold_minutes: 'Hold time (minutes)', deposit_percent: 'Payment needed now (%)', max_nights: 'Longest stay (nights)', callback_promise: 'Call-back promise', staff_alert_numbers: 'Alert numbers', staff_alert_emails: 'Alert emails' };
    var show = function (v) { return Array.isArray(v) ? (v.join(', ') || 'none') : String(v); };
    el.appendChild(h('div', { class: 'panel' }, h('ul', { class: 'log' }, r.activity.map(function (a) {
      if (a.type === 'login') return h('li', {}, h('div', { text: a.by + ' signed in' }), h('div', { class: 'muted small', text: when(a.at) }));
      if (a.type === 'settings') return h('li', {}, h('div', { text: a.by + ' changed settings' }), h('ul', { class: 'errors' }, Object.keys(a.changes).map(function (k) { return h('li', { text: (label[k] || k) + ': ' + show(a.changes[k].from) + ' to ' + show(a.changes[k].to) }); })), h('div', { class: 'muted small', text: when(a.at) }));
      if (a.type === 'message_done' || a.type === 'message_reopened') return h('li', {}, h('div', { text: a.by + (a.type === 'message_done' ? ' marked ' : ' reopened ') + 'the call-back for ' + (a.name || 'a caller') }), h('div', { class: 'muted small', text: when(a.at) }));
      return h('li', {}, h('div', { text: a.type }), h('div', { class: 'muted small', text: when(a.at) }));
    }))));
  };

  // ---------- start ----------
  async function boot() {
    try { state.me = await api('GET', '/me'); } catch (e) { if (!e.signedOut) showLogin(); return; }
    state.tz = state.me.park.timezone || state.tz;
    shell();
    route();
  }
  window.addEventListener('hashchange', route);
  boot();
})();
