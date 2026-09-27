// Claude Snap bridge: receives images from a paired phone over local Wi-Fi
// and saves them into a Claude Code project folder.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 5195;
const MAX_BYTES = 25 * 1024 * 1024;
const CONFIG_PATH = path.join(__dirname, 'bridge-config.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const INBOX_DIR = path.join(os.homedir(), 'Downloads', 'claude-snap');
const RECENT_DAYS = 14;

// ---------- config ----------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return { defaultSubfolder: 'incoming', devices: [], projects: [] }; }
}
function saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); }
const config = loadConfig();

let pairing = null;          // { code, expires }
const recentImages = [];     // newest first, in-memory only
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const projectId = (folder) => sha(folder.toLowerCase()).slice(0, 12);

// ---------- Claude Code project discovery ----------
// Reads Claude Code's local session files. Not a public API, so every step
// tolerates missing or changed files and simply finds fewer projects.
function toWinPath(p) {
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);           // git-bash style /c/Users/...
  return path.normalize(m ? `${m[1].toUpperCase()}:\\${m[2]}` : p);
}
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isProjectRoot(dir) {
  return ['.git', 'package.json', 'pyproject.toml'].some((f) => fs.existsSync(path.join(dir, f)));
}
function readSlice(file, start, len) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.subarray(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}
const PATH_RE = /"(cwd|file_path)":"((?:[^"\\]|\\.)*)"/g;

// Where was this session actually working? If the session started in a
// workspace folder that holds many projects, use the subfolder of the most
// recent file/cwd activity. Returns { folder, certain }.
function projectFolderFor(transcript, rootHint) {
  const size = fs.statSync(transcript).size;
  let root = rootHint;
  if (!root) {
    const head = readSlice(transcript, 0, Math.min(size, 256 * 1024));
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head);
    if (!m) return null;
    root = toWinPath(JSON.parse(`"${m[1]}"`));
  }
  if (!isDir(root)) return null;
  if (isProjectRoot(root)) return { folder: root, certain: true };

  const tailLen = Math.min(size, 512 * 1024);
  const tail = readSlice(transcript, size - tailLen, tailLen);
  const matches = [...tail.matchAll(PATH_RE)];
  const rootLower = root.toLowerCase() + path.sep;
  for (let i = matches.length - 1; i >= 0; i--) {
    let p;
    try { p = toWinPath(JSON.parse(`"${matches[i][2]}"`)); } catch { continue; }
    if (!p.toLowerCase().startsWith(rootLower)) continue;
    const first = p.slice(rootLower.length).split(path.sep)[0];
    const candidate = path.join(root, first);
    if (first && isDir(candidate)) return { folder: candidate, certain: true };
  }
  return { folder: root, certain: false };  // workspace root, no clear subfolder
}

function runningSessions() {
  const out = new Map();  // sessionId -> { name, cwd }
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch { return out; }
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      process.kill(s.pid, 0);  // throws if the process is gone
      out.set(s.sessionId, { name: s.name, cwd: s.cwd });
    } catch { /* stale or unreadable */ }
  }
  return out;
}

