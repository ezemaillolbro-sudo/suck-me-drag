'use strict';
/* mini.js -- sous-ensemble compatible Express 4, zero dependance.
   Ne couvre PAS : res.render, app.param, res.cookie, res.format, req.is,
   urlencoded extended, multi-handlers, Express 5. */

const fs = require('fs');
const http = require('http');
const path = require('path');
const qs = require('querystring');

const MIME = {
  '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',
  '.txt':'text/plain; charset=utf-8','.json':'application/json; charset=utf-8',
  '.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.png':'image/png',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp',
  '.exe':'application/octet-stream','.bin':'application/octet-stream','.zip':'application/zip'
};

function mime(f){ return MIME[path.extname(f).toLowerCase()] || 'application/octet-stream'; }

function parseLimit(l){
  if (l == null) return 1048576;
  if (typeof l === 'number') return l;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(String(l));
  if (!m) return 1048576;
  const u = (m[2] || 'b').toLowerCase();
  return Math.floor(parseFloat(m[1]) * ({ b:1, kb:1024, mb:1048576, gb:1073741824 }[u]));
}

function typeMatch(opt, ct){
  if (opt == null) return true;
  if (opt instanceof RegExp) return opt.test(ct);
  if (typeof opt === 'function') return !!opt(ct);
  if (Array.isArray(opt)) return opt.some(t => typeMatch(t, ct));
  const s = String(opt).toLowerCase();
  if (s === '*/*' || s === '*') return true;
  if (s.indexOf('*') > -1) return new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*') + '$').test(ct);
  return ct.indexOf(s) === 0;
}

function readBody(req, limit){
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit){ const e = new Error('request entity too large'); e.status = 413; req.destroy(); return reject(e); }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function compile(pattern){
  const keys = [];
  let src = String(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })
    .replace(/\*/g, '(.*)');
  if (!src) src = '/';
  return { re: new RegExp('^' + src + '/?$'), keys };
}

function pipeFile(req, res, file, done, onOk){
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()){
      if (done) return done(err || new Error('ENOENT'));
      res.statusCode = 404;
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      return res.end('Not Found');
    }
    const headers = {
      'Content-Type': mime(file),
      'Last-Modified': st.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=0'
    };
    let start = 0, end = st.size - 1, code = 200;
    const range = req.headers.range;
    if (range){
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m){
        if (m[1] === '' && m[2] !== '') start = Math.max(0, st.size - Number(m[2]));
        else if (m[1] !== '') start = Number(m[1]);
        if (m[2] !== '' && m[1] !== '') end = Math.min(end, Number(m[2]));
        if (start <= end && start < st.size){
          code = 206;
          headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
        } else { start = 0; end = st.size - 1; }
      }
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD'){ if (done && onOk) done(null); return res.end(); }
    const s = fs.createReadStream(file, { start, end });
    s.on('error', e => { if (done) done(e); else res.destroy(); });
    if (done && onOk) s.on('end', () => done(null));
    s.pipe(res);
  });
}

function serveStatic(root, opts){
  opts = opts || {};
  const rootAbs = path.resolve(root);
  const index = opts.index === undefined ? 'index.html' : opts.index;
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p; try { p = decodeURIComponent(req.path); } catch (e) { return next(); }
    if (p.indexOf('\0') > -1) return next();
    const file = path.join(rootAbs, path.normalize(p));
    const rel = path.relative(rootAbs, file);
    if (rel.indexOf('..') === 0 || path.isAbsolute(rel)) return next();
    fs.stat(file, (err, st) => {
      if (err) return next();
      if (st.isDirectory()){ if (!index) return next(); return pipeFile(req, res, path.join(file, index), next, false); }
      if (!st.isFile()) return next();
      pipeFile(req, res, file, next, false);
    });
  };
}

function makeParser(kind, opts){
  opts = opts || {};
  const limit = parseLimit(opts.limit);
  const dflt = { json:null, urlencoded:'application/x-www-form-urlencoded', raw:'application/octet-stream', text:'text/plain' }[kind];
  return (req, res, next) => {
    if (req.body !== undefined) return next();
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let ok;
    if (opts.type) ok = typeMatch(opts.type, ct);
    else if (kind === 'json') ok = ct === 'application/json' || /\+json$/.test(ct);
    else ok = ct === dflt;
    if (!ok) return next();
    readBody(req, limit).then(buf => {
      if (!buf.length){ req.body = kind === 'raw' ? Buffer.alloc(0) : (kind === 'text' ? '' : {}); return next(); }
      if (kind === 'raw'){ req.body = buf; return next(); }
      if (kind === 'text'){ req.body = buf.toString(opts.encoding || 'utf8'); return next(); }
      if (kind === 'urlencoded'){ req.body = qs.parse(buf.toString('utf8')); return next(); }
      try { req.body = JSON.parse(buf.toString('utf8')); } catch (e){ e.status = 400; return next(e); }
      next();
    }, next);
  };
}

