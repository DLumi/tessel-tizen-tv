/* network-access.js — implements the Network access setting.
 *
 *   all    allow every connection
 *   own    allow servers and URLs the user added, on the LAN or the
 *          internet; block third-party services (ntfy.sh, used for
 *          cast-from-phone and code pairing)
 *   none   block all network access: only file: URLs play, and the
 *          background service is not started
 *
 * Enforcement has two parts.  install() makes XMLHttpRequest.open throw for
 * blocked URLs, which also covers call sites that skip the check.  Entry
 * points call check() first, so the user sees a dialog offering to raise
 * the level instead of an error.
 *
 * ES5 on purpose, like the rest of the app. */

var NetworkAccess = (function () {
    'use strict';

    /* Levels, from most to least permissive. */
    var LEVELS = ['all', 'own', 'none'];
    /* Third-party hosts the app contacts without the user configuring them. */
    var SERVICES = ['ntfy.sh'];

    /* Return the host of url, or '' for file:, blob:, data: and relative
     * URLs (they never leave the TV). */
    function hostOf(url) {
        var m = /^([a-z][a-z0-9+.-]*):\/\/([^\/?#]*)/i.exec(String(url || '').trim());
        if (!m) return '';
        var scheme = m[1].toLowerCase(), auth = m[2];
        if (scheme === 'file' || scheme === 'blob') return '';
        var at = auth.lastIndexOf('@');
        if (at >= 0) auth = auth.slice(at + 1);
        var v6 = /^\[([^\]]*)\]/.exec(auth);
        return (v6 ? v6[1] : auth.replace(/:\d*$/, '')).toLowerCase();
    }
    function isService(host) {
        for (var i = 0; i < SERVICES.length; i++) {
            var s = SERVICES[i];
            if (host === s || host.slice(-s.length - 1) === '.' + s) return true;
        }
        return false;
    }
    /* Return the most restrictive level that still allows url. */
    function needs(url) {
        var h = hostOf(url);
        return !h ? 'none' : isService(h) ? 'all' : 'own';
    }

    function create(settings) {
        function level() {
            var v = settings ? settings.get('networkAccess') : 'all';
            return LEVELS.indexOf(v) >= 0 ? v : 'all';
        }
        function allows(url) {
            return LEVELS.indexOf(needs(url)) >= LEVELS.indexOf(level());
        }

        /* Dialog callback, set by app.js: function (what, levelNeeded, retry). */
        var prompt = null;
        function setPrompt(fn) { prompt = fn; }

        /* Return true if url is allowed.  Otherwise show the dialog, if one
         * is set, so the user can raise the level and run retry, and return
         * false.  what is the name shown in the dialog (default: the URL's
         * host). */
        function check(url, what, retry) {
            if (allows(url)) return true;
            if (prompt) prompt(what || hostOf(url), needs(url), retry);
            return false;
        }
        /* Check a feature that needs the network but no specific URL
         * (browsing a server, the LAN scan): allowed at every level except
         * 'none'. */
        function checkFeature(what, retry) {
            if (level() !== 'none') return true;
            if (prompt) prompt(what, 'own', retry);
            return false;
        }
        function refusal(what) {
            return new Error(typeof I18n !== 'undefined' ? I18n.t('net.refused', what) : 'network access: ' + what);
        }

        /* Patch XMLHttpRequest.open to refuse blocked URLs.  Every module
         * fetches through XHR, so this catches calls that skipped check(). */
        function install(win) {
            var X = win && win.XMLHttpRequest;
            if (!X || !X.prototype || X.prototype.open.networkAccess) return;
            var open = X.prototype.open;
            function guarded(method, url) {
                if (!allows(url)) throw refusal(hostOf(url));
                return open.apply(this, arguments);
            }
            guarded.networkAccess = true;
            X.prototype.open = guarded;
        }

        return { LEVELS: LEVELS, level: level, allows: allows, needs: needs, hostOf: hostOf,
                 check: check, checkFeature: checkFeature, refusal: refusal,
                 setPrompt: setPrompt, install: install };
    }

    var api = create(typeof Settings !== 'undefined' ? Settings : null);
    api.create = create;
    if (typeof window !== 'undefined') api.install(window);
    return api;
})();

// Ignored by the Tizen/browser build; lets Node tests require these helpers.
if (typeof module !== 'undefined' && module.exports) module.exports = NetworkAccess;
