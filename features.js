/* Soundshelf extras: sync across devices, reading stats, bookmarks & highlights,
 * look-up (dictionary / Wikipedia), and jumping from the audio to the same spot in the book.
 * Loaded after app.js and plugs in through window.Hooks. */
'use strict';

/* ================================================================ small helpers */
const DEVICE = (Store.data.device ||= Math.random().toString(36).slice(2, 10));
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const normText = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

let toastTimer = 0;
function toast(msg, ms = 2500) {
  let el = $('ssToast');
  if (!el) { el = document.createElement('div'); el.id = 'ssToast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ================================================================ sync (Google Drive app-data folder)
 * One small private file, soundshelf.json, in the app's hidden Drive folder. Each device keeps a
 * local copy and merges with it: newest position wins, bookmarks/highlights merge by id, and stats
 * are kept per device so nothing is ever counted twice. */
const Sync = {
  enabled: false, fileId: null, timer: 0, busy: false,
  async req(url, opts = {}) {
    if (Date.now() > DriveSource.expires) await DriveSource.signIn('');
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${DriveSource.token}` } });
    if (!r.ok) throw new Error(`Sync error ${r.status}`);
    return r;
  },
  async remote() {
    if (!this.fileId) {
      const q = enc("name='soundshelf.json'");
      const d = await (await this.req(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id)`)).json();
      this.fileId = d.files[0]?.id || null;
    }
    if (!this.fileId) return null;
    return (await this.req(`https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media`)).json();
  },
  async sync() {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      const remote = await this.remote();
      if (remote) { mergeInto(Store.data, remote); saveQuiet(); }
      const body = JSON.stringify(payload());
      if (!this.fileId) {
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify({ name: 'soundshelf.json', parents: ['appDataFolder'] })], { type: 'application/json' }));
        form.append('file', new Blob([body], { type: 'application/json' }));
        this.fileId = (await (await this.req('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form })).json()).id;
      } else {
        await this.req(`https://www.googleapis.com/upload/drive/v3/files/${this.fileId}?uploadType=media`,
          { method: 'PATCH', body, headers: { 'Content-Type': 'application/json' } });
      }
      Store.data.syncedAt = Date.now(); saveQuiet();
      if (!$('library').hidden) showLibrary();
    } catch (e) { console.warn('sync', e); }
    finally { this.busy = false; }
  },
  schedule() { if (this.enabled) { clearTimeout(this.timer); this.timer = setTimeout(() => this.sync(), 15000); } },
};
function saveQuiet() { try { localStorage.setItem('listen', JSON.stringify(Store.data)); } catch {} }
function payload() {
  const d = Store.data;
  return { v: 1, pos: d.pos || {}, cfi: d.cfi || {}, last: d.last, lastAt: d.lastAt || 0, marks: d.marks || {}, stats: d.stats || {} };
}
function mergeInto(local, remote) {
  const newer = (a, b) => (b?.at || 0) > (a?.at || 0);
  for (const k of ['pos', 'cfi']) {
    local[k] ||= {};
    for (const [id, v] of Object.entries(remote[k] || {})) {
      const lv = typeof local[k][id] === 'string' ? { cfi: local[k][id], at: 0 } : local[k][id];
      if (!lv || newer(lv, v)) local[k][id] = v;
    }
  }
  if ((remote.lastAt || 0) > (local.lastAt || 0)) { local.last = remote.last; local.lastAt = remote.lastAt; }
  local.marks ||= {};
  for (const [bid, items] of Object.entries(remote.marks || {})) {
    const mine = (local.marks[bid] ||= {});
    for (const [id, m] of Object.entries(items)) if (!mine[id] || newer(mine[id], m)) mine[id] = m;
  }
  local.stats ||= {};
  for (const [dev, days] of Object.entries(remote.stats || {})) {
    const mine = (local.stats[dev] ||= {});
    for (const [day, r] of Object.entries(days)) {
      const l = (mine[day] ||= { listen: 0, read: 0, words: 0, pages: 0, h: {}, b: {} });
      for (const f of ['listen', 'read', 'words', 'pages']) l[f] = Math.max(l[f] || 0, r[f] || 0);
      for (const [hr, v] of Object.entries(r.h || {})) l.h[hr] = Math.max(l.h[hr] || 0, v);
      for (const [b, v] of Object.entries(r.b || {})) {
        const lb = (l.b[b] ||= {});
        for (const [f, x] of Object.entries(v)) lb[f] = Math.max(lb[f] || 0, x);
      }
    }
  }
}
Hooks.saved = () => Sync.schedule();
Hooks.signedIn = () => { Sync.enabled = true; Sync.sync(); };
document.addEventListener('visibilitychange', () => { if (Sync.enabled) Sync.sync(); });   // leaving or coming back

