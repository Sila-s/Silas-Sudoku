// Generates puzzles off the main thread so the UI never freezes.
importScripts('engine.js');

self.onmessage = (e) => {
  const { id, difficulty } = e.data;
  const p = self.SudokuEngine.generate(difficulty);
  self.postMessage({ id, difficulty, puzzle: p.puzzle, solution: p.solution, level: p.level });
};
