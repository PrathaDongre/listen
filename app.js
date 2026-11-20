/* Soundshelf — audiobooks with synced text, a speed reader, and an EPUB reader.
 *
 * Books come from one of two places (the rest of the app doesn't care which):
 *  - LocalSource: the little server on your Mac (serve.py), used while developing.
 *  - DriveSource: the "Audiobooks" folder in your Google Drive, used by the online version.
 */
'use strict';
const $ = id => document.getElementById(id);
const audio = $('audio');
const CFG = window.LISTEN_CONFIG || {};
/* Extra features (sync, stats, bookmarks, look-up) live in features.js and plug in through these. */
const Hooks = window.Hooks = { saved() {}, signedIn() {}, readerReady() {}, relocated() {}, selected() {}, jumpFromPlayer() {}, showStats() {} };

/* ================================================================ saved settings & positions */
const Store = {
  data: (() => { try { return JSON.parse(localStorage.getItem('listen') || '{}'); } catch { return {}; } })(),
  save() { try { localStorage.setItem('listen', JSON.stringify(this.data)); } catch {} Hooks.saved(); },
  pos(id) { return (this.data.pos || {})[id]; },
  setPos(id, n, t) { (this.data.pos ||= {})[id] = { n, t: Math.round(t), at: Date.now() }; this.setLast(id); },
  setLast(id) { this.data.last = id; this.data.lastAt = Date.now(); this.save(); },
  cfi(id) { const c = (this.data.cfi || {})[id]; return typeof c === 'string' ? c : c?.cfi; },
};

/* ================================================================ where books come from */
const enc = encodeURIComponent;

const LocalSource = {
  name: 'local',
  async books() { return (await fetch('library.json', { cache: 'no-store' })).json(); },
  async coverUrl(b) { return b.cover ? `books/${enc(b.id)}/cover.jpg` : null; },
  async audioUrl(b, ch) { return `books/${enc(b.id)}/${enc(ch.file)}`; },
  async timing(b, ch) {
    if (!ch.timed) return null;
    const r = await fetch(`books/${enc(b.id)}/${enc(ch.file.replace(/\.mp3$/, '.json'))}`);
    return r.ok ? r.json() : null;
  },
  async epub(b) { return (await fetch(`books/${enc(b.id)}/book.epub`)).arrayBuffer(); },
  async text(b) { const r = await fetch(`books/${enc(b.id)}/text.json`); if (!r.ok) throw new Error('No text for this book'); return r.json(); },
};

const DriveSource = {
  name: 'drive',
  token: null, expires: 0, client: null,
  signIn(prompt) {
    return new Promise((resolve, reject) => {
      if (!window.google?.accounts?.oauth2) return reject(new Error('Google sign-in did not load. Check your connection.'));
      this.client ||= google.accounts.oauth2.initTokenClient({
        client_id: CFG.GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata',
        callback: () => {},
      });
      this.client.callback = r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        this.token = r.access_token; this.expires = Date.now() + (r.expires_in - 60) * 1000; resolve();
      };
      this.client.error_callback = e => reject(new Error(e.message || e.type || 'Sign-in was cancelled.'));
      this.client.requestAccessToken({ prompt });
    });
  },
  async api(url, asBlob) {
    if (Date.now() > this.expires) await this.signIn('');
    let r = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (r.status === 401) { await this.signIn(''); r = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } }); }
    if (!r.ok) throw new Error(`Google Drive error ${r.status}`);
    return asBlob ? r.blob() : r.json();
  },
  async list(q) {
    const out = [];
    let page = '';
    do {
      const d = await this.api(`https://www.googleapis.com/drive/v3/files?pageSize=1000&fields=nextPageToken,files(id,name,size,mimeType,modifiedTime)&q=${enc(q)}${page ? '&pageToken=' + page : ''}`);
      out.push(...d.files); page = d.nextPageToken;
    } while (page);
    return out;
  },
  /* Files are downloaded once and kept on the device, so books also work offline. */
  async file(f) {
    const key = `https://listen.local/drive/${f.id}/${f.modifiedTime || ''}`;
    const cache = 'caches' in window ? await caches.open('listen-files') : null;
    const hit = cache && await cache.match(key);
    if (hit) return hit.blob();
    const blob = await this.api(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, true);
    if (cache) await cache.put(key, new Response(blob)).catch(() => {});
    return blob;
  },
  urls: {},
  async blobUrl(f) { return (this.urls[f.id] ||= URL.createObjectURL(await this.file(f))); },
  async books() {
    const folder = CFG.DRIVE_FOLDER || 'Audiobooks';
    const roots = await this.list(`name='${folder}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    if (!roots.length) return [];
    const subs = await this.list(`'${roots[0].id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const books = await Promise.all(subs.map(async s => {
      const files = await this.list(`'${s.id}' in parents and trashed=false`);
      const by = Object.fromEntries(files.map(f => [f.name, f]));
      let meta = {};
      if (by['book.json']) meta = JSON.parse(await (await this.file(by['book.json'])).text());
      const known = Object.fromEntries((meta.chapters || []).map(c => [c.file, c]));
      const chapters = files.filter(f => f.name.endsWith('.mp3')).sort((a, b) => a.name.localeCompare(b.name)).map(f => {
        const m = f.name.match(/^(\d+)\s*-\s*(.*)\.mp3$/);
        const c = { ...(known[f.name] || { n: m ? +m[1] : 0, title: m ? m[2] : f.name, duration: (+f.size || 0) / 4000 }) };
        c.file = f.name; c.timed = !!by[f.name.replace(/\.mp3$/, '.json')];
        return c;
      }).sort((a, b) => a.n - b.n);                   // by number: 100 comes after 99, not after 10
      if (!by['book.json']) return null;              // not a book folder (e.g. voice samples)
      return { id: s.name, title: meta.title || s.name, author: meta.author || '', voice: meta.voice || '', speed: meta.speed,
               total: meta.total || chapters.length, cover: !!by['cover.jpg'], epub: !!by['book.epub'], chapters, _files: by,
               text: by['text.json'] ? meta.text || [] : [] };
    }));
    return books.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
  },
  async coverUrl(b) { return b._files['cover.jpg'] ? this.blobUrl(b._files['cover.jpg']) : null; },
  async audioUrl(b, ch) { return this.blobUrl(b._files[ch.file]); },
  async timing(b, ch) {
    const f = b._files[ch.file.replace(/\.mp3$/, '.json')];
    return f ? JSON.parse(await (await this.file(f)).text()) : null;
  },
  async epub(b) { return (await this.file(b._files['book.epub'])).arrayBuffer(); },
  async text(b) { return JSON.parse(await (await this.file(b._files['text.json'])).text()); },
};

let Source = LocalSource;