/* ================================================================ reading stats */
function statDay(day = dayKey()) {
  const dev = ((Store.data.stats ||= {})[DEVICE] ||= {});
  return (dev[day] ||= { listen: 0, read: 0, words: 0, pages: 0, h: {}, b: {} });
}
function addTime(kind, sec, bookId) {
  const r = statDay();
  r[kind] = Math.round((r[kind] + sec) * 10) / 10;
  const hr = new Date().getHours();
  r.h[hr] = Math.round(((r.h[hr] || 0) + sec) * 10) / 10;
  if (bookId) { const b = (r.b[bookId] ||= {}); b[kind] = Math.round(((b[kind] || 0) + sec) * 10) / 10; }
}
let lastTick = Date.now(), lastWord = -1, lastInteract = Date.now(), unsaved = 0;
for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel']) addEventListener(ev, () => { lastInteract = Date.now(); }, { passive: true, capture: true });
setInterval(() => {
  const now = Date.now(), dt = (now - lastTick) / 1000;
  lastTick = now;
  if (!audio.paused && book) {                              // listening (also counts while the screen is off)
    addTime('listen', Math.min(dt, 75), book.id);
    if (words.length && cur >= 0) {
      if (lastWord >= 0 && cur > lastWord && cur - lastWord < 80) statDay().words += cur - lastWord;
      lastWord = cur;
    }
    unsaved += dt;
  } else if (SR.playing && book) {                          // silent speed reading counts as reading
    addTime('read', Math.min(dt, 2), book.id);
    if (lastWord >= 0 && cur > lastWord && cur - lastWord < 80) statDay().words += cur - lastWord;
    lastWord = cur;
    unsaved += dt;
  } else lastWord = -1;
  if (!$('reader').hidden && R.ready && !document.hidden && audio.paused && now - lastInteract < 180000) {
    addTime('read', Math.min(dt, 2), R.id);                  // reading: the book is open and you've touched it lately
    unsaved += dt;
  }
  if (unsaved >= 15) { unsaved = 0; Store.save(); }
}, 1000);
addEventListener('pagehide', () => saveQuiet());

/* ================================================================ bookmarks & highlights */
const COLORS = { yellow: '#f5cf3a', green: '#7fd06d', blue: '#73b5f5', pink: '#f38fba' };
const marksOf = (bid, type) => Object.values((Store.data.marks || {})[bid] || {})
  .filter(m => !m.deleted && (!type || m.type === type))
  .sort((a, b) => { try { return new ePub.CFI().compare(a.cfi, b.cfi); } catch { return a.at - b.at; } });
function putMark(bid, m) { ((Store.data.marks ||= {})[bid] ||= {})[m.id] = { ...m, at: Date.now() }; Store.save(); }
function dropMark(bid, id) {
  const m = Store.data.marks?.[bid]?.[id];
  if (!m) return;
  if (m.type === 'highlight' && R.rendition && R.id === bid) try { R.rendition.annotations.remove(m.cfi, 'highlight'); } catch {}
  putMark(bid, { id, type: m.type, cfi: m.cfi, deleted: true });
}
function drawHighlight(m) {
  try { R.rendition.annotations.remove(m.cfi, 'highlight'); } catch {}
  R.rendition.annotations.highlight(m.cfi, { id: m.id }, e => { e?.stopPropagation?.(); openMarkMenu(m.id); }, 'ss-hl',
    { fill: COLORS[m.color] || COLORS.yellow, 'fill-opacity': '0.35' });
}
function pctOf(cfi) { try { return R.locReady ? Math.round(R.epub.locations.percentageFromCfi(cfi) * 100) : null; } catch { return null; } }