function discoverProjects() {
  const running = runningSessions();
  const cutoff = Date.now() - RECENT_DAYS * 864e5;
  const transcripts = [];
  try {
    for (const d of fs.readdirSync(path.join(CLAUDE_DIR, 'projects'))) {
      const dir = path.join(CLAUDE_DIR, 'projects', d);
      if (!isDir(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
        if (mtime > cutoff) transcripts.push({ file: path.join(dir, f), id: f.slice(0, -6), mtime });
      }
    }
  } catch { /* no Claude Code data */ }
  transcripts.sort((a, b) => b.mtime - a.mtime);

  const byFolder = new Map();
  for (const t of transcripts.slice(0, 20)) {
    let found;
    try { found = projectFolderFor(t.file, running.get(t.id)?.cwd); } catch { continue; }
    if (!found) continue;
    const key = found.folder.toLowerCase();
    const prev = byFolder.get(key);
    if (prev && prev.activeAt >= t.mtime) { prev.running ||= running.has(t.id); continue; }
    byFolder.set(key, {
      folder: found.folder, certain: found.certain, activeAt: t.mtime,
      running: running.has(t.id) || !!prev?.running,
    });
  }
  return [...byFolder.values()];
}

// Discovered + manually saved projects, newest activity first.
function listProjects() {
  const merged = new Map();
  for (const d of discoverProjects()) {
    merged.set(d.folder.toLowerCase(), {
      name: path.basename(d.folder), folder: d.folder, subfolder: config.defaultSubfolder,
      activeAt: d.activeAt, running: d.running, certain: d.certain, source: 'claude',
    });
  }
  for (const m of config.projects) {
    const key = m.folder.toLowerCase();
    const d = merged.get(key);
    merged.set(key, {
      name: m.name, folder: m.folder, subfolder: m.subfolder || config.defaultSubfolder,
      activeAt: d?.activeAt || 0, running: !!d?.running, certain: true, source: 'saved',
    });
  }
  const list = [...merged.values()].sort((a, b) => b.activeAt - a.activeAt);
  list.forEach((p) => { p.id = projectId(p.folder); p.available = isDir(p.folder); });
  list.push({
    id: 'inbox', name: 'No project (Downloads inbox)', folder: INBOX_DIR, subfolder: '',
    activeAt: 0, running: false, certain: true, source: 'inbox', available: true,
  });
  return list;
}

// ---------- saving images ----------
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return null;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// Writes with the 'wx' flag so an existing file is never overwritten.
function writeUnique(dir, base, ext, buf) {
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${base}.${ext}` : `${base}-${i}.${ext}`;
    const full = path.join(dir, name);
    try { fs.writeFileSync(full, buf, { flag: 'wx' }); return full; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('Too many files with the same name');
}

function promptFor(file, project) {
  if (project.source === 'inbox') {
    return `I just sent an image from my phone. It is at:\n\n${file}\n\n` +
      `Please copy it into the current project's incoming folder if it's needed there, ` +
      `then look at it and use it as context for the current task.`;
  }
  return `I sent an image from my phone. It is located at:\n\n${file}\n\n` +
    `Please look at this image and use it as context for the current task.`;
}

function copyToClipboard(text) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::InputEncoding=[Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
      { windowsHide: true });
    ps.on('error', () => resolve(false));
    ps.on('close', (code) => resolve(code === 0));
    ps.stdin.end(text, 'utf8');
  });
}

// ---------- HTTP helpers ----------
function isLoopback(addr) { return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'; }
function isPrivate(addr) {
  const a = addr.replace(/^::ffff:/, '');
  return isLoopback(addr) || /^10\./.test(a) || /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a) || /^f[cd]/i.test(a) || /^fe80:/i.test(a);
}
// Desktop-only endpoints: loopback address AND a localhost Host header
// (blocks DNS-rebinding pages from reading the pairing code).
function isDesk(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return isLoopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '[::1]'].includes(host);
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('json only'), { status: 415 });
  return JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
}
function deviceFor(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = sha(m[1]);
  return config.devices.find((d) => d.tokenHash === h) || null;
}
function serveFile(res, file, type) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(__dirname, file)).pipe(res);
}
function lanAddress() {
  const all = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\./.test(ip) ? 2 : 3);
  return all.map((i) => i.address).sort((a, b) => rank(a) - rank(b))[0] || '127.0.0.1';
}
const publicProject = (p) => ({
  id: p.id, name: p.name, folder: p.folder, subfolder: p.subfolder, activeAt: p.activeAt,
  running: p.running, certain: p.certain, available: p.available, source: p.source,
});

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const route = `${req.method} ${url.pathname}`;

  if (!isPrivate(req.socket.remoteAddress)) { res.writeHead(403); return res.end(); }

  // Pages
  if (route === 'GET /') return isDesk(req) ? serveFile(res, 'desktop.html', 'text/html; charset=utf-8')
    : serveFile(res, 'phone.html', 'text/html; charset=utf-8');
  if (route === 'GET /phone') return serveFile(res, 'phone.html', 'text/html; charset=utf-8');

  // ---- desktop (localhost only) ----
  if (url.pathname.startsWith('/api/desk/')) {
    if (!isDesk(req)) return json(res, 403, { error: 'Desktop only' });
    if (route === 'GET /api/desk/state') {
      const projects = listProjects().map(publicProject);
      return json(res, 200, {
        pc: os.hostname(), defaultSubfolder: config.defaultSubfolder, projects,
        devices: config.devices.map(({ name, pairedAt, lastSeen }) => ({ name, pairedAt, lastSeen })),
        recent: recentImages.slice(0, 5),
      });
    }
    if (route === 'POST /api/desk/pair') {
      pairing = { code: crypto.randomBytes(12).toString('hex'), expires: Date.now() + 10 * 60e3 };
      const link = `http://${lanAddress()}:${PORT}/#pair=${pairing.code}`;
      return json(res, 200, { link, svg: await QRCode.toString(link, { type: 'svg', margin: 1 }), expires: pairing.expires });
    }
    if (route === 'POST /api/desk/project') {
      const b = await readJson(req);
      const folder = path.resolve(String(b.folder || ''));
      if (!b.folder || !isDir(folder)) return json(res, 400, { error: 'Folder does not exist' });
      config.projects = config.projects.filter((p) => p.folder.toLowerCase() !== folder.toLowerCase());
      config.projects.push({ name: String(b.name || path.basename(folder)).slice(0, 80), folder, subfolder: cleanSubfolder(b.subfolder) });
      saveConfig();
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/desk/project/remove') {
      const b = await readJson(req);
      config.projects = config.projects.filter((p) => projectId(p.folder) !== b.id);
      saveConfig();
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/desk/settings') {
      const b = await readJson(req);
      config.defaultSubfolder = cleanSubfolder(b.defaultSubfolder) || 'incoming';
      saveConfig();
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/desk/device/remove') {
      const b = await readJson(req);
      config.devices = config.devices.filter((d) => d.name !== b.name);
      saveConfig();
      return json(res, 200, { ok: true });
    }
    if (route === 'POST /api/desk/copy') {
      const last = recentImages[0];
      if (!last) return json(res, 404, { error: 'No image yet' });
      return json(res, 200, { ok: await copyToClipboard(last.prompt) });
    }
    if (route === 'POST /api/desk/open') {
      const b = await readJson(req);
      const p = listProjects().find((x) => x.id === b.id);
      if (!p) return json(res, 404, { error: 'Unknown project' });
      const dir = path.join(p.folder, p.subfolder);
      fs.mkdirSync(dir, { recursive: true });
      spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  }

  // ---- phone ----
  if (route === 'POST /api/pair') {
    const b = await readJson(req);
    if (!pairing || Date.now() > pairing.expires || typeof b.code !== 'string' ||
        !crypto.timingSafeEqual(Buffer.from(sha(b.code)), Buffer.from(sha(pairing.code)))) {
      return json(res, 401, { error: 'This pairing code has expired. Show a new QR code on your PC.' });
    }
    pairing = null;  // one use only
    const token = crypto.randomBytes(32).toString('hex');
    const name = String(b.deviceName || 'Phone').slice(0, 60);
    config.devices = config.devices.filter((d) => d.name !== name);
    config.devices.push({ name, tokenHash: sha(token), pairedAt: Date.now(), lastSeen: Date.now() });
    saveConfig();
    return json(res, 200, { token, pc: os.hostname() });
  }

  const device = deviceFor(req);
  if (url.pathname.startsWith('/api/')) {
    if (!device) return json(res, 401, { error: 'This phone is not paired. Scan the QR code on your PC.' });
    device.lastSeen = Date.now();
  }

  if (route === 'GET /api/status') {
    const projects = listProjects().map(publicProject);
    const latest = projects.find((p) => p.source !== 'inbox' && p.available);
    return json(res, 200, {
      pc: os.hostname(), projects,
      latestId: latest && latest.certain && latest.activeAt ? latest.id : null,
    });
  }

  if (route === 'POST /api/upload') {
    const project = listProjects().find((p) => p.id === url.searchParams.get('project'));
    if (!project || !project.available) return json(res, 404, { error: 'Project not available. Choose another project.' });
    let buf;
    try { buf = await readBody(req, MAX_BYTES); }
    catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? 'Image is larger than 25 MB.' : 'Upload interrupted.' }); }
    const ext = sniffImage(buf);
    if (!ext) return json(res, 415, { error: 'Only PNG, JPEG, WEBP and HEIC images are accepted.' });

    const dir = path.join(project.folder, project.subfolder);
    fs.mkdirSync(dir, { recursive: true });
    const saved = writeUnique(dir, `phone-${stamp()}`, ext, buf);
    if (fs.statSync(saved).size !== buf.length) return json(res, 500, { error: 'File was not fully written.' });

    const prompt = promptFor(saved, project);
    const copied = await copyToClipboard(prompt);
    const entry = {
      file: saved, rel: path.relative(project.folder, saved).split(path.sep).join('/'),
      project: project.name, projectId: project.id, prompt, copied, at: Date.now(), from: device.name, heic: ext === 'heic',
    };
    recentImages.unshift(entry);
    recentImages.length = Math.min(recentImages.length, 20);
    saveConfig();  // persists device lastSeen
    console.log(`Saved ${saved} (${(buf.length / 1024).toFixed(0)} KB) from ${device.name}`);
    return json(res, 200, entry);
  }

  return json(res, 404, { error: 'Not found' });
}

function cleanSubfolder(s) {
  // One or more plain folder names; no drive letters, no "..", no absolute paths.
  return String(s || '').split(/[\\/]+/).map((x) => x.replace(/[<>:"|?*\x00-\x1f]/g, '').trim())
    .filter((x) => x && x !== '.' && x !== '..').join(path.sep).slice(0, 120);
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the PC.' });
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Snap bridge running.`);
  console.log(`  On this PC:  http://localhost:${PORT}`);
  console.log(`  Phone URL:   http://${lanAddress()}:${PORT}  (pair via the QR code on the PC page)`);
  if (process.argv.includes('--open')) spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore' }).unref();
});
