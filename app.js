(() => {
'use strict';
const $ = s => document.querySelector(s);
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const mix = (a, b, t) => a + (b - a) * t;
// Keep interactive work small enough for phones, while exports can still use
// a larger source image when the device has enough memory.
const isSmallScreen = window.matchMedia('(max-width: 650px)').matches;
const PREVIEW_MAX = isSmallScreen ? 900 : 1400;
const EXPORT_MAX = isSmallScreen ? 2400 : 3600;

const DEFAULTS = {levels:0, cast:0, shadows:0, brightness:0, contrast:0, saturation:0, warmth:0, dust:0, denoise:0, sharpen:0, colorize:100, tone:'color'};
const CONTROLS = [
  ['Restore', [
    ['levels','Fix faded tones',0,100,'Stretches washed-out shadows and highlights'],
    ['cast','Remove colour cast',0,100,'Neutralises yellow, green or red tints']]],
  ['Light', [
    ['brightness','Brightness',-100,100],
    ['shadows','Lift dark areas',-100,100,'Opens up shadows without blowing out highlights'],
    ['contrast','Contrast',-100,100]]],
  ['Colour', [
    ['saturation','Colour richness',-100,100],
    ['warmth','Warmth',-100,100],
    ['colorize','Colour recovery (old photos)',0,100,'Brings back natural colours in old black & white or sepia photos']]],
  ['Clean up', [
    ['dust','Dust and scratches',0,100,'Removes thin scratches and small specks'],
    ['denoise','Grain and noise',0,100],
    ['sharpen','Sharpness',0,100]]]
];
const PRESETS = {
  'Auto restore': {levels:85,cast:70,contrast:10,saturation:10,dust:35,denoise:20,sharpen:25},
  'Brighten dark photo': {levels:60,cast:50,shadows:55,brightness:15,contrast:10,denoise:35,sharpen:20},
  'Revive faded colours': {levels:100,cast:90,contrast:20,saturation:30,sharpen:25},
  'Clean scratches': {levels:40,cast:30,dust:75,denoise:30,sharpen:15}
};

const state = {img:null, name:'sample', src:null, stats:null, p:{...DEFAULTS}, colorCanvas:null, colorRef:null};
const el = {frame:$('#frame'), before:$('#before'), after:$('#after'), drop:$('#drop'), hint:$('#hint'), handle:$('#handle')};
const inputs = {};

/* ---------- UI build ---------- */
const sl = $('#sliders');
CONTROLS.forEach(([title, items]) => {
  const box = document.createElement('div'); box.className = 'sl';
  box.innerHTML = `<h3>${title}</h3>`;
  items.forEach(([key, label, min, max, tip]) => {
    const row = document.createElement('div'); row.className = 'sl';
    row.innerHTML = `<label for="s-${key}">${label}<output id="o-${key}">0</output></label>
      <input type="range" id="s-${key}" min="${min}" max="${max}" value="0">${tip ? `<small>${tip}</small>` : ''}`;
    box.appendChild(row);
    const inp = row.querySelector('input'); inputs[key] = inp;
    inp.addEventListener('input', () => { state.p[key] = +inp.value; sync(); schedule(); });
  });
  sl.appendChild(box);
});
const settings = $('#settings'), settingsToggle = $('#settingsToggle');
settingsToggle.addEventListener('click', () => {
  const open = settingsToggle.getAttribute('aria-expanded') === 'true';
  settingsToggle.setAttribute('aria-expanded', String(!open));
  settings.classList.toggle('closed', open);
});
const chips = $('#chips');
Object.keys(PRESETS).forEach(name => {
  const b = document.createElement('button'); b.textContent = name;
  b.onclick = () => { if (!state.img) return toast('Upload a photo or try the sample first.'); applyParams(presetParams(name)); };
  chips.appendChild(b);
});
document.querySelectorAll('#tone button').forEach(b => b.onclick = () => { state.p.tone = b.dataset.t; sync(); schedule(); });
const sessionFilters = {
  original: () => ({...DEFAULTS, tone:'color'}),
  restored: () => presetParams('Auto restore'),
  colorize: () => ({...presetParams('Auto restore'), saturation:25, warmth:10, colorize:100, tone:'colorize'}),
  clean: () => presetParams('Clean scratches')
};
document.querySelectorAll('[data-filter]').forEach(card => card.addEventListener('click', () => {
  document.querySelectorAll('[data-filter]').forEach(x => x.classList.remove('selected'));
  card.classList.add('selected');
  if (!state.img) return toast('Upload a photo or try the sample first.');
  applyParams(sessionFilters[card.dataset.filter]());
}));

function sync() {
  for (const k in inputs) { inputs[k].value = state.p[k]; $('#o-' + k).textContent = state.p[k]; }
  document.querySelectorAll('#tone button').forEach(b => b.setAttribute('aria-pressed', b.dataset.t === state.p.tone));
  const fix = $('#fixFaded');
  if (fix) fix.checked = state.p.levels > 0 || state.p.cast > 0;
  const note = $('#toneNote');
  if (note) {
    if (state.stats && state.stats.old && state.p.tone === 'colorize') {
      note.textContent = 'Old photo detected. AI is restoring natural colours.';
    } else if (state.stats && state.stats.old) {
      note.textContent = 'Old photo detected. Choose Restore colour to bring the colours back.';
    } else {
      note.textContent = 'Colour mode applies to the restored photo.';
    }
  }
}
function applyParams(p) { state.p = {...p}; sync(); schedule(); }
function presetParams(name) {
  const old = !!(state.stats && state.stats.old);
  return {...DEFAULTS, ...PRESETS[name], colorize:100, tone: old ? 'colorize' : 'color'};
}
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3600); }

