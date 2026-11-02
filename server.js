const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let dbPath = process.env.DB_PATH || 'kisan.db';
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.accessSync(path.dirname(dbPath), fs.constants.W_OK);
} catch (e) {
  console.warn('DB folder not writable, using local kisan.db');
  dbPath = 'kisan.db';
}
const db = new Database(dbPath);
db.exec(`
CREATE TABLE IF NOT EXISTS mandi(id INTEGER PRIMARY KEY, crop TEXT, place TEXT, price REAL, t INTEGER);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, uid TEXT, type TEXT, note TEXT, amt REAL, t INTEGER);
`);

const hits = new Map();
function limited(key, max) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter(x => now - x < 3600e3);
  a.push(now); hits.set(key, a);
  return a.length > max;
}
const uidOf = req => String(req.get('x-uid') || '').slice(0, 64);
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.get('/api/mandi', (req, res) =>
  res.json(db.prepare('SELECT * FROM mandi ORDER BY t DESC LIMIT 50').all()));

app.post('/api/mandi', (req, res) => {
  if (limited('m' + req.ip, 30)) return res.sendStatus(429);
  const { crop, place, price } = req.body || {};
  if (!crop || !place || !(price > 0) || crop.length > 40 || place.length > 40) return res.sendStatus(400);
  db.prepare('INSERT INTO mandi(crop,place,price,t) VALUES(?,?,?,?)').run(crop, place, price, Date.now());
  res.sendStatus(201);
});

app.get('/api/ledger', (req, res) => {
  const u = uidOf(req); if (!u) return res.sendStatus(400);
  res.json(db.prepare('SELECT * FROM ledger WHERE uid=? ORDER BY t DESC LIMIT 100').all(u));
});
app.post('/api/ledger', (req, res) => {
  const u = uidOf(req); const { type, note, amt } = req.body || {};
  if (!u || !['in', 'out'].includes(type) || !(amt > 0)) return res.sendStatus(400);
  db.prepare('INSERT INTO ledger(uid,type,note,amt,t) VALUES(?,?,?,?,?)').run(u, type, String(note || '').slice(0, 80), amt, Date.now());
  res.sendStatus(201);
});
app.delete('/api/ledger/:id', (req, res) => {
  db.prepare('DELETE FROM ledger WHERE id=? AND uid=?').run(req.params.id, uidOf(req));
  res.sendStatus(204);
});

const PROMPT = `तुम एक अनुभवी कृषि सलाहकार हो। इस फसल की फोटो देखकर सरल हिंदी में बताओ:
1) फसल का नाम
2) संभावित बीमारी या कीट
3) फोटो में दिख रहे लक्षण
4) घरेलू और जैविक उपाय
5) कब कृषि अधिकारी से मिलना चाहिए
अगर फोटो साफ़ न हो या पौधा स्वस्थ दिखे तो साफ़ बताओ। कोई markdown चिह्न मत लगाओ, छोटे वाक्य लिखो।`;

async function askGemini(model, image) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: PROMPT },
        { inline_data: { mime_type: 'image/jpeg', data: image } }
      ] }]
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data?.error?.message || ('HTTP ' + r.status));
    err.status = r.status;
    throw err;
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Google ne khali jawab diya (' + (data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown') + ')');
  return text;
}

app.post('/api/check', async (req, res) => {
  if (limited('c' + req.ip, 20)) return res.status(429).json({ error: 'बहुत ज़्यादा कोशिशें। थोड़ी देर बाद करें।' });
  const { image } = req.body || {};
  if (!image || typeof image !== 'string') return res.status(400).json({ error: 'फोटो नहीं मिली।' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'सर्वर पर API key नहीं लगी है।' });

  const models = [...new Set([process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-flash-lite-latest'].filter(Boolean))];
  let last = null;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await askGemini(model, image);
        return res.json({ text });
      } catch (e) {
        last = e;
        console.error(model + ': ' + e.message);
        if ([429, 500, 503].includes(e.status) && attempt === 0) { await sleep(2000); continue; }
        break;
      }
    }
  }
  const why = String(last && last.message || '').slice(0, 200);
  res.status(502).json({ error: 'जाँच नहीं हो पाई। कारण: ' + why });
});

app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.status === 413 ? 'फोटो बहुत बड़ी है।' : 'सर्वर में दिक्कत।' }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Kisan Saathi running on port ' + port));
