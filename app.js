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
      });
      if (!by['book.json']) return null;              // not a book folder (e.g. voice samples)
      return { id: s.name, title: meta.title || s.name, author: meta.author || '', voice: meta.voice || '', speed: meta.speed,
               total: meta.total || chapters.length, cover: !!by['cover.jpg'], epub: !!by['book.epub'], chapters, _files: by };
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
const cleanTitle = t => t.replace(/^\s*\d+\s*[:.]\s*/, '');
const hasAudio = b => b.chapters.length > 0;

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
  if (!p || !hasAudio(b)) return 0;
  const done = b.chapters.filter(c => c.n < p.n).reduce((a, c) => a + c.duration, 0) + (p.t || 0);
  return Math.min(1, done / (bookSeconds(b) || 1));
}

/* ================================================================ views & routing */
let books = [];
function show(id) { for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id; }
const findBook = id => books.find(b => b.id === id);

async function loadBooks() { books = await Source.books(); }

async function route() {
  if (Source === DriveSource && !DriveSource.token) return show('signin');
  const [, view, id, n] = location.hash.split('/').map(decodeURIComponent);
  try {
    if (!books.length || !view || view === 'book' || view === 'stats') await loadBooks();
  } catch (e) { console.error(e); }
  if (view !== 'read') closeReader();
  if (view === 'book') return showBook(findBook(id));
  if (view === 'play') return showPlayer(findBook(id), +n);
  if (view === 'read') return openReader(findBook(id));
  if (view === 'stats') return Hooks.showStats();
  showLibrary();
}
addEventListener('hashchange', route);
document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) location.hash = g.dataset.go; });
$('refreshBtn').onclick = async () => { await loadBooks(); showLibrary(); };