Hooks.readerReady = () => {
  for (const m of marksOf(R.id, 'highlight')) drawHighlight(m);
  updateBookmarkBtn();
  if (pendingJump && pendingJump.bookId === R.id) runJump();
};
let firstLoc = true;
Hooks.relocated = loc => {
  if (!firstLoc) statDay().pages += 1;
  firstLoc = false;
  updateBookmarkBtn(loc);
  hideSelBar();
};
function bookmarkHere(loc = R.rendition?.currentLocation()) {
  if (!loc?.start) return null;
  const cmp = new ePub.CFI();
  return marksOf(R.id, 'bookmark').find(m => {
    try { return cmp.compare(m.cfi, loc.start.cfi) >= 0 && cmp.compare(m.cfi, loc.end.cfi) <= 0; } catch { return false; }
  });
}
function updateBookmarkBtn(loc) {
  const on = !!bookmarkHere(loc);
  $('rMarkBtn').classList.toggle('on', on);
  $('rMarkBtn').setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark this page');
}
$('rMarkBtn').onclick = () => {
  if (!R.ready) return;
  const loc = R.rendition.currentLocation(), have = bookmarkHere(loc);
  if (have) { dropMark(R.id, have.id); toast('Bookmark removed'); }
  else {
    putMark(R.id, { id: uid(), type: 'bookmark', cfi: loc.start.cfi, label: $('rChapter').textContent, pct: pctOf(loc.start.cfi), created: Date.now() });
    toast('Bookmarked');
  }
  updateBookmarkBtn(loc);
};

