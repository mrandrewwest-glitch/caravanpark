// A tiny stand-in for Express's Router, so the REAL portal-api.js runs unchanged inside the browser page.
// Supports: router.use([path], ...fns), router.get/post/patch(path, ...fns), :params, req/res helpers the portal uses.
function compile(path) {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
}

function Router() {
  const layers = [];
  const add = (method, path, fns) => fns.forEach((fn) => layers.push({ method, path: path ? compile(path) : null, fn }));
  const router = {
    use(...args) { const path = typeof args[0] === 'string' ? args.shift() : null; add(null, path, args); return router; },
    get: (p, ...f) => { add('GET', p, f); return router; },
    post: (p, ...f) => { add('POST', p, f); return router; },
    patch: (p, ...f) => { add('PATCH', p, f); return router; },
    // Runs a request through the layers; resolves with {status, headers, body} once a handler responds.
    handle(req) {
      return new Promise((resolve) => {
        const res = makeRes(req, resolve);
        let i = 0;
        const next = (err) => {
          if (err) return res.status(500).json({ error: 'Something went wrong.' });
          while (i < layers.length) {
            const l = layers[i++];
            if (l.method && l.method !== req.method) continue;
            let params = {};
            if (l.path) { const m = l.path.re.exec(req.path); if (!m) continue; params = Object.fromEntries(l.path.keys.map((k, n) => [k, decodeURIComponent(m[n + 1])])); }
            req.params = params;
            try { const out = l.fn(req, res, next); if (out && out.catch) out.catch(() => next(true)); } catch { next(true); }
            return;
          }
          res.status(404).json({ error: 'Not found.' });
        };
        next();
      });
    },
  };
  return router;
}

function makeRes(req, resolve) {
  const headers = {}; const setCookies = []; let status = 200;
  const finish = (body) => resolve({ status, headers, setCookies, body });
  const res = {
    set(k, v) { if (typeof k === 'object') Object.entries(k).forEach(([a, b]) => { headers[a.toLowerCase()] = b; }); else headers[k.toLowerCase()] = v; return res; },
    append(k, v) { if (k.toLowerCase() === 'set-cookie') setCookies.push(v); else res.set(k, v); return res; },
    status(s) { status = s; return res; },
    json(obj) { headers['content-type'] = 'application/json; charset=utf-8'; finish(JSON.stringify(obj)); return res; },
    send(text) { finish(String(text)); return res; },
  };
  return res;
}

function express() { throw new Error('express() is not available in the browser demo'); }
express.Router = Router;
module.exports = express;
