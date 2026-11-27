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
    await DriveSource.ensureToken();
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
  return { v: 1, pos: d.pos || {}, cfi: d.cfi || {}, last: d.last, lastAt: d.lastAt || 0, marks: d.marks || {}, stats: d.stats || {}, finished: d.finished || {}, goals: d.goals, marked: d.marked || {}, genres: d.genres || {} };
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
  local.finished ||= {};
  for (const [id, t] of Object.entries(remote.finished || {})) if (!local.finished[id] || t < local.finished[id]) local.finished[id] = t;   // the first time you finished it
  if ((remote.goals?.at || 0) > (local.goals?.at || 0)) local.goals = remote.goals;
  local.marked ||= {};
  for (const [id, v] of Object.entries(remote.marked || {})) if (!local.marked[id] || newer(local.marked[id], v)) local.marked[id] = v;
  for (const [id, v] of Object.entries(local.marked)) if (v.done === false && local.finished) delete local.finished[id];   // un-finished on another device
  local.genres ||= {};
  for (const [id, v] of Object.entries(remote.genres || {})) if (!local.genres[id] || newer(local.genres[id], v)) local.genres[id] = v;
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
  .sort((a, b) => a.n != null && b.n != null ? (a.n - b.n) || (a.a - b.a)
    : (() => { try { return new ePub.CFI().compare(a.cfi, b.cfi); } catch { return a.at - b.at; } })());
