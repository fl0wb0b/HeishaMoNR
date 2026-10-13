// Bilder und Ueberlauf-Pruefung der statischen Vorschau (tools/engine_ui_preview.js) in mehreren Fensterbreiten, offline mit Firefox headless (WebDriver BiDi).
// Usage: node tools/ui_vorschau_pruefen.js <ausgabe-ordner> <seite.html> [weitere.html ...] [--breiten=1024,1920,2560]
// Schreibt je Seite und Breite <ordner>/<seite>_<breite>.png und gibt die Pruefung der Seite aus (window.__pruef). Exit 1 bei einem Fehler.
// Firefox laeuft mit eigenem, leerem Profil: klassische Bildlaufleisten (wie Windows/Chrome), alle Netzwerkzugriffe ueber einen toten Proxy (nur file://).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const args = process.argv.slice(2), opt = args.filter(a => a.startsWith('--')), pos = args.filter(a => !a.startsWith('--'));
const outDir = pos[0], pages = pos.slice(1).map(p => path.resolve(p));
const widths = ((opt.find(a => a.startsWith('--breiten=')) || '--breiten=1024,1920,2560').split('=')[1]).split(',').map(Number);
if (!outDir || !pages.length) { console.error('Usage: node tools/ui_vorschau_pruefen.js <ausgabe-ordner> <seite.html> [...] [--breiten=1024,1920,2560]'); process.exit(2); }
fs.mkdirSync(outDir, {recursive: true});
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'ffprof-'));
fs.writeFileSync(path.join(prof, 'user.js'), [
    ['widget.gtk.overlay-scrollbars.enabled', false], ['widget.non-native-theme.scrollbar.style', 4], ['layout.css.devPixelsPerPx', '"1.0"'],
    ['network.proxy.type', 1], ['network.proxy.http', '"127.0.0.1"'], ['network.proxy.http_port', 9], ['network.proxy.ssl', '"127.0.0.1"'], ['network.proxy.ssl_port', 9],
    ['network.proxy.socks', '"127.0.0.1"'], ['network.proxy.socks_port', 9], ['network.proxy.no_proxies_on', '""'], ['services.settings.server', '"http://127.0.0.1:9/"'],
    ['datareporting.policy.dataSubmissionEnabled', false], ['toolkit.telemetry.enabled', false], ['app.normandy.enabled', false], ['browser.shell.checkDefaultBrowser', false]
].map(p => 'user_pref("' + p[0] + '", ' + p[1] + ');').join('\n') + '\n');
const port = 9300 + Math.floor(Math.random() * 500);
const ff = spawn('firefox', ['--headless', '--no-remote', '--profile', prof, '--remote-debugging-port', String(port), 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
let ready = null; const readyP = new Promise(r => { ready = r; });
ff.stderr.on('data', d => { if (/WebDriver BiDi listening/.test(String(d))) { ready(); } });
const done = code => { try { ff.kill('SIGTERM'); } catch (e) { /* egal */ } try { fs.rmSync(prof, {recursive: true, force: true}); } catch (e) { /* egal */ } process.exit(code); };
setTimeout(() => { console.error('Zeitueberschreitung'); done(3); }, 180000);
(async () => {
    await readyP;
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/session');
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const wait = {};
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && wait[m.id]) { wait[m.id](m); delete wait[m.id]; } };
    const call = (method, params) => new Promise((res, rej) => { const i = ++id; wait[i] = m => (m.type === 'error' ? rej(new Error(method + ': ' + m.error + ' ' + m.message)) : res(m.result)); ws.send(JSON.stringify({id: i, method: method, params: params})); });
    await call('session.new', {capabilities: {}});
    const ctx = (await call('browsingContext.getTree', {})).contexts[0].context;
    let fails = 0;
    for (const pg of pages) {
        for (const w of widths) {
            await call('browsingContext.setViewport', {context: ctx, viewport: {width: w, height: 1000}, devicePixelRatio: 1});
            await call('browsingContext.navigate', {context: ctx, url: 'file://' + pg, wait: 'complete'});
            const r = await call('script.evaluate', {expression: 'new Promise(function (ok) { var n = 0; (function t() { if (window.__pruef || n++ > 60) { ok(JSON.stringify(window.__pruef || null)); } else { setTimeout(t, 50); } })(); })', target: {context: ctx}, awaitPromise: true});
            const P = JSON.parse(r.result.value);
            const shot = await call('browsingContext.captureScreenshot', {context: ctx, origin: 'document'});
            const png = path.join(outDir, path.basename(pg, '.html') + '_' + w + '.png');
            fs.writeFileSync(png, Buffer.from(shot.data, 'base64'));
            if (!P || P.fehler.length) { fails++; }
            console.log((P && !P.fehler.length ? 'OK   ' : 'FAIL ') + path.basename(pg) + ' bei ' + w + ' px (Inhalt ' + (P ? P.breite : '?') + ' px, Spalten ' + (P ? P.spalten : '?') + ') -> ' + png);
            if (P) { P.karten.forEach(k => console.log('       ' + k)); P.fehler.forEach(f => console.log('       FEHLER ' + f)); }
        }
    }
    try { await call('session.end', {}); } catch (e) { /* egal */ }
    done(fails ? 1 : 0);
})().catch(e => { console.error(e.message); done(3); });