/* ---------- AI colouriser (local DDColor server) ---------- */
const AI_ENDPOINT = location.protocol === 'file:' ? 'http://127.0.0.1:8765/colorize' : '/colorize';
let loadToken = 0;
function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The AI returned an unreadable image.')); };
    img.src = url;
  });
}
async function aiColorize(blob) {
  const res = await fetch(AI_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob
  });
  if (!res.ok) {
    let msg = 'AI server returned ' + res.status;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (_) {}
    throw new Error(msg);
  }
  return imageFromBlob(await res.blob());
}

const fixFaded = $('#fixFaded');
fixFaded.addEventListener('change', () => {
  state.p.levels = fixFaded.checked ? 85 : 0;
  state.p.cast = fixFaded.checked ? 70 : 0;
  if (fixFaded.checked && state.stats && state.stats.old) state.p.tone = 'colorize';
  sync(); schedule();
});

/* ---------- Loading ---------- */
function setButtons(on) { ['#save','#reset'].forEach(s => $(s).disabled = !on); }

function loadURL(url, name, done, colorCanvas, sourceBlob) {
  const token = ++loadToken;
  const img = new Image();
  const isObjectURL = url.startsWith('blob:');
  img.onload = () => {
    if (isObjectURL) URL.revokeObjectURL(url);
    state.img = img; state.name = name; state.colorRef = null; state.colorCanvas = colorCanvas || null;
    const s = Math.min(1, PREVIEW_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
    [el.before, el.after].forEach(c => { c.width = w; c.height = h; });
    const ctx = el.before.getContext('2d', {willReadFrequently:true});
    ctx.drawImage(img, 0, 0, w, h);
    state.src = ctx.getImageData(0, 0, w, h);
    state.stats = analyze(state.src);
    el.frame.style.aspectRatio = `${w} / ${h}`;
    el.frame.style.width = `min(100%, calc(66vh * ${w / h}))`;
    el.drop.hidden = true; el.frame.hidden = false; el.hint.hidden = false;
    setPos(50); setButtons(true);
    applyParams(presetParams('Auto restore'));
    document.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('selected', x.dataset.filter === 'restored'));
    if (done) done();
    if (state.stats.old && sourceBlob) {
      toast('Old photo detected. AI is restoring the colours - this takes a few seconds...');
      aiColorize(sourceBlob).then(aiImg => {
        if (token !== loadToken) return;
        state.colorCanvas = aiImg;
        state.colorRef = null;
        if (state.p.tone !== 'colorize') state.p.tone = 'colorize';
        sync(); schedule();
        toast('AI restored the colours. Drag the divider to compare.');
      }).catch(err => {
        if (token !== loadToken) return;
        console.warn('AI colouriser unavailable:', err.message);
        toast('AI colouriser offline - using a quick colour estimate. Run start.bat for full AI restore.');
      });
    } else if (state.stats.old) {
      toast('Old photo detected - natural colours restored.');
    } else {
      toast('Photo loaded. Auto restore applied.');
    }
  };
  img.onerror = () => {
    if (isObjectURL) URL.revokeObjectURL(url);
    toast('That file could not be read as an image. Try a JPG, PNG or WebP.');
  };
  img.src = url;
}

