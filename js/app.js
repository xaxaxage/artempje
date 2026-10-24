import { renderHome } from './home.js?v=1792859704857';
import { renderEditor } from './editor.js?v=1792859704857';
import { startPlay } from './game.js?v=1792859704857';
import { renderHistory } from './historyview.js?v=1792859704857';
import { esc, siteUpdatedBanner } from './util.js?v=1792859704857';
import { VERSION } from './version.js?v=1792859704857';

const host = document.getElementById('app');
let cleanup = null;
let seq = 0;

async function route() {
  const my = ++seq;
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  document.querySelectorAll('.dlg-wrap').forEach((d) => d.close?.(null));
  // A fresh root per page, so listeners from the previous page can't leak.
  const root = document.createElement('div');
  host.replaceChildren(root);
  window.scrollTo(0, 0);
  const [, view, id] = (location.hash.slice(1) || '/').split('/');
  let c;
  try {
    if (view === 'edit' && id) c = await renderEditor(root, id);
    else if (view === 'play' && id) c = await startPlay(root, id);
    else if (view === 'history' && id) c = await renderHistory(root, id);
    else c = await renderHome(root);
  } catch (e) {
    console.error(e);
    root.innerHTML = `<div class="page center"><h1>Что-то сломалось</h1><p class="muted">${esc(e?.message || e)}</p><a class="btn primary" href="#/">На главную</a></div>`;
  }
  if (my !== seq) { try { c?.(); } catch {} return; }
  cleanup = c || null;
}

window.addEventListener('hashchange', route);
route();

// A tab opened before the last deploy keeps running old code: offer a reload.
fetch('version.json', { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { if (j?.v && j.v > VERSION) siteUpdatedBanner(); })
  .catch(() => {});
