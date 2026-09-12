// Serves the MacroMe setup UI and saves the user's plan to macrome-config.json.
// Run: npm run ui  →  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const UI_DIR = path.join(__dirname, 'ui');
const CONFIG_PATH = path.join(__dirname, 'macrome-config.json');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath === '/api/config') {
    if (req.method === 'GET') {
      if (!fs.existsSync(CONFIG_PATH)) return sendJson(res, 404, { error: 'No plan saved yet' });
      return sendJson(res, 200, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const config = JSON.parse(body);
          if (!config.macros || !Array.isArray(config.meals) || !config.budget || !Array.isArray(config.days) || !Array.isArray(config.addresses) || !Array.isArray(config.schedule)) {
            return sendJson(res, 400, { error: 'Config is missing required sections' });
          }
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
          console.log(`Saved plan → ${CONFIG_PATH}`);
          sendJson(res, 200, { ok: true });
        } catch {
          sendJson(res, 400, { error: 'Invalid JSON' });
        }
      });
      return;
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  const file = path.normalize(path.join(UI_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(UI_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`MacroMe setup running at http://localhost:${PORT}`));
