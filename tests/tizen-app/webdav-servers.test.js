'use strict';

var assert = require('assert');
var test   = require('node:test');
var fs     = require('fs');
var vm     = require('vm');
var path   = require('path');
var I18n   = require('./helpers/i18n.js');

var JS  = path.join(__dirname, '../../tizen-app/js/');
var SRC = fs.readFileSync(JS + 'webdav.js', 'utf8');
var STREAM = 'http://127.0.0.1:8127/dav/stream?srv=';

var NC  = { id: 'nc1', name: 'My Nextcloud', url: 'https://cloud.example.com/remote.php/dav/files/pat/', user: 'pat', pass: 'secret', insecure: false };
var NAS = { id: 'nas1', name: '', url: 'http://192.168.1.5:5005/', user: 'tv', pass: 'pw', insecure: true };

/* webdav.js against a fake background service and a fake Settings form. */
function load(opts) {
    opts = opts || {};
    var store = {};
    if (opts.servers) store.vlctv_webdav_v1 = JSON.stringify(opts.servers);
    var known = [];          // server ids the fake service holds
    var sent = [];
    var picker = null, toasts = [];
    var inputs = {};
    ['name', 'url', 'user', 'pass'].forEach(function (k) { inputs['dav-' + k] = { value: '' }; });
    var handlers = {};
    var buttons = {
        'dav-save':     { addEventListener: function (ev, fn) { handlers.save = fn; } },
        'dav-server':   { addEventListener: function (ev, fn) { handlers.server = fn; } },
        'dav-remove':   { addEventListener: function (ev, fn) { handlers.remove = fn; }, style: {} },
        'dav-insecure': { addEventListener: function (ev, fn) { handlers.insecure = fn; } },
        'dav-server-val':   { textContent: '' },
        'dav-insecure-val': { textContent: '' }
    };
    function reply(x, status, body) {
        x.status = status; x.responseText = JSON.stringify(body);
        if (x.onload) x.onload();
    }
    function FakeXHR() {}
    FakeXHR.prototype.open = function (method, url) { this.url = url; };
    FakeXHR.prototype.setRequestHeader = function () {};
    FakeXHR.prototype.send = function (body) {
        var u = this.url;
        sent.push(u);
        if (/\/smb\/ping$/.test(u)) return reply(this, 200, { ok: true, servers: [], dav: known.slice() });
        if (/\/dav\/connect$/.test(u)) {
            var c = JSON.parse(body);
            if (opts.connect) { var r = opts.connect(c); if (r) return reply(this, 502, r); }
            known.push(c.id);
            return reply(this, 200, { ok: true, auth: 'basic' });
        }
        reply(this, 404, { ok: false });
    };
    var sandbox = {
        module: { exports: {} },
        Debug: { send: function () {} },
        I18n: I18n,
        SMB: { ensureService: function (cb) { sent.push('launch'); cb(null); } },
        UI: { toast: function (m) { toasts.push(m); }, focusOn: function () {} },
        localStorage: {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
            setItem: function (k, v) { store[k] = String(v); }
        },
        document: {
            readyState: 'complete',
            addEventListener: function () {},
            getElementById: function (id) { return inputs[id] || buttons[id] || null; }
        },
        window: { VlcApp: { openPicker: function (title, items, cur, cb) { picker = { title: title, items: items, cb: cb }; } } },
        setTimeout: function (fn) { fn(); },
        XMLHttpRequest: FakeXHR
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC + '\nvar W_ = WebDAV;', sandbox);
    return {
        W: sandbox.W_, store: store, sent: sent, toasts: toasts, known: known,
        saved: function () { return JSON.parse(store.vlctv_webdav_v1 || '[]'); },
        type: function (c) { for (var k in c) if (inputs['dav-' + k]) inputs['dav-' + k].value = String(c[k]); },
        toggleInsecure: function () { handlers.insecure(); },
        save: function () { handlers.save(); },
        pick: function (code) { handlers.server(); var p = picker; picker = null; p.cb(code); return p; },
        remove: function (code) { handlers.remove(); var p = picker; picker = null; p.cb(code); },
        serverVal: function () { return buttons['dav-server-val'].textContent; },
        removeShown: function () { return buttons['dav-remove'].style.display !== 'none'; }
    };
}
function plain(x) { return JSON.parse(JSON.stringify(x)); }

test('an address is stored trimmed, with a scheme and one trailing slash', function () {
    var W = load().W;
    assert.strictEqual(W.normalizeUrl('  https://cloud.example.com/remote.php/dav/files/pat '), 'https://cloud.example.com/remote.php/dav/files/pat/');
    assert.strictEqual(W.normalizeUrl('192.168.1.5:5005'), 'http://192.168.1.5:5005/');
    assert.strictEqual(W.normalizeUrl('nas.local/dav//'), 'http://nas.local/dav/');
    assert.strictEqual(W.normalizeUrl('HTTPS://Cloud.Example.com'), 'HTTPS://Cloud.Example.com/');
    assert.strictEqual(W.normalizeUrl(''), '');
    assert.strictEqual(W.normalizeUrl('ftp://nas/'), '');
    assert.strictEqual(W.normalizeUrl('http://'), '');
});