function putMark(bid, m) { ((Store.data.marks ||= {})[bid] ||= {})[m.id] = { ...m, at: Date.now() }; Store.save(); }
function dropMark(bid, id) {
  const m = Store.data.marks?.[bid]?.[id];
  if (!m) return;
  if (m.type === 'highlight' && R.rendition && R.id === bid) try { R.rendition.annotations.remove(m.cfi, 'highlight'); } catch {}
  putMark(bid, { id, type: m.type, cfi: m.cfi, n: m.n, deleted: true });
  if (m.type === 'phl') paintMarks();
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
  $('rMarkList').hidden = tab === 'toc' || tab === 'search';
  $('rSearchPane').hidden = tab !== 'search';
  if (tab === 'search') { setTimeout(() => $('rSearch').focus(), 50); return; }
  if (tab === 'toc') return;
  const list = $('rMarkList'), items = marksOf(R.id, tab === 'bookmarks' ? 'bookmark' : 'highlight');
  list.innerHTML = items.length ? '' : `<li class="empty muted">${tab === 'bookmarks' ? 'No bookmarks yet. Tap the bookmark button at the top to save a page.' : 'No highlights yet. Select some text to highlight it.'}</li>`;
  for (const m of items) {
    const li = document.createElement('li');
    const when = new Date(m.created || m.at).toLocaleDateString([], { day: 'numeric', month: 'short' });
    li.innerHTML = m.type === 'bookmark'
      ? `<button class="mark"><span class="mt">${esc(m.label || 'Bookmark')}</span><span class="mm">${m.pct != null ? m.pct + '% · ' : ''}${when}</span></button>`
      : `<button class="mark hl" style="--hl:${COLORS[m.color] || COLORS.yellow}"><span class="mt">“${esc(m.text.slice(0, 220))}${m.text.length > 220 ? '…' : ''}”</span>${noteLine(m)}<span class="mm">${esc(m.label || '')}${m.label ? ' · ' : ''}${when}</span></button>`;
    const del = document.createElement('button');
    del.className = 'icon del'; del.innerHTML = ic('close'); del.setAttribute('aria-label', 'Delete');
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
  const colors = s.cfi || s.player ? Object.entries(COLORS).map(([k, c]) => `<button class="dot" data-act="hl" data-color="${k}" style="background:${c}" aria-label="Highlight ${k}"></button>`).join('') : '';
  const m = s.markId && Store.data.marks?.[s.bid]?.[s.markId];
  bar.innerHTML = `${colors}${s.cfi || s.player ? `<button data-act="note">${m?.note ? 'Edit note' : 'Note'}</button>` : ''}
    ${s.markId ? '<button data-act="unhl">Remove</button>' : ''}${s.markId && s.player ? '<button data-act="play">Play from here</button>' : ''}
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
  if (act === 'hl' || act === 'note') {
    const old = s.markId && Store.data.marks?.[s.bid]?.[s.markId];
    const color = act === 'hl' ? b.dataset.color : old?.color || 'yellow';
    const m = old ? { ...old, color } : newMark(s, color);
    putMark(s.bid, m);
    if (m.type === 'phl') paintMarks(); else drawHighlight(m);
    if (act === 'note') { clearSelection(); hideSelBar(); return openNote(s.bid, m.id); }
    toast('Highlighted');
  } else if (act === 'unhl') { dropMark(s.bid, s.markId); toast('Highlight removed'); }
  else if (act === 'play') playFrom(s.a);
  else if (act === 'copy') { navigator.clipboard?.writeText(s.text).then(() => toast('Copied')).catch(() => {}); }
  else if (act === 'define' || act === 'lookup') openLookup(s.text, act === 'define' ? 'dict' : 'wiki');
  clearSelection(); hideSelBar();
}
Hooks.selected = (cfi, contents) => {
  const text = String(contents.window.getSelection()).trim().replace(/\s+/g, ' ');
  if (text) showSelBar({ text, cfi, contents, bid: R.id });
};
function openMarkMenu(id) {
  const m = Store.data.marks?.[R.id]?.[id];
  if (m) showSelBar({ text: m.text, cfi: m.cfi, markId: id, bid: R.id });
}
function newMark(s, color) {
  return s.player
    ? { id: uid(), type: 'phl', n: chapter.n, a: s.a, b: s.b, t: textOnly(book) ? s.a : words[s.a].s, text: s.text, color,
        label: cleanTitle(chapter.title), created: Date.now() }
    : { id: uid(), type: 'highlight', cfi: s.cfi, text: s.text, color, label: $('rChapter').textContent, pct: pctOf(s.cfi), created: Date.now() };
}
/* Selecting words in the player's text view: highlight, note, define, look up, copy. */
function selectedWords() {
  const g = getSelection();
  if (!g.rangeCount || !String(g).trim()) return null;
  const r = g.getRangeAt(0);
  if (!$('textView').contains(r.commonAncestorContainer)) return null;
  let a = -1, b = -1;
  for (const w of words) if (r.intersectsNode(w.el)) { const i = +w.el.dataset.i; if (a < 0) a = i; b = i; }
  if (a < 0) return null;
  return { a, b, text: words.slice(a, b + 1).map(w => w.text).join(' ') };
}
for (const ev of ['mouseup', 'touchend']) $('textView').addEventListener(ev, () => setTimeout(() => {
  const w = !$('player').hidden && selectedWords();
  if (w) showSelBar({ ...w, player: true, bid: book.id }); else if (!String(getSelection()).trim()) hideSelBar();
}, 30));
document.addEventListener('selectionchange', () => { if (!$('player').hidden && !String(getSelection()).trim()) setTimeout(() => { if (!String(getSelection()).trim() && sel && !sel.cfi && !sel.markId) hideSelBar(); }, 200); });
addEventListener('hashchange', hideSelBar);

/* The little look-up window: a dictionary definition, or Wikipedia results. */
function lookupBox() {
  let box = $('ssLookup');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ssLookup'; box.className = 'lookup'; box.hidden = true;
    box.innerHTML = `<div class="lk-head"><b id="lkTerm"></b><button class="icon" id="lkClose" aria-label="Close">${ic('close')}</button></div>
      <div class="tabs lk-tabs"><button data-src="dict">Dictionary</button><button data-src="wiki">Wikipedia</button></div>
      <div id="lkBody" class="lk-body"></div>
      <div class="lk-foot"><a id="lkWeb" target="_blank" rel="noopener">Search the web ${ic('out')}</a></div>`;
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
    <a href="${esc(s.content_urls?.mobile?.page || s.content_urls?.desktop?.page || '#')}" target="_blank" rel="noopener">Read on Wikipedia ${ic('out')}</a></div>`;
}
async function loadWikiPage(title) {
  const body = $('lkBody');
  body.innerHTML = '<p class="muted">Loading…</p>';
  try { body.innerHTML = await wikiSummary(title); } catch { body.innerHTML = '<p class="muted">Could not load that page.</p>'; }
}

/* ================================================================ highlights & notes in the player's pages */
const noteLine = m => m.note ? `<span class="mn">${esc(m.note)}</span>` : '';
function paintMarks() {
  if (!book || !words.length) return;
  for (const el of $('textView').querySelectorAll('.w.ph')) {
    el.className = el.className.replace(/\bph(-\w+)?\b/g, '').replace(/\bnote-end\b/g, '').trim();
    delete el.dataset.mid;
  }
  for (const m of marksOf(book.id, 'phl')) {
    if (m.n !== chapter.n || m.a >= words.length) continue;
    const b = Math.min(m.b, words.length - 1);
    for (let k = m.a; k <= b; k++) {
      const el = words[k].el;
      el.classList.add('ph', 'ph-' + (COLORS[m.color] ? m.color : 'yellow'));
      if (k === b) el.classList.add('ph-end');
      el.dataset.mid = m.id;
    }
    if (m.note) words[b].el.classList.add('note-end');
  }
}
let pendingFlash = null;    // { bookId, n, a, b }: show where a search result or highlight is, once its chapter opens
Hooks.textRendered = () => {
  paintMarks();
  if (pendingFlash && pendingFlash.bookId === book.id && pendingFlash.n === chapter.n) { const f = pendingFlash; pendingFlash = null; setTimeout(() => flash(f.a, f.b), 60); }
};
Hooks.tapMark = el => {
  const m = Store.data.marks?.[book.id]?.[el.dataset.mid];
  if (!m || m.deleted) return false;
  showSelBar({ text: m.text, player: true, bid: book.id, markId: m.id, a: m.a, b: m.b });
  return true;
};
function playFrom(i) {
  PG.manual = 0;
  if (silent()) { goToWord(i); if (!SR.playing) startSilent(); return; }
  audio.currentTime = words[i].s; highlight(i, true);
  if (audio.paused) audio.play().catch(() => {});
}
function flash(a, b) {
  if (!words[a]) return;
  PG.manual = Date.now();                               // stay on this page for a moment, even while playing
  if (!$('textView').hidden && layoutPages()) turnTo(pageOf(words[a].el), false);
  for (let k = a; k <= Math.min(b, words.length - 1); k++) {
    const el = words[k].el;
    el.classList.remove('found'); void el.offsetWidth; el.classList.add('found');
    setTimeout(() => el.classList.remove('found'), 2600);
  }
}
/* Go to a spot in this book: same chapter, just show it; otherwise open that chapter there. */
function jumpTo(n, a, b, t) {
  $('pSheet').hidden = true;
  if (chapter?.n === n && words.length) {
    if (rsvpOn()) { silent() ? goToWord(a) : (audio.currentTime = words[a].s, highlight(a, true)); return; }
    const playing = silent() ? SR.playing : !audio.paused;
    if (!playing) { silent() ? goToWord(a) : (audio.currentTime = words[a].s, highlight(a, true)); }
    return flash(a, b);
  }
  pendingFlash = { bookId: book.id, n, a, b };
  Store.setPos(book.id, n, t ?? 0);
  location.hash = `#/play/${enc(book.id)}/${n}`;
}

/* The note editor */
function openNote(bid, id) {
  let box = $('ssNote');
  if (!box) {
    box = document.createElement('div');
    box.id = 'ssNote'; box.className = 'lookup note-box'; box.hidden = true;
    box.innerHTML = `<div class="lk-head"><b>Note</b><button class="icon" data-act="cancel" aria-label="Close">${ic('close')}</button></div>
      <p class="note-quote" id="noteQuote"></p>
      <textarea id="noteText" rows="5" placeholder="Write a note…"></textarea>
      <div class="note-actions"><button class="secondary" data-act="delete">Delete note</button><span></span><button class="secondary" data-act="cancel">Cancel</button><button class="primary" data-act="save">Save</button></div>`;
    box.onclick = e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      const { bid, id } = box.dataset, m = Store.data.marks?.[bid]?.[id];
      if (m && (act === 'save' || act === 'delete')) {
        const note = act === 'save' ? $('noteText').value.trim() : '';
        putMark(bid, { ...m, note });
        if (m.type === 'phl') paintMarks();
        toast(note ? 'Note saved' : 'Note removed');
        if (!$('pSheet').hidden) renderPlayerMarks();
        if (!$('rToc').hidden) renderTabs();
      }
      box.hidden = true;
    };
  }
  const home = !$('reader').hidden ? $('rotor') : document.body;
  if (box.parentNode !== home) home.appendChild(box);
  const m = Store.data.marks?.[bid]?.[id];
  if (!m) return;
  Object.assign(box.dataset, { bid, id });
  $('noteQuote').textContent = `“${m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text}”`;
  $('noteText').value = m.note || '';
  box.querySelector('[data-act="delete"]').hidden = !m.note;
  box.hidden = false;
  setTimeout(() => $('noteText').focus(), 30);
}