function loadSample() {
  loadURL(makeSample(), 'sample', null, sampleColorCanvas);
}
function loadFile(f) {
  if (!f) return;
  if (!f.type.startsWith('image/')) return toast('Please choose an image file (JPG, PNG or WebP).');
  loadURL(URL.createObjectURL(f), f.name.replace(/\.[^.]+$/, ''), null, null, f);
}

$('#file').addEventListener('change', e => { loadFile(e.target.files[0]); e.target.value = ''; });
['dragenter','dragover'].forEach(ev => el.drop.addEventListener(ev, e => { e.preventDefault(); el.drop.classList.add('over'); }));
['dragleave','drop'].forEach(ev => el.drop.addEventListener(ev, e => { e.preventDefault(); el.drop.classList.remove('over'); }));
el.drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); if (!el.drop.contains(e.target)) loadFile(e.dataTransfer.files[0]); });
$('#sample').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); loadSample(); });
$('#uploadMain').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); $('#file').click(); });
$('#again').onclick = () => $('#file').click();
$('#reset').onclick = () => applyParams({...DEFAULTS, tone: state.stats && state.stats.old ? 'colorize' : 'color', colorize:100});

/* ---------- Compare slider ---------- */
let pos = 50;
function setPos(v) {
  pos = Math.min(100, Math.max(0, v));
  el.before.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
  el.handle.style.left = pos + '%';
  el.handle.setAttribute('aria-valuenow', Math.round(pos));
}
let dragging = false;
const move = e => { const r = el.frame.getBoundingClientRect(); setPos((e.clientX - r.left) / r.width * 100); };
el.frame.addEventListener('pointerdown', e => { dragging = true; el.frame.setPointerCapture(e.pointerId); move(e); });
el.frame.addEventListener('pointermove', e => dragging && move(e));
el.frame.addEventListener('pointerup', () => dragging = false);
el.frame.addEventListener('pointercancel', () => dragging = false);
el.handle.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') { setPos(pos - 3); e.preventDefault(); }
  if (e.key === 'ArrowRight') { setPos(pos + 3); e.preventDefault(); }
  if (e.key === 'Home') setPos(0); if (e.key === 'End') setPos(100);
});

/* ---------- Rendering ---------- */
let queued = false;
function schedule() {
  if (!state.src || queued) return; queued = true;
  requestAnimationFrame(() => { queued = false; el.after.getContext('2d').putImageData(process(state.src, state.p, state.stats), 0, 0); });
}
$('#save').onclick = () => {
  const img = state.img, s = Math.min(1, EXPORT_MAX / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
  const x = c.getContext('2d', {willReadFrequently:true}); x.drawImage(img, 0, 0, c.width, c.height);
  const data = x.getImageData(0, 0, c.width, c.height);
  x.putImageData(process(data, state.p, analyze(data)), 0, 0);
    c.toBlob(b => {
      if (!b) return toast('The restored photo could not be exported on this device.');
      const href = URL.createObjectURL(b), a = document.createElement('a');
      a.href = href; a.download = `${state.name}-restored.png`; a.hidden = true;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000); toast('Saved your restored photo.');
  }, 'image/png');
};