/* ================================================================ helpers */
const fmt = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const fmtLong = s => { const m = Math.max(0, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`; };
const hue = str => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cleanTitle = t => /^\s*\d+\s*(\(|$)/.test(t) ? 'Chapter ' + t.trim()   // "13 (part 1 of 2)" → "Chapter 13 (part 1 of 2)"
  : t.replace(/^\s*\d+\s*[:.]\s*/, '');
const hasAudio = b => b.chapters.length > 0;
/* Books without audio can still be speed-read from their text (text.json, made by book2mp3.py --text-only). */
const textOnly = b => !!b && !hasAudio(b) && (b.text || []).length > 0;
const chaptersOf = b => hasAudio(b) ? b.chapters : (b.text || []);

async function cover(el, b) {
  el.innerHTML = '';
  const h = hue(b.title);
  el.style.background = `linear-gradient(160deg, hsl(${h} 45% 42%), hsl(${(h + 40) % 360} 50% 26%))`;
  const fb = document.createElement('div');
  fb.className = 'fallback';
  fb.innerHTML = `<span class="ct">${esc(b.title)}</span><span class="ca">${esc(b.author)}</span>`;
  el.appendChild(fb);
  try {
    const url = await Source.coverUrl(b);
    if (!url) return;
    const img = new Image();
    img.alt = ''; img.decoding = 'async';
    img.onload = () => fb.remove();
    img.src = url;
    el.appendChild(img);
    return url;
  } catch {}
}
function bookSeconds(b) { return b.chapters.reduce((a, c) => a + (c.duration || 0), 0); }
function bookProgress(b) {
  const p = Store.pos(b.id);
  if (p && textOnly(b)) {
    const all = b.text.reduce((a, c) => a + c.words, 0);
    return Math.min(1, (b.text.filter(c => c.n < p.n).reduce((a, c) => a + c.words, 0) + (p.t || 0)) / (all || 1));
  }
  if (!p || !hasAudio(b)) return 0;
  const done = b.chapters.filter(c => c.n < p.n).reduce((a, c) => a + c.duration, 0) + (p.t || 0);
  return Math.min(1, done / (bookSeconds(b) || 1));
}

/* ================================================================ views & routing */
let books = [];
function show(id) { for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id; }
const findBook = id => books.find(b => b.id === id);

/* The book list is kept from last time, so pages open instantly; a fresh copy is fetched quietly
 * in the background (a thin bar at the top shows it's working) and the page updates if anything changed. */
const BOOKS_KEY = () => 'listen-books-' + Source.name;
let booksLoading = null;
function loadBooks() {
  return (booksLoading ||= (async () => {
    busy(+1);
    try {
      const fresh = await Source.books();
      const changed = JSON.stringify(fresh) !== JSON.stringify(books);
      books = fresh;
      try { localStorage.setItem(BOOKS_KEY(), JSON.stringify(fresh)); } catch {}
      return changed;
    } finally { busy(-1); booksLoading = null; }
  })());
}
let busyCount = 0;
function busy(d) { busyCount = Math.max(0, busyCount + d); $('busy').hidden = !busyCount; }

async function route() {
  if (Source === DriveSource && !DriveSource.token) return show('signin');
  const hash = location.hash;
  const [, view, id, n] = hash.split('/').map(decodeURIComponent);
  if (!books.length) try { books = JSON.parse(localStorage.getItem(BOOKS_KEY()) || '[]'); } catch {}
  if (!books.length) {                                   // first time: nothing to show yet
    show('loading');
    try { await loadBooks(); } catch (e) { console.error(e); }
    if (location.hash !== hash) return;
  } else if (!view || view === 'book' || view === 'stats') {
    loadBooks().then(changed => { if (changed && location.hash === hash) render(view, id, n); }).catch(e => console.error(e));
  }
  render(view, id, n);
}
function render(view, id, n) {
  if (view !== 'read') closeReader();
  if (view !== 'play' && SR.playing) stopSilent();     // silent reading only runs while you're looking at it
  if (view === 'book') return showBook(findBook(id));
  if (view === 'play') return showPlayer(findBook(id), +n);
  if (view === 'read') return openReader(findBook(id));
  if (view === 'stats') return Hooks.showStats();
  showLibrary();
}
addEventListener('hashchange', route);
document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) location.hash = g.dataset.go; });
$('refreshBtn').onclick = async () => { try { await loadBooks(); } catch (e) { console.error(e); } showLibrary(); };

/* ---------------- library */
function showLibrary() {
  show('library');
  const shelf = $('shelf');
  shelf.innerHTML = '';
  $('empty').hidden = books.length > 0;
  const last = findBook(Store.data.last);
  $('hero').hidden = !last;
  if (last) {
    const p = Store.pos(last.id), ch = p && chaptersOf(last).find(c => c.n === p.n);
    const hero = $('hero');
    hero.innerHTML = `<div class="cover thumb"></div><div class="info"><span class="label">Continue</span>
      <span class="t">${esc(last.title)}</span>
      <span class="c">${ch ? esc(cleanTitle(ch.title)) + (hasAudio(last) ? ' · ' + fmtLong(bookSeconds(last) * (1 - bookProgress(last))) + ' left' : '') : esc(last.author)}</span>
      <div class="bar"><i style="width:${(bookProgress(last) * 100).toFixed(1)}%"></i></div></div>
      <button class="go" aria-label="Continue">${ch ? '▶' : '📖'}</button>`;
    cover(hero.firstChild, last);
    hero.onclick = () => location.hash = ch ? `#/play/${enc(last.id)}/${ch.n}` : `#/read/${enc(last.id)}`;
  }
  for (const b of books) {
    const card = document.createElement('button');
    card.className = 'book-card';
    const rec = hasAudio(b) ? (b.chapters.length < b.total ? `<span class="pill on">🎧 ${b.chapters.length}/${b.total}</span>` : '<span class="pill on">🎧 Audio</span>')
      : textOnly(b) ? '<span class="pill on">Speed read</span>' : '';
    card.innerHTML = `<div class="cover"></div><span class="t">${esc(b.title)}</span><span class="a">${esc(b.author)}</span>
      <div class="tags">${rec}${b.epub ? '<span class="pill">📖 EPUB</span>' : ''}</div>
      ${bookProgress(b) ? `<div class="bar"><i style="width:${(bookProgress(b) * 100).toFixed(1)}%"></i></div>` : ''}`;
    cover(card.firstChild, b);
    card.onclick = () => location.hash = `#/book/${enc(b.id)}`;
    shelf.appendChild(card);
  }
}

