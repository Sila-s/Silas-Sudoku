// Appearance: applied in <head> before the page paints, so there's no flash
// of the wrong theme on launch. app.js calls SudokuLook.apply() on changes.
(function () {
  'use strict';
  var ACCENTS = {
    blue:     { name: 'Blue',     light: '#2f62c9', dark: '#79a0ff' },
    green:    { name: 'Green',    light: '#2b8150', dark: '#5cc98c' },
    purple:   { name: 'Purple',   light: '#6a4fc4', dark: '#a892ff' },
    orange:   { name: 'Orange',   light: '#c4621a', dark: '#f4a259' },
    rose:     { name: 'Rose',     light: '#c23b69', dark: '#f27ea6' },
    graphite: { name: 'Graphite', light: '#4a5260', dark: '#b9c0cc' },
  };
  var FONTS = {
    system:  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif',
    rounded: 'ui-rounded, "SF Pro Rounded", -apple-system, system-ui, sans-serif',
    serif:   'ui-serif, "New York", Georgia, "Times New Roman", serif',
    mono:    'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  };
  var SIZES = { s: 0.86, m: 1, l: 1.14 };
  var LINES = { light: 1, standard: 2, bold: 3 };
  var DEFAULTS = {
    theme: 'light', accent: 'blue', numSize: 'm', numFont: 'system', gridLines: 'standard',
    showTimer: true, showMistakes: true, showCounts: true,
    animations: !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches),
    sounds: false,
  };
  var darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;

  function resolveTheme(t) {
    if (t === 'auto') return darkQuery && darkQuery.matches ? 'dark' : 'light';
    return t === 'paper' || t === 'dark' ? t : 'light';
  }

  function apply(s) {
    var root = document.documentElement;
    var theme = resolveTheme(s.theme);
    var a = ACCENTS[s.accent] || ACCENTS.blue;
    root.dataset.theme = theme;
    root.style.setProperty('--accent', theme === 'dark' ? a.dark : a.light);
    root.style.setProperty('--num-font', FONTS[s.numFont] || FONTS.system);
    root.style.setProperty('--num-scale', SIZES[s.numSize] || 1);
    root.style.setProperty('--box-gap', (LINES[s.gridLines] || 2) + 'px');
    root.classList.toggle('lines-light', s.gridLines === 'light');
    root.classList.toggle('hide-counts', !s.showCounts);
    root.classList.toggle('no-anim', !s.animations);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#111214' : theme === 'paper' ? '#f3eee3' : '#f6f6f4');
  }

  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('sudoku.settings.v1') || '{}') || {}; } catch (e) { /* ignore */ }
  var current = {};
  for (var k in DEFAULTS) current[k] = k in saved ? saved[k] : DEFAULTS[k];
  apply(current);

  window.SudokuLook = {
    ACCENTS: ACCENTS, DEFAULTS: DEFAULTS, apply: apply, resolveTheme: resolveTheme,
    onSystemThemeChange: function (fn) {
      if (!darkQuery) return;
      if (darkQuery.addEventListener) darkQuery.addEventListener('change', fn);
      else if (darkQuery.addListener) darkQuery.addListener(fn);
    },
  };
})();
