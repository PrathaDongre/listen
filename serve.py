"""Local server for the reader app draft.

Serves the app from this folder, the MP3s/timings from ../Audiobooks under /books/,
and a generated /library.json listing every book. Only reachable from this Mac.
Later, Google Drive replaces this server and the app is hosted on GitHub Pages.
"""
import http.server
import json
import os
import re
import subprocess
import urllib.parse

PORT = 8770
APP = os.path.dirname(os.path.abspath(__file__))
BOOKS = os.path.join(os.path.dirname(APP), "Audiobooks")
_durations = {}


def probe(path):
    """Duration and tags of an MP3 (cached), for books recorded before book.json existed."""
    key = (path, os.path.getmtime(path))
    if key not in _durations:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration:format_tags=album,artist",
                              "-of", "json", path], capture_output=True, text=True).stdout
        fmt = json.loads(out or "{}").get("format", {})
        _durations[key] = (float(fmt.get("duration", 0)), fmt.get("tags", {}))
    return _durations[key]


def library():
    books = []
    for folder in sorted(os.listdir(BOOKS)) if os.path.isdir(BOOKS) else []:
        d = os.path.join(BOOKS, folder)
        if not os.path.isdir(d):
            continue
        mp3s = sorted(f for f in os.listdir(d) if f.endswith(".mp3"))
        has_epub = os.path.exists(os.path.join(d, "book.epub"))
        if not mp3s and not has_epub:
            continue
        try:
            meta = json.load(open(os.path.join(d, "book.json")))
        except (OSError, ValueError):
            meta = {}
        known = {c["file"]: c for c in meta.get("chapters", [])}
        chapters = []
        for f in mp3s:
            c = dict(known.get(f) or {})
            if not c:
                dur, tags = probe(os.path.join(d, f))
                m = re.match(r"(\d+)\s*-\s*(.*)\.mp3$", f)
                c = {"n": int(m.group(1)) if m else len(chapters) + 1,
                     "title": m.group(2) if m else f[:-4], "duration": round(dur, 1)}
                meta.setdefault("title", tags.get("album") or folder)
                meta.setdefault("author", tags.get("artist", ""))
            c["file"] = f
            c["timed"] = os.path.exists(os.path.join(d, f[:-4] + ".json"))
            chapters.append(c)
        books.append({"id": folder, "title": meta.get("title", folder), "author": meta.get("author", ""),
                      "voice": meta.get("voice", ""), "total": meta.get("total", len(chapters)),
                      "cover": os.path.exists(os.path.join(d, "cover.jpg")), "epub": has_epub,
                      "speed": meta.get("speed"), "text": meta.get("text", []), "chapters": chapters})
    return books


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=APP, **kw)

    def translate_path(self, path):
        path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        if path.startswith("/books/"):
            full = os.path.normpath(os.path.join(BOOKS, path[len("/books/"):]))
            return full if full.startswith(BOOKS) else BOOKS
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def do_HEAD(self):
        if self.path.split("?")[0] == "/library.json":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            return
        return super().do_HEAD()

    def do_GET(self):
        if self.path.split("?")[0] == "/library.json":
            body = json.dumps(library(), ensure_ascii=False).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or not os.path.isfile(path):
            return super().do_GET()
        # Byte ranges, so the audio player can jump around inside a chapter.
        size = os.path.getsize(path)
        m = re.match(r"bytes=(\d*)-(\d*)", rng)
        start = int(m.group(1)) if m and m.group(1) else 0
        end = int(m.group(2)) if m and m.group(2) else size - 1
        if m and not m.group(1) and m.group(2):
            start, end = size - int(m.group(2)), size - 1
        end = min(end, size - 1)
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(65536, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"Reader app: http://localhost:{PORT}")
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
