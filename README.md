# LEDGER — project page

Static site: `index.html` + `app.js` + `assets/` (one folder per example: video, memory export, point cloud, answer replay).
No build step. Any static host that supports HTTP range requests (GitHub Pages does) serves it as is.
Local preview: `python3 -m http.server` is not enough for video seeking; use any range-capable static server.