/* ---------------- one book */
async function showBook(b) {
  if (!b) return (location.hash = '#/');
  show('book');
  $('bookBackdrop').style.backgroundImage = '';
  cover($('bookCover'), b).then(url => { if (url) $('bookBackdrop').style.backgroundImage = `url("${url}")`; });
  $('bookTitle').textContent = b.title;
  $('bookAuthor').textContent = b.author;
  const recorded = hasAudio(b) && b.chapters.length < b.total ? ` · ${b.chapters.length} of ${b.total} recorded so far` : '';
  const tWords = (b.text || []).reduce((a, c) => a + c.words, 0);
  $('bookMeta').textContent = hasAudio(b) ? `${b.chapters.length} chapters · ${fmtLong(bookSeconds(b))}${recorded}`
    : textOnly(b) ? `${b.text.length} chapters · ${tWords.toLocaleString()} words · no audio yet` : 'EPUB only';
  const p = Store.pos(b.id), chs = chaptersOf(b);
  $('listenBtn').hidden = !chs.length;
  $('listenBtn').textContent = hasAudio(b) ? (p ? '▶ Continue' : '▶ Listen') : (p ? 'Continue' : 'Speed read');
  $('listenBtn').onclick = () => location.hash = `#/play/${enc(b.id)}/${p ? p.n : chs[0].n}`;
  $('readBtn').hidden = !b.epub;
  $('readBtn').onclick = () => location.hash = `#/read/${enc(b.id)}`;
  $('chaptersTitle').hidden = !chs.length;
  $('noAudio').hidden = hasAudio(b);
  $('noAudio').textContent = textOnly(b) ? 'No audio recorded for this book yet — you can speed-read it or read the book.'
    : 'No audio recorded for this book yet — you can still read it.';
  const list = $('chapterList');
  list.innerHTML = '';
  for (const c of chs) {
    const li = document.createElement('li');
    const cls = p && p.n === c.n ? 'now' : p && c.n < p.n ? 'done' : '';
    li.innerHTML = `<button class="${cls}"><span class="n">${c.n}</span>
      <span class="ttl">${esc(cleanTitle(c.title))}${c.timed || !hasAudio(b) ? '' : '<span class="badge">audio only</span>'}</span>
      <span class="d">${hasAudio(b) ? fmt(c.duration) : fmtLong(c.words * 60 / wpm())}</span></button>`;
    li.firstChild.onclick = () => location.hash = `#/play/${enc(b.id)}/${c.n}`;
    list.appendChild(li);
  }
}

/* ================================================================ player */
let book = null, chapter = null;   // what's loaded in the player
let words = [];                    // flat list: {s, e, el, text}
let cur = -1;
let pendingStart = 0, autoNext = false, loadSeq = 0;

async function showPlayer(b, n) {
  if (!b || !chaptersOf(b).length) return (location.hash = b ? `#/book/${enc(b.id)}` : '#/');
  show('player');
  const ch = chaptersOf(b).find(c => c.n === n) || chaptersOf(b)[0];
  if (book?.id === b.id && chapter?.n === ch.n) { book = b; chapter = ch; return; }
  const seq = ++loadSeq;
  const wasPlaying = !audio.paused || SR.playing || autoNext;
  autoNext = false;
  stopSilent(false);
  audio.pause();
  book = b; chapter = ch;
  Store.setLast(b.id);
  $('pBook').textContent = b.title;
  $('pChapter').textContent = cleanTitle(ch.title);
  $('toReader').hidden = !b.epub;
  const p = Store.pos(b.id);
  pendingStart = p && p.n === ch.n ? p.t : 0;
  $('rsvpToggle').checked = textOnly(b) || !!Store.data.rsvp;
  renderText(null, true);
  showStat();
  let url, data;
  try {
    if (textOnly(b)) {                                   // no audio: just the words, for the silent speed reader
      audio.removeAttribute('src'); audio.load();
      data = await chapterText(b, ch);
      if (seq !== loadSeq) return;
      Store.setPos(b.id, ch.n, pendingStart);
      renderText(data, false, pendingStart);
      pendingStart = 0;
      if (wasPlaying) startSilent();
      return tick(true);
    }
    [url, data] = await Promise.all([
      Source.audioUrl(b, ch),
      Source.timing(b, ch).catch(e => { console.warn('timing', e); return null; }),   // no text is better than no audio
    ]);
  } catch (e) {
    console.error('chapter', e);
    if (seq !== loadSeq) return;
    $('noText').hidden = false;
    $('noText').querySelector('strong').textContent = 'Couldn’t load this chapter';
    $('noText').querySelector('.muted').textContent = /sign|401|token/i.test(e.message || '')
      ? 'Your Google sign-in may have expired. Go back to the library and sign in again.'
      : 'Check your internet connection, then tap the chapter again.';
    return;
  }
  if (seq !== loadSeq) return;
  $('noText').querySelector('strong').textContent = 'Audio only';
  $('noText').querySelector('.muted').textContent = 'This chapter was recorded before word timings were added, so there’s no synced text. Re-recording it adds the text.';
  audio.src = url;
  audio.playbackRate = rate(); audio.defaultPlaybackRate = rate();
  audio.preservesPitch = true;
  Store.setPos(b.id, ch.n, pendingStart);
  mediaSession();
  renderText(data, false, null);
  if (wasPlaying) silent() ? startSilent() : audio.play().catch(() => {});
  tick(true);
}
const textCache = {};
async function chapterText(b, ch) {
  const all = await (textCache[b.id] ||= Source.text(b).catch(e => { delete textCache[b.id]; throw e; }));
  const c = all.chapters.find(x => x.n === ch.n);
  if (!c) throw new Error('This chapter’s text is missing');
  return { paras: c.paras.map(p => ({ title: p.title, w: p.t.split(' ').map(t => [t, null, null]) })) };
}
$('toBook').onclick = () => location.hash = `#/book/${enc(book.id)}`;
$('toReader').onclick = () => { Hooks.jumpFromPlayer(); location.hash = `#/read/${enc(book.id)}`; };

function renderText(data, loading, startAt) {
  const view = $('textView');
  view.innerHTML = '';
  words = []; cur = -1;
  $('noText').hidden = !!data || loading;
  if (!data && !loading) cover($('noTextCover'), book);
  $('rsvpToggle').disabled = !data || textOnly(book);
  if (!data) return applyMode();
  const frag = document.createDocumentFragment();
  for (const para of data.paras) {
    const el = document.createElement(para.title ? 'h3' : 'p');
    const ps = words.length;
    para.w.forEach(([text, s, e], k) => {
      if (k) el.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'w'; span.textContent = text; span.dataset.i = words.length;
      el.appendChild(span);
      words.push({ s, e, el: span, text, ps: words.length === ps, h: !!para.title });
    });
    frag.appendChild(el);
  }
  for (let i = 0; i < words.length; i++) {         // fill any gaps so every word has a time
    if (words[i].s == null) words[i].s = i ? words[i - 1].e ?? words[i - 1].s : 0;
    if (words[i].e == null) words[i].e = words[i].s;
  }
  view.appendChild(frag);
  prepareSpeedReading();
  if (startAt != null && words.length) cur = Math.min(words.length - 1, Math.max(0, Math.round(startAt)));
  else if (words.length && pendingStart) cur = Math.max(0, wordAt(pendingStart + 0.02));
  applyMode();
}