test('a stream URL names its server, and is recognised as ours', function () {
    var W = load({ servers: [NC] }).W;
    var u = W.streamUrl('/Films/a b.mkv', 'nc1');
    assert.strictEqual(u, STREAM + 'nc1&path=%2FFilms%2Fa%20b.mkv');
    assert.strictEqual(W.isStreamUrl(u), true);
    assert.strictEqual(W.streamServerOf(u), 'nc1');
    assert.strictEqual(W.streamServerOf('http://127.0.0.1:8127/smb/stream?path=a'), null);
    assert.strictEqual(W.isStreamUrl('https://cloud.example.com/a.mkv'), false);
});

test('a server is called by its name, else its host', function () {
    var W = load().W;
    assert.strictEqual(W.serverLabel(NC), 'My Nextcloud');
    assert.strictEqual(W.serverLabel(NAS), '192.168.1.5:5005');
    assert.strictEqual(W.serverLabel({ url: 'https://Cloud.example.com/x/' }), 'Cloud.example.com');
});

test('the form saves a new server, then edits it in place; a second address is another server', function () {
    var t = load();
    assert.strictEqual(t.serverVal(), 'New server');
    assert.strictEqual(t.removeShown(), false);
    t.type({ url: 'cloud.example.com/remote.php/dav/files/pat', user: 'pat', pass: 'secret', name: 'Cloud' });
    t.save();
    var saved = t.saved();
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].url, 'http://cloud.example.com/remote.php/dav/files/pat/');
    assert.strictEqual(saved[0].insecure, false);
    assert.ok(/^[a-z0-9]{8}$/.test(saved[0].id));
    assert.strictEqual(t.toasts.pop(), 'WebDAV server saved');
    assert.strictEqual(t.serverVal(), 'Cloud');
    assert.strictEqual(t.removeShown(), true);

    // The same server, edited: the id stays, the toggle is kept.
    t.type({ pass: 'changed' });
    t.toggleInsecure();
    t.save();
    assert.strictEqual(t.saved().length, 1);
    assert.strictEqual(t.saved()[0].id, saved[0].id);
    assert.strictEqual(t.saved()[0].pass, 'changed');
    assert.strictEqual(t.saved()[0].insecure, true);

    // Another one, through the picker's "Add another server".
    var p = t.pick('new');
    assert.deepStrictEqual(plain(p.items.map(function (i) { return i.name; })), ['Cloud', 'Add another server']);
    assert.strictEqual(t.serverVal(), 'New server');
    t.type({ url: NAS.url, user: 'tv', pass: 'pw', name: '' });
    t.save();
    assert.strictEqual(t.saved().length, 2);
    assert.deepStrictEqual(plain(t.W.servers().map(function (s) { return t.W.serverLabel(s); })), ['Cloud', '192.168.1.5:5005']);
});

test('the same address and user twice is refused; a missing address is said so', function () {
    var t = load({ servers: [NC] });
    t.pick('new');
    t.type({ url: 'HTTPS://cloud.example.com/remote.php/dav/files/pat', user: 'pat', pass: 'x' });
    t.save();
    assert.strictEqual(t.toasts.pop(), 'That server is already in the list');
    assert.strictEqual(t.saved().length, 1);
    // Another user on the same server is another server.
    t.type({ user: 'kid' });
    t.save();
    assert.strictEqual(t.saved().length, 2);
    t.pick('new');
    t.type({ url: '', user: '', pass: '' });
    t.save();
    assert.strictEqual(t.toasts.pop(), 'Server address is missing');
    assert.strictEqual(t.saved().length, 2);
});

test('removing a server asks first, then shows the one left', function () {
    var t = load({ servers: [NC, NAS] });
    t.pick('nas1');
    t.remove('keep');
    assert.strictEqual(t.saved().length, 2);
    t.remove('remove');
    assert.deepStrictEqual(plain(t.saved().map(function (s) { return s.id; })), ['nc1']);
    assert.strictEqual(t.toasts.pop(), 'Removed 192.168.1.5:5005');
    assert.strictEqual(t.serverVal(), 'My Nextcloud');
});

test('ensureConnected asks the service once, launching it when needed; a known server costs a ping', function () {
    var t = load({ servers: [NC, NAS] });
    var errs = [];
    t.W.ensureConnected('nc1', function (e) { errs.push(e); });
    assert.deepStrictEqual(errs, [null]);
    assert.deepStrictEqual(t.sent.map(function (u) { return u.replace('http://127.0.0.1:8127', ''); }), ['/smb/ping', 'launch', '/dav/connect']);
    t.W.ensureConnected('nc1', function (e) { errs.push(e); });
    assert.deepStrictEqual(errs, [null, null]);
    assert.strictEqual(t.sent.length, 4, 'only the ping');
    t.W.ensureConnected('gone', function (e) { errs.push(e.message); });
    assert.strictEqual(errs[2], 'That WebDAV server is no longer saved');
});

test('the service\'s reason reaches the user in words', function () {
    var t = load({ servers: [NC], connect: function () { return { ok: false, code: 'cert', error: 'DEPTH_ZERO_SELF_SIGNED_CERT' }; } });
    var msg;
    t.W.ensureConnected('nc1', function (e) { msg = e.message; });
    assert.strictEqual(msg, I18n.t('dav.err.cert'));
    var t2 = load({ servers: [NC], connect: function () { return { ok: false, code: 'other', error: 'HTTP 503' }; } });
    t2.W.ensureConnected('nc1', function (e) { msg = e.message; });
    assert.strictEqual(msg, 'HTTP 503');
});
