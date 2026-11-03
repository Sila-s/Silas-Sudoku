// Node test runner for the engine: `node tests/engine.test.js [countPerDifficulty]`
'use strict';
const E = require('../js/engine.js');

const N = Number(process.argv[2]) || 20;
let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL', msg); };

function validSolution(sol, puzzle) {
  for (const u of E.UNITS) {
    const s = new Set(u.map((i) => sol[i]));
    if (s.size !== 9 || s.has(0)) return false;
  }
  for (let i = 0; i < 81; i++) if (puzzle[i] && puzzle[i] !== sol[i]) return false;
  return true;
}

// Known puzzle sanity checks
const known = '530070000600195000098000060800060003400803001700020006060000280000419005000080079';
const kg = known.split('').map(Number);
if (E.countSolutions(kg, 2) !== 1) fail('known puzzle should be unique');
if (!E.solveLogically(kg, 4).solved) fail('known puzzle should solve logically');
const multi = kg.slice(); multi[0] = 0; multi[1] = 0; multi[4] = 0; multi[9] = 0;
// may or may not stay unique; check a definitely-multiple one:
if (E.countSolutions(new Array(81).fill(0), 2) !== 2) fail('empty grid should have multiple solutions');

for (const diff of E.DIFFICULTIES) {
  const times = [], clues = [], attempts = [];
  const techs = {};
  for (let k = 0; k < N; k++) {
    const t0 = Date.now();
    const p = E.generate(diff);
    times.push(Date.now() - t0);
    clues.push(p.clues);
    attempts.push(p.attempts);
    for (const t of Object.keys(p.used)) techs[t] = (techs[t] || 0) + 1;
    const sols = E.countSolutions(p.puzzle, 2);
    if (sols !== 1) fail(`${diff} #${k}: ${sols} solutions`);
    if (!validSolution(p.solution, p.puzzle)) fail(`${diff} #${k}: invalid solution`);
    const brute = E.solveBrute(p.puzzle);
    if (brute.join('') !== p.solution.join('')) fail(`${diff} #${k}: stored solution differs from brute force`);
    const lg = E.solveLogically(p.puzzle, 4);
    if (!lg.solved) fail(`${diff} #${k}: not solvable by logic`);
    if (lg.level !== E.LEVEL[diff]) fail(`${diff} #${k}: graded level ${lg.level}, wanted ${E.LEVEL[diff]}`);
    // Hints walk the puzzle to completion
    const vals = p.puzzle.slice();
    for (let guard = 0; guard < 81; guard++) {
      const h = E.findHint(vals, p.solution);
      if (!h) break;
      if (h.kind === 'wrong') { fail(`${diff} #${k}: hint flagged a correct cell`); break; }
      const pl = h.kind === 'steps' ? h.steps[h.steps.length - 1].place : h;
      if (h.kind === 'reveal') fail(`${diff} #${k}: hint needed to reveal`);
      if (p.solution[pl.cell] !== pl.digit) { fail(`${diff} #${k}: hint placed wrong digit`); break; }
      vals[pl.cell] = pl.digit;
    }
    if (vals.join('') !== p.solution.join('')) fail(`${diff} #${k}: hints did not finish the puzzle`);
  }
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(0);
  console.log(`${diff.padEnd(7)} n=${N} time avg ${avg(times)}ms max ${Math.max(...times)}ms | clues ${Math.min(...clues)}-${Math.max(...clues)} | attempts avg ${avg(attempts)} max ${Math.max(...attempts)}`);
  console.log('         techniques:', JSON.stringify(techs));
}

// Wrong-entry hint
const p = E.generate('easy', { seed: 7 });
const v = p.puzzle.slice();
const e = v.indexOf(0);
v[e] = (p.solution[e] % 9) + 1;
const h = E.findHint(v, p.solution);
if (!h || h.kind !== 'wrong' || h.cell !== e) fail('wrong entry not flagged by hint');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TESTS PASSED');
process.exit(failures ? 1 : 0);