function wordAt(t) {
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (words[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

function highlight(i, jump) {
  if (i === cur && !jump) return;
  const prev = i === cur ? -1 : cur;
  cur = i;
  if (prev < 0 || Math.abs(i - prev) > 400) {
    words.forEach((w, k) => { w.el.classList.toggle('read', k < i); w.el.classList.toggle('now', k === i); });
  } else {
    for (let k = Math.min(prev, i); k <= Math.max(prev, i) && k < words.length; k++) {
      words[k].el.classList.toggle('read', k < i);
      words[k].el.classList.toggle('now', k === i);
    }
  }
  if (i < 0) return;
  if (rsvpOn()) showRsvp(i);
  else {
    const view = $('textView'), el = words[i].el;
    const top = el.offsetTop - view.offsetTop, h = view.clientHeight;
    if (jump || top < view.scrollTop + h * 0.15 || top > view.scrollTop + h * 0.7)
      view.scrollTo({ top: top - h * 0.35, behavior: jump ? 'auto' : 'smooth' });
  }
}

/* Speed reader: one word at a time with its focus letter fixed in the middle. */
function pivot(word) {
  const core = word.replace(/^[^\p{L}\p{N}]+/u, '');
  const lead = word.length - core.length;
  const n = core.replace(/[^\p{L}\p{N}]+$/u, '').length;
  return lead + (n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4);
}
function showRsvp(i) {
  const [ga, gb] = groupOf(i);
  const w = words.slice(ga, gb).map(x => x.text).join(' '), el = $('rsvpWord').children;
  let k = pivot(w); if (w[k] === ' ') k++;          // never put the focus letter on the gap in a pair
  const near = (a, b) => esc(words.slice(Math.max(0, a), Math.max(0, b)).map(x => x.text).join(' '));
  const before = near(ga - 5, ga), after = near(gb, gb + 5);
  el[0].innerHTML = (before ? `<span class="ctx">${before} </span>` : '') + `<span>${esc(w.slice(0, k))}</span>`;
  el[1].textContent = w[k] || '';
  el[2].innerHTML = `<span>${esc(w.slice(k + 1))}</span>` + (after ? `<span class="ctx"> ${after}</span>` : '');
  const a = Math.max(0, i - 6), b = Math.min(words.length, i + 7);
  $('rsvpContext').innerHTML = words.slice(a, b).map((x, j) => a + j >= ga && a + j < gb ? `<b>${esc(x.text)}</b>` : esc(x.text)).join(' ');
}

/* ---------------- silent speed reading
 * The speed reader either follows the audio (every word shown is the word being spoken), or runs
 * silently on its own clock at a set words-per-minute. Only one of the two ever runs: the silent
 * clock pauses the audio, and when you go back to the audio it starts from the word you were on. */
const SR = { on: false, playing: false, timer: 0, warm: 0, lastStop: 0, mean: 1, lastRewind: 0 };
const SR_DEF = { mode: 'audio', wpm: 300, warm: true, group: true };
const srs = () => ({ ...SR_DEF, ...(Store.data.sr || {}) });
const setSr = o => { Store.data.sr = { ...srs(), ...o }; Store.save(); };
const wpm = () => srs().wpm;
const silent = () => rsvpOn() && (textOnly(book) || srs().mode === 'silent');
const SENT_END = /[.!?…]["'’”)\]]*$/u, CLAUSE_END = /[,;:—–]["'’”)\]]*$/u;
const core = t => t.replace(/[^\p{L}\p{N}]/gu, '');

function prepareSpeedReading() {
  let tot = 0;
  for (let k = 0; k < words.length; k++) {            // how long each word stays up, relative to an average word
    const w = words[k], n = core(w.text).length;
    let f = 1;
    if (n >= 9) f += 0.3;
    if (n >= 13) f += 0.3;
    if (CLAUSE_END.test(w.text)) f += 0.5;
    if (SENT_END.test(w.text)) f += 1;
    if (words[k + 1]?.ps || w.h) f += 0.8;
    w.f = f; tot += f;
  }
  SR.mean = words.length ? tot / words.length : 1;     // so the average really is the words-per-minute you set
  for (let k = 0; k < words.length;) {                 // pair up short words: "of the", "in a", "it was"
    const a = words[k], b = words[k + 1];
    const pair = b && !b.ps && !a.h && !b.h && !/[^\p{L}\p{N}]$/u.test(a.text) && !/^[^\p{L}\p{N}]/u.test(b.text)
      && core(a.text).length <= 3 && core(b.text).length <= 3 && a.text.length + b.text.length <= 8;
    const e = pair ? k + 2 : k + 1;
    for (let j = k; j < e; j++) { words[j].g = k; words[j].ge = e; }
    k = e;
  }
}
const groupOf = i => srs().group && words[i]?.g != null ? [words[i].g, words[i].ge] : [i, i + 1];

function warmFactor(start) {                           // ease in: 75% of your speed, rising to 100% over 20 s
  if (!start || !srs().warm) return 1;
  const p = (Date.now() - start) / 20000;
  return p >= 1 ? 1 : 0.75 + 0.25 * p;
}
function silentDelay(i) {
  const [a, b] = groupOf(i);
  let f = 0;
  for (let k = a; k < b; k++) f += words[k].f || 1;
  return f / SR.mean * 60000 / (wpm() * warmFactor(SR.warm));
}
function silentStep() {
  SR.timer = 0;
  if (!SR.playing) return;
  const next = groupOf(cur)[1];
  if (next >= words.length) {                          // end of chapter: carry on into the next one
    SR.playing = false; SR.lastStop = Date.now();
    const nx = sibling(1);
    if (nx) { autoNext = true; openChapter(nx); } else { savePos(); tick(false); }
    return;
  }
  highlight(next);
  if (Date.now() - lastSave > 5000) savePos();
  sync(false);
  SR.timer = setTimeout(silentStep, silentDelay(next));
}
function startSilent() {
  if (!words.length || SR.playing) return;
  if (!audio.paused) audio.pause();
  if (cur < 0) highlight(0, true);
  if (cur >= words.length - 1) highlight(0, true);
  SR.playing = true;
  SR.warm = Date.now() - SR.lastStop > 5000 ? Date.now() : 0;   // a quick pause doesn't restart the warm-up
  clearTimeout(SR.timer);
  SR.timer = setTimeout(silentStep, silentDelay(cur));
  tick(false);
}
/* Stops the silent clock and parks the audio on the word you're on, so the two never drift apart. */
function stopSilent(save = true) {
  clearTimeout(SR.timer); SR.timer = 0;
  if (SR.playing) { SR.playing = false; SR.lastStop = Date.now(); }
  if (save) { syncAudioToWord(); savePos(); tick(false); }
}
function syncAudioToWord() {
  if (!audio.src || cur < 0 || !words[cur] || !chapter?.timed) return;
  const t = words[cur].s;
  if (audio.readyState >= 1) audio.currentTime = t; else pendingStart = t;
}
function goToWord(i) {
  i = Math.max(0, Math.min(words.length - 1, i));
  highlight(i, true);
  if (SR.playing) { clearTimeout(SR.timer); SR.timer = setTimeout(silentStep, silentDelay(i)); }
  else syncAudioToWord();
  tick(false);
}

/* Tap the left side of the speed reader: back to the start of this sentence (tap again: the one before). */
function sentenceStart(i) {
  let j = Math.max(0, i);
  while (j > 0 && !words[j].ps && !SENT_END.test(words[j - 1].text)) j--;
  return j;
}
function rewind() {
  if (cur < 0) return;
  let j = sentenceStart(cur);
  if (cur - j < 3 || Date.now() - SR.lastRewind < 2500) j = sentenceStart(j - 1);
  SR.lastRewind = Date.now();
  if (silent()) goToWord(j);
  else { audio.currentTime = words[j].s; highlight(j, true); }
  const fx = $('rsvpRewind');
  fx.classList.remove('show'); void fx.offsetWidth; fx.classList.add('show');
}

let raf = 0, seeking = false, lastStat = 0;
function sync(jump) {
  if (silent()) {                                      // the silent clock moves the words; the bar shows words, not seconds
    if (cur < 0 && words.length) highlight(0, true);
    const left = words.length - Math.max(cur, 0);
    $('seek').max = Math.max(1, words.length - 1); if (!seeking) $('seek').value = Math.max(cur, 0);
    $('tNow').textContent = fmt(Math.max(cur, 0) * 60 / wpm());
    $('tLeft').textContent = '-' + fmt(left * 60 / wpm());
    if (jump && cur >= 0) showRsvp(cur);
    if (Date.now() - lastStat > 1000) try { showStat(); } catch (e) { console.error('stat', e); }
    return;
  }
  if (words.length) highlight(wordAt(audio.currentTime + 0.02), jump);
  const d = audio.duration || chapter?.duration || 0;
  $('seek').max = d; if (!seeking) $('seek').value = audio.currentTime;
  $('tNow').textContent = fmt(audio.currentTime);
  $('tLeft').textContent = '-' + fmt((d - audio.currentTime) / rate());
  if (Date.now() - lastStat > 1000) try { showStat(); } catch (e) { console.error('stat', e); }
}
/* The screen follows the audio through two independent clocks: the browser's drawing timer
 * (smooth, but paused whenever the page is hidden or covered) and a plain 250 ms timer plus the
 * audio's own progress events as a backstop. Every play restarts both from scratch, and an error
 * in one update can never stop the next one. */
let ticker = 0;
function tick(jump) {
  try { sync(jump); } catch (e) { console.error('player update', e); }
  try { warmAudio(); } catch (e) { console.error('warm-up', e); }
  const playing = silent() ? SR.playing : !audio.paused;   // keep the button truthful, whatever happened
  if ($('play').dataset.playing !== String(playing)) {
    $('play').dataset.playing = playing;
    $('play').textContent = playing ? '❚❚' : '▶';
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
}
/* Audio warm-up (speed reader on, sped up): start a little slower and ease up to your speed over 20 s.
 * Only the audio's speed changes, so the words on screen stay exactly in step with it. */
let audioWarm = 0, audioStopped = 0;
function warmAudio() {
  if (audio.paused || !audioWarm) return;
  const r = rate(), lo = Math.max(1, r * 0.8);
  const p = (Date.now() - audioWarm) / 20000;
  const want = p >= 1 || lo >= r ? r : Math.round((lo + (r - lo) * p) * 20) / 20;
  if (p >= 1) audioWarm = 0;
  if (Math.abs(audio.playbackRate - want) > 0.001) audio.playbackRate = want;
}
function loop() {
  raf = 0;
  tick(false);
  if (!audio.paused) raf = requestAnimationFrame(loop);
}
function startLoop() {
  cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  clearInterval(ticker);
  ticker = setInterval(() => { if (audio.paused) { clearInterval(ticker); ticker = 0; } tick(false); }, 250);
}

audio.onplay = () => {
  if (silent()) { audio.pause(); return; }          // never both at once
  audioWarm = rsvpOn() && srs().warm && rate() > 1 && Date.now() - audioStopped > 5000 ? Date.now() : 0;
  if (!audioWarm) audio.playbackRate = rate();
  tick(false); startLoop();
};
audio.onplaying = startLoop;
audio.onpause = () => { audioStopped = Date.now(); audioWarm = 0; audio.playbackRate = rate(); tick(false); savePos(); };
audio.onseeked = () => tick(true);
audio.onratechange = () => tick(false);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && SR.playing) stopSilent();
  if (!document.hidden) { tick(true); if (!audio.paused) startLoop(); }
});
audio.onloadedmetadata = () => { if (pendingStart) { audio.currentTime = pendingStart; pendingStart = 0; } tick(true); };
let lastSave = 0;
audio.ontimeupdate = () => { if (!raf || document.hidden) tick(false); if (Date.now() - lastSave > 5000) savePos(); };
function savePos() {
  if (!book || !chapter) return;
  lastSave = Date.now();
  if (textOnly(book)) return Store.setPos(book.id, chapter.n, Math.max(cur, 0));
  if (!audio.src) return;
  Store.setPos(book.id, chapter.n, silent() && cur >= 0 && chapter.timed ? words[cur].s : audio.currentTime);
}
audio.onended = () => { const nx = sibling(1); if (nx) { autoNext = true; openChapter(nx); } };
function sibling(d) { const l = chaptersOf(book); return l[l.indexOf(chapter) + d]; }
function openChapter(c) { if (c) { Store.setPos(book.id, c.n, 0); location.hash = `#/play/${enc(book.id)}/${c.n}`; } }

const togglePlay = () => silent() ? (SR.playing ? stopSilent() : startSilent())
  : audio.paused ? audio.play().catch(() => {}) : audio.pause();
$('play').onclick = togglePlay;
const skipWords = () => Math.round(wpm() / 4);         // 15 seconds' worth of words
$('back15').onclick = () => silent() ? goToWord(cur - skipWords()) : audio.currentTime = Math.max(0, audio.currentTime - 15);
$('fwd15').onclick = () => silent() ? goToWord(cur + skipWords()) : audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 15);
$('prevCh').onclick = () => silent() ? (cur > 20 ? goToWord(0) : openChapter(sibling(-1)))
  : audio.currentTime > 5 ? (audio.currentTime = 0) : openChapter(sibling(-1));
$('nextCh').onclick = () => openChapter(sibling(1));
$('seek').oninput = () => { seeking = true; $('tNow').textContent = fmt(silent() ? +$('seek').value * 60 / wpm() : +$('seek').value); };
$('seek').onchange = () => { seeking = false; silent() ? goToWord(Math.round(+$('seek').value)) : audio.currentTime = +$('seek').value; };
$('textView').onclick = e => {
  const w = e.target.closest('.w');
  if (!w || String(getSelection()).trim()) return;      // selecting text, not tapping a word
  audio.currentTime = words[+w.dataset.i].s;
  if (audio.paused) audio.play().catch(() => {});
};
$('rsvpView').onclick = e => {
  if (e.target.closest('.sr-bar, .sr-opts')) return;
  const r = $('rsvpView').getBoundingClientRect();
  if (e.clientX - r.left < r.width / 3) rewind(); else togglePlay();
};

/* Speed: a multiplier on top of the speed the book was recorded at. */
function rate() { return Store.data.rate || 1; }
function setRate(r) {
  if (r < rate() && audioWarm) r = Math.min(r, audio.playbackRate - 0.1);   // slower than what you're hearing now
  r = Math.min(3, Math.max(0.5, Math.round(r * 20) / 20));
  if (r < rate()) audioWarm = 0;                       // slowing down: straight to the new speed, no easing
  Store.data.rate = r; Store.save();
  audio.defaultPlaybackRate = r;
  if (audioWarm) warmAudio(); else audio.playbackRate = r;   // still easing up: keep easing, toward the new speed
  showSpeed();
}
function setWpm(w) {
  const now = wpm() * warmFactor(SR.playing && SR.warm);
  if (w < wpm()) { w = Math.min(w, Math.ceil(now / 25) * 25 - 25); SR.warm = 0; }   // slowing: below what you see now, no easing
  setSr({ wpm: Math.min(1200, Math.max(100, Math.round(w / 25) * 25)) });
  if (SR.playing) { clearTimeout(SR.timer); SR.timer = setTimeout(silentStep, silentDelay(cur)); }
  showSpeed(); sync(false);
}
function showSpeed() {
  const r = rate();
  $('speedVal').textContent = silent() ? `${wpm()} wpm` : r.toFixed(r * 10 % 1 ? 2 : 1) + '×';
  $('speedVal').title = silent() ? 'Words per minute. Tap to reset to 300.' : 'Tap to reset to 1.0×';
  showStat();
}
$('slower').onclick = () => silent() ? setWpm(wpm() - 25) : setRate(rate() - 0.1);
$('faster').onclick = () => silent() ? setWpm(wpm() + 25) : setRate(rate() + 0.1);
$('speedVal').onclick = () => silent() ? setWpm(300) : setRate(1);

const rsvpOn = () => words.length > 0 && ($('rsvpToggle').checked || textOnly(book));
function applyMode() {
  $('rsvpView').hidden = !rsvpOn();
  $('textView').hidden = rsvpOn() || !words.length;
  SR.on = silent();
  const canSilent = rsvpOn() && !textOnly(book);
  $('srMode').hidden = !canSilent;
  for (const b of $('srMode').children) b.classList.toggle('on', b.dataset.m === (silent() ? 'silent' : 'audio'));
  $('srWarm').checked = srs().warm; $('srGroup').checked = srs().group;
  showSpeed();
  if (silent()) { const k = cur; cur = -1; highlight(Math.max(0, k), true); tick(true); }
  else { cur = -1; if (words.length) tick(true); }
}
/* Any switch between the audio and the silent clock hands over the exact word you're on,
 * and carries on playing if you were. */
function handover(change) {
  const wasSilent = SR.on || SR.playing, was = wasSilent ? SR.playing : !audio.paused;   // the mode as it was on screen
  if (wasSilent) stopSilent();                          // parks the audio on the current word
  else if (words.length) highlight(Math.max(0, wordAt(audio.currentTime + 0.02)), true);
  change();
  if (wasSilent === silent()) return applyMode();
  if (!wasSilent) audio.pause();
  SR.lastStop = audioStopped = Date.now();              // a switch isn't a fresh start: no warm-up
  applyMode();
  if (was) togglePlay();
}
$('rsvpToggle').checked = !!Store.data.rsvp;
$('rsvpToggle').onchange = () => handover(() => { Store.data.rsvp = $('rsvpToggle').checked; Store.save(); });
for (const b of $('srMode').children) b.onclick = e => { e.stopPropagation(); handover(() => setSr({ mode: b.dataset.m })); };
$('srOptsBtn').onclick = e => { e.stopPropagation(); $('srOpts').hidden = !$('srOpts').hidden; };
$('srWarm').onchange = () => setSr({ warm: $('srWarm').checked });
$('srGroup').onchange = () => { setSr({ group: $('srGroup').checked }); if (cur >= 0) showRsvp(cur); };

/* ---------------- stats line: tap to cycle */
const STATS = [
  () => {
    if (silent()) return `${Math.round(wpm() * warmFactor(SR.playing && SR.warm))} words per minute${SR.playing && warmFactor(SR.warm) < 1 ? ' · warming up' : ''}`;
    let w;
    if (words.length > 20) w = words.length / ((words[words.length - 1].e - words[0].s) / 60) * rate();
    else w = 155 * (book?.speed || 1.2) * rate();
    return `${Math.round(w * (audio.paused ? 1 : audio.playbackRate / rate()))} words per minute${audioWarm ? ' · warming up' : ''}`;
  },
  () => `${fmtLong(chapterLeft())} left in chapter`,
  () => `${fmtLong(timeLeft())} left in book`,
  () => `Finishes at ${new Date(Date.now() + timeLeft() * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${timeLeft() > 86400 ? ' (not today)' : ''}`,
  () => silent() ? `${Math.floor(Math.max(cur, 0) / (words.length || 1) * 100)}% of chapter`
    : `${Math.floor(audio.currentTime / (audio.duration || chapter.duration || 1) * 100)}% of chapter`,
  () => `${Math.floor(bookDone() * 100)}% of book`,
  () => `Chapter ${chaptersOf(book).indexOf(chapter) + 1} of ${hasAudio(book) ? book.total || book.chapters.length : chaptersOf(book).length}`,
  () => words.length ? `${Math.max(0, cur + 1).toLocaleString()} of ${words.length.toLocaleString()} words in chapter` : null,
];
const posSecs = () => silent() && cur >= 0 && chapter?.timed ? words[cur].s : audio.currentTime;
function bookLeft() {                                  // seconds of audio left (audio books)
  if (!book) return 0;
  const after = book.chapters.filter(c => c.n > chapter.n).reduce((a, c) => a + c.duration, 0);
  return after + ((audio.duration || chapter.duration) - posSecs());
}
function chapterLeft() {                               // real time left at your current speed
  return silent() ? (words.length - Math.max(cur, 0)) * 60 / wpm() : ((audio.duration || chapter.duration) - audio.currentTime) / rate();
}
function timeLeft() {
  if (textOnly(book)) return chapterLeft() + book.text.filter(c => c.n > chapter.n).reduce((a, c) => a + c.words, 0) * 60 / wpm();
  return silent() ? bookLeft() * 155 * (book.speed || 1.2) / 60 / wpm() * 60 : bookLeft() / rate();
}
function bookDone() {
  if (textOnly(book)) {
    const all = book.text.reduce((a, c) => a + c.words, 0);
    return (book.text.filter(c => c.n < chapter.n).reduce((a, c) => a + c.words, 0) + Math.max(cur, 0)) / (all || 1);
  }
  return 1 - bookLeft() / (bookSeconds(book) || 1);
}
function showStat() {
  if (!book || !chapter) return;
  lastStat = Date.now();
  const k = Store.data.stat || 0;
  let text = null;
  for (let tries = 0; tries < STATS.length && !text; tries++) text = STATS[(k + tries) % STATS.length]();
  $('stat').textContent = text || '';
}
$('stat').onclick = () => {
  let k = Store.data.stat || 0;
  do { k = (k + 1) % STATS.length; } while (!STATS[k]());
  Store.data.stat = k; Store.save(); showStat();
};

/* Lock-screen / headphone controls on phones */
function mediaSession() {
  if (!('mediaSession' in navigator)) return;
  const meta = art => new MediaMetadata({ title: cleanTitle(chapter.title), artist: book.author, album: book.title, artwork: art });
  navigator.mediaSession.metadata = meta([]);
  Source.coverUrl(book).then(u => { if (u) navigator.mediaSession.metadata = meta([{ src: new URL(u, location.href).href }]); }).catch(() => {});
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => silent() ? startSilent() : audio.play());
  ms.setActionHandler('pause', () => silent() ? stopSilent() : audio.pause());
  ms.setActionHandler('seekbackward', () => $('back15').click());
  ms.setActionHandler('seekforward', () => $('fwd15').click());
  ms.setActionHandler('previoustrack', () => $('prevCh').click());
  ms.setActionHandler('nexttrack', () => $('nextCh').click());
}

