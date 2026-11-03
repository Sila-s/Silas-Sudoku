(() => {
  'use strict';

  const VERSION = '1.1.0'; // keep in sync with sw.js
  const E = window.SudokuEngine;
  const $ = (s) => document.querySelector(s);
  const DIFFS = E.DIFFICULTIES;
  const LABEL = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
  const BLURB = { easy: 'Singles only', medium: 'Pairs & pointing', hard: 'Triples & X-Wing', expert: 'Wings & colouring' };
  const KEYS = { game: 'sudoku.game.v1', settings: 'sudoku.settings.v1', stats: 'sudoku.stats.v1', pool: 'sudoku.pool.v1' };

  // ---------- Storage ----------
  const load = (k, def) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } };
  const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };

  const settings = Object.assign({ mistakeMode: 'conflicts', smartNotes: true, highlight: true, mistakeLimit: true }, load(KEYS.settings, {}));
  let stats = load(KEYS.stats, {});
  const pool = load(KEYS.pool, {});
  let game = load(KEYS.game, null);
  if (game && !(Array.isArray(game.values) && game.values.length === 81)) game = null;
  if (game) { game.mistakes = game.mistakes || 0; game.failed = !!game.failed; } // saves from v1.0
  const MAX_MISTAKES = 3;

  // ---------- UI state ----------
  let selected = -1;
  let notesMode = false;
  let noteDigit = 0; // in notes mode: the digit chosen on the pad, applied to each square tapped
  let paused = false;
  let loading = false;
  let hint = null;
  let runningSince = null;
  let warnedFull = false;
  let restartArmed = false;

  // ---------- Clock ----------
  const elapsed = () => (game ? game.elapsed + (runningSince ? Date.now() - runningSince : 0) : 0);
  function startClock() {
    if (!game || game.completed || game.failed || paused || loading || document.hidden || runningSince || !$('#sheet').hidden) return;
    runningSince = Date.now();
  }
  function stopClock() {
    if (runningSince) { game.elapsed += Date.now() - runningSince; runningSince = null; }
  }
  function fmt(ms) {
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0');
  }
  function saveGame() {
    if (!game) return;
    store(KEYS.game, Object.assign({}, game, { elapsed: elapsed() }));
  }

  // ---------- Puzzle generation (Web Workers) ----------
  const workers = {};
  const pending = new Map();
  const inflight = {};
  let reqId = 0;
  function worker(name) {
    if (!workers[name]) {
      const w = new Worker('js/worker.js');
      w.onmessage = (e) => { const cb = pending.get(e.data.id); pending.delete(e.data.id); if (cb) cb(e.data); };
      workers[name] = w;
    }
    return workers[name];
  }
  function generate(diff, lane) {
    if (inflight[diff]) return inflight[diff];
    const id = ++reqId;
    inflight[diff] = new Promise((resolve) => {
      pending.set(id, (d) => { delete inflight[diff]; resolve({ puzzle: d.puzzle, solution: d.solution }); });
      worker(lane).postMessage({ id, difficulty: diff });
    });
    return inflight[diff];
  }
  let refilling = false;
  async function refillPool() {
    if (refilling) return;
    refilling = true;
    try {
      for (const d of DIFFS) {
        if (pool[d]) continue;
        const p = await generate(d, 'bg');
        if (!pool[d]) { pool[d] = p; store(KEYS.pool, pool); }
      }
    } finally { refilling = false; }
  }
  async function takePuzzle(diff) {
    if (pool[diff]) { const p = pool[diff]; delete pool[diff]; store(KEYS.pool, pool); return p; }
    return generate(diff, 'fg');
  }

  // ---------- Game lifecycle ----------
  async function newGame(diff) {
    closeSheet(true);
    stopClock();
    hint = null; selected = -1; notesMode = false; noteDigit = 0; paused = false;
    loading = !pool[diff];
    render();
    const p = await takePuzzle(diff);
    game = {
      difficulty: diff, puzzle: p.puzzle, solution: p.solution,
      values: p.puzzle.slice(), notes: new Array(81).fill(0),
      history: [], future: [], elapsed: 0, hintsUsed: 0, completed: false, mistakes: 0, failed: false,
    };
    loading = false; warnedFull = false;
    saveGame();
    render();
    startClock();
    refillPool();
  }
  function restart() {
    if (!game) return;
    stopClock();
    Object.assign(game, { values: game.puzzle.slice(), notes: new Array(81).fill(0), history: [], future: [], elapsed: 0, hintsUsed: 0, completed: false, mistakes: 0, failed: false });
    hint = null; selected = -1; paused = false; warnedFull = false; notesMode = false; noteDigit = 0;
    saveGame();
    closeSheet();
  }
  const canPlay = () => game && !game.completed && !game.failed && !paused && !loading;

  // ---------- Moves ----------
  // changes: [{i, v, n}] -> new value / notes per cell. Recorded for undo.
  function commit(changes) {
    const rec = [];
    for (const { i, v, n } of changes) {
      const pv = game.values[i], pn = game.notes[i];
      if (pv === v && pn === n) continue;
      rec.push([i, pv, pn, v, n]);
      game.values[i] = v; game.notes[i] = n;
    }
    if (!rec.length) return;
    game.history.push(rec);
    if (game.history.length > 3000) game.history.shift();
    game.future = [];
    hint = null;
    afterChange();
  }
  function afterChange() {
    checkComplete();
    saveGame();
    render();
  }
  function undo() {
    if (!canPlay() || !game.history.length) return;
    const rec = game.history.pop();
    for (let k = rec.length - 1; k >= 0; k--) { const [i, pv, pn] = rec[k]; game.values[i] = pv; game.notes[i] = pn; }
    game.future.push(rec);
    selected = rec[0][0];
    hint = null;
    afterChange();
  }
  function redo() {
    if (!canPlay() || !game.future.length) return;
    const rec = game.future.pop();
    for (const [i, , , v, n] of rec) { game.values[i] = v; game.notes[i] = n; }
    game.history.push(rec);
    selected = rec[0][0];
    hint = null;
    afterChange();
  }
  function placeValue(i, d) {
    const ch = [{ i, v: d, n: 0 }];
    if (settings.smartNotes) {
      const bit = 1 << d;
      for (const p of E.PEERS[i]) if (game.notes[p] & bit) ch.push({ i: p, v: game.values[p], n: game.notes[p] & ~bit });
    }
    commit(ch);
  }
  function inputDigit(d) {
    if (!canPlay() || selected < 0) return;
    const i = selected;
    if (game.puzzle[i]) return;
    if (notesMode) {
      if (!game.values[i]) commit([{ i, v: 0, n: game.notes[i] ^ (1 << d) }]);
      return;
    }
    if (game.values[i] === d) {
      commit([{ i, v: 0, n: 0 }]);
      return;
    }
    const wrong = settings.mistakeLimit && d !== game.solution[i];
    if (wrong) game.mistakes++;
    placeValue(i, d);
    if (wrong) {
      if (game.mistakes >= MAX_MISTAKES) fail();
      else toast('Mistake ' + game.mistakes + ' of ' + MAX_MISTAKES);
    }
  }
  // Pad press: in notes mode it picks the digit to pencil in; otherwise it fills the selected square.
  function padDigit(d) {
    if (!canPlay()) return;
    if (notesMode) { noteDigit = noteDigit === d ? 0 : d; render(); return; }
    inputDigit(d);
  }
  function toggleNote(i) {
    if (game.puzzle[i] || game.values[i]) return;
    commit([{ i, v: 0, n: game.notes[i] ^ (1 << noteDigit) }]);
  }
  function setNotesMode(on) {
    if (!canPlay()) return;
    notesMode = on;
    noteDigit = 0;
    render();
  }
  function fail() {
    stopClock();
    game.failed = true;
    selected = -1; notesMode = false; noteDigit = 0; hint = null;
    const s = stats[game.difficulty] || (stats[game.difficulty] = { completed: 0, best: null, total: 0 });
    s.failed = (s.failed || 0) + 1;
    store(KEYS.stats, stats);
    saveGame();
    render();
    openSheet('failed');
  }
  function erase() {
    if (!canPlay() || selected < 0 || game.puzzle[selected]) return;
    commit([{ i: selected, v: 0, n: 0 }]);
  }
  function fillAllNotes() {
    if (!canPlay()) return;
    const ch = [];
    for (let i = 0; i < 81; i++) if (!game.values[i]) ch.push({ i, v: 0, n: E.candidatesFor(game.values, i) });
    commit(ch);
    toast('Notes filled in');
  }
  function checkComplete() {
    if (game.values.includes(0)) { warnedFull = false; return; }
    if (game.values.every((v, i) => v === game.solution[i])) return complete();
    if (!warnedFull) { warnedFull = true; toast('Not quite — there’s a mistake somewhere'); }
  }
  function complete() {
    stopClock();
    game.completed = true;
    selected = -1; notesMode = false; noteDigit = 0; hint = null;
    const s = stats[game.difficulty] || (stats[game.difficulty] = { completed: 0, best: null, total: 0 });
    s.completed++;
    s.total += game.elapsed;
    const isBest = s.best === null || game.elapsed < s.best;
    if (isBest) s.best = game.elapsed;
    store(KEYS.stats, stats);
    saveGame();
    openSheet('complete', { isBest });
  }

  // ---------- Hints ----------
  function requestHint() {
    if (!canPlay() || (hint && hint.kind === 'confirm')) return;
    if (!E.findHint(game.values, game.solution)) return;
    hint = { kind: 'confirm' };
    render();
  }
  function showHint() {
    const h = E.findHint(game.values, game.solution);
    if (!h) return;
    game.hintsUsed++;
    saveGame();
    if (h.kind === 'wrong') {
      hint = { kind: 'wrong', cell: h.cell };
      selected = h.cell;
    } else if (h.kind === 'reveal') {
      hint = { kind: 'reveal', cell: h.cell, digit: h.digit };
      selected = h.cell;
    } else {
      hint = { kind: 'steps', steps: h.steps, index: 0 };
    }
    render();
  }
  function hintAction() {
    if (!hint || !canPlay()) return;
    if (hint.kind === 'confirm') { showHint(); return; }
    if (hint.kind === 'wrong') { const c = hint.cell; hint = null; commit([{ i: c, v: 0, n: 0 }]); return; }
    if (hint.kind === 'reveal') { placeValue(hint.cell, hint.digit); return; }
    const s = hint.steps[hint.index];
    if (s.place) { selected = s.place.cell; placeValue(s.place.cell, s.place.digit); return; }
    hint.index++;
    render();
  }
  function hintView() {
    if (!hint) return null;
    const v = { pattern: new Set(), elim: new Set(), target: -1, text: '', action: '', close: 'Close' };
    if (hint.kind === 'confirm') {
      v.text = '<b>Use a hint?</b> It will be added to this puzzle\u2019s hint count.';
      v.action = 'Show hint';
      v.close = 'Cancel';
    } else if (hint.kind === 'wrong') {
      v.target = hint.cell;
      v.text = 'This entry isn’t right.';
      v.action = 'Erase it';
    } else if (hint.kind === 'reveal') {
      v.target = hint.cell;
      v.text = 'No technique in this app’s set applies here, so here’s an answer: this cell is <b>' + hint.digit + '</b>.';
      v.action = 'Fill in';
    } else {
      const s = hint.steps[hint.index];
      const n = hint.steps.length;
      s.cells.forEach((c) => v.pattern.add(c));
      s.elim.forEach(([c]) => v.elim.add(c));
      if (s.place) v.target = s.place.cell;
      v.text = (n > 1 ? '<span class="muted">Step ' + (hint.index + 1) + ' of ' + n + ' · </span>' : '') + '<b>' + s.tech + '.</b> ' + s.text;
      v.action = s.place ? 'Fill in' : 'Next';
    }
    return v;
  }

  // ---------- Pause ----------
  function setPaused(p) {
    if (!game || game.completed || loading) return;
    paused = p;
    if (paused) stopClock(); else startClock();
    saveGame();
    render();
  }

  // ---------- Board DOM ----------
  const board = $('#board');
  const cells = new Array(81);
  const noteSpans = new Array(81);
  const valSpans = new Array(81);
  for (let b = 0; b < 9; b++) {
    const box = document.createElement('div');
    box.className = 'box';
    for (let k = 0; k < 9; k++) {
      const r = ((b / 3) | 0) * 3 + ((k / 3) | 0), c = (b % 3) * 3 + (k % 3), i = r * 9 + c;
      const el = document.createElement('div');
      el.className = 'cell';
      el.dataset.i = i;
      el.setAttribute('role', 'gridcell');
      const v = document.createElement('span');
      v.className = 'v';
      const notes = document.createElement('div');
      notes.className = 'notes';
      const spans = [];
      for (let d = 1; d <= 9; d++) { const s = document.createElement('span'); notes.appendChild(s); spans.push(s); }
      el.append(v, notes);
      box.appendChild(el);
      cells[i] = el; valSpans[i] = v; noteSpans[i] = spans;
    }
    board.appendChild(box);
  }
  const pad = $('#pad');
  const keys = [];
  for (let d = 1; d <= 9; d++) {
    const k = document.createElement('button');
    k.className = 'key';
    k.dataset.d = d;
    k.setAttribute('aria-label', String(d));
    k.innerHTML = '<span class="d">' + d + '</span><span class="n"></span>';
    pad.appendChild(k);
    keys.push(k);
  }

  // ---------- Render ----------
  function render() {
    const has = !!game;
    $('#lbl-diff').textContent = loading ? 'New game' : has ? LABEL[game.difficulty] : 'Sudoku';
    updateTime();
    $('#btn-pause').classList.toggle('paused', paused);
    $('#overlay-pause').hidden = !paused;
    $('#overlay-loading').hidden = !loading;

    const values = has ? game.values : new Array(81).fill(0);
    const focus = notesMode && noteDigit ? noteDigit : has && selected >= 0 && settings.highlight ? values[selected] : 0;
    const hv = hintView();
    const bad = new Set();
    if (has) {
      if (settings.mistakeLimit || settings.mistakeMode === 'solution') {
        for (let i = 0; i < 81; i++) if (values[i] && !game.puzzle[i] && values[i] !== game.solution[i]) bad.add(i);
      } else {
        for (let i = 0; i < 81; i++) {
          if (!values[i]) continue;
          for (const p of E.PEERS[i]) if (values[p] === values[i]) { bad.add(i); break; }
        }
      }
    }
    const sr = selected >= 0 ? E.rowOf(selected) : -1, sc = selected >= 0 ? E.colOf(selected) : -1, sb = selected >= 0 ? E.boxOf(selected) : -1;
    for (let i = 0; i < 81; i++) {
      const v = values[i];
      let cls = 'cell';
      if (has && game.puzzle[i]) cls += ' given';
      if (hv && hv.target === i) cls += ' h-target';
      else if (hv && hv.elim.has(i)) cls += ' h-elim';
      else if (hv && hv.pattern.has(i)) cls += ' h-pattern';
      else if (i === selected) cls += ' sel';
      else if (focus && v === focus) cls += ' same';
      else if (selected >= 0 && settings.highlight && (E.rowOf(i) === sr || E.colOf(i) === sc || E.boxOf(i) === sb)) cls += ' peer';
      if (bad.has(i)) cls += ' bad';
      if (cells[i].className !== cls) cells[i].className = cls;
      const t = v ? String(v) : '';
      if (valSpans[i].textContent !== t) valSpans[i].textContent = t;
      const n = has && !v ? game.notes[i] : 0;
      const spans = noteSpans[i];
      for (let d = 1; d <= 9; d++) {
        const on = n & (1 << d);
        const txt = on ? String(d) : '';
        if (spans[d - 1].textContent !== txt) spans[d - 1].textContent = txt;
        const nf = on && focus === d ? 'nf' : '';
        if (spans[d - 1].className !== nf) spans[d - 1].className = nf;
      }
    }

    const counts = new Array(10).fill(0);
    for (const v of values) counts[v]++;
    for (let d = 1; d <= 9; d++) {
      const left = 9 - counts[d];
      keys[d - 1].classList.toggle('done', has && left <= 0);
      keys[d - 1].querySelector('.n').textContent = has ? (left > 0 ? left : '') : '';
    }
    pad.classList.toggle('notes', notesMode);
    for (let d = 1; d <= 9; d++) keys[d - 1].classList.toggle('armed', notesMode && noteDigit === d);

    const playable = canPlay();
    $('#t-undo').disabled = !playable || !game.history.length;
    $('#t-redo').disabled = !playable || !game.future.length;
    $('#t-erase').disabled = !playable;
    $('#t-auto').disabled = !playable;
    $('#t-hint').disabled = !playable;
    $('#t-notes').disabled = !playable;
    $('#t-notes').classList.toggle('on', notesMode);
    $('#notes-badge').textContent = notesMode ? 'On' : 'Off';

    const bar = $('#hintbar');
    bar.hidden = !hv;
    if (hv) $('#toast').classList.remove('show');
    if (hv) {
      $('#hint-text').innerHTML = hv.text;
      $('#hint-action').textContent = hv.action;
      $('#hint-close').textContent = hv.close;
    }
  }
  function updateTime() {
    let t = game ? fmt(elapsed()) : '';
    if (game && settings.mistakeLimit) t += ' \u00b7 Mistakes ' + game.mistakes + '/' + MAX_MISTAKES;
    $('#lbl-time').textContent = t;
  }
  setInterval(updateTime, 500);

  // ---------- Sheets ----------
  const sheet = $('#sheet'), panel = $('#sheet-panel');
  let sheetView = null;
  const chev = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  const backBtn = '<button class="back" data-act="menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>Back</button>';
  function diffGrid() {
    return '<div class="diff-grid">' + DIFFS.map((d) => {
      const s = stats[d];
      const sub = s && s.best !== null ? 'Best ' + fmt(s.best) : BLURB[d];
      return '<button class="diff-btn" data-new="' + d + '"><b>' + LABEL[d] + '</b><small>' + sub + '</small></button>';
    }).join('') + '</div>';
  }
  function openSheet(view, opts) {
    opts = opts || {};
    stopClock();
    sheetView = view;
    restartArmed = false;
    let html = '<div class="grabber"></div>';
    if (view === 'menu') {
      html += '<h3>New game</h3>' + diffGrid();
      if (game && !game.completed) {
        html += '<h3>This puzzle</h3><div class="list"><button class="row" data-act="restart"><span>Restart puzzle</span><span class="val" id="restart-hint"></span></button></div>';
      }
      html += '<h3>More</h3><div class="list">'
        + '<button class="row" data-act="stats"><span>Statistics</span>' + chev + '</button>'
        + '<button class="row" data-act="settings"><span>Settings</span>' + chev + '</button></div>';
    } else if (view === 'settings') {
      html += backBtn + '<h2>Settings</h2><div class="list">'
        + (settings.mistakeLimit ? '' : '<div class="row"><span>Mark mistakes</span><div class="seg">'
        + '<button data-mm="conflicts" class="' + (settings.mistakeMode === 'conflicts' ? 'on' : '') + '">Rule breaks</button>'
        + '<button data-mm="solution" class="' + (settings.mistakeMode === 'solution' ? 'on' : '') + '">Wrong digits</button></div></div>')
        + '<button class="row" data-toggle="mistakeLimit"><span>Game over after 3 mistakes</span><span class="switch' + (settings.mistakeLimit ? ' on' : '') + '"></span></button>'
        + '<button class="row" data-toggle="smartNotes"><span>Auto-remove notes</span><span class="switch' + (settings.smartNotes ? ' on' : '') + '"></span></button>'
        + '<button class="row" data-toggle="highlight"><span>Highlight row, column &amp; digit</span><span class="switch' + (settings.highlight ? ' on' : '') + '"></span></button>'
        + '</div>'
        + '<p class="note">' + (settings.mistakeLimit
          ? 'Any wrong digit is marked in red and counts as a mistake. The third mistake ends the game.'
          : '<b>Rule breaks</b> marks a digit only when it clashes with another in its row, column or box. <b>Wrong digits</b> checks every entry against the solution.') + '</p>'
        + '<h3>About</h3><div class="list"><div class="row"><span>Version</span><span class="val">' + VERSION + '</span></div></div>';
    } else if (view === 'stats') {
      html += backBtn + '<h2>Statistics</h2><div class="list">';
      for (const d of DIFFS) {
        const s = stats[d];
        const best = s && s.best !== null ? fmt(s.best) : '–';
        const avg = s && s.completed ? fmt(s.total / s.completed) : '–';
        html += '<div class="row"><span>' + LABEL[d] + '</span><span class="val">' + (s ? s.completed : 0) + ' solved · best ' + best + ' · avg ' + avg + '</span></div>';
      }
      html += '</div><h3>&nbsp;</h3><div class="list"><button class="row danger" data-act="reset-stats"><span>Reset statistics</span></button></div>';
    } else if (view === 'failed') {
      html += '<h2>Game over</h2><p class="sub">' + MAX_MISTAKES + ' mistakes \u00b7 ' + LABEL[game.difficulty] + ' \u00b7 ' + fmt(game.elapsed) + '</p>'
        + '<div class="list"><button class="row" data-act="retry"><span>Try this puzzle again</span>' + chev + '</button></div>'
        + '<h3>New game</h3>' + diffGrid();
    } else if (view === 'complete') {
      html += '<h2>Solved</h2><p class="sub">' + LABEL[game.difficulty] + (opts.isBest ? ' · new best time' : '') + (game.hintsUsed ? ' · ' + game.hintsUsed + ' hint' + (game.hintsUsed > 1 ? 's' : '') : '') + '</p>'
        + '<div class="done-time">' + fmt(game.elapsed) + '</div>'
        + '<h3>Play again</h3>' + diffGrid();
    }
    panel.innerHTML = html;
    sheet.hidden = false;
    $('#toast').classList.remove('show');
  }
  function closeSheet(force) {
    if (!force && !game) return; // first launch: must choose a difficulty
    sheet.hidden = true;
    sheetView = null;
    render();
    startClock();
  }
  panel.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.new) return newGame(t.dataset.new);
    if (t.dataset.mm) { settings.mistakeMode = t.dataset.mm; store(KEYS.settings, settings); openSheet('settings'); return; }
    if (t.dataset.toggle) { const k = t.dataset.toggle; settings[k] = !settings[k]; store(KEYS.settings, settings); openSheet('settings'); render(); return; }
    const act = t.dataset.act;
    if (act === 'retry') restart();
    else if (act === 'menu' || act === 'stats' || act === 'settings') openSheet(act);
    else if (act === 'restart') {
      if (restartArmed) restart();
      else { restartArmed = true; $('#restart-hint').textContent = 'Tap again to confirm'; }
    } else if (act === 'reset-stats') {
      if (t.dataset.armed) { stats = {}; store(KEYS.stats, stats); openSheet('stats'); }
      else { t.dataset.armed = '1'; t.firstChild.textContent = 'Tap again to reset'; }
    }
  });
  $('#sheet-backdrop').addEventListener('click', () => {
    if (game && (game.completed || game.failed)) return; // choose what to play next
    closeSheet();
  });

  // ---------- Toast ----------
  let toastTimer = 0;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- Input ----------
  // pointerdown (not click) so taps register the instant a finger lands.
  // The browser still fires a click afterwards at the same spot; if that tap
  // opened a sheet (e.g. the puzzle was just solved), the click would land on
  // whatever is now underneath. Swallow that one follow-up click.
  let swallowClickUntil = 0;
  document.addEventListener('click', (e) => {
    if (Date.now() < swallowClickUntil) { e.stopPropagation(); e.preventDefault(); swallowClickUntil = 0; }
  }, true);
  const onTap = (el, fn) => el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    swallowClickUntil = Date.now() + 700;
    fn(e);
  });
  onTap(board, (e) => {
    const c = e.target.closest('.cell');
    if (!c || !canPlay()) return;
    selected = Number(c.dataset.i);
    if (notesMode && noteDigit) toggleNote(selected);
    render();
  });
  onTap(pad, (e) => {
    const k = e.target.closest('.key');
    if (k) padDigit(Number(k.dataset.d));
  });
  onTap($('#t-undo'), undo);
  onTap($('#t-redo'), redo);
  onTap($('#t-erase'), erase);
  onTap($('#t-notes'), () => setNotesMode(!notesMode));
  onTap($('#t-auto'), fillAllNotes);
  onTap($('#t-hint'), requestHint);
  onTap($('#hint-action'), hintAction);
  onTap($('#hint-close'), () => { hint = null; render(); });
  onTap($('#btn-pause'), () => setPaused(!paused));
  onTap($('#btn-resume'), () => setPaused(false));
  // Click (not pointerdown) here, so the tap's own click can't land on the sheet backdrop and close it.
  $('#btn-menu').addEventListener('click', () => openSheet('menu'));

  // Keyboard (handy when testing on a computer)
  document.addEventListener('keydown', (e) => {
    if (!sheet.hidden) { if (e.key === 'Escape') closeSheet(); return; }
    if (/^[1-9]$/.test(e.key)) { padDigit(Number(e.key)); return; }
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') { erase(); return; }
    if (e.key === 'n' || e.key === 'N') { setNotesMode(!notesMode); return; }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    const mv = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (mv && canPlay()) {
      e.preventDefault();
      if (selected < 0) selected = 0;
      else {
        const r = E.rowOf(selected), c = E.colOf(selected);
        if (mv === -9) selected = ((r + 8) % 9) * 9 + c;
        if (mv === 9) selected = ((r + 1) % 9) * 9 + c;
        if (mv === -1) selected = r * 9 + (c + 8) % 9;
        if (mv === 1) selected = r * 9 + (c + 1) % 9;
      }
      render();
    }
  });

  // Block pinch-zoom and double-tap zoom on iOS.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());

  // Pause the clock and save whenever the app goes to the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stopClock(); saveGame(); } else { startClock(); render(); }
  });
  window.addEventListener('pagehide', () => { stopClock(); saveGame(); });

  // ---------- Offline + updates ----------
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) location.reload();
    });
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
        const bar = $('#update-bar');
        const offer = () => {
          if (!reg.waiting || !navigator.serviceWorker.controller) return;
          bar.hidden = false;
          bar.onclick = () => { stopClock(); saveGame(); reloading = true; reg.waiting.postMessage('skipWaiting'); };
        };
        offer();
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(); });
        });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      } catch (err) { /* offline support unavailable; game still works */ }
    });
  }

  // ---------- Boot ----------
  render();
  if (!game) openSheet('menu');
  else if (game.completed) openSheet('complete', {});
  else if (game.failed) openSheet('failed');
  else startClock();
  setTimeout(refillPool, 300);

  // Exposed for automated checks only.
  window.__sudoku = { get game() { return game; }, get selected() { return selected; }, VERSION };
})();