/* ---------- Image processing ---------- */
// Finds the darkest and brightest real tones (ignoring 0.5% outliers) per channel and for brightness overall.
function analyze(im) {
  const d = im.data, n = d.length / 4, H = [0,1,2,3].map(() => new Uint32Array(256));
  let sumRG = 0, sumRG2 = 0, sumYB = 0, sumYB2 = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    H[0][r]++; H[1][g]++; H[2][b]++;
    H[3][(.299 * r + .587 * g + .114 * b) | 0]++;
    const rg = r - g, yb = (r + g) * .5 - b;
    sumRG += rg; sumRG2 += rg * rg; sumYB += yb; sumYB2 += yb * yb;
  }
  const clip = n * 0.005, lo = [], hi = [];
  H.forEach(h => {
    let a = 0, l = 0, r = 255; while (l < 254 && (a += h[l]) < clip) l++;
    a = 0; while (r > l + 20 && (a += h[r]) < clip) r--;
    lo.push(l); hi.push(Math.max(r, l + 20));
  });
  const meanRG = sumRG / n, meanYB = sumYB / n;
  const stdRG = Math.sqrt(Math.max(0, sumRG2 / n - meanRG * meanRG));
  const stdYB = Math.sqrt(Math.max(0, sumYB2 / n - meanYB * meanYB));
  const colorfulness = Math.sqrt(stdRG * stdRG + stdYB * stdYB) + .3 * Math.sqrt(meanRG * meanRG + meanYB * meanYB);
  const gray = colorfulness < 8;
  const mono = colorfulness < 18;
  const sepia = colorfulness < 34 && meanRG > 6 && meanYB > 4;
  const faded = hi[3] - lo[3] < 110;
  return {lo:lo.slice(0, 3), hi:hi.slice(0, 3), loL:lo[3], hiL:hi[3], gray, old: mono || sepia || (faded && colorfulness < 26), colorfulness};
}

function colorRefFor(w, h) {
  if (!state.colorCanvas) return null;
  if (state.colorRef && state.colorRef.width === w && state.colorRef.height === h) return state.colorRef;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(state.colorCanvas, 0, 0, w, h);
  state.colorRef = x.getImageData(0, 0, w, h);
  return state.colorRef;
}

function process(src, p, st) {
  const w = src.width, h = src.height;
  let d = new Uint8ClampedArray(src.data);
  if (p.dust > 0) despeckle(d, w, h, p.dust);
  if (p.denoise > 0) d = smooth(d, w, h, p.denoise / 100);
  const ref = p.tone === 'colorize' ? colorRefFor(w, h) : null;
  colour(d, p, st, ref, w, h);
  if (p.sharpen > 0) d = sharpen(d, w, h, p.sharpen / 100 * 1.6);
  return new ImageData(d, w, h);
}

function colour(d, p, st, ref, w, h) {
  const s = p.levels / 100, c = p.cast / 100;
  const gam = Math.pow(2, p.shadows / 35), con = 1 + p.contrast / 100, br = p.brightness / 100 * .35;
  const luts = [0,1,2].map(ch => {
    const lo0 = st.loL + (st.lo[ch] - st.loL) * c, hi0 = st.hiL + (st.hi[ch] - st.hiL) * c;
    const lo = lo0 * s, hi = 255 + (hi0 - 255) * s, t = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let x = Math.min(1, Math.max(0, (i - lo) / (hi - lo)));
      x = Math.pow(x, 1 / gam) + br;
      t[i] = ((x - .5) * con + .5) * 255;
    }
    return t;
  });
  const [R, G, B] = luts, sat = 1 + p.saturation / 100, wm = p.warmth / 100 * .25, tone = p.tone;
  const cAmt = Math.max(0, Math.min(1, p.colorize / 100));
  let skyLikely = false;
  if (tone === 'colorize' && !ref && st.old) {
    const topRows = Math.max(1, Math.floor(h * .35));
    let sum = 0, sum2 = 0, cnt = 0;
    for (let py = 0; py < topRows; py += 2) for (let px = 0; px < w; px += 2) {
      const j = (py * w + px) * 4;
      const L = .299 * d[j] + .587 * d[j+1] + .114 * d[j+2];
      sum += L; sum2 += L * L; cnt++;
    }
    const mean = sum / cnt, std = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
    skyLikely = mean > 165 && std < 48;
  }
  for (let i = 0; i < d.length; i += 4) {
    let r = R[d[i]], g = G[d[i+1]], b = B[d[i+2]];
    const y = .299 * r + .587 * g + .114 * b;
    if (tone === 'bw') { r = g = b = y; }
    else if (tone === 'sepia') { r = y * 1.07 + 12; g = y * .97 + 4; b = y * .78; }
    else if (tone === 'colorize' && (ref || st.old)) {
      if (ref) {
        const rr = ref.data[i], rg = ref.data[i+1], rb = ref.data[i+2];
        const rl = .299 * rr + .587 * rg + .114 * rb;
        const k = y / Math.max(12, rl);
        r = y + (rr * k - y) * cAmt;
        g = y + (rg * k - y) * cAmt;
        b = y + (rb * k - y) * cAmt;
      } else {
        const idx = i / 4, px = idx % w, py = (idx - px) / w;
        const xn = px / w, yn = py / h;
        let cr = y * 1.02 + 2, cg = y * .99 + 2, cb = y * .96 + 3;
        const dark = clamp01(1 - y / 95);
        cr = mix(cr, 30 + y * .32, dark * .65);
        cg = mix(cg, 22 + y * .26, dark * .65);
        cb = mix(cb, 18 + y * .22, dark * .65);
        const skinTone = clamp01((y - 95) / 70) * (1 - clamp01((y - 228) / 27));
        const nx = Math.abs(xn - .5) * 2, ny = Math.abs(yn - .5) * 2;
        const central = clamp01(1 - (nx * .75 + ny * .55));
        const skin = skinTone * (.35 + .65 * central);
        cr = mix(cr, y * 1.14 + 20, skin * .85);
        cg = mix(cg, y * .93 + 7, skin * .85);
        cb = mix(cb, y * .79 + 3, skin * .85);
        if (skyLikely) {
          const sky = Math.max(0, 1 - yn / .55) * clamp01((y - 130) / 70);
          cr = mix(cr, y * .62 + 8, sky * .85);
          cg = mix(cg, y * .84 + 10, sky * .85);
          cb = mix(cb, Math.min(255, y * 1.16 + 18), sky * .85);
          const fol = clamp01((yn - .45) / .35) * clamp01((y - 45) / 70) * (1 - clamp01((y - 185) / 55));
          cr = mix(cr, y * .72, fol * .55);
          cg = mix(cg, y * 1.06, fol * .55);
          cb = mix(cb, y * .60, fol * .55);
        }
        r = y + (cr - y) * cAmt; g = y + (cg - y) * cAmt; b = y + (cb - y) * cAmt;
      }
    }
    else { r = (y + (r - y) * sat) * (1 + wm); g = y + (g - y) * sat; b = (y + (b - y) * sat) * (1 - wm); }
    d[i] = r; d[i+1] = g; d[i+2] = b;
  }
}