/* ================================================================ EPUB reader */
const R = { book: null, epub: null, rendition: null, id: null, locReady: false, toc: [], ready: false };
const RDEF = { theme: 'light', font: '', size: 100, leading: 1.5, margin: 24, align: '', flow: 'paginated', rotate: '0', columns: 'auto' };
const rset = () => ({ ...RDEF, ...(Store.data.reader || {}) });
const FONT_LINK = 'https://fonts.googleapis.com/css2?family=Literata:ital,wght@0,400;0,600;1,400&family=Source+Serif+4:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;600&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Lexend:wght@400;600&display=swap';
const THEMES = { light: ['#fbfaf7', '#1d1b18'], sepia: ['#f4ecd8', '#5b4636'], gray: ['#5a5a5c', '#ececec'], dark: ['#1e1e20', '#d9d6cf'], black: ['#000000', '#c8c8c8'] };

function readerCss() {
  const s = rset(), [bg, fg] = THEMES[s.theme] || THEMES.light;
  const font = s.font ? `font-family: "${s.font}", Georgia, serif !important;` : '';
  return `html, body { background: ${bg} !important; color: ${fg} !important; }
    body { font-size: ${s.size}% !important; }
    p, li, div, span, blockquote, dd { ${font} line-height: ${s.leading} !important; ${s.align ? `text-align: ${s.align} !important;` : ''} color: inherit !important; }
    h1, h2, h3, h4, h5, h6 { ${font} color: inherit !important; }
    a { color: inherit !important; }
    img, svg { max-width: 100% !important; height: auto !important; }
    ${['dark', 'black', 'gray'].includes(s.theme) ? 'img { filter: brightness(.85); }' : ''}`;
}
function styleContents(contents) {
  const doc = contents.document;
  if (!doc.getElementById('listen-fonts')) {
    const link = doc.createElement('link');
    link.id = 'listen-fonts'; link.rel = 'stylesheet'; link.href = FONT_LINK;
    doc.head.appendChild(link);
  }
  let st = doc.getElementById('listen-style');
  if (!st) { st = doc.createElement('style'); st.id = 'listen-style'; doc.head.appendChild(st); }
  st.textContent = readerCss();
}

