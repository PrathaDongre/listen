# Soundshelf

A small web app for listening to audiobooks with synced text, a one-word-at-a-time
speed reader, and an EPUB reader.

The app itself contains no books. When opened online it asks you to sign in with Google
and reads books from the `Audiobooks` folder in your own Google Drive. Each book is a
folder with `book.json`, `cover.jpg`, `book.epub`, and numbered chapter `.mp3` files
(plus a `.json` file of word timings per chapter for the synced text).

- `index.html`, `style.css`, `app.js` — the app
- `config.js` — the Google OAuth client ID (not a secret; it only works from the
  allowed web addresses and for allowed test users)
- `serve.py` — optional local server for trying the app on your own computer