// 3x3 box blur (edges clamped)
function blur3(d, w, h) {
  // Two one-dimensional passes avoid the old 9-sample nested loop.
  const horizontal = new Uint8ClampedArray(d.length);
  const o = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) {
      const left = ((y * w + Math.max(0, x - 1)) * 4) + k;
      const right = ((y * w + Math.min(w - 1, x + 1)) * 4) + k;
      horizontal[i + k] = (d[left] + d[i + k] + d[right]) / 3;
    }
    horizontal[i + 3] = 255;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const top = (Math.max(0, y - 1) * w + x) * 4;
    const bottom = (Math.min(h - 1, y + 1) * w + x) * 4;
    for (let k = 0; k < 3; k++) o[i + k] = (horizontal[top + k] + horizontal[i + k] + horizontal[bottom + k]) / 3;
    o[i + 3] = 255;
  }
  return o;
}
// Edge-aware noise smoothing: flat areas are blended with their blur, edges are kept
function smooth(d, w, h, a) {
  const b = blur3(d, w, h);
  for (let i = 0; i < d.length; i += 4) {
    const diff = Math.abs(.299 * (d[i] - b[i]) + .587 * (d[i+1] - b[i+1]) + .114 * (d[i+2] - b[i+2]));
    const k = a * Math.max(0, 1 - diff / 40);
    d[i] += (b[i] - d[i]) * k; d[i+1] += (b[i+1] - d[i+1]) * k; d[i+2] += (b[i+2] - d[i+2]) * k;
  }
  return d;
}
// Unsharp mask
function sharpen(d, w, h, k) {
  const b = blur3(d, w, h), o = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    o[i] = d[i] + (d[i] - b[i]) * k; o[i+1] = d[i+1] + (d[i+1] - b[i+1]) * k; o[i+2] = d[i+2] + (d[i+2] - b[i+2]) * k; o[i+3] = 255;
  }
  return o;
}
// Median-based dust and scratch removal: a pixel that is much brighter or darker than the
// median of its 3x3 neighbourhood is replaced by the neighbour closest to that median.
function despeckle(d, w, h, amount) {
  const src = new Uint8ClampedArray(d), L = new Float32Array(w * h), thr = 70 - amount * .55;
  for (let i = 0; i < L.length; i++) L[i] = .299 * src[i*4] + .587 * src[i*4+1] + .114 * src[i*4+2];
  const v = new Float32Array(9), idx = new Int32Array(9);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const c = y * w + x; let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { idx[n] = c + dy * w + dx; v[n++] = L[idx[n - 1]]; }
    // Insertion sort reuses the typed array and avoids an allocation per pixel.
    for (let j = 1; j < 9; j++) {
      const value = v[j]; let k = j - 1;
      while (k >= 0 && v[k] > value) { v[k + 1] = v[k]; k--; }
      v[k + 1] = value;
    }
    const med = v[4];
    if (Math.abs(L[c] - med) > thr) {
      let best = idx[0], bd = 1e9;
      for (let j = 0; j < 9; j++) if (idx[j] !== c) { const q = Math.abs(L[idx[j]] - med); if (q < bd) { bd = q; best = idx[j]; } }
      d[c*4] = src[best*4]; d[c*4+1] = src[best*4+1]; d[c*4+2] = src[best*4+2];
    }
  }
}