async function openReader(b) {
  if (!b || !b.epub) return (location.hash = b ? `#/book/${enc(b.id)}` : '#/');
  show('reader');
  applyReaderChrome();
  if (R.id === b.id) return;                       // already open (or opening)
  closeReader();
  R.id = b.id; R.book = b;
  $('rTitle').textContent = b.title; $('rChapter').textContent = '';
  $('rLoading').hidden = false; $('rLoading').textContent = 'Opening book…';
  $('rPct').textContent = ''; $('rLeft').textContent = '';
  try {
    const data = await Source.epub(b);
    if (R.id !== b.id) return;
    R.epub = ePub(data);
    const s = rset();
    R.rendition = R.epub.renderTo('rStage', { width: '100%', height: '100%', flow: s.flow, allowScriptedContent: false,
      spread: s.columns === 'one' || s.flow !== 'paginated' ? 'none' : 'auto', minSpreadWidth: 800 });
    R.rendition.hooks.content.register(styleContents);
    R.rendition.on('relocated', onRelocated);
    R.rendition.on('click', readerTap);                // taps and swipes are read inside the page itself,
    R.rendition.on('touchstart', readerTouchStart);    // so pressing and dragging can still select text
    R.rendition.on('touchend', readerTouchEnd);
    R.rendition.on('keyup', readerKeys);
    R.rendition.on('selected', (cfi, contents) => Hooks.selected(cfi, contents));
    await R.rendition.display(Store.cfi(b.id) || undefined);
    R.ready = true;
    Store.setLast(b.id);
    Hooks.readerReady();
    $('rLoading').hidden = true;
    const nav = await R.epub.loaded.navigation;
    R.toc = nav.toc;
    buildToc();
    loadLocations(b.id);
  } catch (e) {
    console.error(e);
    $('rLoading').textContent = 'Could not open this book.';
    R.id = null;
  }
}
function closeReader() {
  if (R.rendition) { try { R.rendition.destroy(); R.epub.destroy(); } catch {} }
  R.rendition = null; R.epub = null; R.id = null; R.locReady = false; R.ready = false;
  $('rStage').innerHTML = '';
  $('reader').classList.remove('immersive');
}
async function loadLocations(id) {
  const key = 'listen-loc-' + id;
  let cached = null;
  try { cached = localStorage.getItem(key); } catch {}
  if (cached) R.epub.locations.load(cached);
  else {
    $('rPct').textContent = 'Measuring book…';
    await R.epub.locations.generate(1200);
    try { localStorage.setItem(key, R.epub.locations.save()); } catch {}
  }
  if (R.id !== id) return;
  R.locReady = true;
  const loc = R.rendition.currentLocation();
  if (loc?.start) onRelocated(loc);
}
function tocLabel(href) {
  /* The chapter you're in: the last contents entry that starts at or before this page. */
  const here = R.epub.spine.get(resolveHref(href.split('#')[0]))?.index ?? -1;
  let best = null, bestIdx = -1;
  const walk = items => items.forEach(it => {
    const idx = R.epub.spine.get(resolveHref(it.href.split('#')[0]))?.index ?? -1;
    if (idx <= here && idx > bestIdx) { best = it; bestIdx = idx; }
    if (it.subitems) walk(it.subitems);
  });
  walk(R.toc);
  return best ? best.label.trim() : '';
}
function onRelocated(loc) {
  if (!loc?.start || !R.rendition) return;
  (Store.data.cfi ||= {})[R.id] = { cfi: loc.start.cfi, at: Date.now() }; Store.save();
  Hooks.relocated(loc);
  $('rChapter').textContent = tocLabel(loc.start.href);
  if (R.locReady) {
    const p = R.epub.locations.percentageFromCfi(loc.start.cfi) || 0;
    $('rPct').textContent = `${Math.round(p * 100)}%`;
    $('rSeek').value = Math.round(p * 1000);
    const total = R.epub.locations.length(), at = R.epub.locations.locationFromCfi(loc.start.cfi);
    const minsLeft = (total - at) * 1200 / 5.5 / 250;   // ~1200 characters per location, ~250 words a minute
    $('rLeft').textContent = `about ${fmtLong(minsLeft * 60)} left in book`;
  }
  for (const li of document.querySelectorAll('#rTocList li')) li.classList.toggle('cur', li.dataset.label === $('rChapter').textContent);
}
$('rSeek').onchange = () => { if (R.locReady) R.rendition.display(R.epub.locations.cfiFromPercentage(+$('rSeek').value / 1000)); };

