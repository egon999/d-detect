const P = (c) => {
  c = c.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  throw new Error(c);
};
const L = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const C = (a, b) => { const [h, l] = [L(P(a)), L(P(b))].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
const over = (ff, b) => {
  const [r, g, bl, a] = P(ff); const [br, bg, bb] = P(b);
  const m = (t, o) => Math.round(t * a + o * (1 - a));
  return 'rgb(' + m(r, br) + ', ' + m(g, bg) + ', ' + m(bl, bb) + ')';
};
const hs = (c) => {
  const [R, G, B] = P(c).slice(0, 3).map((v) => v / 255);
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  let h = 0;
  if (d) { if (mx === R) h = ((G - B) / d) % 6; else if (mx === G) h = (B - R) / d + 2; else h = (R - G) / d + 4; h = (h * 60 + 360) % 360; }
  const l = (mx + mn) / 2;
  return { h: +h.toFixed(1), s: +(d ? (d / (1 - Math.abs(2 * l - 1))) * 100 : 0).toFixed(1), l: +(l * 100).toFixed(1) };
};
const hd = (a, b) => { const r = Math.abs(hs(a).h - hs(b).h); return Math.min(r, 360 - r); };
const f = (n) => n.toFixed(2);
let fails = 0;
const ck = (ok, msg) => { if (!ok) { fails += 1; console.log('  ** FAIL ' + msg); } };

const royal = { r990: '#040814', r950: '#070D21', r900: '#0A1530', r880: '#0E1D44', r850: '#112349', r800: '#13285D', r750: '#1A3270', r700: '#22376F', r650: '#294489', r600: '#3153A6', r500: '#3D6AC9', r400: '#3D7BFF', r300: '#7CA9FF' };
console.log('### royal ramp monotonic ###');
const rk = Object.keys(royal);
for (let i = 1; i < rk.length; i += 1) ck(L(P(royal[rk[i]])) > L(P(royal[rk[i - 1]])), rk[i - 1] + ' -> ' + rk[i] + ' not increasing');
for (const k of rk) console.log('  ' + k, royal[k], 'Lum=' + f(L(P(royal[k])) * 100));

const S = { sunken: royal.r990, canvas: royal.r950, surface: royal.r880, raised: royal.r800 };
console.log('\n### surface ladder ###');
const se = Object.entries(S);
for (let i = 1; i < se.length; i += 1) console.log('  ' + se[i - 1][0] + ' -> ' + se[i][0] + '  ratio ' + f(C(se[i - 1][1], se[i][1])));
console.log('  canvas -> raised total ' + f(C(S.canvas, S.raised)));

const TEXT = { text: '#EEF3FF', textSecondary: '#AFC0E0', textTertiary: '#8394B8', textAccent: '#D4C491' };
console.log('\n### text ranks (AA 4.5 on all four) ###');
for (const [n, v] of Object.entries(TEXT)) {
  console.log('  ' + n.padEnd(14), Object.entries(S).map(([sn, sv]) => sn + ':' + f(C(v, sv))).join(' '));
  for (const sv of Object.values(S)) ck(C(v, sv) >= 4.5, n + ' on ' + sv + ' = ' + f(C(v, sv)));
}
for (const d of ['#66748F', '#6B7A96', '#70809C', '#62708A']) {
  console.log('  disabled cand ' + d, Object.entries(S).map(([sn, sv]) => sn + ':' + f(C(d, sv))).join(' '));
}

const tones = {
  neutral: { fg: '#A3ADC2', bg: 'rgba(163, 173, 194, 0.10)', border: 'rgba(163, 173, 194, 0.20)', solid: '#5B6B8C' },
  accent: { fg: royal.r300, bg: 'rgba(61, 123, 255, 0.15)', border: 'rgba(61, 123, 255, 0.32)', solid: '#2B5FD9' },
  danger: { fg: '#FF8A8A', bg: 'rgba(248, 113, 113, 0.14)', border: 'rgba(248, 113, 113, 0.30)', solid: '#C22B2B' },
  warn: { fg: '#FACC33', bg: 'rgba(240, 160, 20, 0.16)', border: 'rgba(240, 160, 20, 0.34)', solid: '#9A6B0C' },
  ok: { fg: '#4ADB86', bg: 'rgba(74, 219, 134, 0.14)', border: 'rgba(74, 219, 134, 0.30)', solid: '#0A7A3A' },
  info: { fg: '#40C0D2', bg: 'rgba(64, 192, 210, 0.14)', border: 'rgba(64, 192, 210, 0.30)', solid: '#0B5A6E' },
  ai: { fg: '#C4A6FF', bg: 'rgba(168, 120, 255, 0.14)', border: 'rgba(168, 120, 255, 0.30)', solid: '#7C3AED' },
};
console.log('\n### tones ###');
for (const [n, t] of Object.entries(tones)) {
  const mins = []; const minsBg = [];
  for (const sv of Object.values(S)) { mins.push(C(t.fg, sv)); minsBg.push(C(t.fg, over(t.bg, sv))); }
  console.log('  ' + n.padEnd(8), 'fg/surf min ' + f(Math.min(...mins)), 'fg/bg min ' + f(Math.min(...minsBg)), 'solid/white ' + f(C(t.solid, '#FFFFFF')), JSON.stringify(hs(t.fg)));
  ck(Math.min(...mins) >= 4.5, n + ' fg on surfaces');
  ck(Math.min(...minsBg) >= 4.5, n + ' fg on own bg');
  ck(C(t.solid, '#FFFFFF') >= 4.5, n + ' solid vs white');
  for (const sv of Object.values(S)) ck(C(over(t.border, sv), sv) >= 1.05, n + ' border on ' + sv);
}
console.log('\n### pairwise all 21 ###');
const names = Object.keys(tones);
for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
  const a = names[i]; const b = names[j];
  const d = hd(tones[a].fg, tones[b].fg); const sg = Math.abs(hs(tones[a].fg).s - hs(tones[b].fg).s);
  ck(d >= 30 || sg >= 50, a + ' vs ' + b + ': hue ' + f(d) + ' satgap ' + f(sg));
}
console.log('### semantic pairs ###');
const sem = ['danger', 'warn', 'ok', 'info', 'ai'];
for (let i = 0; i < sem.length; i += 1) for (let j = i + 1; j < sem.length; j += 1) {
  const a = sem[i]; const b = sem[j];
  const d = hd(tones[a].fg, tones[b].fg); const lr = C(tones[a].fg, tones[b].fg);
  console.log(('  ' + a + ' vs ' + b).padEnd(22), 'hue ' + f(d), 'lum ' + f(lr));
  ck(d >= 40, a + ' vs ' + b + ' hue only ' + f(d));
}
for (const [a, b] of [['danger', 'warn'], ['ok', 'info']]) {
  const lr = C(tones[a].fg, tones[b].fg);
  ck(lr >= 1.2, a + '/' + b + ' lum ' + f(lr));
}