/* Contents / Bookmarks / Highlights tabs */
let tab = 'toc';
$('rTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) { tab = b.dataset.tab; renderTabs(); } };
const openToc = $('rTocBtn').onclick;
$('rTocBtn').onclick = () => { openToc(); if (!$('rToc').hidden) renderTabs(); };
function renderTabs() {
  document.querySelectorAll('#rTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('rTocList').hidden = tab !== 'toc';
  $('rMarkList').hidden = tab === 'toc';
  if (tab === 'toc') return;
  const list = $('rMarkList'), items = marksOf(R.id, tab === 'bookmarks' ? 'bookmark' : 'highlight');
  list.innerHTML = items.length ? '' : `<li class="empty muted">${tab === 'bookmarks' ? 'No bookmarks yet. Tap 🔖 to bookmark a page.' : 'No highlights yet. Select some text to highlight it.'}</li>`;
  for (const m of items) {
    const li = document.createElement('li');
    const when = new Date(m.created || m.at).toLocaleDateString([], { day: 'numeric', month: 'short' });
    li.innerHTML = m.type === 'bookmark'
      ? `<button class="mark"><span class="mt">${esc(m.label || 'Bookmark')}</span><span class="mm">${m.pct != null ? m.pct + '% · ' : ''}${when}</span></button>`
      : `<button class="mark hl" style="--hl:${COLORS[m.color] || COLORS.yellow}"><span class="mt">“${esc(m.text.slice(0, 220))}${m.text.length > 220 ? '…' : ''}”</span><span class="mm">${esc(m.label || '')}${m.label ? ' · ' : ''}${when}</span></button>`;
    const del = document.createElement('button');
    del.className = 'icon del'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete');
    del.onclick = () => { dropMark(R.id, m.id); renderTabs(); updateBookmarkBtn(); };
    li.firstChild.onclick = () => { R.rendition.display(m.cfi); $('rToc').hidden = true; };
    li.appendChild(del);
    list.appendChild(li);
  }
}

/* ================================================================ selection menu + look-up */
let sel = null;     // { text, cfi?, contents?, markId? }
function selBar() {
  let bar = $('ssSel');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ssSel'; bar.className = 'sel-bar'; bar.hidden = true;
    bar.addEventListener('mousedown', e => e.preventDefault());       // keep the text selected
    bar.onclick = onSelAction;
  }
  const home = !$('reader').hidden ? $('rotor') : document.body;
  if (bar.parentNode !== home) home.appendChild(bar);
  return bar;
}
function showSelBar(s) {
  sel = s;
  const bar = selBar();
  const colors = s.cfi ? Object.entries(COLORS).map(([k, c]) => `<button class="dot" data-act="hl" data-color="${k}" style="background:${c}" aria-label="Highlight ${k}"></button>`).join('') : '';
  bar.innerHTML = `${colors}${s.markId ? '<button data-act="unhl">Remove</button>' : ''}
    <button data-act="define">Define</button><button data-act="lookup">Look up</button><button data-act="copy">Copy</button>`;
  bar.hidden = false;
}
function hideSelBar() { const b = $('ssSel'); if (b) b.hidden = true; sel = null; }
function clearSelection() {
  try { sel?.contents?.window.getSelection().removeAllRanges(); } catch {}
  try { getSelection().removeAllRanges(); } catch {}
}
function onSelAction(e) {
  const b = e.target.closest('button');
  if (!b || !sel) return;
  const s = sel, act = b.dataset.act;
  if (act === 'hl') {
    const m = s.markId ? { ...Store.data.marks[R.id][s.markId], color: b.dataset.color }
      : { id: uid(), type: 'highlight', cfi: s.cfi, text: s.text, color: b.dataset.color, label: $('rChapter').textContent, pct: pctOf(s.cfi), created: Date.now() };
    putMark(R.id, m); drawHighlight(m); toast('Highlighted');
  } else if (act === 'unhl') { dropMark(R.id, s.markId); toast('Highlight removed'); }
  else if (act === 'copy') { navigator.clipboard?.writeText(s.text).then(() => toast('Copied')).catch(() => {}); }
  else if (act === 'define' || act === 'lookup') openLookup(s.text, act === 'define' ? 'dict' : 'wiki');
  clearSelection(); hideSelBar();
}
Hooks.selected = (cfi, contents) => {
  const text = String(contents.window.getSelection()).trim().replace(/\s+/g, ' ');
  if (text) showSelBar({ text, cfi, contents });
};
function openMarkMenu(id) {
  const m = Store.data.marks?.[R.id]?.[id];
  if (m) showSelBar({ text: m.text, cfi: m.cfi, markId: id });
}
/* Selecting words in the player's text view (no highlights there, just define / look up / copy). */
for (const ev of ['mouseup', 'touchend']) $('textView').addEventListener(ev, () => setTimeout(() => {
  const t = String(getSelection()).trim().replace(/\s+/g, ' ');
  if (t && !$('player').hidden) showSelBar({ text: t }); else if (!t) hideSelBar();
}, 30));
document.addEventListener('selectionchange', () => { if (!$('player').hidden && !String(getSelection()).trim()) setTimeout(() => { if (!String(getSelection()).trim() && sel && !sel.cfi) hideSelBar(); }, 200); });
addEventListener('hashchange', hideSelBar);

/* The little look-up window: a dictionary definition, or Wikipedia results. */
function lookupBox() {
  let box = $('ssLookup');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ssLookup'; box.className = 'lookup'; box.hidden = true;
    box.innerHTML = `<div class="lk-head"><b id="lkTerm"></b><button class="icon" id="lkClose" aria-label="Close">✕</button></div>
      <div class="tabs lk-tabs"><button data-src="dict">Dictionary</button><button data-src="wiki">Wikipedia</button></div>
      <div id="lkBody" class="lk-body"></div>
      <div class="lk-foot"><a id="lkWeb" target="_blank" rel="noopener">Search the web ↗</a></div>`;
    box.querySelector('#lkClose').onclick = () => { box.hidden = true; };
    box.querySelector('.lk-tabs').onclick = e => { const b = e.target.closest('[data-src]'); if (b) loadLookup(box.dataset.term, b.dataset.src); };
  }
  const home = !$('reader').hidden ? $('rotor') : document.body;
  if (box.parentNode !== home) home.appendChild(box);
  return box;
}
function openLookup(term, src) {
  term = term.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').slice(0, 120);
  const box = lookupBox();
  box.dataset.term = term; box.hidden = false;
  $('lkTerm').textContent = term;
  $('lkWeb').href = `https://www.google.com/search?q=${enc(term)}`;
  loadLookup(term, term.split(/\s+/).length > 2 ? 'wiki' : src);
}
let lookupSeq = 0;
async function loadLookup(term, src) {
  const seq = ++lookupSeq, body = $('lkBody');
  document.querySelectorAll('.lk-tabs button').forEach(b => b.classList.toggle('on', b.dataset.src === src));
  body.innerHTML = '<p class="muted">Looking it up…</p>';
  try {
    const html = src === 'dict' ? await dictionary(term) : await wikipedia(term);
    if (seq === lookupSeq) body.innerHTML = html;
  } catch (e) {
    if (seq === lookupSeq) body.innerHTML = `<p class="muted">${src === 'dict' ? 'No dictionary entry found.' : 'Nothing found on Wikipedia.'} Try the other tab or “Search the web”.</p>`;
  }
  body.querySelectorAll('[data-wiki]').forEach(a => a.onclick = ev => { ev.preventDefault(); loadWikiPage(a.dataset.wiki); });
}
async function dictionary(term) {
  const word = term.split(/\s+/)[0].toLowerCase();
  const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${enc(word)}`);
  if (!r.ok) throw new Error('none');
  const entries = await r.json();
  const e = entries[0];
  const phon = e.phonetic || e.phonetics?.find(p => p.text)?.text || '';
  let html = `<p class="lk-word">${esc(e.word)} <span class="muted">${esc(phon)}</span></p>`;
  for (const m of entries.flatMap(x => x.meanings).slice(0, 4)) {
    html += `<p class="lk-pos">${esc(m.partOfSpeech)}</p><ol class="lk-defs">`;
    for (const d of m.definitions.slice(0, 3)) html += `<li>${esc(d.definition)}${d.example ? `<br><i class="muted">“${esc(d.example)}”</i>` : ''}</li>`;
    html += '</ol>';
  }
  return html;
}
async function wikipedia(term) {
  const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(term)}&srlimit=6&format=json&origin=*`);
  const hits = (await r.json()).query?.search || [];
  if (!hits.length) throw new Error('none');
  const top = await wikiSummary(hits[0].title);
  const others = hits.slice(1).map(h => `<li><a href="#" data-wiki="${esc(h.title)}">${esc(h.title)}</a><br><span class="muted small">${esc(h.snippet.replace(/<[^>]+>/g, ''))}…</span></li>`).join('');
  return top + (others ? `<p class="lk-pos">Other results</p><ul class="lk-results">${others}</ul>` : '');
}
async function wikiSummary(title) {
  const s = await (await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc(title.replace(/ /g, '_'))}`)).json();
  return `<div class="lk-wiki">${s.thumbnail ? `<img src="${esc(s.thumbnail.source)}" alt="">` : ''}
    <p class="lk-word">${esc(s.title)}</p>${s.description ? `<p class="muted small">${esc(s.description)}</p>` : ''}
    <p>${esc(s.extract || '')}</p>
    <a href="${esc(s.content_urls?.mobile?.page || s.content_urls?.desktop?.page || '#')}" target="_blank" rel="noopener">Read on Wikipedia ↗</a></div>`;
}
async function loadWikiPage(title) {
  const body = $('lkBody');
  body.innerHTML = '<p class="muted">Loading…</p>';
  try { body.innerHTML = await wikiSummary(title); } catch { body.innerHTML = '<p class="muted">Could not load that page.</p>'; }
}

/* ================================================================ from the audio to the same spot in the book
 * Takes the words being spoken right now and finds that exact sentence in the EPUB's text,
 * searching the chapters nearest to where it should be first. */
let pendingJump = null;
const sectionText = new Map();          // bookId:spineIndex -> { norm, map, nodes, section }
Hooks.jumpFromPlayer = () => {
  if (!book) return;
  const done = book.chapters.filter(c => c.n < chapter.n).reduce((a, c) => a + c.duration, 0) + audio.currentTime;
  const frac = done / (bookSeconds(book) || 1);
  let phrase = null;
  if (words.length && cur >= 0) {
    const a = Math.max(0, cur - 6), b = Math.min(words.length, cur + 8);
    phrase = { words: words.slice(a, b).map(w => w.text), at: cur - a };
  }
  pendingJump = { bookId: book.id, chapter: chapter.n, phrase, frac };
  if (R.ready && R.id === book.id) setTimeout(runJump, 50);
};
function buildIndex(section) {
  const doc = section.document, nodes = [], map = [];
  let norm = '', space = true;
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const t = n.nodeValue, ni = nodes.push(n) - 1;
    for (let k = 0; k < t.length; k++) {
      const ch = t[k].toLowerCase();
      if (/[\p{L}\p{N}]/u.test(ch) && ch.length === 1) { norm += ch; map.push(ni, k); space = false; }
      else if (!space) { norm += ' '; map.push(ni, k); space = true; }
    }
  }
  return { norm, map, nodes, section };
}
async function sectionIndex(i) {
  const key = R.id + ':' + i;
  if (!sectionText.has(key)) {
    const section = R.epub.spine.get(i);
    await section.load(R.epub.load.bind(R.epub));
    sectionText.set(key, buildIndex(section));
  }
  return sectionText.get(key);
}
function findIn(ix, phrase) {
  const w = phrase.words;
  const tries = [[0, w.length], [Math.max(0, phrase.at - 3), phrase.at + 6], [phrase.at, phrase.at + 6], [Math.max(0, phrase.at - 5), phrase.at + 1], [phrase.at, phrase.at + 4]];
  for (const [a, b] of tries) {
    const slice = w.slice(a, b), q = normText(slice.join(' '));
    if (q.split(' ').length < 3) continue;
    const at = ix.norm.indexOf(q);
    if (at < 0 || ix.norm.indexOf(q, at + 1) >= 0 && b - a < 6) continue;   // not found, or too short to be sure
    const before = normText(w.slice(a, phrase.at).join(' '));
    const start = at + (before ? before.length + 1 : 0), len = Math.max(1, normText(w[phrase.at]).length);
    const s = start * 2, e = (start + len - 1) * 2;
    if (e + 1 >= ix.map.length) continue;
    const range = ix.section.document.createRange();
    range.setStart(ix.nodes[ix.map[s]], ix.map[s + 1]);
    range.setEnd(ix.nodes[ix.map[e]], ix.map[e + 1] + 1);
    return ix.section.cfiFromRange(range);
  }
  return null;
}
async function runJump() {
  const j = pendingJump;
  if (!j || !R.ready || R.id !== j.bookId) return;
  pendingJump = null;
  const spine = R.epub.spine.spineItems.filter(s => s.linear !== false && s.linear !== 'no');
  toast('Finding your place…', 0);
  let cfi = null;
  if (j.phrase) {
    const known = (Store.data.chapSpine || {})[`${j.bookId}:${j.chapter}`];
    const guess = known ?? spine[Math.min(spine.length - 1, Math.floor(j.frac * spine.length))]?.index ?? 0;
    const order = spine.map(s => s.index).sort((a, b) => Math.abs(a - guess) - Math.abs(b - guess));
    for (const i of order) {
      try { cfi = findIn(await sectionIndex(i), j.phrase); } catch (e) { console.warn(e); }
      if (cfi) { ((Store.data.chapSpine ||= {}))[`${j.bookId}:${j.chapter}`] = i; saveQuiet(); break; }
    }
  }
  if (cfi) {
    await R.rendition.display(cfi);
    try {
      R.rendition.annotations.highlight(cfi, {}, null, 'ss-jump', { fill: '#ff9d2e', 'fill-opacity': '0.55' });
      setTimeout(() => { try { R.rendition.annotations.remove(cfi, 'highlight'); } catch {} }, 4000);
    } catch {}
    toast('Here’s where you were listening');
  } else {
    if (!R.locReady) await new Promise(r => { const t = setInterval(() => { if (R.locReady) { clearInterval(t); r(); } }, 300); });
    await R.rendition.display(R.epub.locations.cfiFromPercentage(j.frac));
    toast(j.phrase ? 'Couldn’t find the exact sentence, so opened the nearest spot' : 'Opened about where you were listening (this chapter has no word timings)', 4000);
  }
}

/* ================================================================ stats page */
Hooks.showStats = renderStats;
function allDays() {
  const out = {};
  for (const days of Object.values(Store.data.stats || {})) {
    for (const [day, r] of Object.entries(days)) {
      const o = (out[day] ||= { listen: 0, read: 0, words: 0, pages: 0, h: {}, b: {} });
      for (const f of ['listen', 'read', 'words', 'pages']) o[f] += r[f] || 0;
      for (const [h, v] of Object.entries(r.h || {})) o.h[h] = (o.h[h] || 0) + v;
      for (const [b, v] of Object.entries(r.b || {})) { const ob = (o.b[b] ||= {}); for (const [f, x] of Object.entries(v)) ob[f] = (ob[f] || 0) + x; }
    }
  }
  return out;
}
const mins = s => Math.round(s / 60);
const dur = s => { const m = mins(s); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
function renderStats() {
  show('stats');
  const days = allDays(), today = dayKey();
  const back = n => { const d = new Date(); d.setDate(d.getDate() - n); return dayKey(d); };
  const tot = r => (r?.listen || 0) + (r?.read || 0);
  const week = [...Array(7)].reduce((a, _, i) => a + tot(days[back(i)]), 0);
  let streak = 0;
  for (let i = tot(days[today]) >= 60 ? 0 : 1; tot(days[back(i)]) >= 60; i++) streak++;
  const all = Object.values(days);
  const listen = all.reduce((a, r) => a + r.listen, 0), read = all.reduce((a, r) => a + r.read, 0);
  const wordsHeard = all.reduce((a, r) => a + r.words, 0);
  const listenWithWords = all.filter(r => r.words > 0).reduce((a, r) => a + r.listen, 0);
  const pace = listenWithWords > 60 ? Math.round(wordsHeard / (listenWithWords / 60)) : null;

  const tiles = [
    ['Today', dur(tot(days[today])), `${dur(days[today]?.listen || 0)} listening · ${dur(days[today]?.read || 0)} reading`],
    ['Last 7 days', dur(week), `${dur(week / 7)} a day on average`],
    ['Streak', `${streak} day${streak === 1 ? '' : 's'}`, 'days in a row with 1+ minute'],
    ['All time', dur(listen + read), `${dur(listen)} listening · ${dur(read)} reading`],
    ['Words heard', wordsHeard.toLocaleString(), 'in chapters with synced text'],
    ['Listening pace', pace ? `${pace} wpm` : '—', 'average words per minute'],
  ];
  let html = `<div class="tiles">${tiles.map(([k, v, s]) => `<div class="tile"><span class="tk">${k}</span><span class="tv">${v}</span><span class="ts">${s}</span></div>`).join('')}</div>`;

  /* Last 14 days: listening and reading, stacked */
  const last = [...Array(14)].map((_, i) => back(13 - i));
  const maxDay = Math.max(60, ...last.map(d => tot(days[d])));
  html += `<section class="chart-card"><h3>Last 14 days</h3>
    <div class="legend"><span><i class="sw-listen"></i>Listening</span><span><i class="sw-read"></i>Reading</span></div>
    <div class="bars days">${last.map(d => {
      const r = days[d] || {}, l = r.listen || 0, rd = r.read || 0, dt = new Date(d + 'T12:00');
      const tip = `${dt.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}: ${dur(l)} listening, ${dur(rd)} reading`;
      return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
        <div class="stack">${rd ? `<i class="seg read" style="height:${rd / maxDay * 100}%"></i>` : ''}${l ? `<i class="seg listen" style="height:${l / maxDay * 100}%"></i>` : ''}</div>
        <span class="lab">${d === today ? 'Today' : dt.toLocaleDateString([], { weekday: 'narrow' })}</span></div>`;
    }).join('')}</div><p class="axis-note muted small">Tallest bar: ${dur(maxDay)}</p></section>`;

  /* Time of day */
  const hours = [...Array(24)].map((_, h) => all.reduce((a, r) => a + (r.h[h] || 0), 0));
  const maxH = Math.max(60, ...hours);
  const fmtH = h => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' });
  html += `<section class="chart-card"><h3>When you read and listen</h3>
    <div class="bars hours">${hours.map((s, h) => {
      const tip = `${fmtH(h)}–${fmtH((h + 1) % 24)}: ${dur(s)} in total`;
      return `<div class="col" tabindex="0" data-tip="${esc(tip)}" aria-label="${esc(tip)}"><div class="stack">${s ? `<i class="seg one" style="height:${s / maxH * 100}%"></i>` : ''}</div>
        <span class="lab">${h % 6 === 0 ? fmtH(h) : ''}</span></div>`;
    }).join('')}</div></section>`;

  /* Per book */
  const perBook = {};
  for (const r of all) for (const [b, v] of Object.entries(r.b)) { const p = (perBook[b] ||= { listen: 0, read: 0 }); p.listen += v.listen || 0; p.read += v.read || 0; }
  const ranked = Object.entries(perBook).sort((a, b) => (b[1].listen + b[1].read) - (a[1].listen + a[1].read));
  const maxB = Math.max(1, ...ranked.map(([, v]) => v.listen + v.read));
  html += `<section class="chart-card"><h3>By book</h3>${ranked.length ? '' : '<p class="muted">Nothing yet. Start listening or reading and it shows up here.</p>'}
    <ul class="per-book">${ranked.map(([id, v]) => {
      const b = findBook(id), name = b ? b.title : id;
      const prog = b ? Math.round(bookProgress(b) * 100) : 0;
      return `<li><div class="pb-top"><span>${esc(name)}</span><span class="muted">${dur(v.listen + v.read)}${prog ? ` · ${prog}% listened` : ''}</span></div>
        <div class="pb-bar"><i class="seg listen" style="width:${v.listen / maxB * 100}%"></i><i class="seg read" style="width:${v.read / maxB * 100}%"></i></div></li>`;
    }).join('')}</ul></section>`;

  html += `<p class="muted small pad sync-note">${Sync.enabled ? `Saved to your Google Drive${Store.data.syncedAt ? `, last synced ${new Date(Store.data.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}, so it's the same on every device.` : 'Saved on this device only (sign in online to sync across devices).'}</p>`;
  $('statsBody').innerHTML = html;
}
/* Hover / tap tooltips for the charts */
(() => {
  const tip = document.createElement('div');
  tip.className = 'chart-tip'; tip.hidden = true; document.body.appendChild(tip);
  const showTip = el => {
    tip.textContent = el.dataset.tip; tip.hidden = false;
    const r = el.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
    tip.style.top = (r.top + scrollY - tip.offsetHeight - 8) + 'px';
  };
  document.addEventListener('pointerover', e => { const c = e.target.closest?.('#stats [data-tip]'); if (c) showTip(c); else tip.hidden = true; });
  document.addEventListener('focusin', e => { const c = e.target.closest?.('#stats [data-tip]'); if (c) showTip(c); });
  addEventListener('hashchange', () => { tip.hidden = true; });
})();
