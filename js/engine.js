/*
 * Sudoku engine: generator, solution counter, human-style logical solver,
 * difficulty grader and hint finder. No DOM access, so it runs in the page,
 * in a Web Worker and in Node (for tests).
 *
 * Grids are arrays of 81 numbers, 0 = empty, read row by row.
 * Candidates are bitmasks using bits 1..9.
 */
(function (root) {
  'use strict';

  const ALL = 0x3fe; // bits 1..9

  // ---------- Geometry ----------
  const rowOf = (i) => (i / 9) | 0;
  const colOf = (i) => i % 9;
  const boxOf = (i) => ((rowOf(i) / 3) | 0) * 3 + ((colOf(i) / 3) | 0);

  const UNITS = []; // 0-8 rows, 9-17 columns, 18-26 boxes
  for (let r = 0; r < 9; r++) UNITS.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) UNITS.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let b = 0; b < 9; b++) {
    const r0 = ((b / 3) | 0) * 3, c0 = (b % 3) * 3, cells = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cells.push((r0 + r) * 9 + c0 + c);
    UNITS.push(cells);
  }
  const ROWS = UNITS.slice(0, 9), COLS = UNITS.slice(9, 18), BOXES = UNITS.slice(18);

  const PEERS = [];
  const PEER_SET = [];
  for (let i = 0; i < 81; i++) {
    const s = new Set([...ROWS[rowOf(i)], ...COLS[colOf(i)], ...BOXES[boxOf(i)]]);
    s.delete(i);
    PEERS.push([...s]);
    PEER_SET.push(s);
  }
  const sees = (a, b) => PEER_SET[a].has(b);

  const POP = new Uint8Array(1024);
  for (let m = 1; m < 1024; m++) POP[m] = POP[m >> 1] + (m & 1);
  const DIGITS = []; // DIGITS[mask] = [digits in mask]
  for (let m = 0; m < 1024; m++) {
    const d = [];
    for (let k = 1; k <= 9; k++) if (m & (1 << k)) d.push(k);
    DIGITS.push(d);
  }
  const BIT_DIGIT = {};
  for (let k = 1; k <= 9; k++) BIT_DIGIT[1 << k] = k;

  function unitName(u) {
    if (u < 9) return 'row ' + (u + 1);
    if (u < 18) return 'column ' + (u - 8);
    return 'this box';
  }
  function unitKind(u) { return u < 9 ? 'row' : u < 18 ? 'column' : 'box'; }
  const cellName = (i) => 'R' + (rowOf(i) + 1) + 'C' + (colOf(i) + 1);

  // ---------- Random ----------
  function shuffle(a, rand) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  // Small seeded PRNG so tests are reproducible; defaults to Math.random.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Brute force (solution counting / full grid) ----------
  // Returns number of solutions found, stopping at `limit`. If `out` is given,
  // the first solution is written into it. `rand` randomises digit order.
  function search(grid, limit, out, rand) {
    const g = grid.slice();
    const rowM = new Int32Array(9), colM = new Int32Array(9), boxM = new Int32Array(9);
    for (let i = 0; i < 81; i++) {
      const v = g[i];
      if (!v) continue;
      const bit = 1 << v, r = rowOf(i), c = colOf(i), b = boxOf(i);
      if ((rowM[r] | colM[c] | boxM[b]) & bit) return 0; // invalid givens
      rowM[r] |= bit; colM[c] |= bit; boxM[b] |= bit;
    }
    const empties = [];
    for (let i = 0; i < 81; i++) if (!g[i]) empties.push(i);
    let count = 0;

    function rec() {
      let best = -1, bestMask = 0, bestCount = 10;
      for (let k = 0; k < empties.length; k++) {
        const i = empties[k];
        if (g[i]) continue;
        const m = ALL & ~(rowM[rowOf(i)] | colM[colOf(i)] | boxM[boxOf(i)]);
        const c = POP[m];
        if (c === 0) return;
        if (c < bestCount) { best = i; bestMask = m; bestCount = c; if (c === 1) break; }
      }
      if (best < 0) {
        count++;
        if (out && count === 1) for (let i = 0; i < 81; i++) out[i] = g[i];
        return;
      }
      let digits = DIGITS[bestMask];
      if (rand) digits = shuffle(digits.slice(), rand);
      const r = rowOf(best), c = colOf(best), b = boxOf(best);
      for (const d of digits) {
        const bit = 1 << d;
        g[best] = d; rowM[r] |= bit; colM[c] |= bit; boxM[b] |= bit;
        rec();
        g[best] = 0; rowM[r] &= ~bit; colM[c] &= ~bit; boxM[b] &= ~bit;
        if (count >= limit) return;
      }
    }
    rec();
    return count;
  }

  function countSolutions(grid, limit) { return search(grid, limit || 2, null, null); }
  function solveBrute(grid) {
    const out = new Array(81).fill(0);
    return search(grid, 1, out, null) ? out : null;
  }
  function randomFullGrid(rand) {
    const out = new Array(81).fill(0);
    search(new Array(81).fill(0), 1, out, rand);
    return out;
  }

  // ---------- Logical solver ----------
  function createState(grid) {
    const values = grid.slice();
    const cands = new Array(81).fill(0);
    for (let i = 0; i < 81; i++) {
      if (values[i]) continue;
      let m = ALL;
      for (const p of PEERS[i]) if (values[p]) m &= ~(1 << values[p]);
      cands[i] = m;
    }
    return { values, cands };
  }
  function placeDigit(st, i, d) {
    st.values[i] = d;
    st.cands[i] = 0;
    const nb = ~(1 << d);
    for (const p of PEERS[i]) st.cands[p] &= nb;
  }
  function applyStep(st, step) {
    if (step.place) placeDigit(st, step.place.cell, step.place.digit);
    for (const [c, d] of step.elim) st.cands[c] &= ~(1 << d);
  }
  function isBroken(st) {
    for (let i = 0; i < 81; i++) if (!st.values[i] && !st.cands[i]) return true;
    return false;
  }
  function isSolved(st) {
    for (let i = 0; i < 81; i++) if (!st.values[i]) return false;
    return true;
  }
  function cellsWith(st, unit, d) {
    const bit = 1 << d, res = [];
    for (const i of unit) if (st.cands[i] & bit) res.push(i);
    return res;
  }
  function* combos(arr, n, start = 0, acc = []) {
    if (acc.length === n) { yield acc.slice(); return; }
    for (let k = start; k <= arr.length - (n - acc.length); k++) {
      acc.push(arr[k]);
      yield* combos(arr, n, k + 1, acc);
      acc.pop();
    }
  }
  const digitList = (m) => DIGITS[m].join(', ');

  // --- Level 1: singles ---
  function hiddenSingle(st) {
    // Boxes first: that's how most people scan.
    const order = [...BOXES.map((_, k) => 18 + k), ...ROWS.map((_, k) => k), ...COLS.map((_, k) => 9 + k)];
    for (const u of order) {
      for (let d = 1; d <= 9; d++) {
        const cs = cellsWith(st, UNITS[u], d);
        if (cs.length === 1) {
          return {
            tech: 'Hidden single', level: 1,
            place: { cell: cs[0], digit: d }, elim: [],
            cells: UNITS[u].slice(),
            text: 'This is the only cell in ' + unitName(u) + ' where ' + d + ' can go.',
          };
        }
      }
    }
    return null;
  }
  function nakedSingle(st) {
    for (let i = 0; i < 81; i++) {
      if (!st.values[i] && POP[st.cands[i]] === 1) {
        const d = DIGITS[st.cands[i]][0];
        return {
          tech: 'Naked single', level: 1,
          place: { cell: i, digit: d }, elim: [],
          cells: PEERS[i].filter((p) => st.values[p]),
          text: 'Every other digit already appears in this cell’s row, column or box, so it must be ' + d + '.',
        };
      }
    }
    return null;
  }

  // --- Level 2 ---
  function pointing(st) {
    for (let b = 0; b < 9; b++) {
      for (let d = 1; d <= 9; d++) {
        const cs = cellsWith(st, BOXES[b], d);
        if (cs.length < 2) continue;
        for (const [lineOf, lines, kind] of [[rowOf, ROWS, 'row'], [colOf, COLS, 'column']]) {
          const l = lineOf(cs[0]);
          if (!cs.every((c) => lineOf(c) === l)) continue;
          const elim = [];
          for (const c of lines[l]) if (boxOf(c) !== b && (st.cands[c] & (1 << d))) elim.push([c, d]);
          if (elim.length) {
            return {
              tech: 'Pointing', level: 2, elim, cells: cs,
              text: 'In this box, ' + d + ' can only go in ' + kind + ' ' + (l + 1) + ', so ' + d + ' can be removed from the rest of that ' + kind + '.',
            };
          }
        }
      }
    }
    return null;
  }
  function claiming(st) {
    for (let u = 0; u < 18; u++) {
      for (let d = 1; d <= 9; d++) {
        const cs = cellsWith(st, UNITS[u], d);
        if (cs.length < 2) continue;
        const b = boxOf(cs[0]);
        if (!cs.every((c) => boxOf(c) === b)) continue;
        const elim = [];
        for (const c of BOXES[b]) if (!UNITS[u].includes(c) && (st.cands[c] & (1 << d))) elim.push([c, d]);
        if (elim.length) {
          return {
            tech: 'Claiming', level: 2, elim, cells: cs,
            text: 'In ' + unitName(u) + ', ' + d + ' can only go inside one box, so ' + d + ' can be removed from the rest of that box.',
          };
        }
      }
    }
    return null;
  }
  const SUBSET_NAMES = { 2: 'pair', 3: 'triple' };
  function nakedSubset(n, level) {
    return function (st) {
      for (let u = 0; u < 27; u++) {
        const pool = UNITS[u].filter((i) => !st.values[i] && POP[st.cands[i]] >= 2 && POP[st.cands[i]] <= n);
        if (pool.length < n) continue;
        for (const set of combos(pool, n)) {
          let m = 0;
          for (const i of set) m |= st.cands[i];
          if (POP[m] !== n) continue;
          const elim = [];
          for (const c of UNITS[u]) {
            if (set.includes(c) || st.values[c]) continue;
            for (const d of DIGITS[st.cands[c] & m]) elim.push([c, d]);
          }
          if (elim.length) {
            return {
              tech: 'Naked ' + SUBSET_NAMES[n], level, elim, cells: set,
              text: 'These ' + n + ' cells in ' + unitName(u).replace('this ', 'the ') + ' can only hold ' + digitList(m) + ', so those digits can be removed from the other cells there.',
            };
          }
        }
      }
      return null;
    };
  }
  function hiddenSubset(n, level) {
    return function (st) {
      for (let u = 0; u < 27; u++) {
        const unit = UNITS[u];
        const pos = {};
        const ds = [];
        for (let d = 1; d <= 9; d++) {
          const cs = cellsWith(st, unit, d);
          if (cs.length >= 2 && cs.length <= n) { pos[d] = cs; ds.push(d); }
        }
        if (ds.length < n) continue;
        for (const set of combos(ds, n)) {
          const cells = new Set();
          for (const d of set) for (const c of pos[d]) cells.add(c);
          if (cells.size !== n) continue;
          let keep = 0;
          for (const d of set) keep |= 1 << d;
          const elim = [];
          for (const c of cells) for (const d of DIGITS[st.cands[c] & ~keep]) elim.push([c, d]);
          if (elim.length) {
            return {
              tech: 'Hidden ' + SUBSET_NAMES[n], level, elim, cells: [...cells],
              text: 'In ' + unitName(u).replace('this ', 'the ') + ', ' + set.join(', ') + ' can only go in these ' + n + ' cells, so every other digit can be removed from them.',
            };
          }
        }
      }
      return null;
    };
  }

  // --- Level 3/4: fish ---
  function fish(n, name, level) {
    return function (st) {
      for (let d = 1; d <= 9; d++) {
        for (const [base, cover, baseKind, coverKind, coverIdx] of [
          [ROWS, COLS, 'rows', 'columns', colOf],
          [COLS, ROWS, 'columns', 'rows', rowOf],
        ]) {
          const lines = [];
          for (let l = 0; l < 9; l++) {
            const cs = cellsWith(st, base[l], d);
            if (cs.length >= 2 && cs.length <= n) lines.push({ l, cs, m: cs.reduce((a, c) => a | (1 << coverIdx(c)), 0) });
          }
          if (lines.length < n) continue;
          for (const set of combos(lines, n)) {
            let m = 0;
            for (const x of set) m |= x.m;
            let cnt = 0, mm = m;
            while (mm) { cnt += mm & 1; mm >>= 1; }
            if (cnt !== n) continue;
            const baseLines = new Set(set.map((x) => x.l));
            const elim = [];
            for (let k = 0; k < 9; k++) {
              if (!(m & (1 << k))) continue;
              for (const c of cover[k]) {
                const bl = coverIdx === colOf ? rowOf(c) : colOf(c);
                if (!baseLines.has(bl) && (st.cands[c] & (1 << d))) elim.push([c, d]);
              }
            }
            if (elim.length) {
              const nums = (s) => s.map((x) => x + 1).join(' & ').replace(/ & (?=[^&]*&)/g, ', ');
              const coverLines = [];
              for (let k = 0; k < 9; k++) if (m & (1 << k)) coverLines.push(k);
              return {
                tech: name, level, elim, cells: set.flatMap((x) => x.cs),
                text: 'In ' + baseKind + ' ' + nums([...baseLines]) + ', ' + d + ' is confined to ' + coverKind + ' ' + nums(coverLines) + ', so ' + d + ' can be removed from the rest of those ' + coverKind + '.',
              };
            }
          }
        }
      }
      return null;
    };
  }

  function xyWing(st) {
    const bi = [];
    for (let i = 0; i < 81; i++) if (!st.values[i] && POP[st.cands[i]] === 2) bi.push(i);
    for (const pivot of bi) {
      const pm = st.cands[pivot];
      const wings = bi.filter((w) => w !== pivot && sees(pivot, w) && POP[st.cands[w] & pm] === 1 && st.cands[w] !== pm);
      for (let a = 0; a < wings.length; a++) {
        for (let b = a + 1; b < wings.length; b++) {
          const A = wings[a], B = wings[b];
          const ma = st.cands[A], mb = st.cands[B];
          if ((ma & pm) === (mb & pm)) continue; // must share different pivot digits
          const z = ma & mb & ~pm;
          if (POP[z] !== 1) continue;
          const zd = DIGITS[z][0];
          const elim = [];
          for (const c of PEERS[A]) {
            if (c !== B && c !== pivot && sees(c, B) && (st.cands[c] & z)) elim.push([c, zd]);
          }
          if (elim.length) {
            return {
              tech: 'XY-Wing', level: 4, elim, cells: [pivot, A, B],
              text: 'Whichever value the middle cell (' + digitList(pm) + ') takes, one of the two outer cells must be ' + zd + ', so ' + zd + ' can be removed from cells that see both of them.',
            };
          }
        }
      }
    }
    return null;
  }

  function simpleColouring(st) {
    for (let d = 1; d <= 9; d++) {
      const bit = 1 << d;
      const adj = new Map();
      for (let u = 0; u < 27; u++) {
        const cs = cellsWith(st, UNITS[u], d);
        if (cs.length !== 2) continue;
        for (const [x, y] of [[cs[0], cs[1]], [cs[1], cs[0]]]) {
          if (!adj.has(x)) adj.set(x, new Set());
          adj.get(x).add(y);
        }
      }
      const colour = new Map();
      for (const start of adj.keys()) {
        if (colour.has(start)) continue;
        const groups = [[], []];
        const stack = [start];
        colour.set(start, 0);
        while (stack.length) {
          const x = stack.pop();
          groups[colour.get(x)].push(x);
          for (const y of adj.get(x)) if (!colour.has(y)) { colour.set(y, 1 - colour.get(x)); stack.push(y); }
        }
        if (groups[0].length + groups[1].length < 4) continue;
        // Rule: two cells of the same colour see each other -> that colour is false.
        for (let k = 0; k < 2; k++) {
          const g = groups[k];
          let clash = false;
          for (let a = 0; a < g.length && !clash; a++) for (let b = a + 1; b < g.length; b++) if (sees(g[a], g[b])) { clash = true; break; }
          if (clash) {
            return {
              tech: 'Simple colouring', level: 4, elim: g.map((c) => [c, d]), cells: [...groups[0], ...groups[1]],
              text: 'Following the chain of cells where ' + d + ' has only two spots, one colour group sees itself, so ' + d + ' can be removed from every cell in that group.',
            };
          }
        }
        // Rule: a cell seeing both colours can't be d.
        const elim = [];
        for (let c = 0; c < 81; c++) {
          if (!(st.cands[c] & bit) || colour.has(c) && (groups[0].includes(c) || groups[1].includes(c))) continue;
          if (groups[0].some((x) => sees(x, c)) && groups[1].some((x) => sees(x, c))) elim.push([c, d]);
        }
        if (elim.length) {
          return {
            tech: 'Simple colouring', level: 4, elim, cells: [...groups[0], ...groups[1]],
            text: 'Following the chain of cells where ' + d + ' has only two spots, one of the two colour groups must hold ' + d + '. Cells that see both groups can’t be ' + d + '.',
          };
        }
      }
    }
    return null;
  }

  const TECHNIQUES = [
    { fn: hiddenSingle, level: 1 },
    { fn: nakedSingle, level: 1 },
    { fn: pointing, level: 2 },
    { fn: claiming, level: 2 },
    { fn: nakedSubset(2, 2), level: 2 },
    { fn: hiddenSubset(2, 2), level: 2 },
    { fn: nakedSubset(3, 3), level: 3 },
    { fn: hiddenSubset(3, 3), level: 3 },
    { fn: fish(2, 'X-Wing', 3), level: 3 },
    { fn: fish(3, 'Swordfish', 4), level: 4 },
    { fn: xyWing, level: 4 },
    { fn: simpleColouring, level: 4 },
  ];

  function nextStep(st, maxLevel) {
    for (const t of TECHNIQUES) {
      if (t.level > maxLevel) break;
      const s = t.fn(st);
      if (s) return s;
    }
    return null;
  }

  // Solve using only logic up to maxLevel. Returns {solved, level, used}.
  function solveLogically(grid, maxLevel) {
    const st = createState(grid);
    let level = 0;
    const used = {};
    for (;;) {
      if (isSolved(st)) return { solved: true, level, used };
      if (isBroken(st)) return { solved: false, level, used };
      const s = nextStep(st, maxLevel === undefined ? 4 : maxLevel);
      if (!s) return { solved: false, level, used };
      applyStep(st, s);
      if (s.level > level) level = s.level;
      used[s.tech] = (used[s.tech] || 0) + 1;
    }
  }

  // ---------- Generator ----------
  const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
  const LEVEL = { easy: 1, medium: 2, hard: 3, expert: 4 };
  const MIN_CLUES = { easy: 32, medium: 27, hard: 23, expert: 22 };
  const SYMMETRY_ONLY = { easy: true, medium: false, hard: false, expert: false };

  // One attempt: carve a full grid down (with 180° symmetry) while the puzzle
  // stays unique and solvable by logic up to the target level.
  function carve(target, rand) {
    const solution = randomFullGrid(rand);
    const puzzle = solution.slice();
    const maxLevel = LEVEL[target];
    let clues = 81;
    const tryRemove = (cells) => {
      if (clues - cells.length < MIN_CLUES[target]) return;
      const saved = cells.map((c) => puzzle[c]);
      for (const c of cells) puzzle[c] = 0;
      if (countSolutions(puzzle, 2) === 1 && solveLogically(puzzle, maxLevel).solved) clues -= cells.length;
      else cells.forEach((c, k) => { puzzle[c] = saved[k]; });
    };
    // Pass 1: symmetric pairs (looks tidy). Pass 2: single cells, to dig deeper.
    for (const i of shuffle(Array.from({ length: 41 }, (_, i) => i), rand)) tryRemove(i === 40 ? [40] : [i, 80 - i]);
    if (SYMMETRY_ONLY[target] !== true) {
      for (const i of shuffle(Array.from({ length: 81 }, (_, i) => i), rand)) if (puzzle[i]) tryRemove([i]);
    }
    const grade = solveLogically(puzzle, 4);
    return { puzzle, solution, level: grade.level, used: grade.used, clues };
  }

  function generate(difficulty, opts) {
    opts = opts || {};
    const rand = opts.seed !== undefined ? mulberry32(opts.seed) : Math.random;
    const target = LEVEL[difficulty];
    const maxAttempts = opts.maxAttempts || 3000;
    let best = null;
    for (let a = 1; a <= maxAttempts; a++) {
      const r = carve(difficulty, rand);
      r.attempts = a;
      if (r.level === target) return finish(r, difficulty);
      if (!best || r.level > best.level) best = r;
    }
    return finish(best, difficulty); // extremely unlikely fallback
  }
  function finish(r, difficulty) {
    return { difficulty, puzzle: r.puzzle, solution: r.solution, level: r.level, clues: r.clues, used: r.used, attempts: r.attempts };
  }

  // ---------- Hints ----------
  // values: current board (givens + player entries, 0 = empty).
  // Returns {kind:'wrong', cell} | {kind:'steps', steps:[...]} | {kind:'reveal', cell, digit} | null
  function findHint(values, solution) {
    for (let i = 0; i < 81; i++) if (values[i] && values[i] !== solution[i]) return { kind: 'wrong', cell: i };
    const st = createState(values);
    if (isSolved(st)) return null;
    const steps = [];
    for (let guard = 0; guard < 60; guard++) {
      const s = nextStep(st, 4);
      if (!s) break;
      steps.push(s);
      if (s.place) return { kind: 'steps', steps };
      applyStep(st, s);
    }
    // Fallback: reveal the empty cell with the fewest candidates.
    let best = -1, bc = 10;
    for (let i = 0; i < 81; i++) if (!values[i] && POP[st.cands[i]] < bc) { bc = POP[st.cands[i]]; best = i; }
    return best < 0 ? null : { kind: 'reveal', cell: best, digit: solution[best] };
  }

  function candidatesFor(values, i) {
    if (values[i]) return 0;
    let m = ALL;
    for (const p of PEERS[i]) if (values[p]) m &= ~(1 << values[p]);
    return m;
  }

  const api = {
    ALL, UNITS, ROWS, COLS, BOXES, PEERS, DIGITS, POP,
    rowOf, colOf, boxOf, cellName, unitKind,
    countSolutions, solveBrute, randomFullGrid, solveLogically,
    generate, findHint, candidatesFor, DIFFICULTIES, LEVEL, mulberry32,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SudokuEngine = api;
})(typeof self !== 'undefined' ? self : this);