/* Contents links are sometimes relative to a different folder than the pages: match them by file name. */
function resolveHref(href) {
  const [file, anchor] = href.split('#');
  if (R.epub.spine.get(file)) return href;
  const items = R.epub.spine.spineItems;
  const hit = items.find(s => s.href.endsWith('/' + file) || s.href === file)
    || items.find(s => s.href.split('/').pop() === file.split('/').pop());
  return hit ? hit.href + (anchor ? '#' + anchor : '') : href;
}

function buildToc() {
  const list = $('rTocList');
  list.innerHTML = '';
  const add = (items, depth) => items.forEach(it => {
    const li = document.createElement('li');
    li.className = depth ? 'sub' : '';
    li.dataset.label = it.label.trim();
    li.innerHTML = `<button>${esc(it.label.trim())}</button>`;
    li.firstChild.onclick = () => { R.rendition.display(resolveHref(it.href)).catch(() => {}); $('rToc').hidden = true; };
    list.appendChild(li);
    if (it.subitems?.length && depth < 2) add(it.subitems, depth + 1);
  });
  add(R.toc, 0);
}

/* Turning pages: tap the left/right edges, swipe, or use the arrow keys. Tap the middle for menus. */
const go = dir => { if (!R.ready) return; dir > 0 ? R.rendition.next() : R.rendition.prev(); };
function readerKeys(e) {
  if ($('reader').hidden) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key)) go(1);
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) go(-1);
}
document.addEventListener('keyup', e => { if (!e.target.matches?.('input, select')) readerKeys(e); });
function toggleImmersive() { $('reader').classList.toggle('immersive'); $('rToc').hidden = true; $('rSettings').hidden = true; }
/* Tap the left 30% to go back, the right 30% to go forward, the middle for the menus; swipe to turn.
 * A tap only counts if no text got selected (press-and-hold, double-click or drag selects instead). */
