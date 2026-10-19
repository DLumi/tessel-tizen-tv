'use strict';

var assert    = require('assert');
var test      = require('node:test');
var FileTypes = require('../../tizen-app/js/filetypes.js');

/* macOS leaves "._movie.mp4" AppleDouble companions (a few KB, unplayable)
 * next to every file it copies to a FAT/exFAT stick or an SMB share.  They
 * end in .mp4, so by extension alone they look like videos and show up as
 * duplicates that fail to play.  Dot-prefixed entries are hidden instead. */
test('isHidden: dot-prefixed names are hidden', function () {
    assert.equal(FileTypes.isHidden('._movie.mp4'), true);
    assert.equal(FileTypes.isHidden('.DS_Store'), true);
    assert.equal(FileTypes.isHidden('.Spotlight-V100'), true);
    assert.equal(FileTypes.isHidden('.Trashes'), true);
    assert.equal(FileTypes.isHidden('.fseventsd'), true);
});

test('isHidden: ordinary names are not', function () {
    assert.equal(FileTypes.isHidden('movie.mp4'), false);
    assert.equal(FileTypes.isHidden('Movie.Part.1.mkv'), false);
    assert.equal(FileTypes.isHidden('Music'), false);
    assert.equal(FileTypes.isHidden('cover.jpg'), false);
});

test('isHidden: looks at the last path segment only', function () {
    assert.equal(FileTypes.isHidden('/Movies/._movie.mp4'), true);
    assert.equal(FileTypes.isHidden('/.hidden/movie.mp4'), false);
    assert.equal(FileTypes.isHidden(''), false);
    assert.equal(FileTypes.isHidden(null), false);
});
