// TootFarangi - پوستهٔ Electron
// وظایف: بارگذاری برنامه، پل پوشه (File System)، ضبط صفحه، به‌روزرسانی/بازگشت نسخه، لاگ
const { app, BrowserWindow, Menu, ipcMain, dialog, protocol, net, session,
        desktopCapturer, shell, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { pathToFileURL } = require('url');

app.setName('TootFarangi');
// سقف حافظهٔ جاوااسکریپت (heap) تا ۴ گیگابایت؛ فقط سقف است، حافظه را از قبل رزرو نمی‌کند
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
protocol.registerSchemesAsPrivileged([{
  scheme: 'tf',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

let win = null;
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

/* ---------- لاگ ---------- */
const logFile = () => path.join(app.getPath('userData'), 'crash.log');
function L(msg) {
  try { fs.appendFileSync(logFile(), '[' + new Date().toISOString() + '] ' + msg + '\n'); } catch (e) {}
}
function metrics() {
  try {
    return app.getAppMetrics().map(m => (m.type === 'Tab' ? 'Tab' : m.type) + ':' +
      Math.round((m.memory.workingSetSize || 0) / 1024) + 'MB').join(' ');
  } catch (e) { return ''; }
}
process.on('uncaughtException', e => L('main uncaughtException ' + (e && e.stack || e)));
process.on('unhandledRejection', e => L('main unhandledRejection ' + (e && e.stack || e)));

/* ---------- نسخهٔ برنامه (HTML) ---------- */
const BUNDLED = () => path.join(__dirname, 'app', 'index.html');
const APPDIR = () => path.join(app.getPath('userData'), 'app');
const CUR = () => path.join(APPDIR(), 'current.html');
const PREV = () => path.join(APPDIR(), 'prev');
const verOf = (html) => {
  const m = /<meta name="app-version" content="([\d.]+)"/.exec(String(html).slice(0, 4000));
  return m ? parseFloat(m[1]) : 0;
};
const validApp = (html) => typeof html === 'string' && html.length > 1000 && html.length < 40 * 1024 * 1024 &&
  /<\/html>/i.test(html) && html.includes('cls_set') && verOf(html) > 0;
async function exists(p) { try { await fsp.access(p); return true; } catch (e) { return false; } }
async function readRunning() {
  if (await exists(CUR())) return { html: await fsp.readFile(CUR(), 'utf8'), cur: true };
  return { html: await fsp.readFile(BUNDLED(), 'utf8'), cur: false };
}
async function atomicWrite(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}
async function listPrev() {
  try {
    const names = (await fsp.readdir(PREV())).filter(n => n.endsWith('.html')).sort().reverse();
    return names;
  } catch (e) { return []; }
}
async function archive(html) {
  const name = Date.now() + '_' + verOf(html) + '.html';
  await atomicWrite(path.join(PREV(), name), html);
  const all = await listPrev();
  for (const n of all.slice(5)) { try { await fsp.unlink(path.join(PREV(), n)); } catch (e) {} }
}
// اگر نسخهٔ داخل فایل نصبی جدیدتر از نسخهٔ به‌روزرسانی‌شده باشد، نسخهٔ نصبی اولویت دارد
async function reconcile() {
  try {
    if (!(await exists(CUR()))) return;
    const cur = await fsp.readFile(CUR(), 'utf8');
    const b = await fsp.readFile(BUNDLED(), 'utf8');
    if (verOf(b) > verOf(cur)) { await archive(cur); await fsp.unlink(CUR()); L('reconcile: bundled ' + verOf(b) + ' > current ' + verOf(cur)); }
  } catch (e) { L('reconcile error ' + (e && e.message)); }
}
function relaunchSoon() { setTimeout(() => { app.relaunch(); app.exit(0); }, 900); }

/* ---------- ریشه‌های مجاز (پوشه‌هایی که کاربر خودش انتخاب کرده) ---------- */
const rootsFile = () => path.join(app.getPath('userData'), 'roots.json');
let ROOTS = new Set();
function loadRoots() { try { ROOTS = new Set(JSON.parse(fs.readFileSync(rootsFile(), 'utf8'))); } catch (e) { ROOTS = new Set(); } }
function addRoot(p) {
  ROOTS.add(path.resolve(p));
  try { fs.writeFileSync(rootsFile(), JSON.stringify([...ROOTS])); } catch (e) {}
}
function allowed(p) {
  if (!p || typeof p !== 'string') return false;
  const r = path.resolve(p);
  for (const root of ROOTS) { if (r === root || r.startsWith(root + path.sep)) return true; }
  return false;
}
const E = (name, message) => { const e = new Error(message || name); e.tfName = name; return e; };
const okName = (n) => typeof n === 'string' && n && n !== '.' && n !== '..' && !/[\/\\\0]/.test(n);

/* ---------- عملیات فایل (برای پل پوشه) ---------- */
const W = new Map(); let WID = 0;
const ops = {
  async pickDir() {
    const r = await dialog.showOpenDialog(win, { title: 'انتخاب پوشه', buttonLabel: 'انتخاب', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    addRoot(r.filePaths[0]); return { path: r.filePaths[0] };
  },
  async pickOpen(a) {
    const r = await dialog.showOpenDialog(win, { title: 'انتخاب فایل', buttonLabel: 'انتخاب',
      properties: a && a.multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: (a && a.filters) || [] });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    r.filePaths.forEach(addRoot); return { paths: r.filePaths };
  },
  async pickSave(a) {
    const r = await dialog.showSaveDialog(win, { title: 'ذخیره', defaultPath: (a && a.name) || 'file', filters: (a && a.filters) || [] });
    if (r.canceled || !r.filePath) return { canceled: true };
    addRoot(r.filePath);
    try { await fsp.writeFile(r.filePath, '', { flag: 'a' }); } catch (e) {}
    return { path: r.filePath };
  },
  async exists(a) { return { yes: allowed(a.p) && await exists(a.p) }; },
  async stat(a) {
    if (!allowed(a.p)) throw E('NotAllowedError', 'not allowed');
    let st; try { st = await fsp.stat(a.p); } catch (e) { throw E('NotFoundError', 'A requested file or directory could not be found.'); }
    return { size: st.size, mtime: st.mtimeMs, kind: st.isDirectory() ? 'directory' : 'file' };
  },
  async child(a) {
    if (!allowed(a.dir)) throw E('NotAllowedError', 'not allowed');
    if (!okName(a.name)) throw E('TypeError', 'Name is not allowed.');
    const full = path.join(a.dir, a.name);
    let st = null; try { st = await fsp.stat(full); } catch (e) {}
    if (st) {
      const kind = st.isDirectory() ? 'directory' : 'file';
      if (kind !== a.kind) throw E('TypeMismatchError', 'The path supplied exists, but was not an entry of requested type.');
      return { path: full };
    }
    if (!a.create) throw E('NotFoundError', 'A requested file or directory could not be found.');
    if (a.kind === 'directory') await fsp.mkdir(full, { recursive: true });
    else await fsp.writeFile(full, '', { flag: 'wx' });
    return { path: full };
  },
  async list(a) {
    if (!allowed(a.p)) throw E('NotAllowedError', 'not allowed');
    let ents; try { ents = await fsp.readdir(a.p, { withFileTypes: true }); } catch (e) { throw E('NotFoundError', 'A requested file or directory could not be found.'); }
    const out = [];
    for (const d of ents) {
      if (d.name === '.DS_Store' || d.name.includes('.tf-swap-')) continue;
      let kind = d.isDirectory() ? 'directory' : d.isFile() ? 'file' : null;
      if (!kind) { try { const s = await fsp.stat(path.join(a.p, d.name)); kind = s.isDirectory() ? 'directory' : 'file'; } catch (e) { continue; } }
      out.push({ name: d.name, kind });
    }
    return { items: out };
  },
  async remove(a) {
    if (!allowed(a.dir)) throw E('NotAllowedError', 'not allowed');
    if (!okName(a.name)) throw E('TypeError', 'Name is not allowed.');
    const full = path.join(a.dir, a.name);
    let st; try { st = await fsp.stat(full); } catch (e) { throw E('NotFoundError', 'A requested file or directory could not be found.'); }
    if (st.isDirectory()) {
      if (a.recursive) await fsp.rm(full, { recursive: true, force: true });
      else { try { await fsp.rmdir(full); } catch (e) { throw E('InvalidModificationError', 'The object can not be modified in this way.'); } }
    } else await fsp.unlink(full);
    return {};
  },
  async wopen(a) {
    if (!allowed(a.p)) throw E('NotAllowedError', 'not allowed');
    const id = ++WID, tmp = a.p + '.tf-swap-' + id;
    let keep = false;
    if (a.keep && await exists(a.p)) { await fsp.copyFile(a.p, tmp); keep = true; }
    const fh = await fsp.open(tmp, keep ? 'r+' : 'w');
    W.set(id, { fh, tmp, target: a.p });
    return { id };
  },
  async wwrite(a) {
    const w = W.get(a.id); if (!w) throw E('InvalidStateError', 'stream closed');
    const buf = Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    await w.fh.write(buf, 0, buf.length, a.pos);
    return {};
  },
  async wtruncate(a) { const w = W.get(a.id); if (!w) throw E('InvalidStateError', 'stream closed'); await w.fh.truncate(a.size); return {}; },
  async wclose(a) {
    const w = W.get(a.id); if (!w) throw E('InvalidStateError', 'stream closed');
    await w.fh.close(); W.delete(a.id);
    await fsp.rename(w.tmp, w.target); return {};
  },
  async wabort(a) {
    const w = W.get(a.id); if (!w) return {};
    try { await w.fh.close(); } catch (e) {} W.delete(a.id);
    try { await fsp.unlink(w.tmp); } catch (e) {} return {};
  },

  /* ----- به‌روزرسانی / بازگشت ----- */
  async update(a) {
    const html = a && a.html;
    if (!validApp(html)) throw E('DataError', 'invalid app file');
    const running = await readRunning();
    await archive(running.html);
    await atomicWrite(CUR(), html);
    L('update applied: ' + (a.name || '') + ' ver ' + verOf(html) + ' (previous ' + verOf(running.html) + ')');
    relaunchSoon();
    return { ok: true, ver: verOf(html) };
  },
  async rollbackInfo() {
    const list = await listPrev();
    if (!list.length) return { ok: false, count: 0 };
    const m = /_([\d.]+)\.html$/.exec(list[0]);
    return { ok: true, ver: m ? m[1] : '', count: list.length };
  },
  async rollback() {
    const list = await listPrev();
    if (!list.length) throw E('NotFoundError', 'no previous version');
    const prevPath = path.join(PREV(), list[0]);
    const prevHtml = await fsp.readFile(prevPath, 'utf8');
    if (!validApp(prevHtml)) throw E('DataError', 'previous file invalid');
    const running = await readRunning();
    await atomicWrite(CUR(), prevHtml);
    await fsp.unlink(prevPath);
    await archive(running.html);
    L('rollback to ver ' + verOf(prevHtml));
    relaunchSoon();
    return { ok: true };
  }
};
ipcMain.handle('tf:op', async (e, name, args) => {
  try {
    if (!Object.prototype.hasOwnProperty.call(ops, name)) throw E('NotSupportedError', 'unknown op ' + name);
    return { v: await ops[name](args || {}) };
  } catch (err) {
    if (!(name === 'child' && err && err.tfName === 'NotFoundError')) L('op ' + name + ' failed: ' + (err && (err.tfName || err.code || '') ) + ' ' + (err && err.message));
    return { err: { name: (err && err.tfName) || (err && err.code === 'ENOENT' ? 'NotFoundError' : 'UnknownError'), message: (err && err.message) || String(err) } };
  }
});
ipcMain.on('tf:log', (e, s) => L('[renderer] ' + s));

/* ---------- ضبط صفحه ---------- */
function setupMedia() {
  const ses = session.defaultSession;
  const okPerms = new Set(['media', 'mediaKeySystem', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write',
    'fileSystem', 'persistent-storage', 'fullscreen', 'notifications', 'window-management', 'idle-detection']);
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(okPerms.has(perm)));
  ses.setPermissionCheckHandler((wc, perm) => okPerms.has(perm));

  // ضبط تخته = ضبط خود صفحهٔ برنامه (مثل ضبط تب در Chrome). به مجوز Screen Recording مک نیاز ندارد.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    const deny = () => { try { callback({}); } catch (e) {} };
    try {
      const frame = request.frame || (win && win.webContents && win.webContents.mainFrame);
      if (!frame) { L('display-media: no frame'); return deny(); }
      const out = { video: frame };
      // صدای خود برنامه (ویدیو، موسیقی و ...) هم از همان صفحه گرفته می‌شود؛ صدای میکروفون جداست
      if (request.audioRequested) out.audio = frame;
      L('display-media: capturing app frame, audio=' + !!out.audio);
      callback(out);
    } catch (e) {
      L('display-media error ' + (e && e.stack || e));
      deny();
    }
  });
}

/* ---------- پروتکل tf:// ---------- */
function setupProtocol() {
  protocol.handle('tf', async (request) => {
    try {
      const u = new URL(request.url);
      const p = u.pathname;
      const H = (type) => ({ 'Content-Type': type, 'Cache-Control': 'no-store' });
      if (p === '/' || p === '/index.html') {
        const buf = (await exists(CUR())) ? await fsp.readFile(CUR()) : await fsp.readFile(BUNDLED());
        return new Response(buf, { headers: H('text/html; charset=utf-8') });
      }
      if (p === '/tf-shim.js') {
        return new Response(await fsp.readFile(path.join(__dirname, 'tf-shim.js')), { headers: H('text/javascript; charset=utf-8') });
      }
      if (p.startsWith('/__file/')) {
        const real = decodeURIComponent(p.slice('/__file/'.length));
        if (!allowed(real)) return new Response('forbidden', { status: 403 });
        return net.fetch(pathToFileURL(real).toString(), { headers: request.headers });
      }
      if (p === '/appwrite-sdk.js') {
        if (await exists(SDKFILE())) return new Response(await fsp.readFile(SDKFILE()), { headers: H('text/javascript; charset=utf-8') });
        return new Response('not cached yet', { status: 404 });
      }
      return new Response('not found', { status: 404 });
    } catch (e) {
      L('protocol error ' + (e && e.message));
      return new Response('error', { status: 500 });
    }
  });
}

/* ---------- Appwrite (اتصال به سرور) ----------
   صفحهٔ برنامه با آدرس tf://app باز می‌شود و Appwrite فقط دامنه‌های ثبت‌شده را قبول می‌کند.
   پس: ۱) Origin درخواست‌های Appwrite به مقدار تنظیم‌شده (پیش‌فرض https://localhost) عوض می‌شود
       ۲) سرآیندهای CORS پاسخ برای صفحهٔ tf://app درست می‌شود  ۳) SDK برای حالت آفلاین ذخیره می‌شود
       ۴) منوی Help ← «Appwrite: test connection» دلیل دقیق خطا را نشان می‌دهد. */
const AWCFG = () => path.join(app.getPath('userData'), 'appwrite.json');
let AW = { origin: 'https://localhost', relaxWebSecurity: true, v: 2 };
function normOrigin(o) {
  try { o = String(o || '').trim(); if (!/^https?:\/\//i.test(o)) o = 'https://' + o; return new URL(o).origin; } catch (e) { return 'https://localhost'; }
}
function loadAW() {
  try {
    const j = JSON.parse(fs.readFileSync(AWCFG(), 'utf8'));
    Object.assign(AW, j);
    if (j.v !== 2) { AW.relaxWebSecurity = true; AW.v = 2; fs.writeFileSync(AWCFG(), JSON.stringify(AW, null, 2)); }
  } catch (e) {
    try { fs.writeFileSync(AWCFG(), JSON.stringify(AW, null, 2)); } catch (e2) {}
  }
  AW.origin = normOrigin(AW.origin);
}
let AWI = { ep: '', pj: '', sdk: 'https://cdn.jsdelivr.net/npm/appwrite@22.3.0/dist/iife/sdk.js' };
const AWHOSTS = new Set(['fra.cloud.appwrite.io']);
async function refreshAWInfo() {
  try {
    const html = (await readRunning()).html;
    const ep = /ep\s*:\s*['"](https:\/\/[^'"]+)['"]/.exec(html), pj = /pj\s*:\s*['"]([a-z0-9]+)['"]/i.exec(html);
    const sdk = /https:\/\/cdn\.jsdelivr\.net\/npm\/appwrite@[\d.]+\/dist\/iife\/sdk\.js/.exec(html);
    if (ep) { AWI.ep = ep[1]; try { AWHOSTS.add(new URL(ep[1]).hostname); } catch (e) {} }
    if (pj) AWI.pj = pj[1];
    if (sdk) AWI.sdk = sdk[0];
  } catch (e) {}
}
const isAWHost = (h) => AWHOSTS.has(h) || /(^|\.)appwrite\.(io|run)$/i.test(h);
const hostOf = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
function setupAppwrite() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
    if (!isAWHost(hostOf(d.url))) return cb({});
    const h = d.requestHeaders;
    for (const k of Object.keys(h)) if (/^(origin|referer)$/i.test(k)) delete h[k];
    h['Origin'] = AW.origin; h['Referer'] = AW.origin + '/';
    cb({ requestHeaders: h });
  });
  ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (d, cb) => {
    if (!isAWHost(hostOf(d.url))) return cb({});
    const h = d.responseHeaders || {};
    for (const k of Object.keys(h)) if (/^access-control-allow-(origin|credentials)$/i.test(k)) delete h[k];
    h['Access-Control-Allow-Origin'] = ['tf://app'];
    h['Access-Control-Allow-Credentials'] = ['true'];
    cb({ responseHeaders: h });
  });
  ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (d) => {
    if (isAWHost(hostOf(d.url)) && d.statusCode >= 400) { let p = ''; try { p = new URL(d.url).pathname; } catch (e) {} L('appwrite ' + d.statusCode + ' ' + d.method + ' ' + p); }
  });
  ses.webRequest.onErrorOccurred({ urls: ['<all_urls>'] }, (d) => {
    if (isAWHost(hostOf(d.url))) L('appwrite network error ' + d.error + ' ' + d.method + ' ' + hostOf(d.url));
  });
}
/* SDK: در اولین اجرای آنلاین ذخیره می‌شود تا بدون اینترنت هم (و سریع‌تر) بالا بیاید؛ برنامه آن را از tf://app/appwrite-sdk.js هم امتحان می‌کند */
const SDKFILE = () => path.join(app.getPath('userData'), 'appwrite-sdk.js');
async function cacheSDK() {
  try {
    const r = await net.fetch(AWI.sdk);
    if (r.ok) { const t = await r.text(); if (t.length > 20000) await atomicWrite(SDKFILE(), t); }
  } catch (e) { L('sdk cache failed ' + (e && e.message)); }
}
function awProbe() {
  return new Promise((resolve) => {
    if (!AWI.ep || !AWI.pj) return resolve({ kind: 'noep' });
    let done = false; const fin = (x) => { if (!done) { done = true; resolve(x); } };
    try {
      const req = net.request({ url: AWI.ep.replace(/\/+$/, '') + '/account', method: 'GET', session: session.defaultSession });
      req.setHeader('X-Appwrite-Project', AWI.pj);
      let body = '';
      req.on('response', (r) => { r.on('data', (c) => { body += c; }); r.on('end', () => { let j = {}; try { j = JSON.parse(body); } catch (e) {} fin({ status: r.statusCode, type: j.type || '', message: j.message || '' }); }); });
      req.on('error', (e) => fin({ kind: 'net', message: String(e && e.message) }));
      req.end();
      setTimeout(() => { try { req.abort(); } catch (e) {} fin({ kind: 'timeout' }); }, 12000);
    } catch (e) { fin({ kind: 'net', message: String(e && e.message) }); }
  });
}
async function awDiagnose(silent) {
  await refreshAWInfo();
  const r = await awProbe();
  const host = new URL(AW.origin).hostname;
  let ok = false, msg = '';
  if (r.kind === 'noep') msg = 'در این نسخهٔ برنامه آدرس Appwrite پیدا نشد.';
  else if (r.kind === 'net' || r.kind === 'timeout') msg = 'به سرور Appwrite نرسید. اینترنت را چک کن (' + (r.message || 'timeout') + ').';
  else if (r.status === 200 || r.status === 401) { ok = true; msg = 'اتصال به Appwrite سالم است ✓ (Origin: ' + AW.origin + ')'; }
  else if (r.status === 403 || /origin|platform/i.test(r.type + ' ' + r.message)) msg = 'Appwrite این دامنه را قبول نکرد: ' + host + '\nدر Appwrite Console ← پروژه ← Overview ← Add platform ← Web ← Hostname = ' + host + '\n(یا اگر دامنهٔ دیگری ثبت کرده‌ای، آن را در فایل appwrite.json بنویس.)';
  else if (r.status === 404) msg = 'پروژه پیدا نشد (project id یا endpoint اشتباه است): ' + (r.message || r.type);
  else msg = 'پاسخ غیرمنتظره از سرور: ' + r.status + ' ' + (r.type || '') + ' ' + (r.message || '');
  L('appwrite diagnose: ' + (ok ? 'OK' : 'FAIL') + ' | ' + JSON.stringify(r));
  if (!silent || (!ok && r.status === 403)) {
    const b = await dialog.showMessageBox(win, { type: ok ? 'info' : 'warning', message: ok ? 'Appwrite OK' : 'مشکل در اتصال Appwrite', detail: msg,
      buttons: ok ? ['OK'] : ['باز کردن Appwrite Console', 'ویرایش appwrite.json', 'بستن'], defaultId: 0, cancelId: ok ? 0 : 2 });
    if (!ok && b.response === 0) shell.openExternal('https://cloud.appwrite.io/console');
    if (!ok && b.response === 1) shell.openPath(AWCFG());
  }
  return ok;
}

/* ---------- پنجره ---------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 900, minHeight: 600, show: false,
    backgroundColor: '#f6f4ef', title: 'TootFarangi',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false, spellcheck: false,
      webSecurity: !AW.relaxWebSecurity
    }
  });
  win.once('ready-to-show', () => win.show());
  win.on('unresponsive', () => L('unresponsive {} | ' + metrics()));
  win.on('responsive', () => L('responsive again'));
  win.webContents.on('render-process-gone', (e, d) => L('render-process-gone ' + JSON.stringify(d) + ' | ' + metrics()));
  win.webContents.on('console-message', (e, level, msg) => { if (/\[tf\]/.test(msg) || level >= 3) L('console(' + level + ') ' + String(msg).slice(0, 600)); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('tf://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });
  win.loadURL('tf://app/index.html');
  win.on('closed', () => { win = null; });
}

function setupMenu() {
  const t = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Open log folder', click: () => shell.showItemInFolder(logFile()) },
      { label: 'Appwrite: test connection', click: () => awDiagnose(false) },
      { label: 'Appwrite: edit settings (appwrite.json)', click: () => { if (!fs.existsSync(AWCFG())) { try { fs.writeFileSync(AWCFG(), JSON.stringify(AW, null, 2)); } catch (e) {} } shell.openPath(AWCFG()); } }
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.whenReady().then(async () => {
  loadRoots();
  loadAW();
  await reconcile();
  await refreshAWInfo();
  setupAppwrite();
  setupProtocol();
  setupMedia();
  setupMenu();
  createWindow();
  setTimeout(() => { cacheSDK(); awDiagnose(true); }, 5000);
  L('started, electron ' + process.versions.electron + ', platform ' + process.platform + ' ' + process.arch);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { app.quit(); });