const gold = { g300: '#D4C491', g500: '#BEA860', g600: '#96844A' };
console.log('\n### gold ###');
for (const [n, v] of Object.entries(gold)) console.log('  ' + n, v, 'min ' + f(Math.min(...Object.values(S).map((sv) => C(v, sv)))), JSON.stringify(hs(v)));
ck(Math.min(...Object.values(S).map((sv) => C(gold.g500, sv))) >= 4.5, 'accent text-safe');
ck(Math.min(...Object.values(S).map((sv) => C(gold.g600, sv))) >= 3, 'accentPressed non-text');
ck(Math.min(...Object.values(S).map((sv) => C(gold.g300, sv))) >= 4.5, 'textAccent/focusRing text-safe');
ck(hd(gold.g500, tones.warn.fg) < 10, 'gold within 10deg of warn');
ck(hs(tones.warn.fg).s - hs(gold.g500).s >= 50, 'gold/warn satgap ' + f(hs(tones.warn.fg).s - hs(gold.g500).s));
ck(C('#FFFFFF', gold.g500) < 4.5, 'white on gold must fail');
ck(C(royal.r990, gold.g500) >= 4.5, 'onAccent on gold');
ck(hd(gold.g500, tones.accent.fg) > 90, 'tones.accent stays blue');
ck(hd(tones.info.fg, tones.accent.fg) >= 30, 'info vs accent ' + f(hd(tones.info.fg, tones.accent.fg)));
console.log('  info vs accent hue ' + f(hd(tones.info.fg, tones.accent.fg)));
ck(C('#FFFFFF', '#2B5FD9') >= 4.5, 'white on cta');