function createApp(){
  const stack = [];
  const settings = { 'x-powered-by': false, env: process.env.NODE_ENV || 'development' };
  function app(req, res){ return app.handle(req, res); }

  app.handle = function (req, res, done){
    const q = req.url.indexOf('?');
    req.originalUrl = req.url;
    req.path = q === -1 ? req.url : req.url.slice(0, q);
    try { req.path = decodeURIComponent(req.path); } catch (e) {}
    req.query = qs.parse(q === -1 ? '' : req.url.slice(q + 1));
    req.params = {};
    req.ip = (req.socket && req.socket.remoteAddress) || '';
    req.ips = [req.ip];
    req.hostname = String(req.headers.host || '').split(':')[0];
    req.protocol = 'http'; req.secure = false;
    req.xhr = String(req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';
    req.get = req.header = n => req.headers[String(n).toLowerCase()];
    req.accepts = () => true;

    res.req = req; res.locals = {};
    res.status = c => { res.statusCode = c; return res; };
    res.set = res.header = (k, v) => {
      if (v === undefined && k !== null && typeof k === 'object'){
        for (const n in k) if (Object.prototype.hasOwnProperty.call(k, n)) res.setHeader(n, k[n]);
        return res;
      }
      res.setHeader(k, v); return res;
    };
    res.get = k => res.getHeader(k);
    res.type = t => {
      t = String(t);
      if (t.indexOf('/') === -1) t = MIME['.' + t] || 'application/octet-stream';
      res.setHeader('Content-Type', t); return res;
    };
    res.send = body => {
      if (body === undefined || body === null) body = '';
      if (Buffer.isBuffer(body)){ if (!res.getHeader('Content-Type')) res.setHeader('Content-Type','application/octet-stream'); }
      else if (typeof body === 'object'){ return res.json(body); }
      else { body = String(body); if (!res.getHeader('Content-Type')) res.setHeader('Content-Type','text/html; charset=utf-8'); }
      res.setHeader('Content-Length', Buffer.byteLength(body));
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    };
    res.json = obj => {
      let s; try { s = JSON.stringify(obj); } catch (e){ s = '{}'; }
      if (s === undefined) s = 'null';
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type','application/json; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(s));
      if (req.method === 'HEAD') return res.end();
      return res.end(s);
    };
    res.sendStatus = c => { res.statusCode = c; return res.type('text').send(http.STATUS_CODES[c] || String(c)); };
    res.redirect = (a, b) => {
      let code = 302, loc = a;
      if (b !== undefined){ code = a; loc = b; }
      else if (res.statusCode >= 300 && res.statusCode <= 399) code = res.statusCode;
      res.statusCode = code; res.setHeader('Location', loc); return res.end();
    };
    res.sendFile = (p, opts, cb) => {
      if (typeof opts === 'function'){ cb = opts; opts = {}; }
      opts = opts || {};
      const abs = path.isAbsolute(p) ? p : path.resolve(opts.root || process.cwd(), p);
      pipeFile(req, res, abs, cb || null, true);
      return res;
    };

    if (settings['x-powered-by']) res.setHeader('X-Powered-By','Express');

    let idx = 0;
    function terminal(err){
      if (res.headersSent || res.writableEnded) return;
      if (err){
        res.statusCode = err.status || err.statusCode || 500;
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type','text/plain; charset=utf-8');
        return res.end(err.message || 'Internal Server Error');
      }
      if (done) return done();
      res.statusCode = 404;
      res.setHeader('Content-Type','text/plain; charset=utf-8');
      res.end('Not Found');
    }
    function next(err){
      if (idx >= stack.length) return terminal(err);
      const layer = stack[idx++];
      let params = null;
      if (layer.re){
        const m = layer.re.exec(req.path);
        if (!m) return next(err);
        params = {};
        for (let k = 0; k < layer.keys.length; k++) params[layer.keys[k]] = m[k + 1];
      } else if (layer.prefix && layer.prefix !== '/'){
        if (req.path !== layer.prefix && req.path.indexOf(layer.prefix + '/') !== 0) return next(err);
      }
      const isErr = layer.fn.length === 4;
      if (isErr){ if (!err) return next(err); }
      else if (err) return next(err);
      if (layer.method && layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD')) return next(err);
      const saved = req.params;
      if (params) req.params = Object.assign({}, saved, params);
      function step(e){ req.params = saved; next(e); }
      try {
        if (isErr) layer.fn(err, req, res, step);
        else layer.fn(req, res, step);
      } catch (e){ req.params = saved; next(e); }
    }
    next();
  };

  app.set = (k, v) => { settings[k] = v; return app; };
  app.enable = k => { settings[k] = true; return app; };
  app.disable = k => { settings[k] = false; return app; };
  app.enabled = k => !!settings[k];

  function route(method, p, fn){
    const c = compile(p);
    stack.push({ method, re: c.re, keys: c.keys, fn });
  }
  ['get','post','put','patch','delete','head','options'].forEach(m => {
    app[m] = (p, fn) => {
      if (m === 'get' && fn === undefined) return settings[p];
      if (typeof fn !== 'function') throw new TypeError('handler must be a function');
      return route(m.toUpperCase(), p, fn);
    };
  });
  app.all = (p, fn) => route(null, p, fn);

  app.use = (a, b) => {
    let prefix = null, fn;
    if (typeof a === 'string'){ prefix = a.replace(/\/+$/, '') || '/'; fn = b; }
    else fn = a;
    if (fn && typeof fn !== 'function' && typeof fn.handle === 'function'){
      const sub = fn;
      fn = (req, res, next) => sub.handle(req, res, next);
    }
    if (typeof fn !== 'function') throw new TypeError('app.use() requires a function');
    stack.push(prefix === null ? { fn } : { prefix, fn });
    return app;
  };

  app.listen = function (){
    const server = http.createServer(app);
    return server.listen.apply(server, arguments);
  };
  return app;
}

const express = createApp;
express.json = o => makeParser('json', o);
express.urlencoded = o => makeParser('urlencoded', o);
express.raw = o => makeParser('raw', o);
express.text = o => makeParser('text', o);
express.static = serveStatic;
express.Router = createApp;

module.exports = express;