/* The player's sheet: search the book, and your highlights & notes */
let pTab = 'search';
function openPlayerSheet(t) {
  if (!$('pSheet').hidden && pTab === t) { $('pSheet').hidden = true; return; }
  pTab = t; hideSelBar();
  $('pSheet').hidden = false;
  document.querySelectorAll('#pTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === pTab));
  $('pSearchPane').hidden = pTab !== 'search';
  $('pMarkList').hidden = pTab !== 'marks';
  if (pTab === 'search') setTimeout(() => $('pSearch').focus(), 50); else renderPlayerMarks();
}
$('pSearchBtn').onclick = () => openPlayerSheet('search');
$('pMarksBtn').onclick = () => openPlayerSheet('marks');
$('pTabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b && b.dataset.tab !== pTab) { $('pSheet').hidden = true; openPlayerSheet(b.dataset.tab); } };
addEventListener('hashchange', () => { $('pSheet').hidden = true; const n = $('ssNote'); if (n) n.hidden = true; });
function renderPlayerMarks() {
  const list = $('pMarkList'), items = marksOf(book.id, 'phl');
  list.innerHTML = items.length ? '' : '<li class="empty muted">No highlights yet. Select some words on the page to highlight them or add a note.</li>';
  for (const m of items) {
    const li = document.createElement('li');
    const when = new Date(m.created || m.at).toLocaleDateString([], { day: 'numeric', month: 'short' });
    li.innerHTML = `<button class="mark hl" style="--hl:${COLORS[m.color] || COLORS.yellow}"><span class="mt">“${esc(m.text.slice(0, 220))}${m.text.length > 220 ? '…' : ''}”</span>${noteLine(m)}<span class="mm">${esc(m.label || '')} · ${when}</span></button>`;
    li.firstChild.onclick = () => jumpTo(m.n, m.a, m.b, m.t);
    const note = document.createElement('button');
    note.className = 'icon del'; note.innerHTML = ic('note'); note.setAttribute('aria-label', m.note ? 'Edit note' : 'Add a note');
    note.onclick = () => openNote(book.id, m.id);
    const del = document.createElement('button');
    del.className = 'icon del'; del.innerHTML = ic('close'); del.setAttribute('aria-label', 'Delete');
    del.onclick = () => { dropMark(book.id, m.id); renderPlayerMarks(); };
    li.append(note, del);
    list.appendChild(li);
  }
}

/* Search: every chapter's words, matched loosely (case, accents and punctuation don't matter). */
const norm = w => w.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
const wordCache = {};
async function chapterWords(b, ch) {
  const key = b.id + '/' + ch.n;
  return wordCache[key] ||= (async () => {
    const data = textOnly(b) ? await chapterText(b, ch) : await Source.timing(b, ch);
    const out = [];
    for (const p of data?.paras || []) for (const [t, s] of p.w) out.push({ t, k: norm(t), s: textOnly(b) ? out.length : s ?? (out.length ? out[out.length - 1].s : 0) });
    return out;
  })().catch(e => { delete wordCache[key]; throw e; });
}
function findAll(ws, q) {
  const hits = [];
  for (let i = 0; i <= ws.length - q.length; i++) {
    let ok = true;
    for (let j = 0; j < q.length && ok; j++) ok = j === q.length - 1 ? ws[i + j].k.startsWith(q[j]) : ws[i + j].k === q[j];
    if (ok) { hits.push(i); i += q.length - 1; }
  }
  return hits;
}
function snippet(ws, i, len) {
  const a = Math.max(0, i - 9), b = Math.min(ws.length, i + len + 9);
  const part = (x, y) => esc(ws.slice(x, y).map(w => w.t).join(' '));
  return `${a ? '…' : ''}${part(a, i)} <mark>${part(i, i + len)}</mark> ${part(i + len, b)}${b < ws.length ? '…' : ''}`;
}
let searchSeq = 0, searchTimer = 0;
$('pSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(searchBook, 300); });
$('pSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); searchBook(); } });
async function searchBook() {
  const seq = ++searchSeq, raw = $('pSearch').value.trim(), q = raw.split(/\s+/).map(norm).filter(Boolean);
  const list = $('pResults'), status = $('pSearchStatus');
  list.innerHTML = '';
  if (!q.length || raw.length < 2) { status.textContent = ''; return; }
  const b = book, chs = chaptersOf(b);
  let count = 0;
  for (let c = 0; c < chs.length; c++) {
    status.textContent = `Searching… chapter ${c + 1} of ${chs.length}`;
    let ws;
    try { ws = await chapterWords(b, chs[c]); } catch { continue; }
    if (seq !== searchSeq) return;
    for (const i of findAll(ws, q)) {
      if (count >= 300) break;
      count++;
      const li = document.createElement('li');
      li.innerHTML = `<button class="result"><span class="rc">${esc(cleanTitle(chs[c].title))}</span><span class="rs">${snippet(ws, i, q.length)}</span></button>`;
      const n = chs[c].n;
      li.firstChild.onclick = () => jumpTo(n, i, i + q.length - 1, ws[i].s);
      list.appendChild(li);
    }
  }
  status.textContent = count ? `${count >= 300 ? 'First 300' : count} result${count === 1 ? '' : 's'}` : `No results for “${raw}”`;
}

/* Search in the book reader (the EPUB): epub.js looks through every section. */
let rSearchSeq = 0, rSearchTimer = 0;
$('rSearch').addEventListener('input', () => { clearTimeout(rSearchTimer); rSearchTimer = setTimeout(searchEpub, 350); });
$('rSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(rSearchTimer); searchEpub(); } });
async function searchEpub() {
  const seq = ++rSearchSeq, q = $('rSearch').value.trim(), list = $('rResults'), status = $('rSearchStatus');
  list.innerHTML = '';
  if (q.length < 2 || !R.epub) { status.textContent = ''; return; }
  const items = R.epub.spine.spineItems;
  let count = 0;
  for (let k = 0; k < items.length && count < 300; k++) {
    status.textContent = `Searching… ${Math.round(k / items.length * 100)}%`;
    const item = items[k];
    let found = [];
    try { await item.load(R.epub.load.bind(R.epub)); found = item.find(q); } catch {} finally { try { item.unload(); } catch {} }
    if (seq !== rSearchSeq) return;
    for (const f of found) {
      if (++count > 300) break;
      const li = document.createElement('li');
      const ex = esc(f.excerpt), at = ex.toLowerCase().indexOf(esc(q).toLowerCase());
      const shown = at < 0 ? ex : `${ex.slice(0, at)}<mark>${ex.slice(at, at + esc(q).length)}</mark>${ex.slice(at + esc(q).length)}`;
      li.innerHTML = `<button class="result"><span class="rc">${esc(tocLabel(item.href) || '')}</span><span class="rs">${shown}</span></button>`;
      li.firstChild.onclick = () => { R.rendition.display(f.cfi).then(() => {
        try { R.rendition.annotations.remove(f.cfi, 'highlight'); R.rendition.annotations.highlight(f.cfi, {}, () => {}, 'ss-found', { fill: '#f5cf3a', 'fill-opacity': '0.55' });
          setTimeout(() => { try { R.rendition.annotations.remove(f.cfi, 'highlight'); } catch {} }, 2600); } catch {}
      }).catch(() => {}); $('rToc').hidden = true; };
      list.appendChild(li);
    }
  }
  status.textContent = count ? `${Math.min(count, 300) >= 300 ? 'First 300' : count} result${count === 1 ? '' : 's'}` : `No results for “${q}”`;
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
/* ---------------- goals, books finished, the year calendar */
const GOAL_DEF = { daily: 30, yearly: 12 };
const goals = () => ({ ...GOAL_DEF, ...(Store.data.goals || {}) });
let editGoals = false;
function finishedBooks() {
  const fin = { ...(Store.data.finished || {}) };
  for (const b of books) if (!fin[b.id] && isDone(b)) fin[b.id] = lastOpened(b) || Date.now();   // finished before dates were kept
  return Object.entries(fin).map(([id, at]) => ({ b: findBook(id), at })).filter(x => x.b).sort((x, y) => y.at - x.at);
}
function goalsHtml(todaySecs, doneThisYear) {
  const g = goals(), mToday = Math.round(todaySecs / 60), frac = Math.min(1, mToday / g.daily);
  const r = 34, c = 2 * Math.PI * r;
  const now = new Date(), start = new Date(now.getFullYear(), 0, 1), dayOfYear = (now - start) / 864e5 + 1;
  const expected = g.yearly * dayOfYear / 365, diff = Math.round(doneThisYear - expected);
  const left = g.yearly - doneThisYear;
  const pace = left <= 0 ? 'Goal reached!' : diff >= 1 ? `${plural(diff, 'book')} ahead of pace` : diff >= 0 ? 'Right on pace' : `${left} to go by 31 Dec`;
  const step = (k, d, label) => `<button class="gstep" data-goal="${k}" data-d="${d}" aria-label="${label}">${d > 0 ? '+' : '−'}</button>`;
  return `<section class="chart-card goals${editGoals ? ' editing' : ''}">
    <div class="goals-head"><h3>Goals</h3><button class="link-btn" id="goalEdit">${editGoals ? 'Done' : 'Edit'}</button></div>
    <div class="goal-row">
      <div class="goal">
        <svg class="ring" viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="${r}" class="ring-track"/>
          <circle cx="40" cy="40" r="${r}" class="ring-fill" stroke-dasharray="${(c * frac).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 40 40)"/></svg>
        <div class="goal-txt"><span class="gk">Today</span><span class="gv">${mToday}<small> / ${g.daily} min</small></span>
          <span class="gs">${mToday >= g.daily ? 'Done for today' : `${g.daily - mToday} min to go`}</span>
          <span class="gedit">${step('daily', -5, 'Less time each day')}<b>${g.daily} min a day</b>${step('daily', 5, 'More time each day')}</span></div>
      </div>
      <div class="goal">
        <div class="ybar" aria-hidden="true">${[...Array(Math.min(g.yearly, 52))].map((_, i) => `<i class="${i < doneThisYear ? 'on' : ''}"></i>`).join('')}</div>
        <div class="goal-txt"><span class="gk">Books in ${now.getFullYear()}</span><span class="gv">${doneThisYear}<small> / ${g.yearly}</small></span>
          <span class="gs">${pace}</span>
          <span class="gedit">${step('yearly', -1, 'Fewer books')}<b>${plural(g.yearly, 'book')} a year</b>${step('yearly', 1, 'More books')}</span></div>
      </div>
    </div></section>`;
}
function finishedHtml(list) {
  const year = new Date().getFullYear(), thisYear = list.filter(x => new Date(x.at).getFullYear() === year).length;
  return `<section class="chart-card"><h3>Books finished</h3>
    <p class="muted small fin-sum">${list.length ? `${thisYear} this year · ${list.length} in all` : 'Finish a book and its cover lands here.'}</p>
    ${list.length ? `<div class="fin-shelf">${list.map(({ b, at }) => `<button class="fin" data-book="${esc(b.id)}">
      <div class="cover" data-cover="${esc(b.id)}"></div><span class="ft">${esc(b.title)}</span>
      <span class="fd">${new Date(at).toLocaleDateString([], { day: 'numeric', month: 'short', ...(new Date(at).getFullYear() !== year ? { year: 'numeric' } : {}) })}</span></button>`).join('')}</div>` : ''}
  </section>`;
}
function calendarHtml(days, tot) {
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const W = innerWidth < 600 ? 26 : 53;                // a phone shows the last six months, a wider screen the year
  const start = new Date(today); start.setDate(start.getDate() - (W - 1) * 7 - ((today.getDay() + 6) % 7));   // a Monday
  const level = s => { const m = s / 60; return m < 1 ? 0 : m < 15 ? 1 : m < 30 ? 2 : m < 60 ? 3 : 4; };
  let cells = '', months = '', active = 0, best = 0, run = 0, lastMonth = -1;
  for (let w = 0; w < W; w++) {
    const first = new Date(start); first.setDate(first.getDate() + w * 7);
    if (first.getMonth() !== lastMonth && first.getDate() <= 7) {
      months += `<span style="grid-column:${w + 2}">${first.toLocaleDateString([], { month: 'short' })}</span>`;
      lastMonth = first.getMonth();
    }
    for (let d = 0; d < 7; d++) {
      const day = new Date(first); day.setDate(day.getDate() + d);
      if (day > today) { cells += `<i class="cal-x" style="grid-column:${w + 2};grid-row:${d + 1}"></i>`; continue; }
      const s = tot(days[dayKey(day)]), lv = level(s);
      if (lv) { active++; run++; best = Math.max(best, run); } else run = 0;
      const tip = `${day.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}: ${s >= 60 ? dur(s) : 'nothing'}`;
      cells += `<i class="l${lv}" style="grid-column:${w + 2};grid-row:${d + 1}" data-tip="${esc(tip)}" aria-label="${esc(tip)}"></i>`;
    }
  }
  return `<section class="chart-card"><h3>${W === 53 ? 'Your year' : 'Last six months'}</h3>
    <p class="muted small fin-sum">${plural(active, 'day')} with reading or listening · longest run ${plural(best, 'day')}</p>
    <div class="cal-grid" style="--weeks:${W}"><div class="cal-months">${months}</div>
      <div class="cal"><span class="cd" style="grid-row:1">Mon</span><span class="cd" style="grid-row:3">Wed</span><span class="cd" style="grid-row:5">Fri</span>${cells}</div></div>
    <div class="cal-legend"><span>Less</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>More</span>
      <span class="muted">(under 15 min, 30, 60, an hour+)</span></div>
  </section>`;
}
$('statsBody').addEventListener('click', e => {
  if (e.target.closest('#goalEdit')) { editGoals = !editGoals; return renderStats(); }
  const st = e.target.closest('[data-goal]');
  if (st) {
    const g = goals(), k = st.dataset.goal, lim = k === 'daily' ? [5, 600] : [1, 365];
    Store.data.goals = { ...g, [k]: Math.max(lim[0], Math.min(lim[1], g[k] + +st.dataset.d)), at: Date.now() }; Store.save();
    return renderStats();
  }
  const f = e.target.closest('[data-book]');
  if (f) location.hash = `#/book/${enc(f.dataset.book)}`;
});

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
  const fin = finishedBooks(), finYear = fin.filter(x => new Date(x.at).getFullYear() === new Date().getFullYear()).length;
  let html = goalsHtml(tot(days[today]), finYear);
  html += `<div class="tiles">${tiles.map(([k, v, s]) => `<div class="tile"><span class="tk">${k}</span><span class="tv">${v}</span><span class="ts">${s}</span></div>`).join('')}</div>`;
  html += finishedHtml(fin) + calendarHtml(days, tot);

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
  $('statsBody').querySelectorAll('[data-cover]').forEach(el => { const b = findBook(el.dataset.cover); if (b) cover(el, b); });
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

/* ================================================================ the notebook: every highlight and note, from every book */
/* The notebook's cover: a navy cloth commonplace book with a gold-stamped frame. */
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
let nbSvgId = 0;
function nbCover(count) {
  const id = 'nb' + (++nbSvgId);                       // unique pattern ids: the cover can be on a page twice
  const svg = (body, label) => `<svg class="nb-svg" viewBox="0 0 240 344" role="img" aria-label="${label}">${body}</svg>`;
  return svg(`
    <defs><pattern id="${id}l" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 2h4M2 0v4" stroke="#fff" stroke-opacity=".035"/></pattern>
      <linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".28"/><stop offset=".09" stop-color="#000" stop-opacity="0"/><stop offset=".94" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".06"/></linearGradient></defs>
    <path d="M168 300v40l9-9 9 9v-40z" fill="#9b2f3a"/>
    <rect x="4" y="4" width="232" height="308" rx="6" fill="#1f2b46"/>
    <rect x="4" y="4" width="232" height="308" rx="6" fill="url(#${id}l)"/>
    <rect x="4" y="4" width="232" height="308" rx="6" fill="url(#${id}g)"/>
    <rect x="22" y="22" width="196" height="272" fill="none" stroke="#c9a85c" stroke-width="1.4"/>
    <rect x="27" y="27" width="186" height="262" fill="none" stroke="#c9a85c" stroke-width=".6"/>
    <g fill="#c9a85c">
      <path d="M120 104l6 6-6 6-6-6z"/><path d="M96 110h14M130 110h14" stroke="#c9a85c" stroke-width="1"/>
      <text x="120" y="160" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="27">Commonplace</text>
      <text x="120" y="184" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="11" letter-spacing="6">BOOK</text>
      <path d="M120 204l4 4-4 4-4-4z"/>
      <text x="120" y="236" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="10" fill-opacity=".85">${plural(count, 'clipping')}</text>
    </g>`, 'Classic notebook cover');
}
function allClippings() {
  const out = [];
  for (const [bid, marks] of Object.entries(Store.data.marks || {}))
    for (const m of Object.values(marks)) if (!m.deleted && (m.type === 'phl' || m.type === 'highlight') && m.text) out.push({ ...m, bid });
  return out;
}
Hooks.libraryShown = () => {
  const n = allClippings().length;
  $('nbMini').innerHTML = nbCover(n);
  $('nbCount').textContent = n ? `${n} ${n === 1 ? 'clipping' : 'clippings'} from your books` : 'Your highlights and notes gather here';
};
Hooks.showNotebook = () => {
  show('notebook');
  const clips = allClippings(), byBook = {};
  for (const c of clips) (byBook[c.bid] ||= []).push(c);
  const order = Object.keys(byBook).sort((a, b) => Math.max(...byBook[b].map(c => c.created || c.at)) - Math.max(...byBook[a].map(c => c.created || c.at)));
  const key = c => c.type === 'phl' ? [0, c.n, c.a] : [1, c.pct ?? 0, c.created || 0];
  for (const id of order) byBook[id].sort((x, y) => { const p = key(x), q = key(y); return p[0] - q[0] || p[1] - q[1] || p[2] - q[2]; });
  const notes = clips.filter(c => c.note).length;
  let html = `<div class="nb-hero">${nbCover(clips.length)}
    <p class="nb-sum">${clips.length ? `${clips.length} ${clips.length === 1 ? 'clipping' : 'clippings'} · ${order.length} ${order.length === 1 ? 'book' : 'books'} · ${notes} ${notes === 1 ? 'note' : 'notes'}` : 'Nothing clipped yet.'}</p></div>`;
  if (!clips.length) {
    html += `<section class="nb-page"><p class="muted">Select words while you listen or read, then pick a colour or tap <b>Note</b>. Every highlight and note from every book collects here.</p></section>`;
    $('nbBody').innerHTML = html; return;
  }
  let num = 1;
  const start = {};
  for (const id of order) { start[id] = num; num += byBook[id].length; }
  html += `<section class="nb-page nb-toc" id="nb-toc"><h2>Contents</h2><ol>${order.map((id, i) => {
    const b = findBook(id);
    return `<li><a href="#" data-to="nb-${i}"><span class="tn">${i + 1}</span><span class="tt">${esc(b?.title || id)}<small>${byBook[id].length} ${byBook[id].length === 1 ? 'clipping' : 'clippings'}</small></span><span class="dots"></span><span class="pg">${start[id]}</span></a></li>`;
  }).join('')}</ol></section>`;
  order.forEach((id, i) => {
    const b = findBook(id), list = byBook[id], nn = list.filter(c => c.note).length;
    html += `<section class="nb-page nb-book" id="nb-${i}">
      <header class="nb-bh"><div class="cover thumb" data-cover="${esc(id)}"></div><div><span class="nb-ch">Chapter ${i + 1}</span><h3>${esc(b?.title || id)}</h3>
        <p class="muted small">${esc(b?.author || '')}${b?.author ? ' · ' : ''}${list.length} ${list.length === 1 ? 'clipping' : 'clippings'}${nn ? ` · ${nn} ${nn === 1 ? 'note' : 'notes'}` : ''}</p></div></header>
      ${list.map((c, k) => `<article class="clip" style="--hl:${COLORS[c.color] || COLORS.yellow}">
        <span class="cn">${start[id] + k}</span>
        <blockquote>${esc(c.text)}</blockquote>
        ${c.note ? `<p class="cnote">${esc(c.note)}</p>` : ''}
        <p class="cm"><span>${esc(c.label || '')}${c.label ? ' · ' : ''}${new Date(c.created || c.at).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}</span>
          ${b ? `<button class="cgo" data-bid="${esc(id)}" data-mid="${esc(c.id)}">${c.type === 'phl' ? 'Listen' : 'Read'} here ${ic('right')}</button>` : ''}</p>
      </article>`).join('')}
      <a href="#" class="nb-up" data-to="nb-toc">Back to contents</a>
    </section>`;
  });
  $('nbBody').innerHTML = html;
  $('nbBody').querySelectorAll('[data-cover]').forEach(el => { const b = findBook(el.dataset.cover); if (b) cover(el, b); });
};
$('nbBody').addEventListener('click', e => {
  const to = e.target.closest('[data-to]');
  if (to) { e.preventDefault(); $(to.dataset.to)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const go = e.target.closest('.cgo');
  if (!go) return;
  const m = Store.data.marks?.[go.dataset.bid]?.[go.dataset.mid], b = findBook(go.dataset.bid);
  if (!m || !b) return;
  if (m.type === 'phl') {
    const loaded = book?.id === b.id && chapter?.n === m.n && words.length;
    if (!loaded) { pendingFlash = { bookId: b.id, n: m.n, a: m.a, b: m.b }; Store.setPos(b.id, m.n, m.t ?? 0); }
    location.hash = `#/play/${enc(b.id)}/${m.n}`;
    if (loaded) setTimeout(() => jumpTo(m.n, m.a, m.b, m.t), 80);    // that chapter is already open in the player
  } else {
    (Store.data.cfi ||= {})[b.id] = { cfi: m.cfi, at: Date.now() }; Store.save();
    location.hash = `#/read/${enc(b.id)}`;
  }
});
