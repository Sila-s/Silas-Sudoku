# Sudoku

A clean, offline Sudoku game built for iPhone. Plain HTML, CSS and JavaScript — no framework, no network requests while playing.

## Install on iPhone

1. Open the GitHub Pages link in **Safari**.
2. Tap **Share → Add to Home Screen → Add**.
3. Launch it from the Home Screen once while online. After that it works in aeroplane mode.

## How puzzles are made

- A random complete grid is carved down (symmetric pairs first, then single cells). A clue is only removed if the puzzle still has **exactly one solution** and can still be solved by **logic alone**.
- Difficulty is graded by the hardest technique a human-style solver needs:
  - **Easy** — hidden and naked singles
  - **Medium** — adds pointing/claiming, naked and hidden pairs
  - **Hard** — adds naked/hidden triples and X-Wing
  - **Expert** — adds Swordfish, XY-Wing and simple colouring
- Generation runs in a Web Worker, and one puzzle per difficulty is kept ready so new games start instantly.

## Files

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | Layout and styles |
| `js/engine.js` | Generator, solution counter, logical solver, grader, hints (no DOM) |
| `js/app.js` | Game UI, input, undo/redo, saving, timer, stats, settings |
| `js/worker.js` | Runs puzzle generation off the main thread |
| `sw.js` | Service worker that caches the app for offline play |
| `manifest.webmanifest`, `icons/` | Home Screen install details |
| `tests/` | Engine tests |

## Tests

- In a browser: open `tests/index.html` (generates 20 puzzles per difficulty on that device and checks uniqueness and grade).
- In Node: `node tests/engine.test.js 20` (also checks that hints can walk every puzzle to completion).

## Releasing an update

Bump `VERSION` in **both** `js/app.js` and `sw.js`. Installed copies will show "Update available — tap to reload".