/* ---------- Built-in sample: a black & white family photo with its true colours ---------- */
let sampleColorCanvas = null;

function makeSample() {
  const W = 900, H = 620;
  const color = document.createElement('canvas'); color.width = W; color.height = H;
  const x = color.getContext('2d', {willReadFrequently:true});
  let g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#4f8fd6'); g.addColorStop(.6, '#f4d9a0'); x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = '#fff3c4'; x.beginPath(); x.arc(690, 190, 58, 0, 7); x.fill();
  x.fillStyle = '#3f7d4a'; x.beginPath(); x.moveTo(0, 410); x.quadraticCurveTo(250, 290, 520, 400); x.quadraticCurveTo(730, 470, W, 370); x.lineTo(W, H); x.lineTo(0, H); x.fill();
  x.fillStyle = '#2b5e38'; x.beginPath(); x.moveTo(0, 500); x.quadraticCurveTo(450, 440, W, 510); x.lineTo(W, H); x.lineTo(0, H); x.fill();
  x.fillStyle = '#d0735a'; x.fillRect(250, 360, 220, 140);
  x.fillStyle = '#6b3a2e'; x.beginPath(); x.moveTo(230, 365); x.lineTo(360, 270); x.lineTo(490, 365); x.fill();
  x.fillStyle = '#f2e4c0'; x.fillRect(290, 400, 50, 50); x.fillRect(390, 400, 50, 50);
  x.fillStyle = '#5a3326'; x.fillRect(345, 430, 40, 70);
  [[560,470,'#8b3d3d'],[620,475,'#2f4f7a']].forEach(([px, py, col]) => {
    x.fillStyle = '#e8c4a0'; x.beginPath(); x.arc(px, py - 70, 20, 0, 7); x.fill();
    x.fillStyle = col; x.fillRect(px - 22, py - 50, 44, 90);
  });
  sampleColorCanvas = color;

  const bw = document.createElement('canvas'); bw.width = W; bw.height = H;
  const bx = bw.getContext('2d', {willReadFrequently:true});
  bx.drawImage(color, 0, 0);
  const im = bx.getImageData(0, 0, W, H), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = .299 * d[i] + .587 * d[i+1] + .114 * d[i+2];
    const n = (Math.random() - .5) * 18;
    const v = 128 + (lum - 128) * .48 + 16 + n;
    d[i] = d[i+1] = d[i+2] = v;
  }
  bx.putImageData(im, 0, 0);
  for (let i = 0; i < 9; i++) {
    bx.strokeStyle = `rgba(${Math.random() < .5 ? '235,230,218' : '26,24,22'},.6)`; bx.lineWidth = 1;
    const sx = Math.random() * W; bx.beginPath(); bx.moveTo(sx, Math.random() * 120); bx.lineTo(sx + (Math.random() - .5) * 20, H - Math.random() * 120); bx.stroke();
  }
  for (let i = 0; i < 160; i++) {
    bx.fillStyle = Math.random() < .6 ? 'rgba(240,236,226,.8)' : 'rgba(28,25,22,.7)';
    bx.fillRect(Math.random() * W, Math.random() * H, 1 + Math.random() * 1.5, 1 + Math.random() * 1.5);
  }
  return bw.toDataURL('image/png');
}

sync();
})();
