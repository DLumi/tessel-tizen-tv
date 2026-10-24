'use strict';

var assert = require('assert');
var test   = require('node:test');
var remote = require('../../scripts/tessel-remote');

test('lsSize prints like ls -lh', function () {
    assert.strictEqual(remote.lsSize(0), '0');
    assert.strictEqual(remote.lsSize(291), '291');
    assert.strictEqual(remote.lsSize(8049), '7.9K');
    assert.strictEqual(remote.lsSize(774401332), '739M');
    assert.strictEqual(remote.lsSize(1.3 * 1024 * 1024 * 1024), '1.3G');
    assert.strictEqual(remote.lsSize(500106784768), '466G');
});

test('lsDate shows the time within six months and the year beyond', function () {
    var now = new Date(2026, 9, 24, 12, 0).getTime();
    assert.strictEqual(remote.lsDate(new Date(2026, 7, 3, 16, 1).getTime(), now), 'Aug  3 16:01');
    assert.strictEqual(remote.lsDate(new Date(2025, 4, 10, 8, 8).getTime(), now), 'May 10  2025');
    assert.strictEqual(remote.lsDate(0, now), '            ');
});

function drives(n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ letter: String.fromCharCode(65 + i), root: '/opt/media/USBDrive' + String.fromCharCode(65 + i) + '1', top: [] });
    return out;
}

test('pickDrive: one stick needs no drive at all', function () {
    var t = remote.pickDrive(drives(1), 'shows/S04');
    assert.strictEqual(t.drive.letter, 'A');
    assert.strictEqual(t.rel, 'shows/S04');
    assert.strictEqual(remote.pickDrive(drives(1), '').rel, '');
    assert.strictEqual(remote.pickDrive(drives(1), './shows/').rel, 'shows');
});

test('pickDrive: an A/ prefix or -d picks the stick', function () {
    var d = drives(2);
    assert.strictEqual(remote.pickDrive(d, 'B/kids').drive.letter, 'B');
    assert.strictEqual(remote.pickDrive(d, 'B/kids').rel, 'kids');
    assert.strictEqual(remote.pickDrive(d, 'B').rel, '');
    assert.strictEqual(remote.pickDrive(d, 'kids', 'b').drive.letter, 'B');
    assert.strictEqual(remote.pickDrive(d, 'A/kids', 'B').drive.letter, 'B', '-d wins over the prefix');
});

test('pickDrive: two sticks, the folder that already exists decides', function () {
    var d = drives(2);
    d[1].top = ['kids/', 'music/'];
    var t = remote.pickDrive(d, 'kids/cartoons');
    assert.strictEqual(t.drive.letter, 'B');
    assert.strictEqual(t.rel, 'kids/cartoons');
});

test('pickDrive: refuses when it cannot tell', function () {
    var d = drives(2);
    assert.match(remote.pickDrive(d, 'new').error, /2 USB drives/);
    d[0].top = ['shows/']; d[1].top = ['shows/'];
    assert.match(remote.pickDrive(d, 'shows').error, /2 USB drives/);
    assert.match(remote.pickDrive(d, 'shows', 'C').error, /no USB drive C/);
    assert.match(remote.pickDrive([], 'shows').error, /no USB drive mounted/);
});

test('pickDrive: a real folder called A is not taken for drive A', function () {
    var d = drives(2);
    d[0].top = ['A/']; d[1].top = ['A/'];
    var t = remote.pickDrive(d, 'A/x', 'B');
    assert.strictEqual(t.rel, 'A/x');
});

test('parseArgs', function () {
    var p = remote.parseArgs(['push', '-d', 'b', '--tv', '10.0.0.5', 'shows', 'a.mp4', 'b.mp4']);
    assert.deepStrictEqual(p, { cmd: 'push', args: ['shows', 'a.mp4', 'b.mp4'], opts: { all: false, recursive: false, drive: 'b', tv: '10.0.0.5', sdb: null } });
    assert.strictEqual(remote.parseArgs(['rm', '-r', 'x']).opts.recursive, true);
    p = remote.parseArgs(['ls', '-a', '--sdb=/x/sdb']);
    assert.strictEqual(p.cmd, 'ls');
    assert.strictEqual(p.opts.all, true);
    assert.strictEqual(p.opts.sdb, '/x/sdb');
    assert.strictEqual(remote.parseArgs([]).cmd, '');
});

test('pickDrive: refuses . and .. components (they could leave the stick)', function () {
    assert.match(remote.pickDrive(drives(1), '../../etc').error, /refusing/);
    assert.match(remote.pickDrive(drives(1), 'shows/../x').error, /refusing/);
    assert.match(remote.pickDrive(drives(1), 'shows/./x').error, /refusing/);
    assert.strictEqual(remote.pickDrive(drives(1), 'shows//S04/').rel, 'shows/S04');
});

test('movePlan: rename, move into a folder, never overwrite', function () {
    var f = { rel: 'shows/S01E01 (1).mp4', isDir: false };
    assert.strictEqual(remote.movePlan(f, { rel: 'shows/S01E01.mp4', exists: false }).to, 'shows/S01E01.mp4');
    assert.strictEqual(remote.movePlan(f, { rel: 'shows/S01', exists: true, isDir: true }).to, 'shows/S01/S01E01 (1).mp4');
    assert.strictEqual(remote.movePlan(f, { rel: '', exists: true, isDir: true }).to, 'S01E01 (1).mp4', 'into the drive root');
    assert.match(remote.movePlan(f, { rel: 'shows/S01E02.mp4', exists: true, isDir: false }).error, /not overwriting/);
    assert.match(remote.movePlan({ rel: 'shows/x', isDir: false }, { rel: 'shows', exists: true, isDir: true }).error, /same/, 'into its own folder');
    assert.match(remote.movePlan(f, { rel: '', exists: false }).error, /drive root/);
    assert.match(remote.movePlan({ rel: '', isDir: true }, { rel: 'x', exists: false }).error, /drive root/);
});

test('movePlan: a folder never goes into itself', function () {
    var d = { rel: 'shows', isDir: true };
    assert.match(remote.movePlan(d, { rel: 'shows/S01', exists: true, isDir: true }).error, /into itself/);
    assert.match(remote.movePlan(d, { rel: 'shows/sub', exists: false }).error, /into itself/);
    assert.strictEqual(remote.movePlan(d, { rel: 'shows2', exists: false }).to, 'shows2', 'a sibling with the same prefix is fine');
    assert.strictEqual(remote.movePlan(d, { rel: 'archive', exists: true, isDir: true }).to, 'archive/shows');
});

test('movePlan: names with spaces and non-ASCII pass through untouched', function () {
    var f = { rel: 'Füße & Fässer/Épisode 1 – „Start“ (日本語).mp4', isDir: false };
    assert.strictEqual(remote.movePlan(f, { rel: 'Füße & Fässer/S01', exists: true, isDir: true }).to, 'Füße & Fässer/S01/Épisode 1 – „Start“ (日本語).mp4');
});