/* ---------------- library */
function showLibrary() {
  show('library');
  const shelf = $('shelf');
  shelf.innerHTML = '';
  $('empty').hidden = books.length > 0;
  const last = findBook(Store.data.last);
  $('hero').hidden = !last;
  if (last) {
    const p = Store.pos(last.id), ch = p && last.chapters.find(c => c.n === p.n);
    const hero = $('hero');
    hero.innerHTML = `<div class="cover thumb"></div><div class="info"><span class="label">Continue</span>
      <span class="t">${esc(last.title)}</span>
      <span class="c">${ch ? esc(cleanTitle(ch.title)) + ' · ' + fmtLong(bookSeconds(last) * (1 - bookProgress(last))) + ' left' : esc(last.author)}</span>
      <div class="bar"><i style="width:${(bookProgress(last) * 100).toFixed(1)}%"></i></div></div>
      <button class="go" aria-label="Continue">${ch ? '▶' : '📖'}</button>`;
    cover(hero.firstChild, last);
    hero.onclick = () => location.hash = ch ? `#/play/${enc(last.id)}/${ch.n}` : `#/read/${enc(last.id)}`;
  }
  for (const b of books) {
    const card = document.createElement('button');
    card.className = 'book-card';
    const rec = hasAudio(b) ? (b.chapters.length < b.total ? `<span class="pill on">🎧 ${b.chapters.length}/${b.total}</span>` : '<span class="pill on">🎧 Audio</span>') : '';
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
  $('bookMeta').textContent = hasAudio(b) ? `${b.chapters.length} chapters · ${fmtLong(bookSeconds(b))}${recorded}` : 'EPUB only';
  const p = Store.pos(b.id);
  $('listenBtn').hidden = !hasAudio(b);
  $('listenBtn').textContent = p ? '▶ Continue' : '▶ Listen';
  $('listenBtn').onclick = () => location.hash = `#/play/${enc(b.id)}/${p ? p.n : b.chapters[0].n}`;
  $('readBtn').hidden = !b.epub;
  $('readBtn').onclick = () => location.hash = `#/read/${enc(b.id)}`;
  $('chaptersTitle').hidden = !hasAudio(b);
  $('noAudio').hidden = hasAudio(b);
  const list = $('chapterList');
  list.innerHTML = '';
  for (const c of b.chapters) {
    const li = document.createElement('li');
    const cls = p && p.n === c.n ? 'now' : p && c.n < p.n ? 'done' : '';
    li.innerHTML = `<button class="${cls}"><span class="n">${c.n}</span>
      <span class="ttl">${esc(cleanTitle(c.title))}${c.timed ? '' : '<span class="badge">audio only</span>'}</span>
      <span class="d">${fmt(c.duration)}</span></button>`;
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
  if (!b || !hasAudio(b)) return (location.hash = b ? `#/book/${enc(b.id)}` : '#/');
  show('player');
  const ch = b.chapters.find(c => c.n === n) || b.chapters[0];
  if (book?.id === b.id && chapter?.n === ch.n) { book = b; chapter = ch; return; }
  const seq = ++loadSeq;
  const wasPlaying = !audio.paused || autoNext;
  autoNext = false;
  audio.pause();
  book = b; chapter = ch;
  Store.setLast(b.id);
  $('pBook').textContent = b.title;
  $('pChapter').textContent = cleanTitle(ch.title);
  $('toReader').hidden = !b.epub;
  const p = Store.pos(b.id);
  pendingStart = p && p.n === ch.n ? p.t : 0;
  renderText(null, true);
  showStat();
  let url, data;
  try {
    [url, data] = await Promise.all([
      Source.audioUrl(b, ch),
      Source.timing(b, ch).catch(e => { console.warn('timing', e); return null; }),   // no text is better than no audio
    ]);
  } catch (e) {
    console.error('chapter', e);
    if (seq !== loadSeq) return;
    $('noText').hidden = false;
    $('noText').querySelector('strong').textContent = 'Couldn’t load this chapter';
    $('noText').querySelector('.muted').textContent = /sign|401|token/i.test(e.message)
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
  renderText(data);
  if (wasPlaying) audio.play().catch(() => {});
  tick(true);
}
$('toBook').onclick = () => location.hash = `#/book/${enc(book.id)}`;
$('toReader').onclick = () => { Hooks.jumpFromPlayer(); location.hash = `#/read/${enc(book.id)}`; };

function renderText(data, loading) {
  const view = $('textView');
  view.innerHTML = '';
  words = []; cur = -1;
  $('noText').hidden = !!data || loading;
  if (!data && !loading) cover($('noTextCover'), book);
  $('rsvpToggle').disabled = !data;
  if (!data) return applyMode();
  const frag = document.createDocumentFragment();
  for (const para of data.paras) {
    const el = document.createElement(para.title ? 'h3' : 'p');
    para.w.forEach(([text, s, e], k) => {
      if (k) el.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'w'; span.textContent = text; span.dataset.i = words.length;
      el.appendChild(span);
      words.push({ s, e, el: span, text });
    });
    frag.appendChild(el);
  }
  for (let i = 0; i < words.length; i++) {         // fill any gaps so every word has a time
    if (words[i].s == null) words[i].s = i ? words[i - 1].e ?? words[i - 1].s : 0;
    if (words[i].e == null) words[i].e = words[i].s;
  }
  view.appendChild(frag);
  applyMode();
}

function wordAt(t) {
  let lo = 0, hi = words.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (words[mid].s <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}

function highlight(i, jump) {
  if (i === cur) return;
  const prev = cur;
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
  const w = words[i].text, k = pivot(w), el = $('rsvpWord').children;
  el[0].textContent = w.slice(0, k); el[1].textContent = w[k] || ''; el[2].textContent = w.slice(k + 1);
  const a = Math.max(0, i - 6), b = Math.min(words.length, i + 7);
  $('rsvpContext').innerHTML = words.slice(a, b).map((x, j) => a + j === i ? `<b>${esc(x.text)}</b>` : esc(x.text)).join(' ');
}

let raf = 0, seeking = false, lastStat = 0;
function sync(jump) {
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
  const playing = !audio.paused;                       // keep the button truthful, whatever happened
  if ($('play').dataset.playing !== String(playing)) {
    $('play').dataset.playing = playing;
    $('play').textContent = playing ? '❚❚' : '▶';
    $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
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

audio.onplay = () => { tick(false); startLoop(); };
audio.onplaying = startLoop;
audio.onpause = () => { tick(false); savePos(); };
audio.onseeked = () => tick(true);
audio.onratechange = () => tick(false);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(true); if (!audio.paused) startLoop(); } });
audio.onloadedmetadata = () => { if (pendingStart) { audio.currentTime = pendingStart; pendingStart = 0; } tick(true); };
let lastSave = 0;
audio.ontimeupdate = () => { if (!raf || document.hidden) tick(false); if (Date.now() - lastSave > 5000) savePos(); };
function savePos() { if (book && audio.src) { lastSave = Date.now(); Store.setPos(book.id, chapter.n, audio.currentTime); } }
audio.onended = () => { const nx = sibling(1); if (nx) { autoNext = true; openChapter(nx); } };
function sibling(d) { return book.chapters[book.chapters.indexOf(chapter) + d]; }
function openChapter(c) { if (c) { Store.setPos(book.id, c.n, 0); location.hash = `#/play/${enc(book.id)}/${c.n}`; } }

const togglePlay = () => audio.paused ? audio.play().catch(() => {}) : audio.pause();
$('play').onclick = togglePlay;
$('back15').onclick = () => audio.currentTime = Math.max(0, audio.currentTime - 15);
$('fwd15').onclick = () => audio.currentTime = Math.min(audio.duration || 1e9, audio.currentTime + 15);
$('prevCh').onclick = () => audio.currentTime > 5 ? (audio.currentTime = 0) : openChapter(sibling(-1));
$('nextCh').onclick = () => openChapter(sibling(1));
$('seek').oninput = () => { seeking = true; $('tNow').textContent = fmt(+$('seek').value); };
$('seek').onchange = () => { seeking = false; audio.currentTime = +$('seek').value; };
$('textView').onclick = e => {
  const w = e.target.closest('.w');
  if (!w || String(getSelection()).trim()) return;      // selecting text, not tapping a word
  audio.currentTime = words[+w.dataset.i].s;
  if (audio.paused) audio.play().catch(() => {});
};
document.querySelector('.rsvp').onclick = togglePlay;

/* Speed: a multiplier on top of the speed the book was recorded at. */
function rate() { return Store.data.rate || 1; }
function setRate(r) {
  r = Math.min(3, Math.max(0.5, Math.round(r * 20) / 20));
  Store.data.rate = r; Store.save();
  audio.playbackRate = r; audio.defaultPlaybackRate = r;
  $('speedVal').textContent = r.toFixed(r * 10 % 1 ? 2 : 1) + '×';
  showStat();
}
$('slower').onclick = () => setRate(rate() - 0.1);
$('faster').onclick = () => setRate(rate() + 0.1);
$('speedVal').onclick = () => setRate(1);

const rsvpOn = () => $('rsvpToggle').checked && words.length > 0;
function applyMode() {
  $('rsvpView').hidden = !rsvpOn();
  $('textView').hidden = rsvpOn() || !words.length;
  cur = -1; if (words.length) tick(true);
}
$('rsvpToggle').checked = !!Store.data.rsvp;
$('rsvpToggle').onchange = () => { Store.data.rsvp = $('rsvpToggle').checked; Store.save(); applyMode(); };

/* ---------------- stats line: tap to cycle */
const STATS = [
  () => {
    let wpm;
    if (words.length > 20) wpm = words.length / ((words[words.length - 1].e - words[0].s) / 60) * rate();
    else wpm = 155 * (book?.speed || 1.2) * rate();
    return `${Math.round(wpm)} words per minute`;
  },
  () => `${fmtLong(((audio.duration || chapter.duration) - audio.currentTime) / rate())} left in chapter`,
  () => `${fmtLong(bookLeft() / rate())} left in book`,
  () => `Finishes at ${new Date(Date.now() + bookLeft() / rate() * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${bookLeft() / rate() > 86400 ? ' (not today)' : ''}`,
  () => `${Math.floor(audio.currentTime / (audio.duration || chapter.duration || 1) * 100)}% of chapter`,
  () => `${Math.floor((1 - bookLeft() / (bookSeconds(book) || 1)) * 100)}% of book`,
  () => `Chapter ${book.chapters.indexOf(chapter) + 1} of ${book.total || book.chapters.length}`,
  () => words.length ? `${Math.max(0, cur + 1).toLocaleString()} of ${words.length.toLocaleString()} words in chapter` : null,
];
function bookLeft() {
  if (!book) return 0;
  const after = book.chapters.filter(c => c.n > chapter.n).reduce((a, c) => a + c.duration, 0);
  return after + ((audio.duration || chapter.duration) - audio.currentTime);
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
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
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
    R.rendition.on('click', () => { if (rset().flow !== 'paginated') toggleImmersive(); });
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
let touch = null;
$('rZones').addEventListener('touchstart', e => { touch = e.touches[0]; }, { passive: true });
$('rZones').addEventListener('touchend', e => {
  if (!touch) return;
  const t = e.changedTouches[0];
  let dx = t.clientX - touch.clientX, dy = t.clientY - touch.clientY;
  const rot = +rset().rotate;                          // turn the swipe into the book's own direction
  [dx, dy] = rot === 90 ? [dy, -dx] : rot === 180 ? [-dx, -dy] : rot === 270 ? [-dy, dx] : [dx, dy];
  touch = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { e.preventDefault(); go(dx < 0 ? 1 : -1); }
});
$('rZones').onclick = e => {
  const z = e.target.dataset.z;
  if (z === 'next') go(1); else if (z === 'prev') go(-1); else toggleImmersive();
};
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
  $('rZones').classList.toggle('scroll', s.flow !== 'paginated');
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
        $('signinMsg').textContent = 'Loading your library…';
        await loadBooks();
        $('signinMsg').textContent = '';
        Hooks.signedIn();
        route();
      } catch (e) { $('signinMsg').textContent = e.message; }
    };
  }
  route();
})();
