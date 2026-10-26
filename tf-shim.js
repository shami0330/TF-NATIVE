/* TootFarangi - لایهٔ سازگاری پوسته (قبل از بقیهٔ برنامه اجرا می‌شود)
   ۱) File System Access API (پوشه و فایل) روی دیسک واقعی  ۲) به‌روزرسانی و بازگشت نسخه  ۳) پرچم tfElectron */
(function () {
  'use strict';
  var N = window.tfNative;
  if (!N) return; // مرورگر معمولی: هیچ تغییری نده
  window.tfElectron = true;

  var log = function () {
    try { N.log(Array.prototype.map.call(arguments, function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join(' ')); } catch (e) {}
  };
  function call(op, args) {
    return N.op(op, args || {}).then(function (r) {
      if (r && r.err) throw new DOMException(r.err.message || r.err.name, r.err.name);
      return r ? r.v : undefined;
    });
  }
  var abort = function () { return new DOMException('The user aborted a request.', 'AbortError'); };
  var MIME = { json: 'application/json', html: 'text/html', htm: 'text/html', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4',
    webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', csv: 'text/csv' };
  var mimeOf = function (n) { var m = /\.([A-Za-z0-9]+)$/.exec(n || ''); return (m && MIME[m[1].toLowerCase()]) || ''; };
  var baseName = function (p) { var s = String(p).replace(/[\\\/]+$/, ''); var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i < 0 ? s : s.slice(i + 1); };

  /* ---------- دستگیره‌ها (فقط داده در خود شیء؛ متدها روی prototype تا در IndexedDB ذخیره شوند) ---------- */
  function Handle(kind, path) { this.kind = kind; this.path = path; this.name = baseName(path); this.__tf = 1; }
  Handle.prototype.isSameEntry = function (o) { return Promise.resolve(!!o && o.path === this.path); };
  Handle.prototype.queryPermission = function () {
    return call('exists', { p: this.path }).then(function (r) { return r && r.yes ? 'granted' : 'denied'; }, function () { return 'denied'; });
  };
  Handle.prototype.requestPermission = Handle.prototype.queryPermission;

  function DirHandle(path) { Handle.call(this, 'directory', path); }
  DirHandle.prototype = Object.create(Handle.prototype); DirHandle.prototype.constructor = DirHandle;
  function FileHandle(path) { Handle.call(this, 'file', path); }
  FileHandle.prototype = Object.create(Handle.prototype); FileHandle.prototype.constructor = FileHandle;

  DirHandle.prototype.getFileHandle = function (name, o) {
    return call('child', { dir: this.path, name: name, kind: 'file', create: !!(o && o.create) }).then(function (r) { return new FileHandle(r.path); });
  };
  DirHandle.prototype.getDirectoryHandle = function (name, o) {
    return call('child', { dir: this.path, name: name, kind: 'directory', create: !!(o && o.create) }).then(function (r) { return new DirHandle(r.path); });
  };
  DirHandle.prototype.removeEntry = function (name, o) {
    return call('remove', { dir: this.path, name: name, recursive: !!(o && o.recursive) }).then(function () {});
  };
  DirHandle.prototype._items = function () {
    var self = this;
    return call('list', { p: this.path }).then(function (r) {
      return r.items.map(function (x) {
        var full = self.path.replace(/[\\\/]+$/, '') + '/' + x.name;
        return [x.name, x.kind === 'directory' ? new DirHandle(full) : new FileHandle(full)];
      });
    });
  };
  function iter(self, pick) {
    var items = null, i = 0;
    var it = {
      next: function () {
        var go = items ? Promise.resolve() : self._items().then(function (x) { items = x; });
        return go.then(function () { return i < items.length ? { value: pick(items[i++]), done: false } : { value: undefined, done: true }; });
      }
    };
    it[Symbol.asyncIterator] = function () { return it; };
    return it;
  }
  DirHandle.prototype.entries = function () { return iter(this, function (x) { return x; }); };
  DirHandle.prototype.keys = function () { return iter(this, function (x) { return x[0]; }); };
  DirHandle.prototype.values = function () { return iter(this, function (x) { return x[1]; }); };
  DirHandle.prototype[Symbol.asyncIterator] = DirHandle.prototype.entries;

  FileHandle.prototype.getFile = function () {
    var self = this, name = this.name;
    return call('stat', { p: this.path }).then(function (st) {
      // خواندن از طریق پروتکل (بدون عبور داده از IPC)
      return fetch('/__file/' + encodeURIComponent(self.path), { cache: 'no-store' }).then(function (res) {
        if (!res.ok) throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
        return res.blob();
      }).then(function (b) { return new File([b], name, { type: mimeOf(name), lastModified: Math.round(st.mtime) }); });
    });
  };
  FileHandle.prototype.createWritable = function (o) {
    var self = this;
    return call('wopen', { p: this.path, keep: !!(o && o.keepExistingData) }).then(function (r) { return new Writable(r.id, o && o.keepExistingData ? null : 0); });
  };

  /* ---------- نوشتن ---------- */
  var CH = 4 * 1024 * 1024;
  function Writable(id) { this._id = id; this._pos = 0; this._done = false; this._q = Promise.resolve(); }
  function toBytes(d) {
    if (typeof d === 'string') return Promise.resolve([new TextEncoder().encode(d)]);
    if (d instanceof ArrayBuffer) return Promise.resolve([new Uint8Array(d)]);
    if (ArrayBuffer.isView(d)) return Promise.resolve([new Uint8Array(d.buffer, d.byteOffset, d.byteLength)]);
    if (d && typeof d.arrayBuffer === 'function' && typeof d.size === 'number') {
      var parts = [], off = 0, size = d.size;
      var step = function () {
        if (off >= size) return Promise.resolve(parts);
        return d.slice(off, off + CH).arrayBuffer().then(function (ab) { parts.push(new Uint8Array(ab)); off += CH; return step(); });
      };
      return step();
    }
    return Promise.reject(new TypeError('Unsupported data type'));
  }
  Writable.prototype._enq = function (fn) { var p = this._q.then(fn); this._q = p.catch(function () {}); return p; };
  Writable.prototype.write = function (data) {
    var self = this;
    return this._enq(function () {
      if (self._done) throw new TypeError('Cannot write to a closed writable stream');
      var pos = null;
      if (data && typeof data === 'object' && !(data instanceof Blob) && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && data.type) {
        if (data.type === 'seek') { self._pos = data.position; return; }
        if (data.type === 'truncate') return call('wtruncate', { id: self._id, size: data.size });
        if (data.type === 'write') { if (typeof data.position === 'number') pos = data.position; data = data.data; }
      }
      if (pos !== null) self._pos = pos;
      return toBytes(data).then(function (parts) {
        var chain = Promise.resolve();
        parts.forEach(function (u8) {
          for (var o = 0; o < u8.length || (u8.length === 0 && o === 0); o += CH) {
            (function (slice) {
              chain = chain.then(function () {
                var at = self._pos; self._pos += slice.length;
                return call('wwrite', { id: self._id, data: slice, pos: at });
              });
            })(u8.subarray(o, Math.min(o + CH, u8.length)));
            if (u8.length === 0) break;
          }
        });
        return chain;
      });
    });
  };
  Writable.prototype.seek = function (p) { return this.write({ type: 'seek', position: p }); };
  Writable.prototype.truncate = function (s) { return this.write({ type: 'truncate', size: s }); };
  Writable.prototype.close = function () {
    var self = this;
    return this._enq(function () { if (self._done) return; self._done = true; return call('wclose', { id: self._id }); });
  };
  Writable.prototype.abort = function () {
    var self = this;
    return this._enq(function () { if (self._done) return; self._done = true; return call('wabort', { id: self._id }); });
  };

  /* ---------- انتخاب‌گرها ---------- */
  function filtersOf(types) {
    var out = [];
    (types || []).forEach(function (t) {
      var ext = [];
      Object.keys(t.accept || {}).forEach(function (k) { (t.accept[k] || []).forEach(function (e) { ext.push(String(e).replace(/^\./, '')); }); });
      if (ext.length) out.push({ name: t.description || 'Files', extensions: ext });
    });
    return out;
  }
  window.showDirectoryPicker = function () {
    return call('pickDir').then(function (r) { if (r.canceled) throw abort(); return new DirHandle(r.path); });
  };
  window.showOpenFilePicker = function (o) {
    o = o || {};
    return call('pickOpen', { multiple: !!o.multiple, filters: filtersOf(o.types) }).then(function (r) {
      if (r.canceled) throw abort();
      return r.paths.map(function (p) { return new FileHandle(p); });
    });
  };
  window.showSaveFilePicker = function (o) {
    o = o || {};
    return call('pickSave', { name: o.suggestedName, filters: filtersOf(o.types) }).then(function (r) {
      if (r.canceled) throw abort(); return new FileHandle(r.path);
    });
  };

  // بازسازی دستگیره‌ای که از IndexedDB برگشته (بدون متد)
  window.tfRevive = function (x) {
    try {
      if (x && x.__tf && x.path) return x.kind === 'directory' ? new DirHandle(x.path) : new FileHandle(x.path);
    } catch (e) {}
    return x;
  };

  /* ---------- به‌روزرسانی و بازگشت نسخه ---------- */
  window.appUpdate = function (html, name) { return call('update', { html: html, name: name || '' }); };
  window.appRollbackInfo = function () { return call('rollbackInfo'); };
  window.appRollback = function () { return call('rollback'); };

  window.addEventListener('error', function (e) { log('[tf] window error', e.message, e.filename + ':' + e.lineno); });
  window.addEventListener('unhandledrejection', function (e) { log('[tf] unhandledrejection', String(e.reason && (e.reason.stack || e.reason))); });
  log('[tf] shim ready');
})();
