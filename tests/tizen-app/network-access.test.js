'use strict';

var assert = require('assert');
var test   = require('node:test');
var NetworkAccess = require('../../tizen-app/js/network-access.js');

function at(level) {
    return NetworkAccess.create({ get: function (k) { return k === 'networkAccess' ? level : undefined; } });
}

var NTFY   = 'https://ntfy.sh/vlctv-abc/json?poll=1';
var NAS    = 'http://192.168.1.5:8127/smb/stream?path=/a.mkv';
var CLOUD  = 'https://cloud.example.com/dav/Films/a.mkv';
var LOCALS = ['file:///opt/media/USBDriveA1/a.mkv', 'i18n/de-DE.json', 'assets/keepawake.mp4',
              'blob:file:///4f0c', 'data:text/plain,x', ''];

test('hostOf names the host and nothing else', function () {
    var h = NetworkAccess.hostOf;
    assert.strictEqual(h(NTFY), 'ntfy.sh');
    assert.strictEqual(h(NAS), '192.168.1.5');
    assert.strictEqual(h('HTTP://User:p%40ss@NAS.Local:5005/x'), 'nas.local');
    assert.strictEqual(h('rtsp://[fe80::1]:554/cam'), 'fe80::1');
    assert.strictEqual(h('smb://nas'), 'nas');
    LOCALS.forEach(function (u) { assert.strictEqual(h(u), '', u); });
});

test('needs: the TV itself, a server of the user\'s, a third-party service', function () {
    var n = NetworkAccess.needs;
    LOCALS.forEach(function (u) { assert.strictEqual(n(u), 'none', u); });
    assert.strictEqual(n(NAS), 'own');
    assert.strictEqual(n(CLOUD), 'own');
    assert.strictEqual(n('http://127.0.0.1:8127/smb/ping'), 'own', 'the background service is a network too');
    assert.strictEqual(n(NTFY), 'all');
    assert.strictEqual(n('https://sub.ntfy.sh/x'), 'all');
    assert.strictEqual(n('https://notntfy.sh/x'), 'own');
});

test('each level lets through what it promises', function () {
    var all = at('all'), own = at('own'), none = at('none');
    [NTFY, NAS, CLOUD].concat(LOCALS).forEach(function (u) { assert.ok(all.allows(u), 'all: ' + u); });
    assert.ok(own.allows(NAS) && own.allows(CLOUD) && !own.allows(NTFY));
    LOCALS.forEach(function (u) { assert.ok(own.allows(u) && none.allows(u), u); });
    assert.ok(!none.allows(NAS) && !none.allows(CLOUD) && !none.allows(NTFY));
    assert.strictEqual(at(undefined).level(), 'all', 'no setting reads as everything');
    assert.strictEqual(at('bogus').level(), 'all');
});

test('check() passes, or hands the dialog what to offer and returns false', function () {
    var own = at('own'), asked = [];
    own.setPrompt(function (what, lvl, retry) { asked.push([what, lvl, retry]); });
    var retry = function () {};
    assert.strictEqual(own.check(NAS, 'NAS', retry), true);
    assert.strictEqual(own.check(NTFY, null, retry), false);
    assert.deepStrictEqual(asked, [['ntfy.sh', 'all', retry]]);
    assert.strictEqual(own.check(NTFY, 'Cast from phone'), false);
    assert.deepStrictEqual(asked[1].slice(0, 2), ['Cast from phone', 'all']);
    assert.strictEqual(own.checkFeature('SMB', retry), true);

    var none = at('none');
    assert.strictEqual(none.check(NTFY), false, 'no dialog installed: just refused');
    none.setPrompt(function (what, lvl) { asked.push([what, lvl]); });
    assert.strictEqual(none.checkFeature('SMB', retry), false);
    assert.deepStrictEqual(asked[2], ['SMB', 'own']);
    assert.strictEqual(none.check(NAS), false);
    assert.deepStrictEqual(asked[3], ['192.168.1.5', 'own']);
});

test('the installed backstop makes XMLHttpRequest.open throw for a forbidden URL', function () {
    var opened = [];
    function FakeXhr() {}
    FakeXhr.prototype.open = function (method, url) { opened.push(method + ' ' + url); return 'opened'; };
    var win = { XMLHttpRequest: FakeXhr };
    var own = at('own');
    own.install(win);
    own.install(win);   // once is enough
    var x = new FakeXhr();
    assert.strictEqual(x.open('GET', NAS), 'opened');
    assert.strictEqual(x.open('GET', 'i18n/en.json'), 'opened');
    assert.throws(function () { x.open('GET', NTFY); }, /ntfy\.sh/);
    assert.deepStrictEqual(opened, ['GET ' + NAS, 'GET i18n/en.json']);

    var none = at('none');
    none.install({ XMLHttpRequest: FakeXhr });   // the first install stays; levels are read live
    assert.strictEqual(x.open('GET', NAS), 'opened', 'own is still the installed one');
    function Other() {}
    Other.prototype.open = function () { return 'ok'; };
    none.install({ XMLHttpRequest: Other });
    assert.throws(function () { new Other().open('GET', NAS); }, /192\.168\.1\.5/);
    assert.strictEqual(new Other().open('GET', 'file:///opt/media/a.mkv'), 'ok');
});
