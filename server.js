// Serveur cloud ESP32-CAM : photo + streaming (MJPEG) + texte dans les 2 sens
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const WEB_PASSWORD = process.env.WEB_PASSWORD || "";

// ===== ETAT =====
let pendingPhoto = false;
let streaming = false;
let streamStart = 0;
let lastPhoto = null;
let photoVersion = 0;
let lastSeen = 0;
const viewers = new Set();

let pendingText = null;   // texte page web -> ESP32
let messages = [];        // textes ESP32 -> page web
let msgId = 0;

// ===== SECURITE (optionnelle) =====
function deviceAuth(req, res, next) {
  if (!API_KEY || req.get("x-api-key") === API_KEY) return next();
  res.status(401).json({ error: "cle invalide" });
}

function webAuth(req, res, next) {
  if (!WEB_PASSWORD) return next();
  const [type, b64] = (req.headers.authorization || "").split(" ");
  if (type === "Basic" && b64) {
    const pass = Buffer.from(b64, "base64").toString().split(":").slice(1).join(":");
    if (pass === WEB_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="ESP32-CAM"').status(401).send("Mot de passe requis");
}

// ===== ROUTES POUR L'ESP32 =====
const rawJpeg = express.raw({ type: "image/jpeg", limit: "3mb" });
const rawText = express.text({ type: "text/plain", limit: "10kb" });

// L'ESP32 demande s'il doit agir
app.get("/api/poll", deviceAuth, (req, res) => {
  lastSeen = Date.now();
  const photo = pendingPhoto;
  const text = pendingText;
  pendingPhoto = false;
  pendingText = null; // livre une seule fois
  res.json({ photo, stream: streaming, text });
});

// L'ESP32 envoie une photo
app.post("/api/photo", deviceAuth, rawJpeg, (req, res) => {
  lastSeen = Date.now();
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    lastPhoto = req.body;
    photoVersion++;
  }
  res.json({ ok: true });
});

// L'ESP32 envoie une image du streaming
app.post("/api/frame", deviceAuth, rawJpeg, (req, res) => {
  lastSeen = Date.now();
  if (Date.now() - streamStart > 10 * 60 * 1000) streaming = false; // 10 min max
  const buf = req.body;
  if (Buffer.isBuffer(buf) && buf.length > 0) {
    for (const v of viewers) {
      v.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`);
      v.write(buf);
      v.write("\r\n");
    }
  }
  res.json({ stream: streaming });
});

// L'ESP32 envoie un texte
app.post("/api/data", deviceAuth, rawText, (req, res) => {
  lastSeen = Date.now();
  const t = typeof req.body === "string" ? req.body.trim().slice(0, 500) : "";
  if (t) {
    messages.push({ id: ++msgId, text: t, time: Date.now() });
    if (messages.length > 50) messages.shift();
  }
  res.json({ ok: true });
});

// ===== ROUTES POUR LA PAGE WEB =====
app.use(webAuth);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/command", (req, res) => {
  const cmd = req.body && req.body.cmd;
  if (cmd === "photo") pendingPhoto = true;
  else if (cmd === "stream-start") { streaming = true; streamStart = Date.now(); }
  else if (cmd === "stream-stop") streaming = false;
  else return res.status(400).json({ error: "commande inconnue" });
  res.json({ ok: true });
});

// Page web -> ESP32 (texte)
app.post("/api/text", (req, res) => {
  const t = String((req.body && req.body.text) || "").trim().slice(0, 200);
  if (!t) return res.status(400).json({ error: "texte vide" });
  pendingText = t;
  res.json({ ok: true });
});

// ESP32 -> page web (lecture des messages)
app.get("/api/messages", (req, res) => {
  const since = Number(req.query.since) || 0;
  res.json(messages.filter(m => m.id > since));
});

app.get("/api/status", (req, res) => {
  res.json({
    online: Date.now() - lastSeen < 8000,
    streaming,
    photoVersion,
    hasPhoto: !!lastPhoto,
  });
});

app.get("/api/photo/latest", (req, res) => {
  if (!lastPhoto) return res.status(404).send("Aucune photo");
  res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
  res.send(lastPhoto);
});

app.get("/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  viewers.add(res);
  req.on("close", () => {
    viewers.delete(res);
    if (viewers.size === 0) streaming = false;
  });
});

app.listen(PORT, () => console.log("Serveur demarre sur le port " + PORT));