let touch = null, lastSwipe = 0, tapTimer = 0;
const selectedIn = contents => !!String(contents?.window?.getSelection?.() || '').trim();
function tapSpot(e, contents) {                       // where across the page the tap was, 0 (left) to 1 (right)
  const frame = $('rFrame'), el = contents.document.defaultView.frameElement;
  let x = e.clientX;
  for (let p = el.parentElement; p && p !== frame; p = p.parentElement) x -= p.scrollLeft;
  for (let o = el; o && o !== frame && frame.contains(o); o = o.offsetParent) x += o.offsetLeft;
  return x / (frame.clientWidth || 1);
}
function readerTap(e, contents) {
  if (e.target?.closest?.('a[href]') || selectedIn(contents) || Date.now() - lastSwipe < 500) return;
  const spot = tapSpot(e, contents);
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => {                       // wait a moment: a double-click selects a word instead
    if (selectedIn(contents)) return;
    if (rset().flow !== 'paginated') return toggleImmersive();
    spot < 0.3 ? go(-1) : spot > 0.7 ? go(1) : toggleImmersive();
  }, 250);
}
function readerTouchStart(e) { const t = e.changedTouches[0]; touch = t && { x: t.clientX, y: t.clientY, at: Date.now() }; }
function readerTouchEnd(e, contents) {
  const t = e.changedTouches[0], s = touch;
  touch = null;
  if (!s || !t || selectedIn(contents) || rset().flow !== 'paginated') return;
  const dx = t.clientX - s.x, dy = t.clientY - s.y;     // measured inside the page, so already in the book's direction
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - s.at < 800) {
    lastSwipe = Date.now(); clearTimeout(tapTimer); go(dx < 0 ? 1 : -1);
  }
}
$('rBack').onclick = () => { location.hash = `#/book/${enc(R.id || '')}`; };
$('rTocBtn').onclick = () => { $('rSettings').hidden = true; $('rToc').hidden = !$('rToc').hidden; };
$('rSetBtn').onclick = () => { $('rToc').hidden = true; $('rSettings').hidden = !$('rSettings').hidden; };
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => $(b.dataset.close).hidden = true);

/* Display settings */
function setReader(k, v) {
  Store.data.reader = { ...rset(), [k]: v }; Store.save();
  applyReaderChrome();
  if (!R.rendition || !R.ready) return;
  const loc = R.rendition.currentLocation();
  if (k === 'flow') R.rendition.flow(v);
  if (k === 'flow' || k === 'columns') R.rendition.spread(rset().columns === 'one' || rset().flow !== 'paginated' ? 'none' : 'auto', 800);
  R.rendition.getContents().forEach(styleContents);
  requestAnimationFrame(() => {                       // re-flow the pages, staying on the same spot
    R.rendition.resize();
    if (loc?.start && k !== 'theme') R.rendition.display(loc.start.cfi);
  });
}
function applyReaderChrome() {
  const s = rset(), el = $('reader');
  el.dataset.theme = s.theme; el.dataset.rotate = s.rotate;
  $('rStage').style.inset = `8px ${s.margin}px`;
  document.querySelectorAll('#rSettings .seg').forEach(seg =>
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', String(s[seg.dataset.set]) === b.dataset.v)));
  $('fontSel').value = s.font;
  $('sizeOut').textContent = s.size + '%';
  $('leadingOut').textContent = s.leading.toFixed(1);
  $('fsBtn').textContent = document.fullscreenElement ? 'Exit' : 'Enter';
  $('fsBtn').closest('.set-row').hidden = !document.documentElement.requestFullscreen;
}
document.querySelectorAll('#rSettings .seg').forEach(seg => seg.onclick = e => {
  const b = e.target.closest('button');
  if (b) setReader(seg.dataset.set, b.dataset.v);
});
$('fontSel').onchange = () => setReader('font', $('fontSel').value);
document.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
  const k = b.dataset.step, s = rset();
  if (k === 'size') setReader('size', Math.min(250, Math.max(60, s.size + +b.dataset.d)));
  else setReader('leading', Math.round(Math.min(2.4, Math.max(1, s.leading + +b.dataset.d)) * 10) / 10);
});
$('fsBtn').onclick = async () => {
  try { document.fullscreenElement ? await document.exitFullscreen() : await document.documentElement.requestFullscreen(); } catch {}
  setTimeout(() => { applyReaderChrome(); if (R.ready) R.rendition.resize(); }, 300);
};

/* ================================================================ keyboard for the player */
document.addEventListener('keydown', e => {
  if ($('player').hidden || e.target.matches('input, button, select')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') $('back15').click();
  else if (e.key === 'ArrowRight') $('fwd15').click();
});

/* ================================================================ start */
setRate(rate());
(async () => {
  const forceDrive = new URLSearchParams(location.search).has('drive');   // test the Google Drive version locally
  const local = !forceDrive && ['localhost', '127.0.0.1'].includes(location.hostname) &&
    await fetch('library.json', { method: 'HEAD' }).then(r => r.ok).catch(() => false);
  if (!local) {
    Source = DriveSource;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    document.head.appendChild(s);
    if (!CFG.GOOGLE_CLIENT_ID) $('signinMsg').textContent = 'Google sign-in is not set up yet (no client ID in config.js).';
    $('signinBtn').onclick = async () => {
      $('signinMsg').textContent = '';
      try {
        await DriveSource.signIn('select_account');
        Hooks.signedIn();
        route();                                       // shows last time's library at once, or the loading screen
      } catch (e) { $('signinMsg').textContent = e.message; }
    };
  }
  route();
})();