console.log('\n### paper ###');
const paper = { fill: 'rgba(228, 214, 182, 0.055)', border: 'rgba(228, 214, 182, 0.15)', text: '#E2D8C2', meta: '#A89C81' };
const ground = over(paper.fill, S.canvas);
console.log('  ground ' + ground, 'text ' + f(C(paper.text, ground)), 'meta ' + f(C(paper.meta, ground)));
ck(C(paper.text, ground) >= 4.5, 'paper text');
ck(C(paper.meta, ground) >= 4.5, 'paper meta');
for (const t of [paper.fill, paper.border, paper.text]) {
  ck(hs(t).h > 20 && hs(t).h < 70, 'paper hue ' + hs(t).h);
  ck(hd(t, S.canvas) > 140, 'paper vs canvas ' + f(hd(t, S.canvas)));
}
ck(hd(paper.text, TEXT.text) > 140, 'paper text vs app text');

console.log('\n### glass ###');
const rr = P(S.raised); const r850 = P(royal.r850);
const glass = {
  highlight: 'rgba(196, 218, 255, 0.34)', border: 'rgba(150, 178, 232, 0.17)', innerBorder: 'rgba(168, 198, 255, 0.07)',
  fill: 'rgba(' + rr[0] + ', ' + rr[1] + ', ' + rr[2] + ', 0.62)',
  fillStrong: 'rgba(' + r850[0] + ', ' + r850[1] + ', ' + r850[2] + ', 0.88)',
  chromeFill: 'rgba(14, 30, 72, 0.64)',
};
console.log('  fill ' + glass.fill + '   fillStrong ' + glass.fillStrong);
for (const l of [glass.highlight, glass.border, glass.innerBorder]) ck(C(over(l, S.surface), S.surface) < 3, 'glass layer too strong ' + l);
const panel = over(glass.fill, S.canvas);
console.log('  panel over canvas ' + panel);
for (const [n, v] of Object.entries(TEXT)) {
  if (n === 'textAccent') continue;
  console.log('    ' + n + ' ' + f(C(v, panel)));
  ck(C(v, panel) >= 4.5, n + ' on glass panel');
}
const chrome = over(glass.chromeFill, S.canvas);
for (const [n, v] of Object.entries(TEXT)) if (n !== 'textAccent') ck(C(v, chrome) >= 4.5, n + ' on chrome fill ' + f(C(v, chrome)));

console.log('\n### barFill = canvas + 0.20 wash ###');
console.log('  ' + over('rgba(63, 104, 199, 0.20)', S.canvas));

console.log('\n### track / press overlays ###');
for (const t of ['rgba(150, 178, 232, 0.16)', 'rgba(150, 178, 232, 0.20)']) console.log('  track ' + t, Object.entries(S).map(([n, v]) => n + ':' + f(C(over(t, v), v))).join(' '));
for (const t of ['rgba(168, 198, 255, 0.09)', 'rgba(168, 198, 255, 0.14)']) console.log('  press ' + t, Object.entries(S).map(([n, v]) => n + ':' + f(C(over(t, v), v))).join(' '));
for (const t of ['rgba(150, 178, 232, 0.10)', 'rgba(150, 178, 232, 0.16)', 'rgba(160, 188, 240, 0.30)']) console.log('  border ' + t, Object.entries(S).map(([n, v]) => n + ':' + f(C(over(t, v), v))).join(' '));

console.log(fails === 0 ? '\nALL CHECKS PASS' : '\n' + fails + ' FAILURES');

console.log('\n### solid fills: hue separation + white AA ###');
const solids = { neutral: '#5B6B8C', accent: '#2B5FD9', danger: '#C22B2B', warn: '#9A6B0C', ok: '#0A7A3A', info: '#0B5A6E', ai: '#7C3AED' };
for (const [n, v] of Object.entries(solids)) console.log('  ' + n.padEnd(8), v, JSON.stringify(hs(v)), 'white ' + f(C(v, '#FFFFFF')));
for (const c of ['#A0730E', '#9A6B0C', '#A87410', '#AD7A12', '#B07C14']) console.log('  warn-solid cand ' + c, JSON.stringify(hs(c)), 'white ' + f(C(c, '#FFFFFF')));
const semSolid = ['danger', 'warn', 'ok', 'info', 'ai'];
for (let i = 0; i < semSolid.length; i += 1) for (let j = i + 1; j < semSolid.length; j += 1) {
  const d = hd(solids[semSolid[i]], solids[semSolid[j]]);
  if (d < 40) console.log('  TIGHT solid pair ' + semSolid[i] + '/' + semSolid[j] + ' ' + f(d));
}
console.log('\n### ok-solid candidates (hue ~146-150, white AA) ###');
for (const c of ['#0A7A3A', '#097541', '#0B7A44', '#08703E', '#0C7D40', '#0A7540']) console.log('  ' + c, JSON.stringify(hs(c)), 'white ' + f(C(c, '#FFFFFF')));
