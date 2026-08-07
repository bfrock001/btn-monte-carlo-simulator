/* ============================================================
   Beyond the Noise — Monte Carlo Portfolio Simulation
   Phase 1: data layer + asset class reference table
   ============================================================ */

'use strict';

const STATE = {
  data: null,            // parsed simba_returns_data.json
  assets: [],            // array of asset records (key, name, ticker, group, ...)
  period: 'modern',      // 'native' | 'postwar' | 'modern' | 'custom'
  customRange: { start: 1972, end: 2025 }, // shared Step 3 date range
  sort: { key: 'cagr', dir: 'desc' },
  step3: {
    selectedAssets: [],  // populated in initStep3AssetSelection
    rangeValid: true,    // false when custom range < 10 years
    includePortfolio: true, // periodic table adds the Simulator's loaded mix as a ranked row
  },
  optimizer: {
    selectedAssets: [],  // independent of step3; populated in initOptimizerAssetSelection
  },
};

const GROUP_ORDER = ['US Equity', 'International Equity', 'Fixed Income', 'Alternatives'];

const PERIOD_LABELS = {
  native:  { name: 'Full Data Set',          start: 1871, end: 2025 },
  postwar: { name: 'Post-WWII (1946–2025)',  start: 1946, end: 2025 },
  modern:  { name: 'Modern era (1972–2025)', start: 1972, end: 2025 },
  custom:  { name: 'Custom range',           start: null, end: null }, // populated from STATE.customRange
};

const DATA_URL = './simba_returns_data.json';

// Cache-buster for the Web Worker script. Browsers cache worker scripts hard, so
// a plain refresh can keep running an OLD engine even after the file changed on
// disk. Appending a version the workers are loaded with forces a fresh fetch.
// Bump this whenever simulation.worker.js changes.
const WORKER_VERSION = 'c18y';
const WORKER_URL = `./simulation.worker.js?v=${WORKER_VERSION}`;

/* -----------------------------------------------------------
   Boot
   ----------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  // A gate failure must never block the app from loading its data.
  try { initTermsGate(); } catch (e) { console.error('Terms gate init failed:', e); }
  loadData().catch((err) => showError(err.message || String(err)));
});

async function loadData() {
  const res = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(
      `Unable to load historical return data (${res.status}). Please check that simba_returns_data.json is in the project root and refresh the page.`
    );
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw new Error(
      'Historical return data could not be parsed. The file may be malformed.'
    );
  }

  validateSchema(json);
  applyDataQualityOverrides(json);

  STATE.data = json;
  STATE.assets = buildAssetList(json.assets);

  hideElement('loading-state');
  showElement('app-shell');

  initStep3();
  bindSortHeaders();
  render();

  // Phase 3 input panel — initialized once data is available
  initInputPanel();
}

function validateSchema(json) {
  for (const key of ['metadata', 'assets', 'annual_returns']) {
    if (!json[key]) {
      throw new Error(
        `Historical return data is missing the required '${key}' section. Please check simba_returns_data.json.`
      );
    }
  }
  if (!Array.isArray(json.annual_returns) || json.annual_returns.length === 0) {
    throw new Error('Historical return data contains no annual return rows.');
  }
  if (typeof json.assets !== 'object' || Object.keys(json.assets).length === 0) {
    throw new Error('Historical return data contains no asset definitions.');
  }
}

/* -----------------------------------------------------------
   Data quality overrides
   -----------------------------------------------------------
   Real US Treasury TIPS were first issued in January 1997.
   The Simba dataset labels its 1985–1996 TIPS values as "native"
   but they're really proxy/reconstructed series. Per editorial
   direction we treat TIPS as having real data only from 1997+:
   null out pre-1997 values, update the asset's metadata, and
   recompute the cached stats blocks from the filtered rows.
   Source JSON file is not modified — this runs at load time.
   ----------------------------------------------------------- */
const TIPS_REAL_START = 1997;

function applyDataQualityOverrides(json) {
  // 1. Null out TIPS values before the real-issuance year.
  for (const row of json.annual_returns) {
    if (row.year < TIPS_REAL_START) row.tips = null;
  }
  if (!json.assets || !json.assets.tips) return;

  // 2. Update TIPS metadata.
  json.assets.tips.native_start = TIPS_REAL_START;
  json.assets.tips.splice_note =
    `Real TIPS data from ${TIPS_REAL_START} only (US Treasury TIPS inception). Pre-${TIPS_REAL_START} spliced/proxy data removed.`;

  // 3. Recompute cached stats blocks (native / postwar / modern) from filtered rows.
  json.assets.tips.stats = {
    native:  computeAssetStatsForRangeRaw(json, 'tips', 1871, 2025),
    postwar: computeAssetStatsForRangeRaw(json, 'tips', 1946, 2025),
    modern:  computeAssetStatsForRangeRaw(json, 'tips', 1972, 2025),
  };
}

function computeAssetStatsForRangeRaw(json, key, start, end) {
  // Same math as computeAssetStatsForRange, but operates on the raw json
  // before STATE is populated. Used by the data-quality override path.
  const returns = [];
  const tbills  = [];
  let firstYear = null;
  for (const row of json.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (row[key] == null) continue;
    returns.push(row[key]);
    if (row.st_tbills != null) tbills.push(row.st_tbills);
    if (firstYear == null) firstYear = row.year;
  }
  const n = returns.length;
  if (n === 0) {
    return { mean: 0, std: 0, cagr: 0, min: 0, max: 0, n: 0, sharpe: 0, avg_rf: 0, first_year: null };
  }
  let mean = 0; for (const v of returns) mean += v; mean /= n;
  let variance = 0; for (const v of returns) { const d = v - mean; variance += d * d; } variance /= n;
  const std = Math.sqrt(variance);
  let logSum = 0; for (const v of returns) logSum += Math.log(1 + v / 100);
  const cagr = (Math.exp(logSum / n) - 1) * 100;
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const avg_rf = tbills.length ? tbills.reduce((a, b) => a + b, 0) / tbills.length : 0;
  const sharpe = std > 0 ? (mean - avg_rf) / std : 0;
  return { mean, std, cagr, min, max, n, sharpe, avg_rf, first_year: firstYear };
}

function buildAssetList(assetsObj) {
  return Object.values(assetsObj).map((a) => ({
    ...a,
    quality: classifyQuality(a),
  }));
}

/* -----------------------------------------------------------
   Data quality classification
   ----------------------------------------------------------- */
function classifyQuality(asset) {
  const note = (asset.splice_note || '').toLowerCase();
  const start = asset.native_start;
  if (note.startsWith('native')) return 'native';
  if (note.includes('spliced')) {
    if (start <= 1927) return 'early-splice';
    if (start >= 1969 && start <= 1979) return 'late-splice';
    if (start >= 1980) return 'limited';
    return 'early-splice';
  }
  if (start >= 1980) return 'limited';
  return 'native';
}

const QUALITY_INFO = {
  'native':       { label: 'Native 1871',   className: 'badge--native' },
  'early-splice': { label: 'Spliced <1927', className: 'badge--early-splice' },
  'late-splice':  { label: 'Spliced 1970+', className: 'badge--late-splice' },
  'limited':      { label: 'Limited history', className: 'badge--limited' },
};

/* -----------------------------------------------------------
   Step 3: shared controls (tabs + date range + asset selection)
   ----------------------------------------------------------- */

// Curated default asset set per Step 3 spec §3.2.
// Uses S&P 500 (not Total US Market) as the large-cap-blend anchor and adds
// Large Cap Value so the value tilt is present out of the box.
const STEP3_DEFAULT_ASSETS = [
  'sp500', 'large_cap_value', 'mid_cap_blend', 'small_cap_blend',
  'intl_developed', 'emerging_markets',
  'total_bond', 'lt_treasury', 'tips',
  'reit', 'gold', 'st_tbills',
];
const STEP3_STORAGE_KEY = 'btn-mcsim-step3-selection';
const STEP3_MIN_YEARS = 10;   // Spec §3.1 hard rule
const STEP3_SOFT_CAP = 14;    // Spec §3.2 soft cap for readability

function initStep3() {
  bindTabs();
  bindStep3PeriodToggle();
  bindPeriodicPortfolioToggle();
  initStep3AssetSelection();
  initOptimizer();
  refreshStep3Tools();
}

function bindPeriodicPortfolioToggle() {
  const cb = document.getElementById('periodic-include-portfolio');
  if (!cb) return;
  cb.checked = STATE.step3.includePortfolio;
  cb.addEventListener('change', () => {
    STATE.step3.includePortfolio = cb.checked;
    renderPeriodicTable();
  });
}

function bindTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panelIds = { simulator: 'tab-simulator', data: 'tab-data', optimizer: 'tab-optimizer', methodology: 'tab-methodology' };
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      if (!target) return;
      tabs.forEach((b) => {
        const active = b.dataset.tab === target;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      Object.entries(panelIds).forEach(([key, id]) => {
        const panel = document.getElementById(id);
        if (!panel) return;
        const isActive = key === target;
        panel.hidden = !isActive;
        panel.classList.toggle('is-active', isActive);
      });
      // The optimizer mirrors the Simulator's current plan (balance, spending,
      // strategy…), which may have changed while that tab was open — refresh it
      // each time the Optimizer tab is shown.
      if (target === 'optimizer') renderOptimizerControls();
      // The periodic table's "your portfolio" row reads the Simulator's loaded
      // allocation, which may have changed on the other tab — re-sync on show.
      if (target === 'data') refreshStep3Tools();
    });
  });
}

function bindStep3PeriodToggle() {
  document.querySelectorAll('#tab-data .period-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const period = btn.dataset.period;
      if (!period || period === STATE.period) return;
      STATE.period = period;
      document.querySelectorAll('#tab-data .period-btn').forEach((b) => {
        const active = b.dataset.period === period;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      const customBox = document.getElementById('step3-custom-range');
      if (customBox) customBox.hidden = period !== 'custom';
      if (validateStep3Range()) { render(); refreshStep3Tools(); }
      else { refreshStep3Tools(); }
    });
  });

  const startSel = document.getElementById('step3-custom-start');
  const endSel   = document.getElementById('step3-custom-end');
  if (startSel && startSel.options.length === 0) {
    for (let y = 1871; y <= 2015; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === STATE.customRange.start) opt.selected = true;
      startSel.appendChild(opt);
    }
    startSel.addEventListener('change', () => {
      STATE.customRange.start = parseInt(startSel.value, 10);
      if (validateStep3Range()) { render(); refreshStep3Tools(); }
      else { refreshStep3Tools(); }
    });
  }
  if (endSel && endSel.options.length === 0) {
    for (let y = 1881; y <= 2025; y++) {
      const opt = document.createElement('option');
      opt.value = y; opt.textContent = y;
      if (y === STATE.customRange.end) opt.selected = true;
      endSel.appendChild(opt);
    }
    endSel.addEventListener('change', () => {
      STATE.customRange.end = parseInt(endSel.value, 10);
      if (validateStep3Range()) { render(); refreshStep3Tools(); }
      else { refreshStep3Tools(); }
    });
  }
}

// Returns true when the current range is usable (>= STEP3_MIN_YEARS spans),
// and toggles the inline error message accordingly. Presets are always valid.
function validateStep3Range() {
  const errEl = document.getElementById('step3-custom-range-error');
  if (STATE.period !== 'custom') {
    if (errEl) errEl.hidden = true;
    STATE.step3.rangeValid = true;
    return true;
  }
  const gap = STATE.customRange.end - STATE.customRange.start;
  const valid = gap >= STEP3_MIN_YEARS;
  if (errEl) errEl.hidden = valid;
  STATE.step3.rangeValid = valid;
  return valid;
}

function initStep3AssetSelection() {
  const validKeys = new Set(STATE.assets.map((a) => a.key));
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(STEP3_STORAGE_KEY)); } catch {}
  const restored = Array.isArray(stored) ? stored.filter((k) => validKeys.has(k)) : null;
  STATE.step3.selectedAssets =
    (restored && restored.length >= 2)
      ? restored
      : STEP3_DEFAULT_ASSETS.filter((k) => validKeys.has(k));

  renderStep3AssetChips();
  bindStep3AddAssetMenu();
}

function saveStep3Selection() {
  try { localStorage.setItem(STEP3_STORAGE_KEY, JSON.stringify(STATE.step3.selectedAssets)); } catch {}
}

function groupSlug(group) {
  return String(group || '').toLowerCase().replace(/\s+/g, '-');
}

function renderStep3AssetChips() {
  const chipContainer = document.getElementById('step3-asset-chips');
  if (!chipContainer) return;
  chipContainer.innerHTML = '';

  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  const orderIndex = new Map();
  STATE.assets.forEach((a, i) => orderIndex.set(a.key, i));
  const sorted = [...STATE.step3.selectedAssets]
    .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

  sorted.forEach((key) => {
    const asset = byKey.get(key);
    if (!asset) return;
    const chip = document.createElement('span');
    chip.className = 'asset-chip';
    chip.dataset.group = groupSlug(asset.group);
    chip.innerHTML =
      `<span class="asset-chip__label">${escapeHtml(asset.name)}</span>` +
      `<button type="button" class="asset-chip__remove" aria-label="Remove ${escapeHtml(asset.name)}" data-key="${escapeHtml(key)}">&times;</button>`;
    chipContainer.appendChild(chip);
  });

  chipContainer.querySelectorAll('.asset-chip__remove').forEach((btn) => {
    btn.addEventListener('click', () => removeStep3Asset(btn.dataset.key));
  });

  updateStep3AssetCount();
}

function updateStep3AssetCount() {
  const countEl = document.getElementById('step3-selected-count');
  const warnEl  = document.getElementById('step3-asset-warning');
  const n = STATE.step3.selectedAssets.length;
  if (countEl) countEl.textContent = `(${n} selected)`;
  if (!warnEl) return;
  if (n < 2) {
    warnEl.hidden = false;
    warnEl.textContent = 'Select at least 2 asset classes so the correlation matrix and periodic table have something to compare.';
  } else if (n > STEP3_SOFT_CAP) {
    warnEl.hidden = false;
    warnEl.textContent = `Note: the periodic table gets hard to read beyond ${STEP3_SOFT_CAP} asset classes. You can still proceed.`;
  } else {
    warnEl.hidden = true;
    warnEl.textContent = '';
  }
}

function bindStep3AddAssetMenu() {
  const btn  = document.getElementById('step3-add-asset-btn');
  const menu = document.getElementById('step3-add-asset-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    if (willOpen) buildStep3AddAssetMenu();
    menu.hidden = !willOpen;
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });

  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || e.target === btn) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }
  });
}

function buildStep3AddAssetMenu() {
  const menu = document.getElementById('step3-add-asset-menu');
  if (!menu) return;
  menu.innerHTML = '';

  const selected = new Set(STATE.step3.selectedAssets);
  const available = STATE.assets.filter((a) => !selected.has(a.key));

  if (available.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'asset-selector__empty';
    empty.textContent = 'All asset classes are already selected.';
    menu.appendChild(empty);
    return;
  }

  const byGroup = new Map();
  available.forEach((a) => {
    if (!byGroup.has(a.group)) byGroup.set(a.group, []);
    byGroup.get(a.group).push(a);
  });

  GROUP_ORDER.forEach((group) => {
    if (!byGroup.has(group)) return;
    const heading = document.createElement('div');
    heading.className = 'asset-selector__group';
    heading.textContent = group;
    menu.appendChild(heading);
    byGroup.get(group).forEach((a) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'asset-selector__item';
      item.dataset.group = groupSlug(a.group);
      item.dataset.key = a.key;
      item.textContent = a.name;
      item.addEventListener('click', () => {
        addStep3Asset(a.key);
        menu.hidden = true;
        const btn = document.getElementById('step3-add-asset-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
      menu.appendChild(item);
    });
  });
}

function addStep3Asset(key) {
  if (STATE.step3.selectedAssets.includes(key)) return;
  STATE.step3.selectedAssets.push(key);
  saveStep3Selection();
  renderStep3AssetChips();
  refreshStep3Tools();
}

function removeStep3Asset(key) {
  STATE.step3.selectedAssets = STATE.step3.selectedAssets.filter((k) => k !== key);
  saveStep3Selection();
  renderStep3AssetChips();
  refreshStep3Tools();
}

// Recompute every Step 3 tool that depends on the shared controls.
// Called on: range change, custom-year change, add/remove asset, initial data load.
function refreshStep3Tools() {
  renderCorrelationMatrix();
  renderPeriodicTable();
}

/* -----------------------------------------------------------
   Tool 2 · Annual Correlation Matrix
   Pearson correlation of annual total returns, pairwise common years,
   per-pair min 10 obs, blue/red heatmap using brand tokens.
   ----------------------------------------------------------- */

const STEP3_MIN_PAIR_OBS = 10;  // Spec §5

// Compact column-header labels: keep the matrix readable at ~10 assets wide.
const STEP3_SHORT_LABELS = {
  total_market_us: 'Total US',
  sp500: 'S&P 500',
  large_cap_blend: 'LC Blend',
  large_cap_value: 'LC Value',
  large_cap_growth: 'LC Growth',
  mid_cap_blend: 'MC Blend',
  mid_cap_value: 'MC Value',
  mid_cap_growth: 'MC Growth',
  small_cap_blend: 'SC Blend',
  small_cap_value: 'SC Value',
  small_cap_growth: 'SC Growth',
  total_intl: 'Total Intl',
  intl_developed: 'Intl Dev',
  emerging_markets: 'EM',
  total_bond: 'Total Bond',
  lt_treasury: 'LT Treasury',
  interm_treasury: 'Int Treasury',
  corp_bonds: 'Corp Bonds',
  tips: 'TIPS',
  st_tbills: 'T-Bills',
  reit: 'REIT',
  gold: 'Gold',
};

// Return the [start, end] year range from the shared Step 3 controls.
function getStep3Range() {
  if (STATE.period === 'custom') return [STATE.customRange.start, STATE.customRange.end];
  const p = PERIOD_LABELS[STATE.period];
  return [p.start, p.end];
}

// Pairwise common-year returns for two asset keys.
function pairwiseAnnualReturns(keyA, keyB, start, end) {
  const a = [], b = [];
  for (const row of STATE.data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    const va = row[keyA], vb = row[keyB];
    if (va == null || vb == null) continue;
    a.push(va); b.push(vb);
  }
  return { a, b, n: a.length };
}

// Pearson correlation coefficient. Returns null if n < 2 or variance = 0.
function pearson(a, b) {
  const n = a.length;
  if (n < 2) return null;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let num = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  if (denom === 0) return null;
  return num / denom;
}

// Per-asset CAGR + sample-std over the selected range (annual returns).
// Returns null when there are no rows for that asset in the range.
function step3AssetStats(key, start, end) {
  const returns = [];
  for (const row of STATE.data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (row[key] == null) continue;
    returns.push(row[key]);
  }
  const n = returns.length;
  if (n === 0) return { cagr: null, std: null, n: 0 };
  let mean = 0; for (const v of returns) mean += v; mean /= n;
  // Sample std dev (n-1 divisor) per spec §5.
  let variance = 0; for (const v of returns) { const d = v - mean; variance += d * d; }
  variance /= Math.max(1, n - 1);
  const std = Math.sqrt(variance);
  let logSum = 0; for (const v of returns) logSum += Math.log(1 + v / 100);
  const cagr = (Math.exp(logSum / n) - 1) * 100;
  return { cagr, std, n };
}

// Sentinel "asset key" for the Simulator's loaded portfolio when it's added as a
// row in the periodic table. Not a real asset — handled specially everywhere.
const PORTFOLIO_KEY = '__portfolio__';

// The Simulator's currently-loaded allocation as normalized weights, or null if
// nothing usable is entered. Weights are normalized to the entered total so a
// partially-filled allocation still blends sensibly.
function getSimulatorPortfolio() {
  const validKeys = new Set(STATE.assets.map((a) => a.key));
  const raw = (INPUT_STATE.allocations || []).filter((a) => a.key && a.pct > 0 && validKeys.has(a.key));
  if (!raw.length) return null;
  const totalPct = raw.reduce((s, a) => s + a.pct, 0);
  if (totalPct <= 0) return null;
  const weights = raw.map((a) => ({ key: a.key, pct: a.pct, w: a.pct / totalPct }));
  return { weights, totalPct };
}

// Per-year blended return for the portfolio over [start, end], rebalanced to
// target weights each year. A year is INCLUDED only if EVERY holding has data
// that year; otherwise it's skipped and the missing holding(s) are recorded so
// the UI can explain what constrained the row.
function computePortfolioYearReturns(pf, start, end, rowsByYear) {
  const byYear = new Map();
  const skipped = [];
  const missing = new Map(); // assetKey -> count of skipped years it caused
  for (let y = start; y <= end; y++) {
    const row = rowsByYear.get(y);
    if (!row) continue; // year absent from the dataset entirely — not a holding gap
    const gaps = pf.weights.filter((h) => row[h.key] == null);
    if (gaps.length) {
      skipped.push(y);
      gaps.forEach((h) => missing.set(h.key, (missing.get(h.key) || 0) + 1));
      continue;
    }
    let ret = 0;
    for (const h of pf.weights) ret += h.w * row[h.key];
    byYear.set(y, ret);
  }
  return { byYear, skipped, missing };
}

// CAGR / sample-σ of the portfolio over the years it actually covers — same
// formulas as step3AssetStats so the summary column is apples-to-apples.
function computePortfolioStats(byYear) {
  const returns = [...byYear.values()];
  const n = returns.length;
  if (n === 0) return { cagr: null, std: null, n: 0 };
  let mean = 0; for (const v of returns) mean += v; mean /= n;
  let variance = 0; for (const v of returns) { const d = v - mean; variance += d * d; }
  variance /= Math.max(1, n - 1);
  const std = Math.sqrt(variance);
  let logSum = 0; for (const v of returns) logSum += Math.log(1 + v / 100);
  const cagr = (Math.exp(logSum / n) - 1) * 100;
  return { cagr, std, n };
}

// Compress a sorted year list into compact ranges: [1972,1973,1974,1988] → "1972–1974, 1988".
function compressYears(years) {
  if (!years.length) return '';
  const sorted = [...years].sort((a, b) => a - b);
  const parts = [];
  let runStart = sorted[0], prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const y = sorted[i];
    if (y === prev + 1) { prev = y; continue; }
    parts.push(runStart === prev ? `${runStart}` : `${runStart}–${prev}`);
    runStart = prev = y;
  }
  return parts.join(', ');
}

// Short display label for the Simulator portfolio, e.g. "Portfolio 60/40" when
// it's a clean equity/fixed-income split, else just "Portfolio".
function portfolioShortLabel(pf) {
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  let eq = 0, fi = 0, other = 0;
  for (const h of pf.weights) {
    const g = (byKey.get(h.key) || {}).group;
    if (g === 'US Equity' || g === 'International Equity') eq += h.pct;
    else if (g === 'Fixed Income') fi += h.pct;
    else other += h.pct;
  }
  const tot = eq + fi + other;
  if (tot > 0 && other === 0) {
    return `Portfolio ${Math.round((eq / tot) * 100)}/${Math.round((fi / tot) * 100)}`;
  }
  return 'Portfolio';
}

function renderCorrelationMatrix() {
  const scroll = document.getElementById('correlation-scroll');
  const empty  = document.getElementById('correlation-empty');
  const sub    = document.getElementById('correlation-sub');
  const thead  = document.getElementById('correlation-thead');
  const tbody  = document.getElementById('correlation-tbody');
  if (!scroll || !thead || !tbody) return;

  const selected = STATE.step3.selectedAssets.slice();
  if (selected.length < 2) {
    scroll.hidden = true;
    empty.hidden = false;
    empty.textContent = 'Select at least 2 asset classes above to see a correlation matrix.';
    if (sub) sub.textContent = '';
    return;
  }
  if (STATE.period === 'custom' && !STATE.step3.rangeValid) {
    scroll.hidden = true;
    empty.hidden = false;
    empty.textContent = 'Correlation matrix paused — pick a range of at least 10 years above.';
    if (sub) sub.textContent = '';
    return;
  }
  scroll.hidden = false;
  empty.hidden = true;

  const [start, end] = getStep3Range();
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  const orderIndex = new Map();
  STATE.assets.forEach((a, i) => orderIndex.set(a.key, i));
  const keys = selected
    .filter((k) => byKey.has(k))
    .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

  // Per-asset stats (right-side columns)
  const stats = new Map();
  keys.forEach((k) => stats.set(k, step3AssetStats(k, start, end)));

  // Overall N: intersection of all selected assets over the range.
  let overallN = 0;
  for (const row of STATE.data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (keys.every((k) => row[k] != null)) overallN++;
  }

  // ---- thead ----
  thead.innerHTML = '';
  const headRow = document.createElement('tr');
  headRow.appendChild(headCell('corr-corner', ''));
  keys.forEach((k) => {
    const asset = byKey.get(k);
    const th = document.createElement('th');
    th.className = 'corr-colhead';
    th.scope = 'col';
    th.title = asset.name;
    th.dataset.group = groupSlug(asset.group);
    th.textContent = STEP3_SHORT_LABELS[k] || asset.ticker || asset.name;
    headRow.appendChild(th);
  });
  ['Ann. Return', 'Ann. Std Dev'].forEach((label, i) => {
    const th = document.createElement('th');
    th.className = 'corr-stat-head' + (i === 0 ? ' corr-stat-head--first' : '');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);

  // ---- tbody ----
  tbody.innerHTML = '';
  keys.forEach((rowKey, rowIdx) => {
    const rowAsset = byKey.get(rowKey);
    const tr = document.createElement('tr');

    const rowHead = document.createElement('th');
    rowHead.className = 'corr-rowhead';
    rowHead.scope = 'row';
    rowHead.dataset.group = groupSlug(rowAsset.group);
    rowHead.title = rowAsset.name;
    rowHead.textContent = rowAsset.name;
    tr.appendChild(rowHead);

    keys.forEach((colKey, colIdx) => {
      const td = document.createElement('td');
      td.className = 'corr-cell';
      if (rowKey === colKey) {
        td.classList.add('corr-cell--diag');
        td.textContent = '1.00';
        td.title = `${rowAsset.name}`;
      } else {
        const pair = pairwiseAnnualReturns(rowKey, colKey, start, end);
        if (pair.n < STEP3_MIN_PAIR_OBS) {
          td.classList.add('corr-cell--none');
          td.textContent = '—';
          td.title = `Not enough overlapping annual data (${pair.n} common years; need ≥ ${STEP3_MIN_PAIR_OBS}).`;
        } else {
          const r = pearson(pair.a, pair.b);
          if (r == null) {
            td.classList.add('corr-cell--none');
            td.textContent = '—';
            td.title = 'Correlation undefined (zero variance).';
          } else {
            paintCorrelationCell(td, r);
            td.textContent = formatCorr(r);
            td.title = `${rowAsset.name} × ${byKey.get(colKey).name}\n` +
                       `r = ${r.toFixed(4)} · ${pair.n} common years (${start}–${end})`;
          }
        }
      }
      tr.appendChild(td);
    });

    const rowStats = stats.get(rowKey);
    const cagrTd = document.createElement('td');
    cagrTd.className = 'corr-stat';
    cagrTd.textContent = rowStats.cagr == null ? '—' : `${rowStats.cagr.toFixed(2)}%`;
    tr.appendChild(cagrTd);
    const stdTd = document.createElement('td');
    stdTd.className = 'corr-stat';
    stdTd.textContent = rowStats.std == null ? '—' : `${rowStats.std.toFixed(2)}%`;
    tr.appendChild(stdTd);

    tbody.appendChild(tr);
  });

  // Subtitle: N assets, range, overall N intersection years, methodology hint.
  if (sub) {
    const periodLabel = STATE.period === 'custom'
      ? `Custom (${start}–${end})`
      : PERIOD_LABELS[STATE.period].name;
    sub.textContent =
      `${keys.length} assets · ${periodLabel} · ` +
      `${overallN} year${overallN === 1 ? '' : 's'} where all selected assets overlap.`;
  }
}

function headCell(className, text) {
  const th = document.createElement('th');
  th.className = className;
  th.textContent = text;
  return th;
}

// Format a correlation value: signed, 2 decimals, no leading zero-int loss.
function formatCorr(r) {
  const sign = r < 0 ? '−' : '';   // proper minus glyph
  return sign + Math.abs(r).toFixed(2);
}

// Paint a cell background using alpha-blended brand tokens over paper:
//   positive r → navy at alpha |r| ; negative r → clay at alpha |r|.
// Text stays dark until |r| passes ~0.55, then flips to paper for contrast.
function paintCorrelationCell(td, r) {
  const mag = Math.min(1, Math.abs(r));
  const alpha = Math.max(0.06, mag * 0.85);   // don't wash cells to invisible
  if (r >= 0) {
    td.style.background = `rgba(31, 61, 107, ${alpha})`;   // --navy
    td.classList.add('corr-cell--pos');
  } else {
    td.style.background = `rgba(200, 74, 48, ${alpha})`;   // --clay
    td.classList.add('corr-cell--neg');
  }
  if (mag > 0.55) td.classList.add('corr-cell--dark');
}

/* -----------------------------------------------------------
   Tool 3 · Periodic Table of Returns (Callan-style)
   Group-family colors with lightness variation: consistent per asset
   across every year column so leadership rotation is visible.
   ----------------------------------------------------------- */

// [hue, sat, lightness] per asset. Group-family hues (navy/teal/gold/clay)
// with lightness stepping down for narrower / later-vintage styles inside
// each family. Slight hue nudge separates value (warmer) vs growth (cooler).
const STEP3_ASSET_HSL = {
  // US Equity — navy family (h ~208–220)
  total_market_us:  [214, 55, 27],
  sp500:            [214, 50, 35],
  large_cap_blend:  [214, 48, 42],
  large_cap_value:  [220, 45, 47],
  large_cap_growth: [208, 45, 47],
  mid_cap_blend:    [214, 42, 52],
  mid_cap_value:    [220, 40, 57],
  mid_cap_growth:   [208, 40, 57],
  small_cap_blend:  [214, 38, 62],
  small_cap_value:  [220, 35, 66],
  small_cap_growth: [208, 35, 66],
  // International Equity — teal family
  total_intl:       [180, 61, 27],
  intl_developed:   [178, 52, 40],
  emerging_markets: [174, 48, 52],
  // Fixed Income — gold family
  total_bond:       [42, 68, 42],
  lt_treasury:      [35, 62, 32],
  interm_treasury:  [38, 55, 42],
  corp_bonds:       [45, 52, 52],
  tips:             [48, 48, 62],
  st_tbills:        [52, 45, 72],
  // Alternatives — clay family
  reit:             [9,  62, 49],
  gold:             [22, 68, 60],
};

function assetColor(key) {
  const t = STEP3_ASSET_HSL[key];
  if (!t) return 'hsl(0, 0%, 60%)';
  return `hsl(${t[0]}, ${t[1]}%, ${t[2]}%)`;
}

// Text on the swatch flips to --paper when the swatch is dark enough
// that dark text would fail contrast.
function assetColorIsDark(key) {
  const t = STEP3_ASSET_HSL[key];
  if (!t) return false;
  return t[2] < 55;
}

// Signed-pct with proper minus glyph, one decimal.
function fmtSignedPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v >= 0 ? '+' : '−';
  return s + Math.abs(v).toFixed(1) + '%';
}

// Periodic-table asset spotlight: hovering any cell / summary / legend chip of
// an asset brightens that asset's whole trail across the years and dims the rest,
// so its rank rotation is easy to follow. Pure presentation — toggles classes
// only. `data-asset-key` is stamped on every keyed element in renderPeriodicTable.
let periodicHlKey = null;
function setPeriodicHighlight(key) {
  if (key === periodicHlKey) return;
  periodicHlKey = key;
  const section = document.getElementById('periodic-section');
  if (!section) return;
  section.querySelectorAll('.pt-hl').forEach((el) => el.classList.remove('pt-hl'));
  if (key) {
    section.classList.add('pt-focus');
    section.querySelectorAll(`[data-asset-key="${CSS.escape(key)}"]`)
      .forEach((el) => el.classList.add('pt-hl'));
  } else {
    section.classList.remove('pt-focus');
  }
}

function bindPeriodicHighlight(section) {
  if (!section || section.dataset.hlBound) return;
  section.dataset.hlBound = '1';
  // Delegated so it survives every tbody/legend rebuild.
  section.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-asset-key]');
    setPeriodicHighlight(el ? el.dataset.assetKey : null);
  });
  section.addEventListener('mouseleave', () => setPeriodicHighlight(null));
}

function renderPeriodicTable() {
  const scroll  = document.getElementById('periodic-scroll');
  const empty   = document.getElementById('periodic-empty');
  const legend  = document.getElementById('periodic-legend');
  const thead   = document.getElementById('periodic-thead');
  const tbody   = document.getElementById('periodic-tbody');
  const sub     = document.getElementById('periodic-sub');
  if (!scroll || !thead || !tbody || !legend) return;

  // Highlight state is per-render (cells are rebuilt below): reset it and make
  // sure the hover handlers are bound to the section once.
  const section = document.getElementById('periodic-section');
  bindPeriodicHighlight(section);
  periodicHlKey = null;
  if (section) section.classList.remove('pt-focus');
  // Portfolio constraint note starts hidden every render; the main path re-shows
  // it only when the portfolio row actually had to skip years.
  const pNote0 = document.getElementById('periodic-portfolio-note');
  if (pNote0) pNote0.hidden = true;

  const selected = STATE.step3.selectedAssets.slice();
  if (selected.length < 2) {
    scroll.hidden = true; empty.hidden = false; legend.innerHTML = '';
    empty.textContent = 'Select at least 2 asset classes above to see the periodic table.';
    if (sub) sub.textContent = '';
    return;
  }
  if (STATE.period === 'custom' && !STATE.step3.rangeValid) {
    scroll.hidden = true; empty.hidden = false; legend.innerHTML = '';
    empty.textContent = 'Periodic table paused — pick a range of at least 10 years above.';
    if (sub) sub.textContent = '';
    return;
  }
  scroll.hidden = false; empty.hidden = true;

  const [start, end] = getStep3Range();
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  const orderIndex = new Map();
  STATE.assets.forEach((a, i) => orderIndex.set(a.key, i));
  const keys = selected
    .filter((k) => byKey.has(k))
    .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

  // Build a year → data-row map once for O(1) lookups.
  const rowsByYear = new Map();
  for (const row of STATE.data.annual_returns) rowsByYear.set(row.year, row);

  // For each year in range, rank the selected assets that have data.
  const years = [];
  for (let y = start; y <= end; y++) years.push(y);
  const yearRankings = new Map();
  let maxRank = 0;
  years.forEach((y) => {
    const row = rowsByYear.get(y);
    if (!row) { yearRankings.set(y, []); return; }
    const ranked = keys
      .filter((k) => row[k] != null)
      .map((k) => ({ key: k, ret: row[k] }))
      .sort((a, b) => b.ret - a.ret);
    if (ranked.length > maxRank) maxRank = ranked.length;
    yearRankings.set(y, ranked);
  });

  // Summary column: assets sorted by CAGR desc across the whole range.
  const stats = new Map();
  keys.forEach((k) => stats.set(k, step3AssetStats(k, start, end)));
  const summary = keys.slice();

  // ---- Optional: the Simulator's loaded portfolio as an extra ranked row ----
  // Blended (annually-rebalanced) return per year; skips years where any holding
  // has no data and calls out which holding(s) constrained the row.
  const pf = STATE.step3.includePortfolio ? getSimulatorPortfolio() : null;
  let portfolioLabel = 'Portfolio';       // full label (legend + tooltips)
  let portfolioCellLabel = 'Portfolio';   // compact label for narrow table cells
  const noteEl = document.getElementById('periodic-portfolio-note');
  if (pf) {
    portfolioLabel = portfolioShortLabel(pf);
    portfolioCellLabel = portfolioLabel.startsWith('Portfolio ')
      ? portfolioLabel.slice('Portfolio '.length)  // "Portfolio 60/40" -> "60/40"
      : portfolioLabel;
    const pInfo = computePortfolioYearReturns(pf, start, end, rowsByYear);
    // Insert into each covered year's ranking + grow maxRank as needed.
    years.forEach((y) => {
      if (!pInfo.byYear.has(y)) return;
      const ranked = yearRankings.get(y);
      ranked.push({ key: PORTFOLIO_KEY, ret: pInfo.byYear.get(y), isPortfolio: true });
      ranked.sort((a, b) => b.ret - a.ret);
      if (ranked.length > maxRank) maxRank = ranked.length;
    });
    stats.set(PORTFOLIO_KEY, computePortfolioStats(pInfo.byYear));
    if (pInfo.byYear.size) summary.push(PORTFOLIO_KEY);
    // Constraint callout.
    if (noteEl) {
      if (pInfo.skipped.length) {
        const names = [...pInfo.missing.keys()].map((k) => (byKey.get(k) || {}).name || k);
        const nameStr = names.length === 1 ? names[0]
          : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
        noteEl.innerHTML =
          `Your portfolio row skips ${pInfo.skipped.length} year${pInfo.skipped.length === 1 ? '' : 's'} ` +
          `(${escapeHtml(compressYears(pInfo.skipped))}) — ${escapeHtml(nameStr)} ` +
          `${names.length === 1 ? 'has' : 'have'} no data then, so no blended return can be shown.`;
        noteEl.hidden = false;
      } else {
        noteEl.hidden = true;
        noteEl.textContent = '';
      }
    }
  } else if (noteEl) {
    noteEl.hidden = true;
    noteEl.textContent = '';
  }

  // Sort the summary column (assets + optional portfolio) by CAGR desc.
  summary.sort((a, b) => {
    const ca = stats.get(a)?.cagr, cb = stats.get(b)?.cagr;
    return (cb == null ? -Infinity : cb) - (ca == null ? -Infinity : ca);
  });

  // ---- Legend (color chip + asset name, grouped by family) ----
  legend.innerHTML = '';
  if (pf) {
    const item = document.createElement('span');
    item.className = 'periodic-legend__item periodic-legend__item--portfolio';
    item.dataset.assetKey = PORTFOLIO_KEY;
    const chip = document.createElement('span');
    chip.className = 'periodic-legend__chip';
    const label = document.createElement('span');
    label.className = 'periodic-legend__label';
    label.textContent = portfolioLabel + ' (your mix)';
    item.appendChild(chip);
    item.appendChild(label);
    legend.appendChild(item);
  }
  keys.forEach((k) => {
    const asset = byKey.get(k);
    const item = document.createElement('span');
    item.className = 'periodic-legend__item';
    item.dataset.group = groupSlug(asset.group);
    item.dataset.assetKey = k;
    const chip = document.createElement('span');
    chip.className = 'periodic-legend__chip';
    chip.style.background = assetColor(k);
    const label = document.createElement('span');
    label.className = 'periodic-legend__label';
    label.textContent = asset.name;
    item.appendChild(chip);
    item.appendChild(label);
    legend.appendChild(item);
  });

  // ---- Header row: [Rank] [year1] [year2] ... [yearN] [CAGR summary] ----
  thead.innerHTML = '';
  const hr = document.createElement('tr');
  const rankHead = document.createElement('th');
  rankHead.className = 'pt-rank-head';
  rankHead.scope = 'col';
  rankHead.textContent = 'Rank';
  hr.appendChild(rankHead);
  years.forEach((y) => {
    const th = document.createElement('th');
    th.className = 'pt-year-head';
    th.scope = 'col';
    th.textContent = y;
    hr.appendChild(th);
  });
  const sumHead = document.createElement('th');
  sumHead.className = 'pt-summary-head';
  sumHead.scope = 'col';
  sumHead.innerHTML = `${start}&ndash;${end}<br><span class="pt-summary-head__sub">CAGR / &sigma;</span>`;
  hr.appendChild(sumHead);
  thead.appendChild(hr);

  // ---- Body rows: one per rank slot ----
  // Extend to the longer of the tallest year column and the summary list, so a
  // portfolio (or any asset) that never shares a fully-populated year still gets
  // its summary row rendered.
  tbody.innerHTML = '';
  const rowCount = Math.max(maxRank, summary.length);
  for (let rank = 0; rank < rowCount; rank++) {
    const tr = document.createElement('tr');

    const rh = document.createElement('th');
    rh.className = 'pt-rank';
    rh.scope = 'row';
    rh.textContent = String(rank + 1);
    tr.appendChild(rh);

    years.forEach((y) => {
      const ranked = yearRankings.get(y);
      const entry = ranked[rank];
      if (!entry) {
        const td = document.createElement('td');
        td.className = 'pt-cell pt-cell--empty';
        tr.appendChild(td);
        return;
      }
      const td = document.createElement('td');
      td.className = 'pt-cell';
      td.dataset.assetKey = entry.key;
      let label;
      if (entry.isPortfolio) {
        td.classList.add('pt-cell--portfolio', 'pt-cell--dark');
        td.title = `${portfolioLabel} (your mix) · ${y}: ${fmtSignedPct(entry.ret)}\n` +
                   `Rank ${rank + 1} of ${ranked.length}`;
        label = portfolioCellLabel;
      } else {
        const asset = byKey.get(entry.key);
        td.style.background = assetColor(entry.key);
        if (assetColorIsDark(entry.key)) td.classList.add('pt-cell--dark');
        td.dataset.group = groupSlug(asset.group);
        td.title = `${asset.name} · ${y}: ${fmtSignedPct(entry.ret)}\n` +
                   `Rank ${rank + 1} of ${ranked.length}`;
        label = STEP3_SHORT_LABELS[entry.key] || asset.ticker || asset.name;
      }
      td.innerHTML =
        `<span class="pt-cell__label">${escapeHtml(label)}</span>` +
        `<span class="pt-cell__ret">${fmtSignedPct(entry.ret)}</span>`;
      tr.appendChild(td);
    });

    // Summary cell for this rank slot
    const sumKey = summary[rank];
    const td = document.createElement('td');
    td.className = 'pt-summary';
    if (!sumKey) {
      td.classList.add('pt-summary--empty');
    } else {
      const s = stats.get(sumKey);
      const isPf = sumKey === PORTFOLIO_KEY;
      td.dataset.assetKey = sumKey;
      let label;
      if (isPf) {
        td.classList.add('pt-summary--portfolio', 'pt-summary--dark');
        td.title = `${portfolioLabel} (your mix)\n` +
                   `CAGR ${s.cagr == null ? '—' : s.cagr.toFixed(2) + '%'} · ` +
                   `σ ${s.std == null ? '—' : s.std.toFixed(2) + '%'} · ` +
                   `${s.n} yrs`;
        label = portfolioCellLabel;
      } else {
        const asset = byKey.get(sumKey);
        td.style.background = assetColor(sumKey);
        if (assetColorIsDark(sumKey)) td.classList.add('pt-summary--dark');
        td.dataset.group = groupSlug(asset.group);
        td.title = `${asset.name}\n` +
                   `CAGR ${s.cagr == null ? '—' : s.cagr.toFixed(2) + '%'} · ` +
                   `σ ${s.std == null ? '—' : s.std.toFixed(2) + '%'} · ` +
                   `${s.n} yrs`;
        label = STEP3_SHORT_LABELS[sumKey] || asset.ticker || asset.name;
      }
      td.innerHTML =
        `<span class="pt-summary__label">${escapeHtml(label)}</span>` +
        `<span class="pt-summary__cagr">${s.cagr == null ? '—' : s.cagr.toFixed(1) + '%'}</span>` +
        `<span class="pt-summary__std">σ ${s.std == null ? '—' : s.std.toFixed(1) + '%'}</span>`;
    }
    tr.appendChild(td);

    tbody.appendChild(tr);
  }

  if (sub) {
    const periodLabel = STATE.period === 'custom'
      ? `Custom (${start}–${end})`
      : PERIOD_LABELS[STATE.period].name;
    sub.textContent =
      `${keys.length} assets${pf ? ' + your portfolio' : ''} · ${periodLabel} · ` +
      `${years.length} year column${years.length === 1 ? '' : 's'}.`;
  }

  // Wide ranges get parked at the latest year — recent decades are what
  // most users open the table to read first. Rank column stays sticky-left.
  if (scroll.scrollWidth > scroll.clientWidth) {
    scroll.scrollLeft = scroll.scrollWidth;
  }
}

/* ============================================================
   Tool 4 · Portfolio Optimizer (success-adjusted efficient frontier)
   ------------------------------------------------------------
   Sweeps a constrained grid of allocations over the shared selected
   assets, holding the Simulator tab's plan (balance, horizon, spending,
   income, strategy, period) fixed, and — in the engine phase — runs each
   candidate through the same Monte Carlo worker to find the portfolio with
   the highest real median CAGR that still clears the user's success floor.

   Phase 1 (this block): controls, constrained-grid enumeration/count with
   per-asset min/max caps, live candidate-count + runtime preview, and the
   "no spending plan" gate. The engine + results land in Phase 2/3.
   ============================================================ */

const OPTIMIZER_STEP_OPTIONS  = [5, 10, 20, 25];
const OPTIMIZER_SIMS_OPTIONS  = [1000, 2000, 5000, 10000];
// The portfolio ceiling is a FIXED count — the same regardless of sims or plan
// horizon, so the number the user sees is predictable. A bigger net is worth a
// longer wait: the live runtime ESTIMATE + soft warning below flag a slow run
// honestly (e.g. ~3 min at 10k sims × 10k portfolios) instead of silently
// shrinking the search. optimizerCandidateCap() returns this so every call site
// stays stable.
const OPTIMIZER_PORTFOLIO_CAP  = 10000;  // fixed portfolio ceiling per run
// Results tables always show at least this many portfolios (padded past the
// efficient frontier with the next-highest-CAGR mixes) so the user gets a real
// short-list to compare, even when the frontier itself collapses to 1–2 rows.
const OPTIMIZER_TABLE_MIN_ROWS  = 10;
// When a search is over the cap we recount up to this higher ceiling so the
// preview can tell the user *how many* they're over by (e.g. "12,480 — 2,480
// over the 10,000 limit"), instead of a bare "10,000+". Counting stops here, so
// a wildly-wide grid reads "100,000+ — 90,000+ over" rather than hanging.
const OPTIMIZER_COUNT_CEILING   = 100000;
const OPTIMIZER_WARN_MS         = 20000; // soft warning above ~20s estimated runtime
// Rough per-sim-year cost (ms) used only for the runtime estimate. Calibrated
// against measured throughput (~0.0002 ms/sim-year/core: 1,001 portfolios ×
// 1,000 sims × 30 yr ≈ 1.5s on 4 cores). Nudged up slightly so the estimate
// over- rather than under-promises, and it absorbs per-candidate + worker-startup
// overhead on smaller runs.
const OPTIMIZER_MS_PER_SIM_YEAR = 0.00025;
// The worker "optimize" path + pool orchestrator exist as of Phase 2.
const OPTIMIZER_ENGINE_READY = true;

const OPTIMIZER_STRATEGY_LABELS = {
  none:             'Fixed expense schedule',
  constant_dollar:  'Constant dollar',
  forgo_inflation:  'Forgo inflation in down years',
  actual_spending:  'Actual spending decline',
  guyton_klinger:   'Guyton-Klinger guardrails',
  vanguard_dynamic: 'Vanguard dynamic spending',
};

const OPTIMIZER_STATE = {
  step: 10,
  floorPct: 92,
  maxDrawdownPct: null,   // max investment drawdown the user will accept (magnitude %); null = off
  simsPerCandidate: 2000,
  caps: {},        // key -> { min: number|null, max: number|null } in whole %
  lastCount: 0,    // candidate count from the most recent preview
  poolSize: Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 4)),
  running: false,  // true while a batch is in flight
  lastRun: null,   // { points, plan, floorPct, N, step, elapsedMs, results }
  mode: 'free',    // 'free' (one-shot grid) | 'twostep' (stock/bond split → refine)
  twostep: {
    equityKey: null,       // Step-1 stock proxy
    fiKey: null,           // Step-1 bond proxy
    lockedEquityPct: null, // winning split (% stocks), locked into Step 2
    running: false,        // true while a Step-1 sweep is in flight
    step2Grid: 5,          // Step-2 sub-class weight grid (5 | 10); 10 only for mult-of-10 splits
  },
};

const OPTIMIZER_STORAGE_KEY = 'btn-mcsim-optimizer-selection';
const OPTIMIZER_MODE_KEY    = 'btn-mcsim-optimizer-mode';

// The portfolio ceiling: a fixed count, identical regardless of sims or horizon.
// Kept as a function so every call site stays stable; the runtime estimate + soft
// warning in updateOptimizer*Preview do the "this run will be slow" messaging.
function optimizerCandidateCap() {
  return OPTIMIZER_PORTFOLIO_CAP;
}

// Build the "how many over the limit" note for the preview, given a bounded total
// count and whether counting hit OPTIMIZER_COUNT_CEILING (bailed = true means the
// real total is even higher). Used by both optimizer modes.
function optimizerOverLimitNote(total, bailed) {
  const cap = optimizerCandidateCap();
  if (bailed) {
    return {
      totalStr: `${OPTIMIZER_COUNT_CEILING.toLocaleString('en-US')}+`,
      overStr:  `${(OPTIMIZER_COUNT_CEILING - cap).toLocaleString('en-US')}+ over the ${cap.toLocaleString('en-US')} limit`,
    };
  }
  const over = Math.max(0, total - cap);
  return {
    totalStr: total.toLocaleString('en-US'),
    overStr:  `${over.toLocaleString('en-US')} over the ${cap.toLocaleString('en-US')} limit`,
  };
}

/* ---- Optimizer's own asset universe (add/delete), independent of the Data tab.
   Mirrors the Data-tab chip + add-menu pattern, bound to STATE.optimizer. ---- */

function initOptimizerAssetSelection() {
  const validKeys = new Set(STATE.assets.map((a) => a.key));
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(OPTIMIZER_STORAGE_KEY)); } catch {}
  const restored = Array.isArray(stored) ? stored.filter((k) => validKeys.has(k)) : null;
  STATE.optimizer.selectedAssets =
    (restored && restored.length >= 1)
      ? restored
      : STEP3_DEFAULT_ASSETS.filter((k) => validKeys.has(k));
  renderOptimizerAssetChips();
  bindOptimizerAddAssetMenu();
}

function saveOptimizerSelection() {
  try { localStorage.setItem(OPTIMIZER_STORAGE_KEY, JSON.stringify(STATE.optimizer.selectedAssets)); } catch {}
}

function renderOptimizerAssetChips() {
  const chipContainer = document.getElementById('opt-asset-chips');
  if (!chipContainer) return;
  chipContainer.innerHTML = '';

  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  const orderIndex = new Map();
  STATE.assets.forEach((a, i) => orderIndex.set(a.key, i));
  const sorted = [...STATE.optimizer.selectedAssets]
    .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));

  sorted.forEach((key) => {
    const asset = byKey.get(key);
    if (!asset) return;
    const chip = document.createElement('span');
    chip.className = 'asset-chip';
    chip.dataset.group = groupSlug(asset.group);
    chip.innerHTML =
      `<span class="asset-chip__label">${escapeHtml(asset.name)}</span>` +
      `<button type="button" class="asset-chip__remove" aria-label="Remove ${escapeHtml(asset.name)}" data-key="${escapeHtml(key)}">&times;</button>`;
    chipContainer.appendChild(chip);
  });

  chipContainer.querySelectorAll('.asset-chip__remove').forEach((btn) => {
    btn.addEventListener('click', () => removeOptimizerAsset(btn.dataset.key));
  });

  updateOptimizerAssetCount();
}

function updateOptimizerAssetCount() {
  const countEl = document.getElementById('opt-selected-count');
  const warnEl  = document.getElementById('opt-asset-warning');
  const n = STATE.optimizer.selectedAssets.length;
  if (countEl) countEl.textContent = `(${n} selected)`;
  if (!warnEl) return;
  if (n < 2) {
    warnEl.hidden = false;
    warnEl.textContent = 'Add at least 2 asset classes for the optimizer to compare portfolios.';
  } else {
    warnEl.hidden = true;
    warnEl.textContent = '';
  }
}

function bindOptimizerAddAssetMenu() {
  const btn  = document.getElementById('opt-add-asset-btn');
  const menu = document.getElementById('opt-add-asset-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = menu.hidden;
    if (willOpen) buildOptimizerAddAssetMenu();
    menu.hidden = !willOpen;
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  });

  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || e.target === btn) return;
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      btn.focus();
    }
  });
}

function buildOptimizerAddAssetMenu() {
  const menu = document.getElementById('opt-add-asset-menu');
  if (!menu) return;
  menu.innerHTML = '';

  const selected = new Set(STATE.optimizer.selectedAssets);
  const available = STATE.assets.filter((a) => !selected.has(a.key));

  if (available.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'asset-selector__empty';
    empty.textContent = 'All asset classes are already selected.';
    menu.appendChild(empty);
    return;
  }

  const byGroup = new Map();
  available.forEach((a) => {
    if (!byGroup.has(a.group)) byGroup.set(a.group, []);
    byGroup.get(a.group).push(a);
  });

  GROUP_ORDER.forEach((group) => {
    if (!byGroup.has(group)) return;
    const heading = document.createElement('div');
    heading.className = 'asset-selector__group';
    heading.textContent = group;
    menu.appendChild(heading);
    byGroup.get(group).forEach((a) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'asset-selector__item';
      item.dataset.group = groupSlug(a.group);
      item.dataset.key = a.key;
      item.textContent = a.name;
      item.addEventListener('click', () => {
        addOptimizerAsset(a.key);
        menu.hidden = true;
        const btn = document.getElementById('opt-add-asset-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      });
      menu.appendChild(item);
    });
  });
}

function addOptimizerAsset(key) {
  if (STATE.optimizer.selectedAssets.includes(key)) return;
  STATE.optimizer.selectedAssets.push(key);
  saveOptimizerSelection();
  renderOptimizerAssetChips();
  renderOptimizerControls();
}

function removeOptimizerAsset(key) {
  STATE.optimizer.selectedAssets = STATE.optimizer.selectedAssets.filter((k) => k !== key);
  saveOptimizerSelection();
  renderOptimizerAssetChips();
  renderOptimizerControls();
}

// One-time setup: build the static selects, seed defaults, bind events.
function initOptimizer() {
  const stepSel = document.getElementById('optimizer-step');
  if (stepSel && stepSel.options.length === 0) {
    OPTIMIZER_STEP_OPTIONS.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = `${s}%`;
      if (s === OPTIMIZER_STATE.step) opt.selected = true;
      stepSel.appendChild(opt);
    });
    stepSel.addEventListener('change', () => {
      OPTIMIZER_STATE.step = parseInt(stepSel.value, 10) || 10;
      updateOptimizerPreview();
    });
  }

  const simsSel = document.getElementById('optimizer-sims');
  if (simsSel && simsSel.options.length === 0) {
    OPTIMIZER_SIMS_OPTIONS.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${n.toLocaleString('en-US')} sims`;
      if (n === OPTIMIZER_STATE.simsPerCandidate) opt.selected = true;
      simsSel.appendChild(opt);
    });
    simsSel.addEventListener('change', () => {
      OPTIMIZER_STATE.simsPerCandidate = parseInt(simsSel.value, 10) || 2000;
      updateOptimizerPreview();
    });
  }

  const floorInput = document.getElementById('optimizer-floor');
  if (floorInput) {
    floorInput.value = String(OPTIMIZER_STATE.floorPct);
    floorInput.addEventListener('input', () => {
      OPTIMIZER_STATE.floorPct = clampPct(parseFloat(floorInput.value), OPTIMIZER_STATE.floorPct);
      // The floor doesn't change the simulated points — only which one wins and
      // which rows clear it. If a run's config is otherwise unchanged, re-derive
      // the winner/frontier instantly instead of forcing a re-run.
      const lr = OPTIMIZER_STATE.lastRun;
      if (lr && lr.signature === optimizerConfigSignature()) rederiveOptimizerResults();
      updateOptimizerPreview();
    });
    floorInput.addEventListener('blur', () => {
      floorInput.value = String(OPTIMIZER_STATE.floorPct);
    });
  }

  const maxddInput = document.getElementById('optimizer-maxdd');
  if (maxddInput) {
    maxddInput.value = OPTIMIZER_STATE.maxDrawdownPct == null ? '' : String(OPTIMIZER_STATE.maxDrawdownPct);
    maxddInput.addEventListener('input', () => {
      const raw = maxddInput.value.trim();
      OPTIMIZER_STATE.maxDrawdownPct = raw === '' ? null : clampPct(parseFloat(raw), null);
      // The drawdown cap is a post-hoc filter — re-rank the existing run in place.
      const lr = OPTIMIZER_STATE.lastRun;
      if (lr && lr.signature === optimizerConfigSignature()) rederiveOptimizerResults();
      updateOptimizerPreview();
    });
  }

  const runBtn = document.getElementById('optimizer-run');
  if (runBtn) runBtn.addEventListener('click', runOptimizer);

  // Caps quick-presets. "Diversify" caps every covered asset at 50% and adds a 5%
  // floor — but only when the floor is feasible with room to vary. A 5% floor
  // snaps up to the weight grid (e.g. 10% on a 10% step), so with many assets
  // N×floor could exceed 100% (infeasible) or exactly equal it (only equal-weight
  // survives). In those cases we apply the 50% cap alone. Default stays open, so
  // concentrated/simple portfolios remain discoverable when no preset is applied.
  const presetBtn = document.getElementById('optimizer-preset-diversify');
  if (presetBtn) presetBtn.addEventListener('click', () => {
    const { covered } = optimizerGridPartition();
    const step = OPTIMIZER_STATE.step;
    const m = Math.round(100 / step);
    const floorUnits = Math.ceil(5 / step);              // grid units a 5% floor occupies
    const applyFloor = covered.length * floorUnits < m;  // strict → feasible AND leaves room to vary
    covered.forEach((k) => { OPTIMIZER_STATE.caps[k] = { min: applyFloor ? 5 : null, max: 50 }; });
    renderOptimizerControls();
  });
  const clearBtn = document.getElementById('optimizer-clear-caps');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    OPTIMIZER_STATE.caps = {};
    renderOptimizerControls();
  });

  initOptimizerMode();
  bindOptimizerTwoStep();
  initOptimizerAssetSelection();
  renderOptimizerControls();
}

/* ---- Mode toggle: free (one-shot grid) vs. two-step (stock/bond split first).
   Free mode is the original tool, untouched; two-step is built in c18i / c18j. ---- */
function initOptimizerMode() {
  let stored = null;
  try { stored = localStorage.getItem(OPTIMIZER_MODE_KEY); } catch {}
  if (stored === 'free' || stored === 'twostep') OPTIMIZER_STATE.mode = stored;

  document.querySelectorAll('#optimizer-mode .optimizer-mode__btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode === 'twostep' ? 'twostep' : 'free';
      if (mode === OPTIMIZER_STATE.mode) return;
      OPTIMIZER_STATE.mode = mode;
      try { localStorage.setItem(OPTIMIZER_MODE_KEY, mode); } catch {}
      applyOptimizerMode();
    });
  });
  applyOptimizerMode();
}

// Reflect the active mode: highlight the button, show the matching block, and
// (in two-step) render its panels.
function applyOptimizerMode() {
  const mode = OPTIMIZER_STATE.mode;
  document.querySelectorAll('#optimizer-mode .optimizer-mode__btn').forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const free = document.getElementById('optimizer-free');
  const two  = document.getElementById('optimizer-twostep');
  if (free) free.hidden = mode !== 'free';
  if (two)  two.hidden  = mode !== 'twostep';
  if (mode === 'twostep') renderOptimizerTwoStep();
}

/* ============================================================
   Two-step mode — Step 1: the stock / bond frontier (c18i)
   ============================================================ */

let optimizerStep1Chart = null;   // Chart.js instance for the split frontier
let optimizerStep1Run = null;     // { points, plan, floorPct, N, equityKey, fiKey, start, end, winner, winnerEquityPct }

const OPT_EQUITY_GROUPS = ['US Equity', 'International Equity'];
const OPT_FI_GROUP = 'Fixed Income';
const OPT_STEP1_SWEEP = 5;        // equity % increment across the frontier

// Compact money for chart-axis ticks: $1.2M, $800k, $950.
function optimizerMoneyShort(v) {
  if (v == null || !isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
}

function optimizerAssetName(key) {
  const a = STATE.assets.find((x) => x.key === key);
  return a ? a.name : key;
}

// Assets in the given groups that have full data over [start,end].
function optimizerCoveredInGroups(groups, start, end) {
  return STATE.assets
    .filter((a) => groups.includes(a.group) && optimizerAssetCoversPeriod(a.key, start, end))
    .map((a) => ({ key: a.key, name: a.name }));
}

// One-time binding of the Step-1 controls (buttons/selects are static HTML).
function bindOptimizerTwoStep() {
  const eqSel = document.getElementById('opt-step1-equity');
  const fiSel = document.getElementById('opt-step1-fi');
  if (eqSel) eqSel.addEventListener('change', () => {
    OPTIMIZER_STATE.twostep.equityKey = eqSel.value;
    updateOptimizerStep1Preview();
  });
  if (fiSel) fiSel.addEventListener('change', () => {
    OPTIMIZER_STATE.twostep.fiKey = fiSel.value;
    updateOptimizerStep1Preview();
  });

  // Floor + sims live in two-step too (the free-mode controls are hidden here);
  // both write the shared OPTIMIZER_STATE so the modes stay in sync.
  const floorInput = document.getElementById('opt-step1-floor');
  if (floorInput) {
    floorInput.addEventListener('input', () => {
      OPTIMIZER_STATE.floorPct = clampPct(parseFloat(floorInput.value), OPTIMIZER_STATE.floorPct);
      // Floor doesn't change the simulated splits — re-pick the winner + redraw
      // the floor line from the existing points, no re-run.
      if (optimizerStep1Run) rederiveOptimizerStep1();
      rederiveOptimizerStep2();
      syncOptimizerFreeFloorInput();
      updateOptimizerStep1Preview();
    });
    floorInput.addEventListener('blur', () => { floorInput.value = String(OPTIMIZER_STATE.floorPct); });
  }

  const maxddInput = document.getElementById('opt-step1-maxdd');
  if (maxddInput) {
    maxddInput.addEventListener('input', () => {
      const raw = maxddInput.value.trim();
      OPTIMIZER_STATE.maxDrawdownPct = raw === '' ? null : clampPct(parseFloat(raw), null);
      if (optimizerStep1Run) rederiveOptimizerStep1();
      rederiveOptimizerStep2();
      syncOptimizerFreeMaxddInput();
      updateOptimizerStep1Preview();
    });
  }

  const simsSel = document.getElementById('opt-step1-sims');
  if (simsSel && simsSel.options.length === 0) {
    OPTIMIZER_SIMS_OPTIONS.forEach((n) => {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${n.toLocaleString('en-US')} sims`;
      if (n === OPTIMIZER_STATE.simsPerCandidate) opt.selected = true;
      simsSel.appendChild(opt);
    });
    simsSel.addEventListener('change', () => {
      OPTIMIZER_STATE.simsPerCandidate = parseInt(simsSel.value, 10) || 2000;
      syncOptimizerFreeSimsInput();
      updateOptimizerStep1Preview();
      updateOptimizerStep2Preview();
    });
  }

  const runBtn = document.getElementById('opt-step1-run');
  if (runBtn) runBtn.addEventListener('click', runOptimizerStep1);
  const refineBtn = document.getElementById('opt-step1-refine');
  if (refineBtn) refineBtn.addEventListener('click', enterOptimizerStep2);
}

// Keep the (hidden) free-mode floor / sims inputs in step with two-step edits,
// so switching back to Optimize-freely shows the same values.
function syncOptimizerFreeFloorInput() {
  const f = document.getElementById('optimizer-floor');
  if (f) f.value = String(OPTIMIZER_STATE.floorPct);
}
function syncOptimizerFreeSimsInput() {
  const s = document.getElementById('optimizer-sims');
  if (s) s.value = String(OPTIMIZER_STATE.simsPerCandidate);
}
function syncOptimizerFreeMaxddInput() {
  const m = document.getElementById('optimizer-maxdd');
  if (m) m.value = OPTIMIZER_STATE.maxDrawdownPct == null ? '' : String(OPTIMIZER_STATE.maxDrawdownPct);
}

// Two-step renderer (called on mode switch / tab show / asset change).
function renderOptimizerTwoStep() {
  populateOptimizerProxySelects();
  // Sync the shared floor / drawdown cap / sims into the two-step inputs.
  const f = document.getElementById('opt-step1-floor');
  if (f) f.value = String(OPTIMIZER_STATE.floorPct);
  const md = document.getElementById('opt-step1-maxdd');
  if (md) md.value = OPTIMIZER_STATE.maxDrawdownPct == null ? '' : String(OPTIMIZER_STATE.maxDrawdownPct);
  const s = document.getElementById('opt-step1-sims');
  if (s) s.value = String(OPTIMIZER_STATE.simsPerCandidate);
  updateOptimizerStep1Preview();
  // If Step 2 is open, refresh its buckets/preview (asset selection may have
  // changed) without wiping any results it already shows.
  const step2 = document.getElementById('opt-step2');
  if (step2 && !step2.hidden) renderOptimizerStep2Controls();
  // Keep an existing frontier chart correctly sized when the tab re-shows.
  const two = document.getElementById('optimizer-twostep');
  if (optimizerStep1Chart && two && !two.hidden) optimizerStep1Chart.resize();
}

// Fill the equity / FI proxy dropdowns from covered assets, preserving the
// current pick when still valid, else defaulting (Total US Market / Interm Treasury).
function populateOptimizerProxySelects() {
  const { plan } = getSimulatorPlanForOptimizer();
  const [start, end] = optimizerPlanPeriodRange(plan);
  const eqSel = document.getElementById('opt-step1-equity');
  const fiSel = document.getElementById('opt-step1-fi');
  if (!eqSel || !fiSel) return;

  const fill = (sel, opts, preferred) => {
    const prev = sel.value;
    sel.innerHTML = '';
    opts.forEach((o) => {
      const el = document.createElement('option');
      el.value = o.key; el.textContent = o.name;
      sel.appendChild(el);
    });
    const keys = opts.map((o) => o.key);
    const pick = keys.includes(prev) ? prev
               : (preferred.find((k) => keys.includes(k)) || keys[0] || '');
    sel.value = pick;
    return pick;
  };

  OPTIMIZER_STATE.twostep.equityKey =
    fill(eqSel, optimizerCoveredInGroups(OPT_EQUITY_GROUPS, start, end), ['total_market_us', 'sp500']);
  OPTIMIZER_STATE.twostep.fiKey =
    fill(fiSel, optimizerCoveredInGroups([OPT_FI_GROUP], start, end), ['interm_treasury', 'total_bond']);
}

// Build the split sweep: equity 0..100 by OPT_STEP1_SWEEP, each a 1- or 2-asset
// allocation with non-zero weights only.
function optimizerStep1Candidates(equityKey, fiKey) {
  const out = [];
  for (let e = 0; e <= 100; e += OPT_STEP1_SWEEP) {
    if (e === 0)        out.push([{ key: fiKey, pct: 100 }]);
    else if (e === 100) out.push([{ key: equityKey, pct: 100 }]);
    else                out.push([{ key: equityKey, pct: e }, { key: fiKey, pct: 100 - e }]);
  }
  return out;
}

// % stocks for a split point (0 for the all-bonds point).
function optimizerStep1EquityPct(point, equityKey) {
  const hit = point.allocation.find((a) => a.key === equityKey);
  return hit ? hit.pct : 0;
}

function updateOptimizerStep1Preview() {
  const previewEl = document.getElementById('opt-step1-preview');
  const warnEl = document.getElementById('opt-step1-warning');
  const runBtn = document.getElementById('opt-step1-run');
  if (!previewEl || !runBtn) return;

  const { plan, hasSpending } = getSimulatorPlanForOptimizer();
  const eqKey = OPTIMIZER_STATE.twostep.equityKey;
  const fiKey = OPTIMIZER_STATE.twostep.fiKey;
  const nSplits = Math.floor(100 / OPT_STEP1_SWEEP) + 1;

  let warn = '';
  let canRun = true;
  if (!hasSpending) { canRun = false; }         // gate message shows via #optimizer-plan
  else if (!eqKey || !fiKey) {
    canRun = false;
    warn = 'Need a stock proxy and a bond proxy with full data over your plan period.';
  }

  if (!hasSpending) {
    previewEl.textContent = '';
  } else {
    const estMs = nSplits * OPTIMIZER_STATE.simsPerCandidate * plan.period_years *
                  OPTIMIZER_MS_PER_SIM_YEAR / OPTIMIZER_STATE.poolSize;
    const estStr = estMs < 1000 ? '~1s' : `~${Math.round(estMs / 1000)}s`;
    previewEl.innerHTML =
      `<strong>${nSplits}</strong> splits · <span class="optimizer-preview__est">${estStr} on ${OPTIMIZER_STATE.poolSize} core${OPTIMIZER_STATE.poolSize === 1 ? '' : 's'} · ${OPTIMIZER_STATE.simsPerCandidate.toLocaleString('en-US')} sims each</span>`;
  }
  if (warnEl) { warnEl.hidden = warn === ''; warnEl.textContent = warn; }
  runBtn.disabled = OPTIMIZER_STATE.twostep.running || !canRun;
}

function setOptimizerStep1Busy(busy) {
  const btn = document.getElementById('opt-step1-run');
  const prog = document.getElementById('opt-step1-progress');
  if (btn)  { btn.disabled = busy; btn.textContent = busy ? 'Finding…' : 'Find the split'; }
  if (prog) prog.hidden = !busy;
}

function optimizerStep1Progress(done, total) {
  const fill = document.getElementById('opt-step1-progress-fill');
  const label = document.getElementById('opt-step1-progress-label');
  if (fill) fill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  if (label) label.textContent =
    `Simulating every split in your browser — ${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`;
}

function runOptimizerStep1() {
  if (OPTIMIZER_STATE.running || OPTIMIZER_STATE.twostep.running) return;
  const { plan, hasSpending } = getSimulatorPlanForOptimizer();
  if (!hasSpending) return;
  const [start, end] = optimizerPlanPeriodRange(plan);
  const equityKey = OPTIMIZER_STATE.twostep.equityKey;
  const fiKey = OPTIMIZER_STATE.twostep.fiKey;
  if (!equityKey || !fiKey) return;

  const candidates = optimizerStep1Candidates(equityKey, fiKey);
  const floorPct = OPTIMIZER_STATE.floorPct;
  const N = OPTIMIZER_STATE.simsPerCandidate;
  const total = candidates.length;

  OPTIMIZER_STATE.twostep.running = true;
  setOptimizerStep1Busy(true);
  const refineBtn = document.getElementById('opt-step1-refine');
  if (refineBtn) refineBtn.disabled = true;
  optimizerStep1Progress(0, total);
  const startedAt = performance.now();

  runOptimizeBatch(candidates, plan, N, { onProgress: optimizerStep1Progress })
    .then((points) => {
      OPTIMIZER_STATE.twostep.running = false;
      setOptimizerStep1Busy(false);
      finishOptimizerStep1(points, { plan, floorPct, N, equityKey, fiKey, start, end,
                                     elapsedMs: performance.now() - startedAt });
    })
    .catch((err) => {
      OPTIMIZER_STATE.twostep.running = false;
      setOptimizerStep1Busy(false);
      const warnEl = document.getElementById('opt-step1-warning');
      if (warnEl) { warnEl.hidden = false; warnEl.textContent = (err && err.message) || 'The engine reported an error.'; }
    });
}

function finishOptimizerStep1(points, ctx) {
  const { plan, floorPct, N, equityKey, fiKey, start, end } = ctx;
  // Winner = max real median CAGR among splits clearing BOTH the success floor
  // and the max-drawdown cap. computeOptimizerResults tags meets_floor/meets_dd.
  const ddCap = OPTIMIZER_STATE.maxDrawdownPct;
  const res = computeOptimizerResults(points, floorPct, ddCap);
  const winner = res.best || res.closest || null;
  const winnerEquityPct = winner ? optimizerStep1EquityPct(winner, equityKey) : null;

  const prevLocked = OPTIMIZER_STATE.twostep.lockedEquityPct;
  optimizerStep1Run = { points, plan, floorPct, ddCap, N, equityKey, fiKey, start, end, winner, winnerEquityPct };
  OPTIMIZER_STATE.twostep.lockedEquityPct = winnerEquityPct;

  // If Step 2 is already open and the winning split moved (e.g. the floor
  // changed), refresh its buckets and drop the now-stale results.
  const step2 = document.getElementById('opt-step2');
  if (step2 && !step2.hidden && prevLocked !== winnerEquityPct) {
    renderOptimizerStep2Controls();
    const s2r = document.getElementById('opt-step2-results');
    if (s2r) s2r.hidden = true;
  }

  const results = document.getElementById('opt-step1-results');
  if (results) results.hidden = false;
  renderOptimizerStep1Chart(optimizerStep1Run);
  renderOptimizerStep1Table(optimizerStep1Run);

  const note = document.getElementById('opt-step1-winner-note');
  const refineBtn = document.getElementById('opt-step1-refine');
  const eqName = optimizerAssetName(equityKey);
  const fiName = optimizerAssetName(fiKey);
  if (winner && res.best) {
    if (note) note.innerHTML =
      `Winning split: <strong>${winnerEquityPct}% ${escapeHtml(eqName)} / ${100 - winnerEquityPct}% ${escapeHtml(fiName)}</strong>` +
      ` — ${winner.success_rate_pct.toFixed(1)}% success, ${winner.cagr_real_median.toFixed(2)}% real CAGR, ${optimizerFmtDD(winner.mdd_investment_median)} max drawdown.`;
    if (refineBtn) refineBtn.disabled = false;
  } else if (winner) {
    const why = ddCap != null ? `your ${floorPct}% success / ${ddCap}% drawdown limits` : `your ${floorPct}% floor`;
    if (note) note.innerHTML =
      `No split clears ${why}. Closest is <strong>${winnerEquityPct}% ${escapeHtml(eqName)} / ${100 - winnerEquityPct}% ${escapeHtml(fiName)}</strong>` +
      ` (${winner.success_rate_pct.toFixed(1)}% success, ${optimizerFmtDD(winner.mdd_investment_median)} drawdown) — loosen a limit or extend the data range.`;
    if (refineBtn) refineBtn.disabled = false;
  } else {
    if (note) note.textContent = 'No valid splits — check your plan and data range.';
    if (refineBtn) refineBtn.disabled = true;
  }
}

function renderOptimizerStep1Chart(run) {
  const canvas = document.getElementById('opt-step1-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const css = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
  const teal = css('--teal', '#1A6E6E');
  const gold = css('--gold', '#B58820');
  const clay = css('--clay', '#C84A30');
  const navy = css('--navy', '#1F3D6B');

  const pts = [...run.points].sort((a, b) =>
    optimizerStep1EquityPct(a, run.equityKey) - optimizerStep1EquityPct(b, run.equityKey));
  const eq = (p) => optimizerStep1EquityPct(p, run.equityKey);
  const successData  = pts.map((p) => ({ x: eq(p), y: p.success_rate_pct }));
  const drawdownData = pts.map((p) => ({ x: eq(p), y: p.mdd_investment_median == null ? null : Math.abs(p.mdd_investment_median) }));
  const wealthData   = pts.map((p) => ({ x: eq(p), y: p.ending_wealth_real }));
  const floorData    = [{ x: 0, y: run.floorPct }, { x: 100, y: run.floorPct }];
  const capData      = run.ddCap != null ? [{ x: 0, y: run.ddCap }, { x: 100, y: run.ddCap }] : null;

  const wePct = run.winnerEquityPct;
  const ptRadius = pts.map((p) => (eq(p) === wePct ? 6 : 2.5));
  const ptColor  = pts.map((p) => (eq(p) === wePct ? navy : teal));

  if (optimizerStep1Chart) optimizerStep1Chart.destroy();
  optimizerStep1Chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      datasets: [
        { label: 'Success rate', data: successData, borderColor: teal, backgroundColor: teal,
          yAxisID: 'y', tension: 0.25, pointRadius: ptRadius, pointBackgroundColor: ptColor,
          pointBorderColor: ptColor, order: 1 },
        { label: 'Max drawdown', data: drawdownData, borderColor: clay, backgroundColor: clay,
          yAxisID: 'y', tension: 0.25, pointRadius: 0, order: 2 },
        { label: `Success floor (${run.floorPct}%)`, data: floorData, borderColor: teal, backgroundColor: teal,
          yAxisID: 'y', pointRadius: 0, borderDash: [6, 4], borderWidth: 1.5, order: 0 },
        ...(capData ? [{ label: `Drawdown cap (${run.ddCap}%)`, data: capData, borderColor: clay, backgroundColor: clay,
          yAxisID: 'y', pointRadius: 0, borderDash: [6, 4], borderWidth: 1.5, order: 0 }] : []),
        { label: 'Median ending (real)', data: wealthData, borderColor: gold, backgroundColor: gold,
          yAxisID: 'y1', tension: 0.25, pointRadius: 0, order: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { type: 'linear', min: 0, max: 100,
             title: { display: true, text: '% in stocks' },
             ticks: { callback: (v) => `${v}%`, stepSize: 20 } },
        y: { position: 'left', min: 0, max: 100,
             title: { display: true, text: 'Success / drawdown' },
             ticks: { callback: (v) => `${v}%` } },
        y1: { position: 'right', grid: { drawOnChartArea: false },
              title: { display: true, text: 'Median ending (real)' },
              ticks: { callback: (v) => optimizerMoneyShort(v) } },
      },
      plugins: {
        legend: { display: true, position: 'bottom' },
        tooltip: { callbacks: {
          title: (items) => `${items[0].parsed.x}% stocks / ${100 - items[0].parsed.x}% bonds`,
          label: (item) => {
            const lbl = item.dataset.label;
            if (item.dataset.yAxisID === 'y1') return `Median ending (real): ${formatCurrency(item.parsed.y)}`;
            if (lbl.startsWith('Success floor') || lbl.startsWith('Drawdown cap')) return lbl;
            if (lbl === 'Max drawdown') return `Max drawdown: ${item.parsed.y.toFixed(1)}%`;
            return `Success: ${item.parsed.y.toFixed(1)}%`;
          },
        } },
      },
    },
  });
}

function renderOptimizerStep1Table(run) {
  const wrap = document.getElementById('opt-step1-table');
  if (!wrap) return;
  const eqName = optimizerAssetName(run.equityKey);
  const fiName = optimizerAssetName(run.fiKey);
  const pts = [...run.points].sort((a, b) =>
    optimizerStep1EquityPct(a, run.equityKey) - optimizerStep1EquityPct(b, run.equityKey));

  let html =
    `<table class="opt-step1-table"><thead><tr>` +
    `<th>Split (stocks / bonds)</th><th>Success</th><th>Real median CAGR</th>` +
    `<th>Median ending (real)</th><th>Volatility</th><th>Max drawdown</th></tr></thead><tbody>`;
  pts.forEach((p) => {
    const e = optimizerStep1EquityPct(p, run.equityKey);
    const vol = portfolioAnnualVol(p.allocation, run.start, run.end);
    const isWinner = e === run.winnerEquityPct;
    const clearsFloor = p.success_rate_pct >= run.floorPct;
    const clearsDD = run.ddCap == null || (p.mdd_investment_median != null && p.mdd_investment_median >= -run.ddCap);
    html +=
      `<tr class="${isWinner ? 'is-winner' : ''}">` +
      `<td>${e}% stocks / ${100 - e}% bonds</td>` +
      `<td class="${clearsFloor ? 'clears' : ''}">${p.success_rate_pct.toFixed(1)}%</td>` +
      `<td>${p.cagr_real_median != null ? p.cagr_real_median.toFixed(2) + '%' : '—'}</td>` +
      `<td>${formatCurrency(p.ending_wealth_real)}</td>` +
      `<td>${vol != null ? vol.toFixed(1) + '%' : '—'}</td>` +
      `<td class="${clearsDD ? '' : 'optimizer-dd-fail'}">${optimizerFmtDD(p.mdd_investment_median)}</td>` +
      `</tr>`;
  });
  html += `</tbody></table>`;
  const winCond = run.ddCap != null
    ? `the highest real median CAGR that clears your ${run.floorPct}% success floor and ${run.ddCap}% drawdown cap`
    : `the highest real median CAGR that still clears your ${run.floorPct}% floor`;
  html += `<p class="field-note small">Stocks = ${escapeHtml(eqName)} · Bonds = ${escapeHtml(fiName)}. Winner (highlighted) = ${winCond}.</p>`;
  wrap.innerHTML = html;
}

// Re-pick the Step-1 winner + redraw from the existing points at the current
// floor (no re-simulation) — used when the floor changes.
function rederiveOptimizerStep1() {
  const r = optimizerStep1Run;
  if (!r) return;
  finishOptimizerStep1(r.points, {
    plan: r.plan, floorPct: OPTIMIZER_STATE.floorPct, N: r.N,
    equityKey: r.equityKey, fiKey: r.fiKey, start: r.start, end: r.end, elapsedMs: 0,
  });
}

/* ============================================================
   Two-step mode — Step 2: refine within the locked split (c18j)
   ============================================================ */

// Step-2 sub-class weight grid, user-selectable (5% or 10%). Returns the chosen
// grid as-is; enumerateStep2Bucket() keeps each bucket's sum EXACTLY on the locked
// split even when a 10% grid can't tile an odd-5 split (e.g. 75/25) — it lets one
// fund per bucket carry the leftover 5%.
function optimizerStep2Step() {
  return OPTIMIZER_STATE.twostep.step2Grid || 5;
}

// Enumerate one bucket's compositions at the chosen grid, always summing EXACTLY
// to targetPct. A 10% grid is expressed as the 5% grid filtered to at most one
// weight ending in 5: on a mult-of-10 bucket that leaves only pure 10% weights
// (zero odd weights); on an odd-5 bucket it keeps the sum exact by letting exactly
// one fund carry the extra 5% (all others are multiples of 10). Respects per-fund
// caps because it filters the existing cap-aware enumeration.
function enumerateStep2Bucket(keys, targetPct, grid, cap) {
  if (targetPct === 0) return [[]];
  if (grid === 5 || targetPct % grid === 0) {
    return enumerateGridCompositions(keys, grid, cap, targetPct);
  }
  // grid === 10 on an odd-5 bucket: 5% grid, ≤1 weight ending in 5.
  const fine = enumerateGridCompositions(keys, 5, cap, targetPct);
  return fine.filter((alloc) => alloc.reduce((n, a) => n + (a.pct % 10 === 5 ? 1 : 0), 0) <= 1);
}

// Partition the optimizer's covered, selected assets into stock / bond buckets.
// Alternatives are excluded from two-step v1 and reported separately.
function optimizerStep2Buckets() {
  const { covered } = optimizerGridPartition();
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  const equityKeys = [], fiKeys = [], altKeys = [];
  covered.forEach((k) => {
    const g = (byKey.get(k) || {}).group;
    if (OPT_EQUITY_GROUPS.includes(g)) equityKeys.push(k);
    else if (g === OPT_FI_GROUP) fiKeys.push(k);
    else altKeys.push(k);
  });
  return { equityKeys, fiKeys, altKeys };
}

// User clicked "Refine this split →" — reveal + build Step 2.
function enterOptimizerStep2() {
  if (OPTIMIZER_STATE.twostep.lockedEquityPct == null) return;
  const sec = document.getElementById('opt-step2');
  if (!sec) return;
  sec.hidden = false;
  renderOptimizerStep2Shell();
  renderOptimizerStep2Controls();
  sec.scrollIntoView({ block: 'start' });
}

// Build the Step-2 inner shell once per entry, then bind its run button.
function renderOptimizerStep2Shell() {
  const sec = document.getElementById('opt-step2');
  if (!sec) return;
  sec.innerHTML =
    `<div class="opt-step__head"><span class="opt-step__num">Step 2</span>` +
    `<h3 class="opt-step__title">Refine within your split</h3></div>` +
    `<div id="opt-step2-banner" class="opt-step2-banner" aria-live="polite"></div>` +
    `<p class="opt-step__intro">Now hold that stock/bond split fixed and search for the best mix of ` +
    `specific asset classes <strong>inside each bucket</strong>. Uses the asset classes you selected ` +
    `above; pick a weight grid below and the buckets stay exactly on your split.</p>` +
    `<div id="opt-step2-gridrow" class="opt-step2-gridrow"></div>` +
    `<div id="opt-step2-caps" class="opt-step2-caps"></div>` +
    `<p id="opt-step2-warning" class="field-warning" hidden></p>` +
    `<div class="optimizer-run-row">` +
      `<div id="opt-step2-preview" class="optimizer-preview" aria-live="polite"></div>` +
      `<button type="button" id="opt-step2-run" class="btn-primary" disabled>Refine within this split</button>` +
    `</div>` +
    `<div id="opt-step2-progress" class="dev-progress optimizer-progress" hidden>` +
      `<p class="optimizer-progress__title">Running the model&hellip;</p>` +
      `<div class="dev-progress__bar"><div class="dev-progress__fill" id="opt-step2-progress-fill"></div></div>` +
      `<p class="dev-progress__label" id="opt-step2-progress-label">Simulating&hellip;</p>` +
    `</div>` +
    `<div id="opt-step2-results" class="optimizer-results" hidden></div>`;
  const runBtn = document.getElementById('opt-step2-run');
  if (runBtn) runBtn.addEventListener('click', runOptimizerStep2);
}

// Refresh the banner + bucketed caps + preview (does not touch results).
function renderOptimizerStep2Controls() {
  const E = OPTIMIZER_STATE.twostep.lockedEquityPct;
  const banner = document.getElementById('opt-step2-banner');
  const capsWrap = document.getElementById('opt-step2-caps');
  if (E == null || !banner || !capsWrap) return;
  const F = 100 - E;
  const { equityKeys, fiKeys, altKeys } = optimizerStep2Buckets();
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));

  banner.innerHTML = `Refining within <strong>${E}% stocks / ${F}% bonds</strong> — locked from Step 1.`;

  // Weight-grid selector (5% / 10%) — 10% is always available. For a mult-of-10
  // split it tiles cleanly; for an odd-5 split (e.g. 75/25) the enumeration keeps
  // the sum exact by letting one fund per bucket carry the leftover 5% (noted below).
  const oddSplit = E != null && E % 10 !== 0;
  const curGrid = optimizerStep2Step();
  const gridRow = document.getElementById('opt-step2-gridrow');
  if (gridRow) {
    gridRow.innerHTML =
      `<label class="opt-step2-gridrow__lab" for="opt-step2-grid">Weight grid</label>` +
      `<select id="opt-step2-grid" class="select opt-step2-grid__select">` +
        `<option value="5"${curGrid === 5 ? ' selected' : ''}>5% steps · finer</option>` +
        `<option value="10"${curGrid === 10 ? ' selected' : ''}>10% steps · fewer portfolios</option>` +
      `</select>` +
      (oddSplit ? `<span class="field-note small opt-step2-gridrow__note">Your ${E}/${F} split isn’t a multiple of 10 — a 10% grid keeps it exact by letting one fund per bucket carry the leftover 5%.</span>` : '');
    const gsel = document.getElementById('opt-step2-grid');
    if (gsel) gsel.addEventListener('change', () => {
      OPTIMIZER_STATE.twostep.step2Grid = parseInt(gsel.value, 10) || 5;
      renderOptimizerStep2Controls();   // rebuild caps (input step attrs) + preview
    });
  }

  let html = '';
  html += optimizerStep2BucketBlock('Stocks', E, equityKeys, byKey);
  html += optimizerStep2BucketBlock('Bonds', F, fiKeys, byKey);
  if (altKeys.length) {
    html += `<p class="field-note small">Not included in two-step: ` +
      `${altKeys.map((k) => escapeHtml((byKey.get(k) || {}).name || k)).join(', ')} (Alternatives). ` +
      `Use “Optimize freely” to include them.</p>`;
  }
  capsWrap.innerHTML = html;
  bindOptimizerStep2CapInputs();
  updateOptimizerStep2Preview();
}

function optimizerStep2BucketBlock(label, bucketPct, keys, byKey) {
  if (bucketPct === 0) return '';
  if (keys.length === 0) {
    return `<div class="opt-step2-bucket"><div class="opt-step2-bucket__head">${label} — ${bucketPct}% ` +
      `<span class="field-note small">needs at least one ${label.toLowerCase()} asset class selected above</span>` +
      `</div></div>`;
  }
  const rows = keys.map((key) => {
    const asset = byKey.get(key) || {};
    const cap = OPTIMIZER_STATE.caps[key] || {};
    const minVal = cap.min == null ? '' : cap.min;
    // Pre-fill the max at the bucket ceiling (E for stocks, F for bonds) so the
    // ceiling is visible; stored max stays null so it tracks the split until the
    // user types a tighter cap. min/max can't exceed the bucket total.
    const maxVal = cap.max == null ? bucketPct : cap.max;
    return `<div class="optimizer-cap-row" data-group="${groupSlug(asset.group)}">` +
      `<span class="optimizer-cap-row__name">${escapeHtml(asset.name || key)}</span>` +
      `<span class="optimizer-cap-row__field"><label class="optimizer-cap-row__lab" for="opt2-min-${escapeHtml(key)}">min</label>` +
        `<input id="opt2-min-${escapeHtml(key)}" class="num-input optimizer-cap-input opt2-cap" type="number" min="0" max="${bucketPct}" step="${optimizerStep2Step()}" inputmode="numeric" autocomplete="off" placeholder="0" value="${minVal}" data-key="${escapeHtml(key)}" data-bound="min" />` +
        `<span class="optimizer-cap-row__pct">%</span></span>` +
      `<span class="optimizer-cap-row__field"><label class="optimizer-cap-row__lab" for="opt2-max-${escapeHtml(key)}">max</label>` +
        `<input id="opt2-max-${escapeHtml(key)}" class="num-input optimizer-cap-input opt2-cap" type="number" min="0" max="${bucketPct}" step="${optimizerStep2Step()}" inputmode="numeric" autocomplete="off" placeholder="${bucketPct}" value="${maxVal}" data-key="${escapeHtml(key)}" data-bound="max" />` +
        `<span class="optimizer-cap-row__pct">%</span></span>` +
    `</div>`;
  }).join('');
  return `<div class="opt-step2-bucket"><div class="opt-step2-bucket__head">${label} — must total ${bucketPct}%</div>${rows}</div>`;
}

function bindOptimizerStep2CapInputs() {
  // Per-fund ceiling = its bucket total (stocks → E, bonds → F); a typed min/max
  // above that is meaningless (the split is locked), so clamp to it.
  const E = OPTIMIZER_STATE.twostep.lockedEquityPct;
  const F = E == null ? null : 100 - E;
  const { equityKeys, fiKeys } = optimizerStep2Buckets();
  const ceilOf = {};
  equityKeys.forEach((k) => { ceilOf[k] = E; });
  fiKeys.forEach((k) => { ceilOf[k] = F; });
  document.querySelectorAll('#opt-step2-caps .opt2-cap').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.key, bound = input.dataset.bound;
      if (!OPTIMIZER_STATE.caps[key]) OPTIMIZER_STATE.caps[key] = { min: null, max: null };
      const raw = input.value.trim();
      const parsed = raw === '' ? null : clampPct(parseFloat(raw), null);
      const ceil = ceilOf[key] != null ? ceilOf[key] : 100;
      OPTIMIZER_STATE.caps[key][bound] = parsed == null ? null : Math.min(parsed, ceil);
      updateOptimizerStep2Preview();
    });
  });
}

// Composition count for one bucket (targetPct=0 → the empty bucket, one way).
function optimizerStep2BucketCount(keys, targetPct, cap) {
  if (targetPct === 0) return { count: 1, feasible: true, exceeded: false };
  if (keys.length === 0) return { count: 0, feasible: false, exceeded: false };
  const grid = optimizerStep2Step();
  // Divisible grid (any 5% grid, or 10% on a mult-of-10 bucket): fast combinatorial count.
  if (grid === 5 || targetPct % grid === 0) {
    const { m, lo, hi } = optimizerUnitBounds(keys, grid, targetPct);
    return countGridCompositions(lo, hi, m, cap);
  }
  // 10% grid on an odd-5 bucket has no uniform tiling — enumerate the one-remainder
  // set and count it (Step-2 buckets are small).
  const arr = enumerateStep2Bucket(keys, targetPct, grid, cap);
  return { count: arr.length, feasible: arr.length > 0, exceeded: arr.length > cap };
}

// The full candidate set = equity compositions (sum E) × FI compositions (sum F).
function optimizerStep2Candidates() {
  const E = OPTIMIZER_STATE.twostep.lockedEquityPct;
  if (E == null) return { candidates: [], eqKeys: [], fiKeys: [] };
  const F = 100 - E;
  const { equityKeys, fiKeys } = optimizerStep2Buckets();
  const eqComps = E === 0 ? [[]] : enumerateStep2Bucket(equityKeys, E, optimizerStep2Step(), optimizerCandidateCap());
  const fiComps = F === 0 ? [[]] : enumerateStep2Bucket(fiKeys, F, optimizerStep2Step(), optimizerCandidateCap());
  const candidates = [];
  for (const ec of eqComps) {
    for (const fc of fiComps) {
      candidates.push(ec.concat(fc));
      if (candidates.length > optimizerCandidateCap()) {
        return { candidates, eqKeys: equityKeys, fiKeys, overflow: true };
      }
    }
  }
  return { candidates, eqKeys: equityKeys, fiKeys };
}

function updateOptimizerStep2Preview() {
  const previewEl = document.getElementById('opt-step2-preview');
  const warnEl = document.getElementById('opt-step2-warning');
  const runBtn = document.getElementById('opt-step2-run');
  if (!previewEl || !runBtn) return;

  const E = OPTIMIZER_STATE.twostep.lockedEquityPct;
  const F = E == null ? null : 100 - E;
  const { plan, hasSpending } = getSimulatorPlanForOptimizer();
  const { equityKeys, fiKeys } = optimizerStep2Buckets();

  let warn = '', canRun = true, count = 0, overNote = null;
  const eqCnt = optimizerStep2BucketCount(equityKeys, E || 0, optimizerCandidateCap());
  const fiCnt = optimizerStep2BucketCount(fiKeys, F || 0, optimizerCandidateCap());

  if (!hasSpending || E == null) { canRun = false; }
  else if (E > 0 && equityKeys.length === 0) { canRun = false; warn = 'Select at least one stock asset class above to fill the stock bucket.'; }
  else if (F > 0 && fiKeys.length === 0)     { canRun = false; warn = 'Select at least one bond asset class above to fill the bond bucket.'; }
  else if (!eqCnt.feasible || !fiCnt.feasible) { canRun = false; warn = 'No mix fits these per-asset limits — loosen a min/max.'; }
  else {
    count = eqCnt.count * fiCnt.count;
    if (eqCnt.exceeded || fiCnt.exceeded || count > optimizerCandidateCap()) {
      canRun = false;
      // Recount each bucket to a higher ceiling so we can report how far over the
      // cap the split is (buckets are small, so the product is exact well past 10k).
      const eqHi = optimizerStep2BucketCount(equityKeys, E || 0, OPTIMIZER_COUNT_CEILING);
      const fiHi = optimizerStep2BucketCount(fiKeys, F || 0, OPTIMIZER_COUNT_CEILING);
      const total = eqHi.count * fiHi.count;
      const bailed = eqHi.exceeded || fiHi.exceeded || total > OPTIMIZER_COUNT_CEILING;
      overNote = optimizerOverLimitNote(Math.min(total, OPTIMIZER_COUNT_CEILING), bailed);
      warn = `Too many mixes to run at a ${optimizerStep2Step()}% grid. Refine fewer sub-classes, add per-asset limits, or use a coarser grid.`;
    }
  }

  if (!hasSpending || E == null) {
    previewEl.textContent = '';
  } else if (count > 0 && canRun) {
    const estMs = count * OPTIMIZER_STATE.simsPerCandidate * plan.period_years * OPTIMIZER_MS_PER_SIM_YEAR / OPTIMIZER_STATE.poolSize;
    const estStr = estMs < 1000 ? '~1s' : `~${Math.round(estMs / 1000)}s`;
    previewEl.innerHTML =
      `<strong>${count.toLocaleString('en-US')}</strong> portfolio${count === 1 ? '' : 's'}` +
      ` · <span class="optimizer-preview__est">${estStr} on ${OPTIMIZER_STATE.poolSize} core${OPTIMIZER_STATE.poolSize === 1 ? '' : 's'}</span>`;
  } else if (overNote) {
    previewEl.innerHTML =
      `<strong>${overNote.totalStr}</strong> portfolios · <span class="optimizer-over">${overNote.overStr}</span>`;
  } else {
    previewEl.textContent = '';
  }

  if (warnEl) { warnEl.hidden = warn === ''; warnEl.textContent = warn; }
  runBtn.disabled = OPTIMIZER_STATE.twostep.running || !canRun || count < 1;
}

function setOptimizerStep2Busy(busy) {
  const btn = document.getElementById('opt-step2-run');
  const prog = document.getElementById('opt-step2-progress');
  if (btn)  { btn.disabled = busy; btn.textContent = busy ? 'Refining…' : 'Refine within this split'; }
  if (prog) prog.hidden = !busy;
}

function optimizerStep2Progress(done, total) {
  const fill = document.getElementById('opt-step2-progress-fill');
  const label = document.getElementById('opt-step2-progress-label');
  if (fill) fill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  if (label) label.textContent =
    `Simulating every portfolio in your browser — ${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`;
}

function runOptimizerStep2() {
  if (OPTIMIZER_STATE.running || OPTIMIZER_STATE.twostep.running) return;
  const { plan, hasSpending } = getSimulatorPlanForOptimizer();
  if (!hasSpending) return;
  const E = OPTIMIZER_STATE.twostep.lockedEquityPct;
  if (E == null) return;
  const [start, end] = optimizerPlanPeriodRange(plan);
  const { candidates, eqKeys, fiKeys, overflow } = optimizerStep2Candidates();
  if (overflow || candidates.length === 0 || candidates.length > optimizerCandidateCap()) return;

  const floorPct = OPTIMIZER_STATE.floorPct;
  const N = OPTIMIZER_STATE.simsPerCandidate;
  const total = candidates.length;

  OPTIMIZER_STATE.twostep.running = true;
  setOptimizerStep2Busy(true);
  optimizerStep2Progress(0, total);
  const startedAt = performance.now();

  runOptimizeBatch(candidates, plan, N, { onProgress: optimizerStep2Progress })
    .then((points) => {
      OPTIMIZER_STATE.twostep.running = false;
      setOptimizerStep2Busy(false);
      finishOptimizerStep2(points, { plan, floorPct, N, keys: [...eqKeys, ...fiKeys],
                                     start, end, elapsedMs: performance.now() - startedAt, E });
    })
    .catch((err) => {
      OPTIMIZER_STATE.twostep.running = false;
      setOptimizerStep2Busy(false);
      const warnEl = document.getElementById('opt-step2-warning');
      if (warnEl) { warnEl.hidden = false; warnEl.textContent = (err && err.message) || 'The engine reported an error.'; }
    });
}

let optimizerStep2Chart = null;   // Chart.js scatter for the refined-mix frontier
let optimizerStep2Run = null;     // { points, plan, floorPct, ddCap, N, keys, elapsedMs, E }

function finishOptimizerStep2(points, ctx) {
  const { plan, floorPct, N, keys, elapsedMs, E } = ctx;
  const ddCap = OPTIMIZER_STATE.maxDrawdownPct;
  const res = computeOptimizerResults(points, floorPct, ddCap);
  optimizerStep2Run = { points, plan, floorPct, ddCap, N, keys, elapsedMs, E };
  // Park this as the "last run" so the shared JSON/CSV export path exports it.
  OPTIMIZER_STATE.lastRun = {
    points, plan, floorPct, ddCap, N, step: optimizerStep2Step(), elapsedMs, keys, results: res,
    signature: optimizerConfigSignature(),
  };
  renderOptimizerStep2Results(res, { points, floorPct, ddCap, N, step: optimizerStep2Step(), elapsedMs, total: points.length, E });
}

// Re-rank the last Step-2 run at the current floor + drawdown cap (no re-sim).
// Only fires while Step-2 results are on screen.
function rederiveOptimizerStep2() {
  const r = optimizerStep2Run;
  const box = document.getElementById('opt-step2-results');
  if (!r || !box || box.hidden) return;
  const floorPct = OPTIMIZER_STATE.floorPct;
  const ddCap = OPTIMIZER_STATE.maxDrawdownPct;
  const res = computeOptimizerResults(r.points, floorPct, ddCap);
  r.floorPct = floorPct; r.ddCap = ddCap;
  OPTIMIZER_STATE.lastRun = {
    points: r.points, plan: r.plan, floorPct, ddCap, N: r.N, step: optimizerStep2Step(),
    elapsedMs: r.elapsedMs, keys: r.keys, results: res, signature: optimizerConfigSignature(),
  };
  renderOptimizerStep2Results(res, { points: r.points, floorPct, ddCap, N: r.N, step: optimizerStep2Step(), elapsedMs: r.elapsedMs, total: r.points.length, E: r.E });
}

function renderOptimizerStep2Results(res, meta) {
  const box = document.getElementById('opt-step2-results');
  if (!box) return;
  box.hidden = false;
  const { best, closest, frontier, invalidCount } = res;
  const { points, floorPct, ddCap, N, step, elapsedMs, total, E } = meta;
  const F = 100 - E;
  const pick = best || closest;
  const constraint = optimizerConstraintLabel(floorPct, ddCap);

  let headline;
  if (best) {
    headline =
      `<div class="optimizer-best">` +
        `<p class="optimizer-best__label">Best ${E}/${F} portfolio clearing ${constraint}</p>` +
        `<p class="optimizer-best__alloc">${optimizerAllocationSummary(best.allocation)}</p>` +
        `<div class="optimizer-best__stats">` +
          statPill('Success', optimizerFmtPct(best.success_rate_pct)) +
          statPill('Real median CAGR', optimizerFmtPct(best.cagr_real_median, 2)) +
          statPill('Median ending (real)', formatCurrency(Math.round(best.ending_wealth_real))) +
          statPill('Max drawdown', optimizerFmtDD(best.mdd_investment_median)) +
        `</div>` +
      `</div>`;
  } else if (closest) {
    headline =
      `<div class="optimizer-best optimizer-best--miss">` +
        `<p class="optimizer-best__label">No ${E}/${F} mix cleared ${constraint}</p>` +
        `<p class="optimizer-best__alloc">Closest: ${optimizerAllocationSummary(closest.allocation)}</p>` +
        `<div class="optimizer-best__stats">` +
          statPill('Success', optimizerFmtPct(closest.success_rate_pct)) +
          statPill('Real median CAGR', optimizerFmtPct(closest.cagr_real_median, 2)) +
          statPill('Median ending (real)', formatCurrency(Math.round(closest.ending_wealth_real))) +
          statPill('Max drawdown', optimizerFmtDD(closest.mdd_investment_median)) +
        `</div>` +
        `<p class="field-note small">The split is locked — lower your floor, raise your drawdown cap, or go back and pick a different split.</p>` +
      `</div>`;
  } else {
    headline = `<div class="optimizer-best optimizer-best--miss"><p class="optimizer-best__label">No valid portfolios in this split.</p></div>`;
  }

  // Risk/return scatter card (built here so its canvas is in the DOM before the chart).
  let chartCard = '';
  if (pick) {
    const capNote = ddCap != null ? ' · dashed = your drawdown cap' : '';
    chartCard =
      `<div class="chart-card opt-step2-chart-card">` +
        `<div class="chart-card__head"><h3 class="chart-card__title">Return vs. drawdown — refined mixes</h3></div>` +
        `<div class="chart-container opt-step2-chart-container"><canvas id="opt-step2-chart"></canvas></div>` +
        `<p class="chart-card__note">Each dot is a portfolio at your locked split. Teal = clears both limits · gray = fails a limit · navy = winner · teal line = most return at each drawdown${capNote}.</p>` +
      `</div>`;
  }

  // Frontier table (winner always shown, even if the cap pushes it off the
  // success/CAGR frontier), with a Max Drawdown column. Padded up to the top 10
  // so a locked split that yields a 1–2-point frontier still gives a real list.
  const frontierRows = optimizerTableRows(res, OPTIMIZER_TABLE_MIN_ROWS);
  let table = '';
  if (frontierRows.length) {
    const rows = frontierRows.map((p) => {
      const isBest = p === best;
      return `<tr class="${isBest ? 'is-best' : ''}${p.qualifies ? '' : ' is-belowfloor'}">` +
        `<td class="optimizer-rt__alloc">${optimizerAllocationSummary(p.allocation)}${isBest ? ' <span class="optimizer-tag">best</span>' : ''}</td>` +
        `<td class="num">${optimizerFmtPct(p.success_rate_pct)}</td>` +
        `<td class="num">${optimizerFmtPct(p.cagr_real_mean, 2)}</td>` +
        `<td class="num">${optimizerFmtPct(p.cagr_real_median, 2)}</td>` +
        `<td class="num">${formatCurrency(Math.round(p.ending_wealth_real))}</td>` +
        `<td class="num${p.meets_dd ? '' : ' optimizer-dd-fail'}">${optimizerFmtDD(p.mdd_investment_median)}</td>` +
      `</tr>`;
    }).join('');
    const dimNote = ddCap != null ? 'Rows failing your floor or drawdown cap are dimmed.' : 'Rows below your floor are dimmed.';
    table =
      `<div class="optimizer-rt-head">Efficient frontier <span class="field-note small">— non-dominated mixes within your locked split; your winner is highlighted. ${dimNote}</span></div>` +
      `<div class="table-wrap"><table class="optimizer-rt"><thead><tr>` +
        `<th>Allocation</th><th class="num">Success</th><th class="num">Avg CAGR (real)</th><th class="num">Median CAGR (real)</th><th class="num">Median ending (real)</th><th class="num">Max drawdown</th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  const actions =
    `<div class="optimizer-actions">` +
      (pick ? `<button type="button" class="optimizer-btn" id="opt-step2-load-sim">Load ${best ? 'best' : 'closest'} into Simulator</button>` : '') +
      `<button type="button" class="optimizer-btn" id="opt-step2-export-json">Export JSON</button>` +
      `<button type="button" class="optimizer-btn" id="opt-step2-export-csv">Export CSV</button>` +
    `</div>`;

  const meta1 = `<p class="optimizer-meta field-note small">Ran <strong>${total.toLocaleString('en-US')}</strong> portfolios × ${N.toLocaleString('en-US')} sims in ${(elapsedMs / 1000).toFixed(1)}s · ${step}% sub-class grid, split locked at ${E}/${F}${invalidCount ? ` · ${invalidCount} skipped` : ''}. Success/CAGR are Monte-Carlo estimates — re-check the winner in the Simulator at full sims.</p>`;

  box.innerHTML = headline + chartCard + actions + table + meta1;

  if (pick) renderOptimizerStep2Chart(res, meta);

  const loadBtn = document.getElementById('opt-step2-load-sim');
  if (loadBtn && pick) loadBtn.addEventListener('click', () => loadAllocationIntoSimulator(pick.allocation));
  const jsonBtn = document.getElementById('opt-step2-export-json');
  if (jsonBtn) jsonBtn.addEventListener('click', exportOptimizerJSON);
  const csvBtn = document.getElementById('opt-step2-export-csv');
  if (csvBtn) csvBtn.addEventListener('click', exportOptimizerCSV);
}

// Efficient-frontier scatter for the refined mixes: real median CAGR (Y) vs.
// max drawdown (X). Qualifying dots teal, cap/floor failures gray, winner navy;
// a teal line traces the CAGR-vs-drawdown efficient set, and a dashed line marks
// the drawdown cap.
function renderOptimizerStep2Chart(res, meta) {
  const canvas = document.getElementById('opt-step2-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const css = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
  const teal = css('--teal', '#1A6E6E');
  const clay = css('--clay', '#C84A30');
  const navy = css('--navy', '#1F3D6B');
  const faint = css('--faint', '#c7c7c7');

  const { points, ddCap } = meta;
  const best = res.best;
  const ddMag = (p) => Math.abs(p.mdd_investment_median);
  const valid = points.filter((p) => !p.invalid && p.cagr_real_median != null &&
                                     Number.isFinite(p.cagr_real_median) && p.mdd_investment_median != null);
  if (!valid.length) { if (optimizerStep2Chart) { optimizerStep2Chart.destroy(); optimizerStep2Chart = null; } return; }

  // CAGR-vs-drawdown efficient set: no other valid point has ≤ drawdown AND ≥ CAGR.
  const eff = valid.filter((p) => !valid.some((q) =>
    q !== p && ddMag(q) <= ddMag(p) && q.cagr_real_median >= p.cagr_real_median &&
    (ddMag(q) < ddMag(p) || q.cagr_real_median > p.cagr_real_median)))
    .sort((a, b) => ddMag(a) - ddMag(b));

  const pt = (p) => ({ x: ddMag(p), y: p.cagr_real_median, alloc: optimizerAllocLines(p.allocation) });
  const qual = valid.filter((p) => p.qualifies && p !== best).map(pt);
  const fail = valid.filter((p) => !p.qualifies && p !== best).map(pt);

  const cagrs = valid.map((p) => p.cagr_real_median);
  const yMin = Math.min(...cagrs), yMax = Math.max(...cagrs);
  const capData = ddCap != null ? [{ x: ddCap, y: yMin }, { x: ddCap, y: yMax }] : null;

  const datasets = [
    { type: 'line', label: 'Efficient set', data: eff.map(pt), borderColor: teal, backgroundColor: teal,
      pointRadius: 0, borderWidth: 1.5, tension: 0.1, order: 3 },
    { type: 'scatter', label: 'Fails a limit', data: fail, backgroundColor: faint, borderColor: faint, pointRadius: 3, order: 2 },
    { type: 'scatter', label: 'Clears both limits', data: qual, backgroundColor: teal, borderColor: teal, pointRadius: 3.5, order: 1 },
    ...(best ? [{ type: 'scatter', label: 'Winner', data: [pt(best)], backgroundColor: navy, borderColor: navy, pointRadius: 7, order: 0 }] : []),
    ...(capData ? [{ type: 'line', label: `Drawdown cap (${ddCap}%)`, data: capData, borderColor: clay, backgroundColor: clay,
      pointRadius: 0, borderDash: [6, 4], borderWidth: 1.5, order: 0 }] : []),
  ];

  if (optimizerStep2Chart) optimizerStep2Chart.destroy();
  optimizerStep2Chart = new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Max drawdown (bear-market)' }, ticks: { callback: (v) => `${v}%` } },
        y: { type: 'linear', title: { display: true, text: 'Real median CAGR' }, ticks: { callback: (v) => `${v}%` } },
      },
      plugins: {
        legend: { display: true, position: 'bottom' },
        tooltip: { callbacks: {
          label: (item) => {
            const lbl = item.dataset.label;
            if (lbl.startsWith('Drawdown cap')) return lbl;
            const head = `${item.parsed.y.toFixed(2)}% CAGR @ ${item.parsed.x.toFixed(1)}% drawdown`;
            const alloc = (item.raw && item.raw.alloc) ? item.raw.alloc : [];
            return [head, ...alloc];
          },
        } },
      },
    },
  });
}

// Rebuild the parts of Tool 4 that depend on the shared selection or the
// Simulator plan. Called from refreshStep3Tools (asset add/remove, range change)
// and when the Data tab becomes visible (plan may have changed on the Simulator).
function renderOptimizerControls() {
  renderOptimizerPlan();
  renderOptimizerCaps();
  updateOptimizerPreview();
  applyOptimizerMode();
}

// clamp helper: returns a number in [0,100], or the fallback for NaN/blank.
function clampPct(v, fallback) {
  if (v == null || Number.isNaN(v)) return fallback;
  return Math.min(100, Math.max(0, v));
}

// Selected assets ordered by the master asset order (stable UI).
function optimizerSelectedKeys() {
  const orderIndex = new Map();
  STATE.assets.forEach((a, i) => orderIndex.set(a.key, i));
  return [...STATE.optimizer.selectedAssets]
    .filter((k) => orderIndex.has(k))
    .sort((a, b) => (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0));
}

/* ---- Data-coverage gating ----
   The optimizer simulates every candidate over the SAME window — the Simulator
   plan's historical period. If a portfolio held a late-starting asset, the
   engine would intersect the year pool down to that asset's first year, so
   different candidates would be judged over different histories — an unfair
   frontier. So the grid only includes assets with FULL data over the plan
   period; late-starting ones are surfaced separately and left out of the grid.
   (The correlation matrix and periodic table intentionally still show partial-
   coverage assets — only the optimizer needs a level playing field.) */

// [start, end] of the plan's historical period (what the optimizer runs over).
function optimizerPlanPeriodRange(plan) {
  if (plan.historical_period === 'custom') return [plan.custom_start, plan.custom_end];
  const p = PERIOD_LABELS[plan.historical_period];
  return p ? [p.start, p.end] : [null, null];
}

// True if `key` has a non-null return for every year in [start, end].
function optimizerAssetCoversPeriod(key, start, end) {
  if (start == null || end == null) return true;
  for (const row of STATE.data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (row[key] == null) return false;
  }
  return true;
}

// First year `key` has data — used to explain why an asset was excluded.
function optimizerAssetFirstYear(key) {
  let first = null;
  for (const row of STATE.data.annual_returns) {
    if (row[key] != null && (first == null || row.year < first)) first = row.year;
  }
  return first;
}

// Partition the selected assets into { covered, excluded } for the current plan
// period. `covered` (full history) drives the grid; `excluded` is reported.
function optimizerGridPartition() {
  const keys = optimizerSelectedKeys();
  const { plan } = getSimulatorPlanForOptimizer();
  const [start, end] = optimizerPlanPeriodRange(plan);
  const covered = [], excluded = [];
  for (const k of keys) {
    if (optimizerAssetCoversPeriod(k, start, end)) covered.push(k);
    else excluded.push(k);
  }
  return { covered, excluded, start, end };
}

// Snapshot the Simulator tab's current plan (everything except allocations),
// matching the shape runSimulationFromInputs builds for the worker.
function getSimulatorPlanForOptimizer() {
  const buckets = Array.isArray(INPUT_STATE.buckets) ? INPUT_STATE.buckets : [];
  const bucket1Annual = buckets.length ? (buckets[0].expense || 0) : 0;
  const hasSpending = bucket1Annual > 0;
  const plan = {
    period_years:        INPUT_STATE.period_years,
    current_age:         INPUT_STATE.current_age,
    initial_balance:     INPUT_STATE.initial_balance,
    historical_period:   INPUT_STATE.historical_period,
    custom_start:        INPUT_STATE.custom_start,
    custom_end:          INPUT_STATE.custom_end,
    sequence_of_returns: INPUT_STATE.sequence_of_returns,
    sor_force_2008:      INPUT_STATE.sor_force_2008,
    inflation_adjust:    INPUT_STATE.inflation_adjust,
    expense_mode:        'annual',
    spouse_b_age:        INPUT_STATE.spouse_b_age,
    ss:        { ...INPUT_STATE.ss },
    pension:   { ...INPUT_STATE.pension },
    ss_b:      { ...INPUT_STATE.ss_b },
    pension_b: { ...INPUT_STATE.pension_b },
    annuity:   { ...INPUT_STATE.annuity },
    buckets: buckets.map((b) => ({ expense: b.expense || 0 })),
    distribution_strategy:     INPUT_STATE.distribution_strategy,
    minimum_withdrawal_annual: INPUT_STATE.minimum_withdrawal_annual,
    strategy_params:           { ...INPUT_STATE.strategy_params },
  };
  return { plan, hasSpending, bucket1Annual };
}

// Annualized volatility of a portfolio's *historical* annual returns over the
// plan period — the classic "risk" number paired with return on a frontier.
// Deterministic and main-thread (independent of the Monte Carlo draws), computed
// from STATE.data.annual_returns (the same series the correlation matrix uses).
// `allocation` is [{ key, pct }] with pct in whole %. annual_returns are stored
// in percent (e.g. 21.5 = +21.5%), so the result is a std dev already in percent
// points (e.g. 17.3 = 17.3% annualized vol) — null if fewer than 2 usable years.
// Sample std dev (n-1), matching spreadsheet STDEV.
function portfolioAnnualVol(allocation, start, end) {
  if (start == null || end == null) return null;
  const weights = allocation.map((a) => ({ key: a.key, w: a.pct / 100 }));
  const series = [];
  for (const row of STATE.data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    let r = 0, ok = true;
    for (const { key, w } of weights) {
      const v = row[key];
      if (v == null) { ok = false; break; }
      r += w * v;
    }
    if (ok) series.push(r);
  }
  const n = series.length;
  if (n < 2) return null;
  const mean = series.reduce((s, x) => s + x, 0) / n;
  let sq = 0;
  for (const x of series) sq += (x - mean) * (x - mean);
  return Math.sqrt(sq / (n - 1));
}

function optimizerPeriodLabel(plan) {
  if (plan.historical_period === 'custom') {
    return `Custom (${plan.custom_start}–${plan.custom_end})`;
  }
  const p = PERIOD_LABELS[plan.historical_period];
  return p ? p.name : plan.historical_period;
}

// Plan summary chip, or the spending gate when no expense is configured.
function renderOptimizerPlan() {
  const box = document.getElementById('optimizer-plan');
  const controls = document.getElementById('optimizer-controls');
  if (!box) return;
  const { plan, hasSpending, bucket1Annual } = getSimulatorPlanForOptimizer();

  if (!hasSpending) {
    box.className = 'optimizer-plan optimizer-plan--gate';
    box.innerHTML =
      `<strong>No spending set.</strong> The optimizer compares how long each portfolio ` +
      `lasts, so it needs an annual expense. Open the <strong>Simulator</strong> tab and enter ` +
      `an expense (Bucket 1), then come back.`;
    if (controls) controls.hidden = true;
    return;
  }

  if (controls) controls.hidden = false;
  box.className = 'optimizer-plan';
  const startAge = plan.current_age;
  const endAge   = plan.current_age + plan.period_years;
  const strategy = OPTIMIZER_STRATEGY_LABELS[plan.distribution_strategy] || plan.distribution_strategy;
  const parts = [
    `<strong>${formatCurrency(plan.initial_balance)}</strong> start`,
    `${plan.period_years} yrs (age ${startAge}→${endAge})`,
    `<strong>${formatCurrency(bucket1Annual)}/yr</strong> spending`,
    strategy,
    optimizerPeriodLabel(plan),
  ];
  box.innerHTML =
    `<span class="optimizer-plan__label">Using your Simulator plan:</span> ` +
    parts.map((p) => `<span class="optimizer-plan__chip">${p}</span>`).join('');
}

// Surface any selected assets left out of the grid for lack of full history.
function renderOptimizerExcludedNote(excluded, start, byKey) {
  const note = document.getElementById('optimizer-excluded-note');
  if (!note) return;
  if (!excluded || excluded.length === 0 || start == null) {
    note.hidden = true;
    note.innerHTML = '';
    return;
  }
  const items = excluded.map((k) => {
    const name = (byKey.get(k) || {}).name || k;
    const fy = optimizerAssetFirstYear(k);
    return `${escapeHtml(name)}${fy ? ` (data from ${fy})` : ''}`;
  }).join(', ');
  note.hidden = false;
  note.innerHTML =
    `<strong>Left out of the grid</strong> — no data back to ${start} (your Simulator plan's period): ${items}. ` +
    `Every portfolio is scored over the same window, so a shorter-history asset can't be mixed in fairly. ` +
    `To include one, set the Simulator plan to a period starting at or after its first year (e.g. a custom range).`;
}

// Build the per-asset min/max rows, preserving caps for still-selected assets.
// Only assets with full data over the plan period get a row (see coverage note);
// late-starting ones are listed separately in the excluded note.
function renderOptimizerCaps() {
  const wrap = document.getElementById('optimizer-caps-rows');
  if (!wrap) return;
  const selected = optimizerSelectedKeys();
  const { covered, excluded, start } = optimizerGridPartition();
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));

  // Prune caps for assets no longer selected (keep caps for excluded-but-selected
  // ones, in case a plan-period change brings them back into coverage).
  Object.keys(OPTIMIZER_STATE.caps).forEach((k) => {
    if (!selected.includes(k)) delete OPTIMIZER_STATE.caps[k];
  });

  renderOptimizerExcludedNote(excluded, start, byKey);

  wrap.innerHTML = '';
  if (covered.length < 2) {
    wrap.innerHTML = (selected.length >= 2 && excluded.length)
      ? `<p class="field-note small">Fewer than 2 of your selected assets have full data back to ${start}. Add longer-history assets, or set the Simulator plan to a later start.</p>`
      : `<p class="field-note small">Select at least 2 asset classes above to optimize.</p>`;
    return;
  }

  covered.forEach((key) => {
    const asset = byKey.get(key);
    if (!asset) return;
    const cap = OPTIMIZER_STATE.caps[key] || {};
    const minVal = cap.min == null ? '' : cap.min;
    const maxVal = cap.max == null ? '' : cap.max;
    const row = document.createElement('div');
    row.className = 'optimizer-cap-row';
    row.dataset.group = groupSlug(asset.group);
    row.innerHTML =
      `<span class="optimizer-cap-row__name">${escapeHtml(asset.name)}</span>` +
      `<span class="optimizer-cap-row__field">` +
        `<label class="optimizer-cap-row__lab" for="opt-min-${escapeHtml(key)}">min</label>` +
        `<input id="opt-min-${escapeHtml(key)}" class="num-input optimizer-cap-input" type="number" ` +
          `min="0" max="100" step="${OPTIMIZER_STATE.step}" inputmode="numeric" autocomplete="off" ` +
          `placeholder="0" value="${minVal}" data-key="${escapeHtml(key)}" data-bound="min" />` +
        `<span class="optimizer-cap-row__pct">%</span>` +
      `</span>` +
      `<span class="optimizer-cap-row__field">` +
        `<label class="optimizer-cap-row__lab" for="opt-max-${escapeHtml(key)}">max</label>` +
        `<input id="opt-max-${escapeHtml(key)}" class="num-input optimizer-cap-input" type="number" ` +
          `min="0" max="100" step="${OPTIMIZER_STATE.step}" inputmode="numeric" autocomplete="off" ` +
          `placeholder="100" value="${maxVal}" data-key="${escapeHtml(key)}" data-bound="max" />` +
        `<span class="optimizer-cap-row__pct">%</span>` +
      `</span>`;
    wrap.appendChild(row);
  });

  wrap.querySelectorAll('.optimizer-cap-input').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.key;
      const bound = input.dataset.bound;
      if (!OPTIMIZER_STATE.caps[key]) OPTIMIZER_STATE.caps[key] = { min: null, max: null };
      const raw = input.value.trim();
      OPTIMIZER_STATE.caps[key][bound] = raw === '' ? null : clampPct(parseFloat(raw), null);
      updateOptimizerPreview();
    });
  });
}

/* ---- Constrained-grid enumeration ----
   Weights are multiples of `step` summing to 100. In units of `step` the total
   is m = 100/step, and each asset i is bounded to [lo_i, hi_i] units derived
   from its min/max caps (min rounds up, max rounds down to the step grid). */

function optimizerUnitBounds(keys, step, targetPct = 100) {
  const m = Math.round(targetPct / step);
  const lo = [], hi = [];
  for (const k of keys) {
    const cap = OPTIMIZER_STATE.caps[k] || {};
    const minPct = clampPct(cap.min, 0);
    const maxPct = clampPct(cap.max, 100);
    lo.push(Math.ceil(minPct / step - 1e-9));
    hi.push(Math.floor(maxPct / step + 1e-9));
  }
  return { m, lo, hi };
}

// Count compositions with perfect feasibility pruning, bailing out once the
// count exceeds `cap` (we block above the cap anyway, so the exact value past
// it is irrelevant). Returns { count, exceeded, feasible }.
function countGridCompositions(lo, hi, m, cap) {
  const k = lo.length;
  for (let i = 0; i < k; i++) if (lo[i] > hi[i]) return { count: 0, exceeded: false, feasible: false };
  const sufLo = new Array(k + 1).fill(0);
  const sufHi = new Array(k + 1).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    sufLo[i] = sufLo[i + 1] + lo[i];
    sufHi[i] = sufHi[i + 1] + hi[i];
  }
  if (sufLo[0] > m || sufHi[0] < m) return { count: 0, exceeded: false, feasible: false };

  let count = 0;
  let bailed = false;
  function rec(i, remaining) {
    if (bailed) return;
    if (i === k) { if (remaining === 0) count++; return; }
    const lowU  = Math.max(lo[i], remaining - sufHi[i + 1]);
    const highU = Math.min(hi[i], remaining - sufLo[i + 1]);
    for (let u = lowU; u <= highU; u++) {
      rec(i + 1, remaining - u);
      if (count > cap) { bailed = true; return; }
    }
  }
  rec(0, m);
  return { count, exceeded: bailed, feasible: true };
}

// Smallest (finest) weight step from the options that keeps the candidate count
// within `cap` for the current assets/caps. Returns { step, count } or null when
// even the coarsest step is too wide.
function finestStepUnderCap(keys, cap) {
  for (const s of OPTIMIZER_STEP_OPTIONS) { // ascending: 5, 10, 20, 25
    const { m, lo, hi } = optimizerUnitBounds(keys, s);
    const r = countGridCompositions(lo, hi, m, cap);
    if (r.feasible && !r.exceeded && r.count >= 1) return { step: s, count: r.count };
  }
  return null;
}

// Live preview: candidate count + runtime estimate, plus run-button state and
// any blocking/soft warnings.
function updateOptimizerPreview() {
  const previewEl = document.getElementById('optimizer-preview');
  const warnEl    = document.getElementById('optimizer-warning');
  const capsNote  = document.getElementById('optimizer-caps-note');
  if (!previewEl) return;

  // Only assets with full data over the plan period drive the grid.
  const { covered: keys, excluded } = optimizerGridPartition();
  const { plan, hasSpending } = getSimulatorPlanForOptimizer();
  const step = OPTIMIZER_STATE.step;

  let count = 0, exceeded = false, feasible = true, overInfo = null;
  if (keys.length >= 2) {
    const { m, lo, hi } = optimizerUnitBounds(keys, step);
    const res = countGridCompositions(lo, hi, m, optimizerCandidateCap());
    count = res.count; exceeded = res.exceeded; feasible = res.feasible;
    if (exceeded) {
      // Recount to a higher ceiling so we can report exactly how far over the cap.
      const full = countGridCompositions(lo, hi, m, OPTIMIZER_COUNT_CEILING);
      overInfo = optimizerOverLimitNote(full.count, full.exceeded);
    }
  }
  OPTIMIZER_STATE.lastCount = count;

  // Preview text
  if (keys.length < 2) {
    previewEl.textContent = excluded.length
      ? 'Need at least 2 assets with full data over your plan period.'
      : 'Select at least 2 asset classes above to optimize.';
  } else if (!feasible) {
    previewEl.textContent = 'No portfolio fits these limits.';
  } else if (exceeded) {
    previewEl.innerHTML = overInfo
      ? `<strong>${overInfo.totalStr}</strong> portfolios · <span class="optimizer-over">${overInfo.overStr}</span>`
      : `<strong>${optimizerCandidateCap().toLocaleString('en-US')}+</strong> portfolios — too many to run.`;
  } else {
    const estMs = count * OPTIMIZER_STATE.simsPerCandidate * plan.period_years *
                  OPTIMIZER_MS_PER_SIM_YEAR / OPTIMIZER_STATE.poolSize;
    const estStr = estMs < 1000 ? '~1s' : `~${Math.round(estMs / 1000)}s`;
    previewEl.innerHTML =
      `<strong>${count.toLocaleString('en-US')}</strong> portfolio${count === 1 ? '' : 's'}` +
      ` · <span class="optimizer-preview__est">${estStr} on ${OPTIMIZER_STATE.poolSize} core${OPTIMIZER_STATE.poolSize === 1 ? '' : 's'}</span>`;
  }

  // Blocking / soft warnings. When over the cap, offer a one-click coarser step
  // that fits (the combinatorics aren't obvious), or — if even the coarsest step
  // is too wide — tell the user to drop assets.
  let warnHtml = '';
  let suggestStep = null;
  if (keys.length >= 2 && !feasible) {
    warnHtml = 'No portfolio fits these limits — your minimums add up past 100%, or your maximums don’t reach 100%. Loosen a limit.';
  } else if (exceeded) {
    const fit = finestStepUnderCap(keys, optimizerCandidateCap());
    if (fit && fit.step > step) {
      suggestStep = fit.step;
      warnHtml =
        `Too many portfolios at a ${step}% step. ` +
        `<button type="button" class="optimizer-inline-btn" id="optimizer-suggest-step">` +
          `Switch to ${fit.step}% step (${fit.count.toLocaleString('en-US')} portfolios)</button>` +
        `, or remove an asset / tighten per-asset limits.`;
    } else {
      const coarsest = OPTIMIZER_STEP_OPTIONS[OPTIMIZER_STEP_OPTIONS.length - 1];
      warnHtml =
        `Too many portfolios to run (over ${optimizerCandidateCap().toLocaleString('en-US')}), even at a ${coarsest}% step. ` +
        `A grid over ${keys.length} assets is very wide — remove a few asset classes above, or add per-asset limits.`;
    }
  } else if (count >= 2) {
    const estMs = count * OPTIMIZER_STATE.simsPerCandidate * plan.period_years *
                  OPTIMIZER_MS_PER_SIM_YEAR / OPTIMIZER_STATE.poolSize;
    if (estMs > OPTIMIZER_WARN_MS) {
      warnHtml = `Large search (~${Math.round(estMs / 1000)}s). A coarser step or fewer sims will speed it up.`;
    }
  }
  if (warnEl) {
    warnEl.hidden = warnHtml === '';
    warnEl.innerHTML = warnHtml;
    if (suggestStep) {
      const sug = document.getElementById('optimizer-suggest-step');
      if (sug) sug.addEventListener('click', () => {
        OPTIMIZER_STATE.step = suggestStep;
        const stepSel = document.getElementById('optimizer-step');
        if (stepSel) stepSel.value = String(suggestStep);
        renderOptimizerControls();
      });
    }
  }
  if (capsNote) {
    capsNote.textContent = keys.length >= 2
      ? `Limits snap to the ${step}% weight grid.`
      : '';
  }

  updateOptimizerRunState({ keys, hasSpending, count, exceeded, feasible });

  // Hide displayed results once the config no longer matches the run that
  // produced them (asset/step/sims/caps change). Floor changes re-derive in
  // place, so they don't trip this.
  const box = document.getElementById('optimizer-results');
  if (box && !box.hidden && OPTIMIZER_STATE.lastRun &&
      OPTIMIZER_STATE.lastRun.signature !== optimizerConfigSignature()) {
    box.hidden = true;
  }
}

function updateOptimizerRunState({ keys, hasSpending, count, exceeded, feasible }) {
  const btn = document.getElementById('optimizer-run');
  if (!btn) return;
  if (OPTIMIZER_STATE.running) { btn.disabled = true; return; }
  const floorValid = OPTIMIZER_STATE.floorPct >= 0 && OPTIMIZER_STATE.floorPct <= 100;
  const configValid = hasSpending && keys.length >= 2 && feasible && !exceeded &&
                      count >= 1 && count <= optimizerCandidateCap() && floorValid;
  btn.disabled = !configValid || !OPTIMIZER_ENGINE_READY;
  btn.title = OPTIMIZER_ENGINE_READY ? '' : 'Optimization engine arrives in the next update.';
}

/* ---- Constrained-grid enumeration (allocations) ----
   Same walk as countGridCompositions, but emits each composition as an
   allocation array [{key, pct}] filtered to non-zero weights — a 0% asset must
   not be sent to the worker, or buildEligibleRows would still require its data
   and needlessly shrink the eligible-year pool. */
function enumerateGridCompositions(keys, step, capCount, targetPct = 100) {
  const k = keys.length;
  const { m, lo, hi } = optimizerUnitBounds(keys, step, targetPct);
  for (let i = 0; i < k; i++) if (lo[i] > hi[i]) return [];
  const sufLo = new Array(k + 1).fill(0);
  const sufHi = new Array(k + 1).fill(0);
  for (let i = k - 1; i >= 0; i--) {
    sufLo[i] = sufLo[i + 1] + lo[i];
    sufHi[i] = sufHi[i + 1] + hi[i];
  }
  if (sufLo[0] > m || sufHi[0] < m) return [];

  const out = [];
  const units = new Array(k);
  function rec(i, remaining) {
    if (out.length > capCount) return; // safety guard; caller checks the cap first
    if (i === k) {
      if (remaining === 0) {
        const alloc = [];
        for (let j = 0; j < k; j++) {
          if (units[j] > 0) alloc.push({ key: keys[j], pct: units[j] * step });
        }
        out.push(alloc);
      }
      return;
    }
    const lowU  = Math.max(lo[i], remaining - sufHi[i + 1]);
    const highU = Math.min(hi[i], remaining - sufLo[i + 1]);
    for (let u = lowU; u <= highU; u++) {
      units[i] = u;
      rec(i + 1, remaining - u);
    }
  }
  rec(0, m);
  return out;
}

/* ---- Reusable worker-pool batch ----
   Runs an array of candidate allocations through the optimize engine across a
   pool of workers and resolves with the merged data points. Both free mode and
   the two-step flow (Step 1 splits, Step 2 refine) call this. The caller owns the
   OPTIMIZER_STATE.running guard and the busy/progress UI; this helper just fans
   the work out and merges it back. */
function runOptimizeBatch(candidates, plan, N, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const total = candidates.length;
    if (total === 0) { resolve([]); return; }

    // One Common-Random-Numbers seed per run, shared by every pooled worker, so
    // all candidates (across all workers) draw from the SAME bootstrap sequences.
    // Fresh each run, so re-running still reflects Monte-Carlo variability.
    const crnSeed = (Math.random() * 0x100000000) >>> 0;

    // Split into contiguous slices, one per pooled worker.
    const poolSize = Math.max(1, Math.min(OPTIMIZER_STATE.poolSize, total));
    const sliceSize = Math.ceil(total / poolSize);
    const slices = [];
    for (let i = 0; i < total; i += sliceSize) slices.push(candidates.slice(i, i + sliceSize));
    const target = slices.length;

    const results  = new Array(target);
    const doneByWk = new Array(target).fill(0);
    const workers  = [];
    let finished = 0;
    let aborted = false;
    const cleanup = () => workers.forEach((w) => { try { w.terminate(); } catch {} });

    slices.forEach((slice, wi) => {
      let w;
      try {
        w = new Worker(WORKER_URL);
      } catch (e) {
        aborted = true;
        cleanup();
        reject(new Error('Could not start the optimization workers. Your browser may not support Web Workers.'));
        return;
      }
      workers.push(w);
      w.onmessage = (e) => {
        if (aborted) return;
        const m = e.data || {};
        if (m.type === 'optimize_progress') {
          doneByWk[wi] = m.done;
          let done = 0; for (const d of doneByWk) done += d;
          if (onProgress) onProgress(done, total);
        } else if (m.type === 'optimize_results') {
          results[wi] = m.points;
          finished++;
          if (finished === target) { cleanup(); resolve(results.flat()); }
        } else if (m.type === 'optimize_error') {
          aborted = true;
          cleanup();
          reject(new Error(m.message || 'The optimization engine reported an error.'));
        }
      };
      w.onerror = (err) => {
        if (aborted) return;
        aborted = true;
        cleanup();
        reject(new Error((err && err.message) || 'Optimization worker error.'));
      };
      w.postMessage({ type: 'optimize', plan, candidates: slice, simsPerCandidate: N, data: STATE.data, crnSeed });
    });
  });
}

/* ---- Free-mode run: enumerate the full grid, batch it, render results. ---- */
function runOptimizer() {
  if (OPTIMIZER_STATE.running) return;
  const { covered: keys } = optimizerGridPartition(); // grid = full-coverage assets only
  const { plan, hasSpending } = getSimulatorPlanForOptimizer();
  if (!hasSpending || keys.length < 2) return;

  const step = OPTIMIZER_STATE.step;
  const candidates = enumerateGridCompositions(keys, step, optimizerCandidateCap());
  if (candidates.length === 0 || candidates.length > optimizerCandidateCap()) return;

  const floorPct = OPTIMIZER_STATE.floorPct;
  const N = OPTIMIZER_STATE.simsPerCandidate;
  const total = candidates.length;

  OPTIMIZER_STATE.running = true;
  setOptimizerBusy(true);
  hideElement('optimizer-empty');
  optimizerUpdateProgress(0, total);
  const startedAt = performance.now();

  runOptimizeBatch(candidates, plan, N, { onProgress: optimizerUpdateProgress })
    .then((points) => {
      finishOptimizer(points, plan, floorPct, N, step, performance.now() - startedAt, keys);
    })
    .catch((err) => {
      OPTIMIZER_STATE.running = false;
      setOptimizerBusy(false);
      showOptimizerError(err && err.message ? err.message : 'The optimization engine reported an error.');
    });
}

function finishOptimizer(points, plan, floorPct, N, step, elapsedMs, keys) {
  OPTIMIZER_STATE.running = false;
  setOptimizerBusy(false);
  const ddCap = OPTIMIZER_STATE.maxDrawdownPct;
  const res = computeOptimizerResults(points, floorPct, ddCap);
  OPTIMIZER_STATE.lastRun = {
    points, plan, floorPct, ddCap, N, step, elapsedMs, keys, results: res,
    signature: optimizerConfigSignature(),
  };
  renderOptimizerResults(res, { plan, floorPct, ddCap, N, step, elapsedMs, total: points.length });
  updateOptimizerPreview(); // restore run-button enabled state
}

// A fingerprint of everything that affects the *simulated* points (not the
// floor). When the current controls no longer match a run's signature, the
// displayed results are stale.
function optimizerConfigSignature() {
  const { covered, start, end } = optimizerGridPartition();
  return JSON.stringify({
    keys: covered,          // only the assets that actually enter the grid
    period: [start, end],   // plan-period change alters coverage → new run
    step: OPTIMIZER_STATE.step,
    sims: OPTIMIZER_STATE.simsPerCandidate,
    caps: OPTIMIZER_STATE.caps,
  });
}

// Re-rank an existing run against the current floor + drawdown cap without
// re-simulating (both are post-hoc filters on the stored points).
function rederiveOptimizerResults() {
  const lr = OPTIMIZER_STATE.lastRun;
  if (!lr) return;
  const ddCap = OPTIMIZER_STATE.maxDrawdownPct;
  const res = computeOptimizerResults(lr.points, OPTIMIZER_STATE.floorPct, ddCap);
  lr.results = res;
  lr.floorPct = OPTIMIZER_STATE.floorPct;
  renderOptimizerResults(res, {
    plan: lr.plan, floorPct: OPTIMIZER_STATE.floorPct, ddCap,
    N: lr.N, step: lr.step, elapsedMs: lr.elapsedMs, total: lr.points.length,
  });
}

// Identify the winning portfolio + the Pareto-efficient frontier, and tag every
// point with meets_floor / meets_dd / qualifies / on_frontier. "Best" = max real
// median CAGR among points clearing BOTH the success floor AND the max-drawdown
// cap (ddCap = a magnitude %, e.g. 35; null = off). If none qualify, expose the
// closest (highest success among cap-respecting points, else overall). Drawdown
// is stored negative (e.g. -32.5), so "|dd| ≤ cap" is "mdd ≥ -cap".
function computeOptimizerResults(points, floorPct, ddCap = null) {
  const valid = points.filter((p) => !p.invalid && p.cagr_real_median != null && Number.isFinite(p.cagr_real_median));
  const meetsDD = (p) => ddCap == null || (p.mdd_investment_median != null && p.mdd_investment_median >= -ddCap);

  let best = null;
  let closest = null;
  const qualifying = valid.filter((p) => p.success_rate_pct >= floorPct && meetsDD(p));
  if (qualifying.length) {
    best = qualifying.reduce((a, b) => (b.cagr_real_median > a.cagr_real_median ? b : a));
  } else if (valid.length) {
    // No portfolio clears both constraints. Closest = highest success among the
    // cap-respecting points (if any), else highest success overall.
    const pool = valid.filter(meetsDD);
    const from = pool.length ? pool : valid;
    closest = from.reduce((a, b) => {
      if (b.success_rate_pct !== a.success_rate_pct) return b.success_rate_pct > a.success_rate_pct ? b : a;
      return b.cagr_real_median > a.cagr_real_median ? b : a;
    });
  }

  // Pareto frontier: success ↑ vs real median CAGR ↑ (drawdown shown as a column).
  const frontier = valid.filter((p) => !valid.some((q) =>
    q !== p &&
    q.success_rate_pct  >= p.success_rate_pct &&
    q.cagr_real_median  >= p.cagr_real_median &&
    (q.success_rate_pct > p.success_rate_pct || q.cagr_real_median > p.cagr_real_median)
  ));
  const frontierSet = new Set(frontier);

  points.forEach((p) => {
    const ok = !p.invalid && p.cagr_real_median != null;
    p.meets_floor = ok && p.success_rate_pct >= floorPct;
    p.meets_dd    = ok && meetsDD(p);
    p.qualifies   = p.meets_floor && p.meets_dd;
    p.on_frontier = frontierSet.has(p);
  });

  // Frontier sorted by success ascending (natural left→right for the chart).
  frontier.sort((a, b) => a.success_rate_pct - b.success_rate_pct || a.cagr_real_median - b.cagr_real_median);

  // valid, ranked by real median CAGR desc — pads the table to ≥5 rows and feeds
  // every portfolio to the free-mode frontier chart.
  const rankedValid = [...valid].sort((a, b) => b.cagr_real_median - a.cagr_real_median);

  const invalidCount = points.length - valid.length;
  return { best, closest, frontier, valid: rankedValid, validCount: valid.length, invalidCount };
}

// Build the row set for a results table: the efficient frontier, guaranteed to
// include the winner, padded up to `minRows` with the next-highest-real-CAGR
// valid portfolios (res.valid is ranked CAGR desc). If the frontier already has
// more rows than minRows, all of them are kept — this only ever adds rows. The
// returned list is ordered success ↑ then real-CAGR ↑ for display.
function optimizerTableRows(res, minRows) {
  const { frontier, best } = res;
  let rows = (best && !frontier.includes(best)) ? [...frontier, best] : [...frontier];
  if (rows.length < minRows && res.valid) {
    const shown = new Set(rows);
    for (const p of res.valid) {           // res.valid is ranked by real CAGR desc
      if (rows.length >= minRows) break;
      if (!shown.has(p)) { rows.push(p); shown.add(p); }
    }
  }
  rows.sort((a, b) =>
    a.success_rate_pct - b.success_rate_pct || a.cagr_real_median - b.cagr_real_median);
  return rows;
}

/* ---- Run-state UI helpers ---- */
function setOptimizerBusy(busy) {
  const btn  = document.getElementById('optimizer-run');
  const prog = document.getElementById('optimizer-progress');
  if (btn)  { btn.disabled = busy; btn.textContent = busy ? 'Optimizing…' : 'Run optimizer'; }
  if (prog) prog.hidden = !busy;
}

function optimizerUpdateProgress(done, total) {
  const fill  = document.getElementById('optimizer-progress-fill');
  const label = document.getElementById('optimizer-progress-label');
  if (fill)  fill.style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
  if (label) label.textContent =
    `Simulating every portfolio in your browser — ${done.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`;
}

function showOptimizerError(message) {
  const empty = document.getElementById('optimizer-empty');
  if (empty) { empty.hidden = false; empty.textContent = message; }
  const prog = document.getElementById('optimizer-progress');
  if (prog) prog.hidden = true;
}

/* ---- Results rendering (Phase 2: best callout + frontier table) ---- */
function optimizerAllocationSummary(alloc) {
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  return [...alloc]
    .sort((a, b) => b.pct - a.pct)
    .map((a) => `${a.pct}% ${escapeHtml((byKey.get(a.key) || {}).name || a.key)}`)
    .join(' · ');
}

// Plain-text allocation, one "45% S&P 500" per array element (NOT HTML-escaped —
// this feeds Chart.js canvas tooltips, where "&amp;" would render literally).
// Returned as an array so each holding is its own tooltip line.
function optimizerAllocLines(alloc) {
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  return [...alloc]
    .sort((a, b) => b.pct - a.pct)
    .map((a) => `${a.pct}% ${(byKey.get(a.key) || {}).name || a.key}`);
}

function optimizerFmtPct(v, d = 1) { return v == null ? '—' : `${v.toFixed(d)}%`; }
// Drawdown is stored negative; show its magnitude (e.g. -32.5 → "32.5%").
function optimizerFmtDD(v, d = 1) { return v == null ? '—' : `${Math.abs(v).toFixed(d)}%`; }
// "92% success" or "92% success & ≤35% drawdown" depending on the cap.
function optimizerConstraintLabel(floorPct, ddCap) {
  const s = `${optimizerFmtPct(floorPct, 0)} success`;
  return ddCap != null ? `${s} & max drawdown ${ddCap}%` : s;
}

function renderOptimizerResults(res, meta) {
  const box = document.getElementById('optimizer-results');
  if (!box) return;
  box.hidden = false;

  const { best, closest, frontier, validCount, invalidCount } = res;
  const { floorPct, ddCap, N, step, elapsedMs, total } = meta;
  const constraint = optimizerConstraintLabel(floorPct, ddCap);

  // Headline: winner or closest-miss.
  let headline;
  if (best) {
    headline =
      `<div class="optimizer-best">` +
        `<p class="optimizer-best__label">Best portfolio clearing ${constraint}</p>` +
        `<p class="optimizer-best__alloc">${optimizerAllocationSummary(best.allocation)}</p>` +
        `<div class="optimizer-best__stats">` +
          statPill('Success', optimizerFmtPct(best.success_rate_pct)) +
          statPill('Real median CAGR', optimizerFmtPct(best.cagr_real_median, 2)) +
          statPill('Median ending (real)', formatCurrency(Math.round(best.ending_wealth_real))) +
          statPill('Max drawdown', optimizerFmtDD(best.mdd_investment_median)) +
        `</div>` +
      `</div>`;
  } else if (closest) {
    headline =
      `<div class="optimizer-best optimizer-best--miss">` +
        `<p class="optimizer-best__label">No portfolio cleared ${constraint}</p>` +
        `<p class="optimizer-best__alloc">Closest: ${optimizerAllocationSummary(closest.allocation)}</p>` +
        `<div class="optimizer-best__stats">` +
          statPill('Success', optimizerFmtPct(closest.success_rate_pct)) +
          statPill('Real median CAGR', optimizerFmtPct(closest.cagr_real_median, 2)) +
          statPill('Median ending (real)', formatCurrency(Math.round(closest.ending_wealth_real))) +
          statPill('Max drawdown', optimizerFmtDD(closest.mdd_investment_median)) +
        `</div>` +
        `<p class="field-note small">Lower your success floor, raise your drawdown cap, allow more equity, or extend the data range.</p>` +
      `</div>`;
  } else {
    headline = `<div class="optimizer-best optimizer-best--miss"><p class="optimizer-best__label">No valid portfolios — none of the portfolios had data over your plan’s period.</p></div>`;
  }

  const pick = best || closest;

  // Efficient-frontier chart card (built here so its canvas is in the DOM before
  // the chart is drawn): success rate (X) vs real median ending value (Y).
  let chartCard = '';
  if (res.valid && res.valid.length) {
    const dotNote = ddCap != null
      ? 'Teal clears your floor &amp; drawdown cap, gray misses one'
      : 'Teal clears your success floor, gray falls below it';
    chartCard =
      `<div class="chart-card opt-free-chart-card">` +
        `<div class="chart-card__head"><h3 class="chart-card__title">Success vs. ending value</h3></div>` +
        `<div class="chart-container opt-free-chart-container"><canvas id="opt-free-chart"></canvas></div>` +
        `<p class="chart-card__note">Each dot is a portfolio. ${dotNote} · navy = winner · teal line = most ending value at each success level · dashed = your success floor.</p>` +
      `</div>`;
  }

  // Frontier table. The Pareto set is success↑ vs CAGR↑; when the drawdown cap
  // binds, the winner can be dominated on those two axes, so it's force-included
  // (tagged "best"). Always show up to the top 10 — pad past the frontier with
  // the next-highest real-CAGR portfolios (dimmed if they miss the floor/cap).
  const frontierRows = optimizerTableRows(res, OPTIMIZER_TABLE_MIN_ROWS);
  let table = '';
  if (frontierRows.length) {
    const rows = frontierRows.map((p) => {
      const isBest = p === best;
      return `<tr class="${isBest ? 'is-best' : ''}${p.qualifies ? '' : ' is-belowfloor'}">` +
        `<td class="optimizer-rt__alloc">${optimizerAllocationSummary(p.allocation)}${isBest ? ' <span class="optimizer-tag">best</span>' : ''}</td>` +
        `<td class="num">${optimizerFmtPct(p.success_rate_pct)}</td>` +
        `<td class="num">${optimizerFmtPct(p.cagr_real_mean, 2)}</td>` +
        `<td class="num">${optimizerFmtPct(p.cagr_real_median, 2)}</td>` +
        `<td class="num">${formatCurrency(Math.round(p.ending_wealth_real))}</td>` +
        `<td class="num${p.meets_dd ? '' : ' optimizer-dd-fail'}">${optimizerFmtDD(p.mdd_investment_median)}</td>` +
      `</tr>`;
    }).join('');
    const dimNote = ddCap != null ? 'Rows failing your floor or drawdown cap are dimmed.' : 'Rows below your floor are dimmed.';
    table =
      `<div class="optimizer-rt-head">Efficient frontier <span class="field-note small">— non-dominated portfolios (success ↑, real median CAGR ↑); your winner is highlighted. ${dimNote}</span></div>` +
      `<div class="table-wrap"><table class="optimizer-rt"><thead><tr>` +
        `<th>Allocation</th><th class="num">Success</th><th class="num">Avg CAGR (real)</th><th class="num">Median CAGR (real)</th><th class="num">Median ending (real)</th><th class="num">Max drawdown</th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // Actions: load the winner into the Simulator for a full-fidelity re-check,
  // and export the full point set for external plotting.
  const actions =
    `<div class="optimizer-actions">` +
      (pick ? `<button type="button" class="optimizer-btn" id="optimizer-load-sim">Load ${best ? 'best' : 'closest'} into Simulator</button>` : '') +
      `<button type="button" class="optimizer-btn" id="optimizer-export-json">Export JSON</button>` +
      `<button type="button" class="optimizer-btn" id="optimizer-export-csv">Export CSV</button>` +
    `</div>`;

  const meta1 = `<p class="optimizer-meta field-note small">Ran <strong>${total.toLocaleString('en-US')}</strong> portfolios × ${N.toLocaleString('en-US')} sims in ${(elapsedMs / 1000).toFixed(1)}s · ${step}% weight grid${invalidCount ? ` · ${invalidCount} skipped (no data in period)` : ''}. Success/CAGR are Monte-Carlo estimates at ${N.toLocaleString('en-US')} sims — re-check the winner in the Simulator at full sims.</p>`;

  box.innerHTML = headline + chartCard + actions + table + meta1;

  if (res.valid && res.valid.length) renderOptimizerFreeChart(res, meta);

  const loadBtn = document.getElementById('optimizer-load-sim');
  if (loadBtn && pick) loadBtn.addEventListener('click', () => loadAllocationIntoSimulator(pick.allocation));
  const jsonBtn = document.getElementById('optimizer-export-json');
  if (jsonBtn) jsonBtn.addEventListener('click', exportOptimizerJSON);
  const csvBtn = document.getElementById('optimizer-export-csv');
  if (csvBtn) csvBtn.addEventListener('click', exportOptimizerCSV);
}

let optimizerFreeChart = null;   // Chart.js scatter for the free-mode frontier

// Free-mode efficient-frontier scatter: chance of success (X) vs real median
// ending value (Y). Qualifying dots teal, floor/cap failures gray, winner navy;
// a teal line traces the success-vs-ending-value efficient set (upper-right
// envelope), and a dashed clay line marks the success floor.
function renderOptimizerFreeChart(res, meta) {
  const canvas = document.getElementById('opt-free-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const css = (n, f) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f);
  const teal = css('--teal', '#1A6E6E');
  const clay = css('--clay', '#C84A30');
  const navy = css('--navy', '#1F3D6B');
  const faint = css('--faint', '#c7c7c7');

  const { floorPct, ddCap } = meta;
  const best = res.best;
  const valid = (res.valid || []).filter((p) =>
    p.ending_wealth_real != null && Number.isFinite(p.ending_wealth_real) &&
    p.success_rate_pct != null && Number.isFinite(p.success_rate_pct));
  if (!valid.length) { if (optimizerFreeChart) { optimizerFreeChart.destroy(); optimizerFreeChart = null; } return; }

  // Success-vs-ending-value efficient set: no other valid point has ≥ success AND
  // ≥ ending value (the upper-right envelope).
  const eff = valid.filter((p) => !valid.some((q) =>
    q !== p && q.success_rate_pct >= p.success_rate_pct && q.ending_wealth_real >= p.ending_wealth_real &&
    (q.success_rate_pct > p.success_rate_pct || q.ending_wealth_real > p.ending_wealth_real)))
    .sort((a, b) => a.success_rate_pct - b.success_rate_pct || a.ending_wealth_real - b.ending_wealth_real);

  const pt = (p) => ({ x: p.success_rate_pct, y: p.ending_wealth_real, alloc: optimizerAllocLines(p.allocation) });
  const qual = valid.filter((p) => p.qualifies && p !== best).map(pt);
  const fail = valid.filter((p) => !p.qualifies && p !== best).map(pt);

  const ys = valid.map((p) => p.ending_wealth_real);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const floorData = (floorPct != null) ? [{ x: floorPct, y: yMin }, { x: floorPct, y: yMax }] : null;

  const qualLabel = ddCap != null ? 'Clears floor & cap' : 'Clears your floor';
  const failLabel = ddCap != null ? 'Misses a limit' : 'Below your floor';

  const datasets = [
    { type: 'line', label: 'Efficient set', data: eff.map(pt), borderColor: teal, backgroundColor: teal,
      pointRadius: 0, borderWidth: 1.5, tension: 0.1, order: 3 },
    { type: 'scatter', label: failLabel, data: fail, backgroundColor: faint, borderColor: faint, pointRadius: 3, order: 2 },
    { type: 'scatter', label: qualLabel, data: qual, backgroundColor: teal, borderColor: teal, pointRadius: 3.5, order: 1 },
    ...(best ? [{ type: 'scatter', label: 'Winner', data: [pt(best)], backgroundColor: navy, borderColor: navy, pointRadius: 7, order: 0 }] : []),
    ...(floorData ? [{ type: 'line', label: `Success floor (${floorPct}%)`, data: floorData, borderColor: clay, backgroundColor: clay,
      pointRadius: 0, borderDash: [6, 4], borderWidth: 1.5, order: 0 }] : []),
  ];

  // Compact currency for the Y axis ticks ($1.2M / $850k / $500); tooltip shows full.
  const fmtAxis = (v) => {
    const a = Math.abs(v);
    if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (a >= 1e3) return `$${Math.round(v / 1e3)}k`;
    return `$${Math.round(v)}`;
  };

  if (optimizerFreeChart) optimizerFreeChart.destroy();
  optimizerFreeChart = new Chart(canvas.getContext('2d'), {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Chance of success' }, ticks: { callback: (v) => `${v}%` } },
        y: { type: 'linear', title: { display: true, text: 'Median ending value (real)' }, ticks: { callback: fmtAxis } },
      },
      plugins: {
        legend: { display: true, position: 'bottom' },
        tooltip: { callbacks: {
          label: (item) => {
            const lbl = item.dataset.label;
            if (lbl.startsWith('Success floor')) return lbl;
            const head = `${formatCurrency(Math.round(item.parsed.y))} ending @ ${item.parsed.x.toFixed(1)}% success`;
            const alloc = (item.raw && item.raw.alloc) ? item.raw.alloc : [];
            return [head, ...alloc];
          },
        } },
      },
    },
  });
}

/* ---- Data export + "load into Simulator" ---- */

// Push an optimizer allocation into the Simulator's allocation rows and switch
// to that tab so the user can re-validate the portfolio at full fidelity.
function loadAllocationIntoSimulator(alloc) {
  if (!Array.isArray(alloc) || alloc.length === 0) return;
  INPUT_STATE.allocations = alloc.map((a) => ({ key: a.key, pct: a.pct }));
  renderAllocationRows();
  refreshAllDerived();
  const simTab = document.getElementById('tab-btn-simulator');
  if (simTab) simTab.click();
  const allocSection = document.getElementById('alloc-rows');
  if (allocSection) allocSection.scrollIntoView({ block: 'center' });
}

function optimizerRound(v, d) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

// One point → the export record (the data model in the plan).
function optimizerPointExport(p) {
  if (p.invalid) {
    return { allocation: p.allocation, invalid: true, reason: p.reason || 'invalid' };
  }
  return {
    allocation: p.allocation.map((a) => ({ key: a.key, pct: a.pct })),
    success_rate_pct:        optimizerRound(p.success_rate_pct, 3),
    cagr_real_mean:          optimizerRound(p.cagr_real_mean, 4),
    cagr_real_median:        optimizerRound(p.cagr_real_median, 4),
    ending_wealth_real:      p.ending_wealth_real == null ? null : Math.round(p.ending_wealth_real),
    ending_wealth_real_mean: p.ending_wealth_real_mean == null ? null : Math.round(p.ending_wealth_real_mean),
    mdd_investment_median:   optimizerRound(p.mdd_investment_median, 3),
    meets_floor:  !!p.meets_floor,
    meets_dd:     !!p.meets_dd,
    on_frontier:  !!p.on_frontier,
  };
}

function buildOptimizerExportDoc() {
  const lr = OPTIMIZER_STATE.lastRun;
  if (!lr) return null;
  const plan = lr.plan;
  const byKey = new Map(STATE.assets.map((a) => [a.key, a]));
  const bucket1 = (plan.buckets && plan.buckets[0]) ? (plan.buckets[0].expense || 0) : 0;
  return {
    generated_at: new Date().toISOString(),
    tool: 'Beyond the Noise — Portfolio Optimizer',
    plan: {
      initial_balance:  plan.initial_balance,
      period_years:     plan.period_years,
      current_age:      plan.current_age,
      annual_spending:  bucket1,
      distribution_strategy: plan.distribution_strategy,
      inflation_adjust: plan.inflation_adjust,
      historical_period: plan.historical_period === 'custom'
        ? `custom ${plan.custom_start}-${plan.custom_end}`
        : plan.historical_period,
    },
    settings: {
      weight_step_pct:      lr.step,
      success_floor_pct:    lr.floorPct,
      max_drawdown_cap_pct: lr.ddCap == null ? null : lr.ddCap,
      sims_per_portfolio:   lr.N,
    },
    asset_universe: (lr.keys || []).map((k) => ({ key: k, name: (byKey.get(k) || {}).name || k })),
    summary: {
      total_portfolios: lr.points.length,
      valid:            lr.results.validCount,
      invalid:          lr.results.invalidCount,
      frontier_size:    lr.results.frontier.length,
      best:    lr.results.best    ? optimizerPointExport(lr.results.best)    : null,
      closest: lr.results.closest ? optimizerPointExport(lr.results.closest) : null,
    },
    points: lr.points.map(optimizerPointExport),
  };
}

function buildOptimizerCSV() {
  const lr = OPTIMIZER_STATE.lastRun;
  if (!lr) return null;
  const keys = lr.keys || [];
  const header = [
    ...keys.map((k) => `pct_${k}`),
    'success_rate_pct', 'cagr_real_mean', 'cagr_real_median',
    'ending_wealth_real', 'ending_wealth_real_mean', 'mdd_investment_median',
    'meets_floor', 'meets_dd', 'on_frontier',
  ];
  const lines = [header.join(',')];
  for (const p of lr.points) {
    if (p.invalid) continue; // omit candidates with no data in the period
    const pctByKey = new Map(p.allocation.map((a) => [a.key, a.pct]));
    const row = [
      ...keys.map((k) => pctByKey.get(k) || 0),
      optimizerRound(p.success_rate_pct, 3),
      optimizerRound(p.cagr_real_mean, 4),
      optimizerRound(p.cagr_real_median, 4),
      p.ending_wealth_real == null ? '' : Math.round(p.ending_wealth_real),
      p.ending_wealth_real_mean == null ? '' : Math.round(p.ending_wealth_real_mean),
      optimizerRound(p.mdd_investment_median, 3),
      p.meets_floor ? 1 : 0,
      p.meets_dd ? 1 : 0,
      p.on_frontier ? 1 : 0,
    ];
    lines.push(row.join(','));
  }
  return lines.join('\n');
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

function exportOptimizerJSON() {
  const doc = buildOptimizerExportDoc();
  if (!doc) return;
  downloadTextFile('btn-optimizer-results.json', JSON.stringify(doc, null, 2), 'application/json');
}

function exportOptimizerCSV() {
  const csv = buildOptimizerCSV();
  if (!csv) return;
  downloadTextFile('btn-optimizer-results.csv', csv, 'text/csv');
}

function statPill(label, value) {
  return `<span class="optimizer-stat"><span class="optimizer-stat__label">${label}</span><span class="optimizer-stat__value">${value}</span></span>`;
}

/* -----------------------------------------------------------
   Sort behavior
   ----------------------------------------------------------- */
function bindSortHeaders() {
  document.querySelectorAll('#ref-table thead th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      const type = th.dataset.type;
      if (!key) return;
      if (STATE.sort.key === key) {
        STATE.sort.dir = STATE.sort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        STATE.sort.key = key;
        STATE.sort.dir = type === 'num' ? 'desc' : 'asc';
      }
      render();
    });
  });
}

/* -----------------------------------------------------------
   Render: subtitle, summary strip, warning, table
   ----------------------------------------------------------- */
function render() {
  const periodKey = STATE.period;
  const rows = buildRowsForPeriod(periodKey);

  renderSubtitle(rows);
  renderSummaryStrip(rows);
  renderWarning(rows, periodKey);
  renderSortIndicators();
  renderTable(rows);
}

function buildRowsForPeriod(periodKey) {
  // Each row joins asset metadata with the period stats block.
  // For native/postwar/modern, stats are pre-computed in the JSON.
  // For 'custom', we recompute stats on the fly from annual_returns over the
  // user-selected [start, end] window. Assets with no rows in the window are
  // dropped from the table.
  if (periodKey === 'custom') {
    const { start, end } = STATE.customRange;
    return STATE.assets
      .map((a) => {
        const stats = computeAssetStatsForRange(a, start, end);
        if (!stats || stats.n === 0) return null;
        return {
          key: a.key, name: a.name, ticker: a.ticker, group: a.group,
          native_start: a.native_start, splice_note: a.splice_note, quality: a.quality,
          ...stats,
        };
      })
      .filter(Boolean);
  }
  return STATE.assets
    .map((a) => {
      const stats = a.stats?.[periodKey];
      if (!stats || stats.n == null) return null;
      return {
        key: a.key,
        name: a.name,
        ticker: a.ticker,
        group: a.group,
        native_start: a.native_start,
        splice_note: a.splice_note,
        quality: a.quality,
        first_year: stats.first_year,
        n: stats.n,
        cagr: stats.cagr,
        mean: stats.mean,
        std: stats.std,
        sharpe: stats.sharpe,
        min: stats.min,
        max: stats.max,
        avg_rf: stats.avg_rf,
      };
    })
    .filter(Boolean);
}

function computeAssetStatsForRange(asset, start, end) {
  if (!STATE.data) return null;
  const key = asset.key;
  const returns = [];
  const tbills = [];
  let firstYear = null;
  for (const row of STATE.data.annual_returns) {
    if (row.year < start || row.year > end) continue;
    if (row[key] == null) continue;
    returns.push(row[key]);
    if (row.st_tbills != null) tbills.push(row.st_tbills);
    if (firstYear == null) firstYear = row.year;
  }
  const n = returns.length;
  if (n === 0) return null;

  let mean = 0; for (const v of returns) mean += v; mean /= n;
  let variance = 0; for (const v of returns) { const d = v - mean; variance += d * d; } variance /= n;
  const std = Math.sqrt(variance);
  let logSum = 0; for (const v of returns) logSum += Math.log(1 + v / 100);
  const cagr = (Math.exp(logSum / n) - 1) * 100;
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const avg_rf = tbills.length ? tbills.reduce((a, b) => a + b, 0) / tbills.length : 0;
  const sharpe = std > 0 ? (mean - avg_rf) / std : 0;

  return { mean, std, cagr, min, max, n, sharpe, avg_rf, first_year: firstYear };
}

function renderSubtitle(rows) {
  const el = document.getElementById('reference-sub');
  if (!el) return;
  const totalYears = STATE.data.metadata.total_years;
  const totalAssets = Object.keys(STATE.data.assets).length;
  const shown = rows.length;
  const periodLabel = STATE.period === 'custom'
    ? `Custom range (${STATE.customRange.start}–${STATE.customRange.end})`
    : PERIOD_LABELS[STATE.period].name;
  el.textContent =
    `${totalAssets} asset classes · ${totalYears} years of annual data (1871–2025) · ` +
    `Showing ${shown} assets for ${periodLabel}.`;
}

function renderSummaryStrip(rows) {
  const ul = document.getElementById('summary-strip');
  if (!ul) return;

  const highestCagr = rows.reduce((best, r) => (r.cagr > (best?.cagr ?? -Infinity) ? r : best), null);
  const bestSharpe  = rows.reduce((best, r) => (r.sharpe > (best?.sharpe ?? -Infinity) ? r : best), null);

  const usEquity = rows.filter((r) => r.group === 'US Equity');
  const avgUsCagr = usEquity.length
    ? usEquity.reduce((s, r) => s + r.cagr, 0) / usEquity.length
    : null;

  // Average risk-free rate: take from ST T-Bills row if present, else mean of avg_rf.
  const tbillsRow = rows.find((r) => r.key === 'st_tbills');
  const avgRf = tbillsRow
    ? tbillsRow.cagr
    : (rows.reduce((s, r) => s + (r.avg_rf || 0), 0) / Math.max(1, rows.length));

  ul.innerHTML = '';
  ul.appendChild(summaryCell('Highest CAGR',  highestCagr ? `${fmtPct(highestCagr.cagr)}` : '—', highestCagr ? highestCagr.name : ''));
  ul.appendChild(summaryCell('Best Sharpe',   bestSharpe  ? `${fmtNum(bestSharpe.sharpe, 3)}` : '—', bestSharpe ? bestSharpe.name : ''));
  ul.appendChild(summaryCell('Avg US Equity CAGR', avgUsCagr != null ? fmtPct(avgUsCagr) : '—', `${usEquity.length} assets`));
  ul.appendChild(summaryCell('Avg Risk-Free Rate', avgRf != null ? fmtPct(avgRf) : '—', tbillsRow ? 'ST T-Bills CAGR' : 'mean of avg_rf'));
}

function summaryCell(label, value, hint) {
  const li = document.createElement('li');
  const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
  const v = document.createElement('span'); v.className = 'value'; v.textContent = value;
  const h = document.createElement('span'); h.className = 'hint';  h.textContent = hint || '';
  li.appendChild(l); li.appendChild(v); li.appendChild(h);
  return li;
}

function renderWarning(rows, periodKey) {
  const el = document.getElementById('period-warning');
  if (!el) return;
  if (periodKey === 'modern') {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  // Resolve the period's start year (custom overrides PERIOD_LABELS).
  const periodStart = periodKey === 'custom'
    ? STATE.customRange.start
    : PERIOD_LABELS[periodKey].start;

  // Identify the most-constrained asset shown: latest native_start beyond the period start.
  const constrained = rows
    .filter((r) => r.quality !== 'native' && (periodStart == null || r.native_start > periodStart))
    .sort((a, b) => b.native_start - a.native_start)[0];

  if (!constrained) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  let periodLabel;
  if (periodKey === 'native')       periodLabel = 'the full data set (1871 onward)';
  else if (periodKey === 'custom')  periodLabel = `${STATE.customRange.start}–${STATE.customRange.end}`;
  else                              periodLabel = `${periodStart}`;

  el.hidden = false;
  el.textContent =
    `${constrained.name} has native data starting in ${constrained.native_start}. ` +
    `Using ${periodLabel} will include reconstructed proxy data prior to ${constrained.native_start}, ` +
    `which may affect simulation accuracy. Other assets may also use spliced data — see the badges in the table.`;
}

function renderSortIndicators() {
  document.querySelectorAll('#ref-table thead th.sortable').forEach((th) => {
    if (th.dataset.key === STATE.sort.key) {
      th.setAttribute('aria-sort', STATE.sort.dir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

function renderTable(rows) {
  const tbody = document.getElementById('ref-tbody');
  if (!tbody) return;

  // Sort
  const { key, dir } = STATE.sort;
  const sorted = [...rows].sort((a, b) => compareRows(a, b, key, dir));

  // Max std for volatility bar scaling (use sorted rows; same population)
  const maxStd = rows.reduce((m, r) => Math.max(m, r.std || 0), 0) || 1;

  tbody.innerHTML = '';
  sorted.forEach((r) => {
    const tr = document.createElement('tr');

    tr.appendChild(cellAsset(r));
    tr.appendChild(cellMonoText(r.ticker, 'ticker'));
    tr.appendChild(cellYear(r.first_year));
    tr.appendChild(cellNum(r.n, 0));
    tr.appendChild(cellPct(r.cagr));
    tr.appendChild(cellPct(r.std));
    tr.appendChild(cellVolBar(r.std, maxStd));
    tr.appendChild(cellNum(r.sharpe, 3));
    tr.appendChild(cellPct(r.min, true));
    tr.appendChild(cellPct(r.max, true));
    tr.appendChild(cellPct(r.avg_rf));
    tr.appendChild(cellQuality(r.quality));

    tbody.appendChild(tr);
  });
}

function compareRows(a, b, key, dir) {
  // Special-case: group ordering when sorting by name asc.
  let av, bv;
  if (key === 'quality') {
    const order = ['native', 'early-splice', 'late-splice', 'limited'];
    av = order.indexOf(a.quality);
    bv = order.indexOf(b.quality);
  } else {
    av = a[key];
    bv = b[key];
  }
  if (av == null && bv == null) return 0;
  if (av == null) return 1;       // nulls sort to the end
  if (bv == null) return -1;
  if (typeof av === 'string') {
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  }
  return dir === 'asc' ? av - bv : bv - av;
}

/* -----------------------------------------------------------
   Cell builders
   ----------------------------------------------------------- */
function cellAsset(r) {
  const td = document.createElement('td');
  const name = document.createElement('span');
  name.className = 'asset-name';
  name.textContent = r.name;
  const group = document.createElement('span');
  group.className = 'asset-group';
  group.textContent = r.group;
  td.appendChild(name);
  td.appendChild(group);
  return td;
}

function cellMonoText(text, extraClass = '') {
  const td = document.createElement('td');
  const span = document.createElement('span');
  if (extraClass) span.className = extraClass;
  span.textContent = text;
  td.appendChild(span);
  return td;
}

function cellNum(value, decimals) {
  const td = document.createElement('td');
  td.className = 'num';
  td.textContent = value == null ? '—' : fmtNum(value, decimals);
  if (value == null) td.classList.add('dash');
  return td;
}

function cellYear(value) {
  // Years should never get a thousands separator (e.g. "1976", not "1,976").
  const td = document.createElement('td');
  td.className = 'num';
  if (value == null) { td.textContent = '—'; td.classList.add('dash'); return td; }
  td.textContent = String(value);
  return td;
}

function cellPct(value, signColor = false) {
  const td = document.createElement('td');
  td.className = 'num';
  if (value == null) { td.textContent = '—'; td.classList.add('dash'); return td; }
  td.textContent = fmtPct(value);
  if (signColor) td.classList.add(value < 0 ? 'neg' : 'pos');
  return td;
}

function cellVolBar(std, maxStd) {
  const td = document.createElement('td');
  td.className = 'volbar-cell num';
  if (std == null) { td.textContent = '—'; td.classList.add('dash'); return td; }
  const track = document.createElement('div');
  track.className = 'volbar-track';
  const fill = document.createElement('div');
  fill.className = 'volbar-fill';
  const pct = Math.max(2, Math.min(100, (std / maxStd) * 100));
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  td.appendChild(track);
  return td;
}

function cellQuality(quality) {
  const td = document.createElement('td');
  const info = QUALITY_INFO[quality] || { label: '—', className: '' };
  const span = document.createElement('span');
  span.className = `badge ${info.className}`;
  span.textContent = info.label;
  td.appendChild(span);
  return td;
}

/* -----------------------------------------------------------
   Formatters
   ----------------------------------------------------------- */
function fmtNum(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(v, decimals = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${fmtNum(v, decimals)}%`;
}

/* -----------------------------------------------------------
   UI helpers
   ----------------------------------------------------------- */
function showElement(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = false;
}
function hideElement(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}
function showError(message) {
  hideElement('loading-state');
  hideElement('app-shell');
  const wrapper = document.getElementById('error-state');
  const msg = document.getElementById('error-message');
  if (msg) msg.textContent = message;
  if (wrapper) wrapper.hidden = false;
}

// Expose a tiny inspection hook for verification in DevTools/preview_eval.
window.__MC_STATE__ = STATE;

/* ============================================================
   Phase 2/3 — Web Worker
   ============================================================ */

const WORKER = {
  instance: null,
  busy: false,
  startedAt: 0,
};

function initWorker() {
  if (WORKER.instance) return WORKER.instance;
  try {
    WORKER.instance = new Worker(WORKER_URL);
  } catch (e) {
    showError(
      'Your browser does not support Web Workers, or the simulation engine failed to load. ' +
      'Please use a modern browser (Chrome, Firefox, Safari, Edge).'
    );
    return null;
  }
  WORKER.instance.onmessage = onWorkerMessage;
  WORKER.instance.onerror = (e) => {
    devShowError(`Simulation worker error: ${e.message || 'unknown'}`);
    WORKER.busy = false;
    setRunButtonBusy(false);
  };
  return WORKER.instance;
}

function onWorkerMessage(e) {
  const msg = e.data || {};
  if (msg.type === 'progress') {
    devUpdateProgress(msg.completed, msg.total);
  } else if (msg.type === 'results') {
    devRenderResults(msg.data);
    WORKER.busy = false;
    setRunButtonBusy(false);
    refreshRunButtonState();
  } else if (msg.type === 'error') {
    devShowError(msg.message || 'Unknown simulation error.');
    WORKER.busy = false;
    setRunButtonBusy(false);
    refreshRunButtonState();
  }
}

function setRunButtonBusy(busy) {
  const btn = document.getElementById('run-sim');
  if (btn) btn.disabled = busy || !computeValidation().valid;
  const status = document.getElementById('run-status');
  if (status) status.textContent = busy ? 'Running simulation…' : '';
}

/* ============================================================
   Phase 3 — Input panel
   ============================================================ */

const ASSET_GROUPS_FOR_DROPDOWN = ['US Equity', 'International Equity', 'Fixed Income', 'Alternatives'];

const DEFAULTS = {
  current_age: 60,
  spouse_b_age: 60,   // Spouse B's current age; their SS/pension start relative to it
  period_years: 30,
  n_simulations: 10000,
  historical_period: 'modern',
  custom_start: 1972,
  custom_end: 2025,
  sequence_of_returns: false,
  sor_force_2008: false,
  inflation_adjust: true,
  expense_mode: 'annual', // 'annual' | 'monthly'
  initial_balance: 1_000_000,
  allocations: [
    { key: 'sp500',      pct: 60 },
    { key: 'total_bond', pct: 40 },
    { key: '',           pct: 0 },
    { key: '',           pct: 0 },
    { key: '',           pct: 0 },
  ],
  // Guaranteed income streams. ss/pension = Spouse A (primary); ss_b/pension_b =
  // Spouse B, whose start ages resolve against spouse_b_age, not current_age.
  ss:        { amount: 0, start_age: 67 },
  pension:   { amount: 0, start_age: 65, cola: false },
  ss_b:      { amount: 0, start_age: 67 },
  pension_b: { amount: 0, start_age: 65, cola: false },
  annuity:   { amount: 0, start_age: 65, stop_age: null, cola: false }, // stop_age null = lifetime
  // Buckets — one expense per 5 years. Default first bucket is blank;
  // user must enter at least bucket 1 expense before Run enables.
  bucket1_default_expense: 0,
  // Distribution Strategy (v1.1 + v1.2 + v1.3 "None")
  distribution_strategy: 'none',
  minimum_withdrawal_annual: 0,
  strategy_params: {
    real_spending_decline_pct: 2.0,
    upper_guardrail_pct: 6.0,
    lower_guardrail_pct: 4.0,
    upper_adjustment_pct: 10.0,
    lower_adjustment_pct: 10.0,
    vds_ceiling_pct: 5.0,
    vds_floor_pct: 2.5,
  },
};

// Mutable working state for the form
const INPUT_STATE = {
  current_age: DEFAULTS.current_age,
  spouse_b_age: DEFAULTS.spouse_b_age,
  period_years: DEFAULTS.period_years,
  n_simulations: DEFAULTS.n_simulations,
  historical_period: DEFAULTS.historical_period,
  custom_start: DEFAULTS.custom_start,
  custom_end: DEFAULTS.custom_end,
  sequence_of_returns: DEFAULTS.sequence_of_returns,
  sor_force_2008: DEFAULTS.sor_force_2008,
  inflation_adjust: DEFAULTS.inflation_adjust,
  expense_mode: DEFAULTS.expense_mode,
  expenses_uniform: true,            // when true, all buckets sync to Bucket 1
  initial_balance: DEFAULTS.initial_balance,
  allocations: DEFAULTS.allocations.map((a) => ({ ...a })),
  ss:        { ...DEFAULTS.ss },
  pension:   { ...DEFAULTS.pension },
  ss_b:      { ...DEFAULTS.ss_b },
  pension_b: { ...DEFAULTS.pension_b },
  annuity:   { ...DEFAULTS.annuity },
  buckets: [], // [{ expense, manual }]
  // Distribution Strategy
  distribution_strategy: DEFAULTS.distribution_strategy,
  minimum_withdrawal_annual: DEFAULTS.minimum_withdrawal_annual,
  strategy_params: { ...DEFAULTS.strategy_params },
  // Disclaimer / Terms of Use acceptance — null until the user checks the
  // box; set to an ISO timestamp on check, cleared on uncheck. Surfaced in
  // the PDF inputs section as a paper trail that the user agreed before
  // running and exporting.
  terms_accepted_at: null,
};

function initInputPanel() {
  if (!STATE.data) return;
  buildAgeDropdown();
  buildPeriodYearsDropdown();
  buildHistoricalCustomYearDropdowns();
  buildStartAgeDropdowns();
  populateAssetDropdownTemplate();

  // Initialize buckets to match the default period
  INPUT_STATE.buckets = buildBucketsArray(INPUT_STATE.period_years, INPUT_STATE.buckets);
  // Render initial UI
  renderAllocationRows();
  renderBuckets();
  syncSimpleInputsFromState();

  // Event bindings
  bindInputEvents();
  bindStrategyModal();
  bindTermsModal();
  bindExportButtons();

  // Initial validation pass
  refreshAllDerived();
}

/* -----------------------------------------------------------
   Build dropdowns
   ----------------------------------------------------------- */
function buildAgeDropdown() {
  const sel = document.getElementById('current-age');
  if (!sel) return;
  sel.innerHTML = '';
  for (let a = 40; a <= 80; a++) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    if (a === DEFAULTS.current_age) opt.selected = true;
    sel.appendChild(opt);
  }
}

function buildPeriodYearsDropdown() {
  const sel = document.getElementById('period-years');
  if (!sel) return;
  sel.innerHTML = '';
  for (const y of [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = `${y} years`;
    if (y === DEFAULTS.period_years) opt.selected = true;
    sel.appendChild(opt);
  }
}

function buildHistoricalCustomYearDropdowns() {
  const startSel = document.getElementById('custom-start');
  const endSel   = document.getElementById('custom-end');
  if (!startSel || !endSel) return;
  startSel.innerHTML = '';
  endSel.innerHTML = '';
  for (let y = 1871; y <= 2020; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === DEFAULTS.custom_start) opt.selected = true;
    startSel.appendChild(opt);
  }
  for (let y = 1876; y <= 2025; y++) {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    if (y === DEFAULTS.custom_end) opt.selected = true;
    endSel.appendChild(opt);
  }
}

function buildStartAgeDropdowns() {
  const ss      = document.getElementById('ss-start-age');
  const pension = document.getElementById('pension-start-age');
  const annuity = document.getElementById('annuity-start-age');
  fillAgeOptions(ss,      62, 70, DEFAULTS.ss.start_age);
  fillAgeOptions(pension, 50, 80, DEFAULTS.pension.start_age);
  fillAgeOptions(annuity, 50, 90, DEFAULTS.annuity.start_age);
  fillStopAgeOptions(document.getElementById('annuity-stop-age'), 50, 95, DEFAULTS.annuity.stop_age);
  // Spouse B: their own current age + SS/pension start ages.
  fillAgeOptions(document.getElementById('spouse-b-age'),        40, 80, DEFAULTS.spouse_b_age);
  fillAgeOptions(document.getElementById('ss-b-start-age'),      62, 70, DEFAULTS.ss_b.start_age);
  fillAgeOptions(document.getElementById('pension-b-start-age'), 50, 80, DEFAULTS.pension_b.start_age);
}

// Like fillAgeOptions but with a leading "Lifetime" (value "") for streams that
// can end — a null/blank selection means "pays for life" (no stop).
function fillStopAgeOptions(sel, min, max, selectedVal) {
  if (!sel) return;
  sel.innerHTML = '';
  const life = document.createElement('option');
  life.value = '';
  life.textContent = 'Lifetime';
  if (selectedVal == null) life.selected = true;
  sel.appendChild(life);
  for (let a = min; a <= max; a++) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    if (a === selectedVal) opt.selected = true;
    sel.appendChild(opt);
  }
}

function fillAgeOptions(sel, min, max, defaultVal) {
  if (!sel) return;
  sel.innerHTML = '';
  for (let a = min; a <= max; a++) {
    const opt = document.createElement('option');
    opt.value = a;
    opt.textContent = a;
    if (a === defaultVal) opt.selected = true;
    sel.appendChild(opt);
  }
}

function populateAssetDropdownTemplate() {
  // Build a single <select> template (a string) that we clone into each
  // allocation row. Reorders assets by group.
  const groups = ASSET_GROUPS_FOR_DROPDOWN.map((group) => ({
    group,
    assets: STATE.assets.filter((a) => a.group === group),
  }));
  let html = '<option value="">— Select asset —</option>';
  for (const g of groups) {
    html += `<optgroup label="${g.group}">`;
    for (const a of g.assets) {
      html += `<option value="${a.key}">${escapeHtml(a.name)}</option>`;
    }
    html += '</optgroup>';
  }
  INPUT_STATE._assetSelectHtml = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;',
  }[c]));
}

/* -----------------------------------------------------------
   Allocation table — render + interactions
   ----------------------------------------------------------- */
function renderAllocationRows() {
  const tbody = document.getElementById('alloc-rows');
  if (!tbody) return;
  tbody.innerHTML = '';

  const usedKeys = new Set(INPUT_STATE.allocations.map((a) => a.key).filter(Boolean));

  INPUT_STATE.allocations.forEach((alloc, idx) => {
    const tr = document.createElement('tr');

    // Asset dropdown
    const td1 = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'alloc-select select';
    sel.innerHTML = INPUT_STATE._assetSelectHtml;
    sel.value = alloc.key || '';
    // Disable options already used by other rows
    Array.from(sel.options).forEach((opt) => {
      if (opt.value && opt.value !== alloc.key && usedKeys.has(opt.value)) {
        opt.disabled = true;
      }
    });
    sel.addEventListener('change', () => {
      const newKey = sel.value || '';
      if (newKey && INPUT_STATE.allocations.some((a, j) => j !== idx && a.key === newKey)) {
        // Should not happen because options are disabled, but guard anyway
        sel.value = alloc.key || '';
        return;
      }
      INPUT_STATE.allocations[idx].key = newKey;
      renderAllocationRows();
      refreshAllDerived();
    });
    td1.appendChild(sel);
    tr.appendChild(td1);

    // Percentage input
    const td2 = document.createElement('td');
    const pct = document.createElement('input');
    pct.type = 'number';
    pct.min = 0;
    pct.max = 100;
    pct.step = 1;
    pct.className = 'alloc-pct';
    pct.value = alloc.pct ?? '';
    pct.addEventListener('input', () => {
      let v = parseInt(pct.value, 10);
      if (!Number.isFinite(v)) v = 0;
      v = Math.max(0, Math.min(100, v));
      INPUT_STATE.allocations[idx].pct = v;
      updateAllocTotal();
      refreshRunButtonState();
    });
    pct.addEventListener('blur', () => {
      pct.value = INPUT_STATE.allocations[idx].pct ?? 0;
    });
    td2.appendChild(pct);
    tr.appendChild(td2);

    // Remove button (disabled when only 1 row)
    const td3 = document.createElement('td');
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'alloc-remove';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove asset row');
    rm.disabled = INPUT_STATE.allocations.length <= 1;
    rm.addEventListener('click', () => {
      INPUT_STATE.allocations.splice(idx, 1);
      renderAllocationRows();
      refreshAllDerived();
    });
    td3.appendChild(rm);
    tr.appendChild(td3);

    tbody.appendChild(tr);
  });

  // Disable Add button at 10 rows
  const add = document.getElementById('add-alloc');
  if (add) add.disabled = INPUT_STATE.allocations.length >= 10;

  updateAllocTotal();
}

function updateAllocTotal() {
  const total = INPUT_STATE.allocations.reduce((s, a) => s + (a.pct || 0), 0);
  const el = document.getElementById('alloc-total');
  if (el) {
    const ok = total === 100;
    el.textContent = `Total: ${total}%`;
    el.classList.toggle('is-valid',   ok);
    el.classList.toggle('is-invalid', !ok);
  }
  const err = document.getElementById('alloc-error');
  if (err) err.hidden = total === 100;
}

/* -----------------------------------------------------------
   Expense buckets — generation + render + carry-forward
   ----------------------------------------------------------- */
function buildBucketsArray(periodYears, existing) {
  const target = Math.ceil(periodYears / 5);
  const out = [];
  let lastValue = null;
  let lastManual = false;
  for (let i = 0; i < target; i++) {
    if (existing && existing[i]) {
      const b = existing[i];
      out.push({ expense: b.expense || 0, manual: !!b.manual });
      if (b.manual) { lastValue = b.expense; lastManual = true; }
      else if (lastManual && lastValue != null) {
        out[i].expense = lastValue;
      }
    } else {
      // New bucket added because period grew — carry forward from last value
      out.push({ expense: lastValue != null ? lastValue : 0, manual: false });
    }
  }
  return out;
}

function renderBuckets() {
  const container = document.getElementById('buckets-container');
  if (!container) return;
  container.innerHTML = '';
  const monthly = INPUT_STATE.expense_mode === 'monthly';
  const uniform = INPUT_STATE.expenses_uniform;

  // Strategies that lock buckets 2-N (visually + functionally disabled):
  // Constant Dollar uses only bucket 1. Actual Spending Decline carries forward
  // year-over-year and uses bucket 1 alone for floor/ceiling. Vanguard Dynamic
  // floats with the portfolio after the year-1 anchor — buckets 2-N have no
  // effect. Strategies that drive baseline directly from buckets (None, FI, G-K)
  // keep them editable.
  const cdLockBuckets =
    INPUT_STATE.distribution_strategy === 'constant_dollar' ||
    INPUT_STATE.distribution_strategy === 'actual_spending' ||
    INPUT_STATE.distribution_strategy === 'vanguard_dynamic';

  INPUT_STATE.buckets.forEach((bucket, idx) => {
    const startYear = idx * 5 + 1;
    const endYear   = Math.min(startYear + 4, INPUT_STATE.period_years);
    const startAge  = INPUT_STATE.current_age + (startYear - 1);
    const endAge    = INPUT_STATE.current_age + (endYear - 1);

    const wrap = document.createElement('div');
    wrap.className = 'bucket';
    if ((uniform || cdLockBuckets) && idx > 0) wrap.classList.add('bucket--locked');

    const header = document.createElement('div');
    header.className = 'bucket__header';
    const title = document.createElement('div');
    title.className = 'bucket__title';
    title.textContent = `Bucket ${idx + 1} · Ages ${startAge}–${endAge}`;
    const yearsSpan = document.createElement('div');
    yearsSpan.className = 'bucket__years';
    yearsSpan.textContent = `Years ${startYear}–${endYear}`;
    header.appendChild(title);
    header.appendChild(yearsSpan);
    wrap.appendChild(header);

    const labelRow = document.createElement('div');
    labelRow.style.display = 'flex';
    labelRow.style.justifyContent = 'space-between';
    labelRow.style.alignItems = 'baseline';

    const lbl = document.createElement('label');
    lbl.className = 'field-label small';
    lbl.textContent = monthly ? 'Monthly Expenses (today’s $)' : 'Annual Expenses (today’s $)';
    lbl.setAttribute('for', `bucket-${idx}`);
    labelRow.appendChild(lbl);

    if ((uniform || cdLockBuckets) && idx > 0) {
      const synced = document.createElement('span');
      synced.className = 'bucket__carry';
      synced.textContent = cdLockBuckets ? 'not used' : '= Bucket 1';
      labelRow.appendChild(synced);
    } else if (!bucket.manual && idx > 0 && bucket.expense > 0) {
      const carry = document.createElement('span');
      carry.className = 'bucket__carry';
      carry.textContent = '↓ carried forward';
      labelRow.appendChild(carry);
    }
    wrap.appendChild(labelRow);

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `bucket-${idx}`;
    input.className = 'currency-input';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    const displayVal = monthly ? Math.round((bucket.expense || 0) / 12) : (bucket.expense || 0);
    input.value = bucket.expense > 0 ? formatCurrency(displayVal) : '$0';

    if ((uniform || cdLockBuckets) && idx > 0) {
      input.disabled = true;
    } else {
      // Shared logic for propagating bucket 1's value across uniform/carry-forward buckets.
      const propagateBucketValue = (raw) => {
        const annualValue = monthly ? raw * 12 : raw;
        INPUT_STATE.buckets[idx].expense = annualValue;
        INPUT_STATE.buckets[idx].manual = true;
        if (INPUT_STATE.expenses_uniform) {
          // Bucket 1 is the only editable bucket — propagate to all
          for (let j = 1; j < INPUT_STATE.buckets.length; j++) {
            INPUT_STATE.buckets[j].expense = annualValue;
            INPUT_STATE.buckets[j].manual = false;
          }
        } else {
          // Per-bucket carry-forward: propagate into later non-manual buckets
          for (let j = idx + 1; j < INPUT_STATE.buckets.length; j++) {
            if (!INPUT_STATE.buckets[j].manual) {
              INPUT_STATE.buckets[j].expense = annualValue;
            }
          }
        }
      };
      attachCurrencyHandlers(
        input,
        // onCommit (blur): update state, rebuild buckets to reflect uniform/carry-forward
        // labels and re-trigger downstream derived UI. Safe because focus is already
        // leaving the input.
        (raw) => {
          propagateBucketValue(raw);
          renderBuckets();
          refreshAllDerived();
        },
        // onLiveUpdate (input keystroke): update state only — no renderBuckets()
        // because re-creating the input would destroy the active element mid-typing.
        // The blur handler will re-render once the user tabs/clicks away.
        (raw) => {
          propagateBucketValue(raw);
          refreshAllDerived();
        }
      );
    }
    wrap.appendChild(input);

    // Strategy callout for buckets 2+ under non-Constant strategies.
    // Field stays editable; the callout just explains what happens.
    if (idx > 0) {
      const note = strategyBucketNote(INPUT_STATE.distribution_strategy);
      if (note) {
        const callout = document.createElement('div');
        callout.className = 'bucket__strategy-note';
        callout.textContent = note;
        wrap.appendChild(callout);
      }
    }

    container.appendChild(wrap);
  });
}

function strategyBucketNote(strategy) {
  if (strategy === 'none') {
    return null; // No callout — buckets are honored literally as planned.
  }
  if (strategy === 'constant_dollar') {
    return 'Not used under Constant Dollar. Only Bucket 1 drives every year’s withdrawal (inflation-adjusted).';
  }
  if (strategy === 'forgo_inflation') {
    return 'Used as the baseline withdrawal target for years in this bucket. Inflation raises are skipped in years following a portfolio loss, and skipped raises are permanent.';
  }
  if (strategy === 'actual_spending') {
    return 'Not used under Actual Spending Decline. Only Bucket 1 drives the year-1 anchor and the 50% floor / 150% ceiling references.';
  }
  if (strategy === 'guyton_klinger') {
    return 'Acts as a rebase point at this bucket’s transition year. Within the bucket, the prior year’s withdrawal carries forward (with Rule 1 inflation and Rule 2 guardrails). At the transition, the carry-forward value is scaled by (this bucket / prior bucket) so the rebased plan becomes the new baseline.';
  }
  if (strategy === 'vanguard_dynamic') {
    return 'Not used under Vanguard Dynamic Spending. Bucket 1 anchors year-1 spending (which implies the target rate); subsequent years float with the portfolio bounded by the ceiling/floor.';
  }
  return null;
}

/* -----------------------------------------------------------
   Currency input formatting
   ----------------------------------------------------------- */
function attachCurrencyHandlers(input, onCommit, onLiveUpdate) {
  // Two-callback model:
  //   onLiveUpdate (optional) — fired on every keystroke. Should ONLY update
  //     state. Do NOT re-render the containing DOM (it would destroy the input
  //     mid-typing).
  //   onCommit — fired on blur. Final commit; safe to do DOM rebuilds.
  //
  // If the caller doesn't pass onLiveUpdate, we still commit per-keystroke
  // using onCommit — fine for simple inputs (SS, balance, etc.) whose commit
  // callback does NOT recreate the input element.
  input.addEventListener('focus', () => {
    const raw = parseCurrency(input.value);
    input.value = raw > 0 ? String(raw) : '';
  });
  input.addEventListener('input', () => {
    // Strip non-digit chars while typing (but leave the field as the user sees)
    const cleaned = input.value.replace(/[^0-9]/g, '');
    input.value = cleaned;
    // Live-update state to track the displayed digits. Guards against edge
    // cases where blur never fires (touch, focus races, autofill, etc.).
    const raw = cleaned ? parseInt(cleaned, 10) || 0 : 0;
    if (onLiveUpdate) onLiveUpdate(raw);
    else              onCommit(raw);
  });
  input.addEventListener('blur', () => {
    const raw = parseCurrency(input.value);
    input.value = formatCurrency(raw);
    onCommit(raw);
  });
}

function parseCurrency(s) {
  if (!s) return 0;
  const cleaned = String(s).replace(/[^0-9]/g, '');
  if (!cleaned) return 0;
  return parseInt(cleaned, 10) || 0;
}

function formatCurrency(n) {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  return '$' + Math.round(n).toLocaleString('en-US');
}

/* -----------------------------------------------------------
   Sync DOM from INPUT_STATE (one-time after build)
   ----------------------------------------------------------- */
function syncSimpleInputsFromState() {
  const ib = document.getElementById('initial-balance');
  if (ib) ib.value = formatCurrency(INPUT_STATE.initial_balance);

  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  setVal('current-age',  INPUT_STATE.current_age);
  setVal('period-years', INPUT_STATE.period_years);
  setVal('n-simulations',INPUT_STATE.n_simulations);
  setVal('historical-period', INPUT_STATE.historical_period);
  setVal('custom-start', INPUT_STATE.custom_start);
  setVal('custom-end',   INPUT_STATE.custom_end);

  const setChecked = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
  setChecked('sor-toggle',       INPUT_STATE.sequence_of_returns);
  setChecked('sor-force-2008',   INPUT_STATE.sor_force_2008);
  setChecked('inflation-toggle', INPUT_STATE.inflation_adjust);
  setChecked('expense-mode',     INPUT_STATE.expense_mode === 'monthly');
  setChecked('uniform-expense',  INPUT_STATE.expenses_uniform);

  setVal('ss-amount',      formatCurrency(INPUT_STATE.ss.amount));
  setVal('ss-start-age',   INPUT_STATE.ss.start_age);
  setVal('pension-amount', formatCurrency(INPUT_STATE.pension.amount));
  setVal('pension-start-age', INPUT_STATE.pension.start_age);
  setChecked('pension-cola',   INPUT_STATE.pension.cola);
  setVal('spouse-b-age',        INPUT_STATE.spouse_b_age);
  setVal('ss-b-amount',         formatCurrency(INPUT_STATE.ss_b.amount));
  setVal('ss-b-start-age',      INPUT_STATE.ss_b.start_age);
  setVal('pension-b-amount',    formatCurrency(INPUT_STATE.pension_b.amount));
  setVal('pension-b-start-age', INPUT_STATE.pension_b.start_age);
  setChecked('pension-b-cola',  INPUT_STATE.pension_b.cola);
  setVal('annuity-amount', formatCurrency(INPUT_STATE.annuity.amount));
  setVal('annuity-start-age', INPUT_STATE.annuity.start_age);
  setVal('annuity-stop-age',  INPUT_STATE.annuity.stop_age == null ? '' : INPUT_STATE.annuity.stop_age);
  setChecked('annuity-cola',   INPUT_STATE.annuity.cola);

  // Strategy
  setVal('distribution-strategy', INPUT_STATE.distribution_strategy);
  setVal('minimum-withdrawal',    INPUT_STATE.minimum_withdrawal_annual > 0 ? formatCurrency(INPUT_STATE.minimum_withdrawal_annual) : '');
  setVal('real-spending-decline', INPUT_STATE.strategy_params.real_spending_decline_pct);
  setVal('gk-upper-guardrail',    INPUT_STATE.strategy_params.upper_guardrail_pct);
  setVal('gk-lower-guardrail',    INPUT_STATE.strategy_params.lower_guardrail_pct);
  setVal('gk-upper-adjustment',   INPUT_STATE.strategy_params.upper_adjustment_pct);
  setVal('gk-lower-adjustment',   INPUT_STATE.strategy_params.lower_adjustment_pct);
  setVal('vds-ceiling',           INPUT_STATE.strategy_params.vds_ceiling_pct);
  setVal('vds-floor',             INPUT_STATE.strategy_params.vds_floor_pct);

  // Show/hide custom range pane
  const customWrap = document.getElementById('custom-range');
  if (customWrap) customWrap.hidden = INPUT_STATE.historical_period !== 'custom';

  // Show/hide strategy parameter panels + populate description
  const stratDesc = document.getElementById('strategy-description');
  if (stratDesc) stratDesc.textContent = STRATEGY_DESCRIPTIONS[INPUT_STATE.distribution_strategy] || '';
  const aspParams = document.getElementById('params-actual-spending');
  if (aspParams) aspParams.hidden = INPUT_STATE.distribution_strategy !== 'actual_spending';
  const gkParams = document.getElementById('params-guyton-klinger');
  if (gkParams) gkParams.hidden = INPUT_STATE.distribution_strategy !== 'guyton_klinger';
  const vdsParams = document.getElementById('params-vanguard-dynamic');
  if (vdsParams) vdsParams.hidden = INPUT_STATE.distribution_strategy !== 'vanguard_dynamic';
  // Uniform-expense toggle visibility matches strategy
  const uniformRow = document.getElementById('uniform-expense-row');
  if (uniformRow) {
    uniformRow.hidden =
      INPUT_STATE.distribution_strategy === 'constant_dollar' ||
      INPUT_STATE.distribution_strategy === 'actual_spending' ||
      INPUT_STATE.distribution_strategy === 'vanguard_dynamic';
  }
}

/* -----------------------------------------------------------
   Wire form events
   ----------------------------------------------------------- */
function bindInputEvents() {
  // Add allocation
  document.getElementById('add-alloc')?.addEventListener('click', () => {
    if (INPUT_STATE.allocations.length >= 10) return;
    INPUT_STATE.allocations.push({ key: '', pct: 0 });
    renderAllocationRows();
    refreshAllDerived();
  });

  // Initial balance
  const ib = document.getElementById('initial-balance');
  if (ib) {
    attachCurrencyHandlers(ib, (raw) => {
      INPUT_STATE.initial_balance = raw;
      refreshAllDerived();
    });
  }

  // Age / period / simulations
  document.getElementById('current-age')?.addEventListener('change', (e) => {
    INPUT_STATE.current_age = parseInt(e.target.value, 10) || DEFAULTS.current_age;
    renderBuckets();
    refreshAllDerived();
  });
  document.getElementById('period-years')?.addEventListener('change', (e) => {
    INPUT_STATE.period_years = parseInt(e.target.value, 10) || DEFAULTS.period_years;
    INPUT_STATE.buckets = buildBucketsArray(INPUT_STATE.period_years, INPUT_STATE.buckets);
    renderBuckets();
    refreshAllDerived();
  });
  document.getElementById('n-simulations')?.addEventListener('change', (e) => {
    INPUT_STATE.n_simulations = parseInt(e.target.value, 10) || DEFAULTS.n_simulations;
  });

  // Historical period
  document.getElementById('historical-period')?.addEventListener('change', (e) => {
    INPUT_STATE.historical_period = e.target.value;
    const customWrap = document.getElementById('custom-range');
    if (customWrap) customWrap.hidden = INPUT_STATE.historical_period !== 'custom';
    refreshAllDerived();
  });
  document.getElementById('custom-start')?.addEventListener('change', (e) => {
    INPUT_STATE.custom_start = parseInt(e.target.value, 10);
    refreshAllDerived();
  });
  document.getElementById('custom-end')?.addEventListener('change', (e) => {
    INPUT_STATE.custom_end = parseInt(e.target.value, 10);
    refreshAllDerived();
  });

  // SoR + inflation toggles
  document.getElementById('sor-toggle')?.addEventListener('change', (e) => {
    INPUT_STATE.sequence_of_returns = e.target.checked;
    refreshSorUi();
  });
  document.getElementById('sor-force-2008')?.addEventListener('change', (e) => {
    INPUT_STATE.sor_force_2008 = e.target.checked;
    refreshSorUi();
  });
  document.getElementById('inflation-toggle')?.addEventListener('change', (e) => {
    INPUT_STATE.inflation_adjust = e.target.checked;
    const w = document.getElementById('inflation-warning');
    if (w) w.hidden = INPUT_STATE.inflation_adjust;
  });

  // Expense mode (Annual / Monthly)
  document.getElementById('expense-mode')?.addEventListener('change', (e) => {
    INPUT_STATE.expense_mode = e.target.checked ? 'monthly' : 'annual';
    renderBuckets();
  });

  // Use Bucket 1 for all buckets
  document.getElementById('uniform-expense')?.addEventListener('change', (e) => {
    INPUT_STATE.expenses_uniform = e.target.checked;
    if (INPUT_STATE.expenses_uniform && INPUT_STATE.buckets.length > 0) {
      const b1 = INPUT_STATE.buckets[0].expense || 0;
      for (let j = 1; j < INPUT_STATE.buckets.length; j++) {
        INPUT_STATE.buckets[j].expense = b1;
        INPUT_STATE.buckets[j].manual = false;
      }
    }
    renderBuckets();
    refreshAllDerived();
  });

  // Income sources
  const ssAmt = document.getElementById('ss-amount');
  if (ssAmt) attachCurrencyHandlers(ssAmt, (raw) => { INPUT_STATE.ss.amount = raw; refreshAllDerived(); });
  document.getElementById('ss-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.ss.start_age = parseInt(e.target.value, 10) || DEFAULTS.ss.start_age;
    refreshAllDerived();
  });

  const pensAmt = document.getElementById('pension-amount');
  if (pensAmt) attachCurrencyHandlers(pensAmt, (raw) => { INPUT_STATE.pension.amount = raw; refreshAllDerived(); });
  document.getElementById('pension-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.pension.start_age = parseInt(e.target.value, 10) || DEFAULTS.pension.start_age;
    refreshAllDerived();
  });
  document.getElementById('pension-cola')?.addEventListener('change', (e) => {
    INPUT_STATE.pension.cola = e.target.checked;
    refreshAllDerived();
  });

  // Spouse B: current age + their own SS / pension.
  document.getElementById('spouse-b-age')?.addEventListener('change', (e) => {
    INPUT_STATE.spouse_b_age = parseInt(e.target.value, 10) || DEFAULTS.spouse_b_age;
    refreshAllDerived();
  });
  const ssBAmt = document.getElementById('ss-b-amount');
  if (ssBAmt) attachCurrencyHandlers(ssBAmt, (raw) => { INPUT_STATE.ss_b.amount = raw; refreshAllDerived(); });
  document.getElementById('ss-b-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.ss_b.start_age = parseInt(e.target.value, 10) || DEFAULTS.ss_b.start_age;
    refreshAllDerived();
  });
  const pensBAmt = document.getElementById('pension-b-amount');
  if (pensBAmt) attachCurrencyHandlers(pensBAmt, (raw) => { INPUT_STATE.pension_b.amount = raw; refreshAllDerived(); });
  document.getElementById('pension-b-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.pension_b.start_age = parseInt(e.target.value, 10) || DEFAULTS.pension_b.start_age;
    refreshAllDerived();
  });
  document.getElementById('pension-b-cola')?.addEventListener('change', (e) => {
    INPUT_STATE.pension_b.cola = e.target.checked;
    refreshAllDerived();
  });

  const annAmt = document.getElementById('annuity-amount');
  if (annAmt) attachCurrencyHandlers(annAmt, (raw) => { INPUT_STATE.annuity.amount = raw; refreshAllDerived(); });
  document.getElementById('annuity-start-age')?.addEventListener('change', (e) => {
    INPUT_STATE.annuity.start_age = parseInt(e.target.value, 10) || DEFAULTS.annuity.start_age;
    // A stop age that's now before the start age would pay nothing — reset it to
    // Lifetime and reflect that in the select so the state can't be inconsistent.
    if (INPUT_STATE.annuity.stop_age != null && INPUT_STATE.annuity.stop_age < INPUT_STATE.annuity.start_age) {
      INPUT_STATE.annuity.stop_age = null;
      setVal('annuity-stop-age', '');
    }
    refreshAllDerived();
  });
  document.getElementById('annuity-stop-age')?.addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    // Blank ("Lifetime") or a value before the start age ⇒ no stop (lifetime).
    INPUT_STATE.annuity.stop_age = (Number.isFinite(v) && v >= INPUT_STATE.annuity.start_age) ? v : null;
    if (INPUT_STATE.annuity.stop_age == null && e.target.value !== '') setVal('annuity-stop-age', '');
    refreshAllDerived();
  });
  document.getElementById('annuity-cola')?.addEventListener('change', (e) => {
    INPUT_STATE.annuity.cola = e.target.checked;
    refreshAllDerived();
  });

  // Distribution Strategy
  document.getElementById('distribution-strategy')?.addEventListener('change', handleStrategyChange);
  document.getElementById('real-spending-decline')?.addEventListener('input', updateActualSpendingPreview);
  document.getElementById('gk-upper-guardrail')?.addEventListener('input',  () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  document.getElementById('gk-lower-guardrail')?.addEventListener('input',  () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  document.getElementById('gk-upper-adjustment')?.addEventListener('input', () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  document.getElementById('gk-lower-adjustment')?.addEventListener('input', () => { updateGKPreview(); validateGKInputs(); refreshRunButtonState(); });
  document.getElementById('vds-ceiling')?.addEventListener('input', () => { updateVDSPreview(); validateVDSInputs(); refreshRunButtonState(); });
  document.getElementById('vds-floor')?.addEventListener('input',   () => { updateVDSPreview(); validateVDSInputs(); refreshRunButtonState(); });
  const minEl = document.getElementById('minimum-withdrawal');
  if (minEl) {
    attachCurrencyHandlers(minEl, (raw) => {
      INPUT_STATE.minimum_withdrawal_annual = raw;
      handleMinimumWithdrawalChange();
    });
  }

  // Run + Reset (Terms acceptance is handled once, up front, by the clickwrap gate)
  document.getElementById('run-sim')?.addEventListener('click', runSimulationFromInputs);
  document.getElementById('reset-defaults')?.addEventListener('click', resetToDefaults);
  // Mirrored Reset button at the top of the input panel (QA / quick-access).
  document.getElementById('reset-defaults-top')?.addEventListener('click', resetToDefaults);
}

/* -----------------------------------------------------------
   Derived UI updates (constraining warning, net draw, button)
   ----------------------------------------------------------- */
function refreshAllDerived() {
  refreshConstrainingWarning();
  refreshCustomRangeError();
  refreshBalanceError();
  refreshNetDraw();
  refreshSorUi();
  // Strategy live previews — update whenever underlying inputs (bucket 1, balance, income, ages) change.
  if (INPUT_STATE.distribution_strategy === 'actual_spending')  updateActualSpendingPreview();
  if (INPUT_STATE.distribution_strategy === 'guyton_klinger')   updateGKPreview();
  if (INPUT_STATE.distribution_strategy === 'vanguard_dynamic') updateVDSPreview();
  refreshRunButtonState();
}

function refreshSorUi() {
  const sub  = document.getElementById('sor-sub');
  const note = document.getElementById('sor-note');
  if (!sub || !note) return;
  if (!INPUT_STATE.sequence_of_returns) {
    sub.hidden = true;
    note.textContent = '';
    return;
  }
  sub.hidden = false;
  const Y = INPUT_STATE.period_years;
  if (INPUT_STATE.sor_force_2008) {
    note.textContent =
      `Year 1 of every simulation is replaced with 2008's actual returns. The other ${Y - 1} years come from the random bootstrap draw in their drawn order.`;
  } else {
    note.textContent =
      `Within each simulation, ${Y} years are randomly drawn from the selected historical period; the year with the lowest weighted portfolio return is moved to Year 1, and the other ${Y - 1} years stay in their original drawn order. Different simulations will have different Year 1 outcomes.`;
  }
}

function refreshConstrainingWarning() {
  const el = document.getElementById('constraining-warning');
  if (!el) return;
  const period = INPUT_STATE.historical_period;
  let start;
  if (period === 'custom') start = INPUT_STATE.custom_start;
  else if (period === 'native')  start = 1871;
  else if (period === 'postwar') start = 1946;
  else if (period === 'modern')  start = 1972;

  // Find selected asset with latest native_start > period start.
  // Only consider allocations with a positive weight — a 0% asset is dropped by
  // the run-time filter before the worker sees it, so it doesn't actually
  // constrain the sample pool. Including it in this check would produce a
  // misleading warning that doesn't match the simulation's behavior.
  let worst = null;
  for (const a of INPUT_STATE.allocations) {
    if (!a.key) continue;
    if (!(a.pct > 0)) continue;
    const meta = STATE.data.assets[a.key];
    if (!meta) continue;
    if (meta.native_start > start) {
      if (!worst || meta.native_start > worst.native_start) worst = meta;
    }
  }
  if (!worst) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  // Detect data-quality-override assets (TIPS): their splice_note explicitly
  // says pre-native data was REMOVED, so the simulator does NOT use proxy data
  // for them. Tell the truth: the sample pool is narrowed instead.
  const note = (worst.splice_note || '').toLowerCase();
  const proxyRemoved = note.includes('removed') || note.startsWith('real ');
  if (proxyRemoved) {
    el.textContent =
      `${worst.name} has native data starting in ${worst.native_start}. ` +
      `When ${worst.name} is in your allocation, years prior to ${worst.native_start} are excluded ` +
      `from the bootstrap sample pool, effectively restricting the simulation to ${worst.native_start}–${period === 'custom' ? INPUT_STATE.custom_end : 2025}.`;
  } else {
    el.textContent =
      `${worst.name} has native data starting in ${worst.native_start}. Using ${start} ` +
      `will include reconstructed proxy data prior to ${worst.native_start}, which may affect simulation accuracy.`;
  }
}

function refreshCustomRangeError() {
  const el = document.getElementById('custom-range-error');
  if (!el) return;
  if (INPUT_STATE.historical_period !== 'custom') { el.hidden = true; return; }
  const gap = INPUT_STATE.custom_end - INPUT_STATE.custom_start;
  el.hidden = gap >= 5;
}

function refreshBalanceError() {
  const el = document.getElementById('balance-error');
  const input = document.getElementById('initial-balance');
  if (!el) return;
  const v = INPUT_STATE.initial_balance;
  let msg = '';
  if (v < 1000) msg = 'Minimum is $1,000.';
  else if (v > 99_999_999) msg = 'Maximum is $99,999,999.';
  el.hidden = !msg;
  el.textContent = msg;
  if (input) input.classList.toggle('is-invalid', !!msg);
}

function refreshNetDraw() {
  const el = document.getElementById('net-draw-value');
  const hint = document.getElementById('net-draw-hint');
  if (!el || !hint) return;

  // Year 1 net draw using today's-$ values (no inflation applied).
  const monthly = INPUT_STATE.expense_mode === 'monthly';
  const bucket1 = INPUT_STATE.buckets[0]?.expense || 0;
  const annualExpense = bucket1; // already stored as annual

  const age = INPUT_STATE.current_age + 1; // year 1 (Spouse A)
  const ageB = INPUT_STATE.spouse_b_age + 1; // year 1 (Spouse B)
  let income = 0;
  if (INPUT_STATE.ss.amount        > 0 && age  >= INPUT_STATE.ss.start_age)        income += INPUT_STATE.ss.amount;
  if (INPUT_STATE.pension.amount   > 0 && age  >= INPUT_STATE.pension.start_age)   income += INPUT_STATE.pension.amount;
  if (INPUT_STATE.ss_b.amount      > 0 && ageB >= INPUT_STATE.ss_b.start_age)      income += INPUT_STATE.ss_b.amount;
  if (INPUT_STATE.pension_b.amount > 0 && ageB >= INPUT_STATE.pension_b.start_age) income += INPUT_STATE.pension_b.amount;
  if (INPUT_STATE.annuity.amount > 0 && age >= INPUT_STATE.annuity.start_age &&
      (INPUT_STATE.annuity.stop_age == null || age <= INPUT_STATE.annuity.stop_age)) income += INPUT_STATE.annuity.amount;

  const net = annualExpense - income;

  el.classList.remove('is-positive','is-neutral','is-surplus');
  if (annualExpense === 0) {
    el.textContent = '—';
    hint.textContent = 'Enter Bucket 1 expense to see net portfolio draw.';
  } else if (net > 0) {
    el.textContent = formatCurrency(net) + ' / yr';
    el.classList.add('is-positive');
    hint.textContent = monthly
      ? `${formatCurrency(Math.round(net / 12))} / month · Expenses ${formatCurrency(annualExpense)}, Income ${formatCurrency(income)}`
      : `Expenses ${formatCurrency(annualExpense)} − Income ${formatCurrency(income)}`;
  } else if (net === 0) {
    el.textContent = '$0';
    el.classList.add('is-neutral');
    hint.textContent = 'Income exactly covers expenses in Year 1.';
  } else {
    el.textContent = '+ ' + formatCurrency(-net) + ' / yr';
    el.classList.add('is-surplus');
    hint.textContent = 'Income exceeds expenses — surplus will be added to portfolio.';
  }
}

/* -----------------------------------------------------------
   Distribution Strategy (v1.1 + v1.2)
   ----------------------------------------------------------- */
const STRATEGY_DESCRIPTIONS = {
  none:
    'No strategy logic — each year’s withdrawal is set by your expense schedule (the bucket ' +
    'for that year, inflated forward from today’s dollars). Use this when you want the model ' +
    'to honor your planned spending exactly as entered. The simulation tells you whether your ' +
    'portfolio survives that plan.',
  constant_dollar:
    'Withdraws your target expense amount each year, adjusted upward for inflation. ' +
    'Your portfolio absorbs all market gains and losses. This is the strategy assumed ' +
    'in Bengen’s original 4% rule research. Only Bucket 1 is used (buckets 2-N are locked).',
  forgo_inflation:
    'Same as Constant Dollar, except the annual inflation raise is skipped in any year ' +
    'the portfolio lost value. The skipped raise is permanent — it does not catch up. ' +
    'A small, cumulative protection that compounds over a 30+ year retirement.',
  actual_spending:
    'Starts at your target expense level and increases withdrawals at a reduced rate — ' +
    'inflation minus your selected real spending decline rate. Reflects research showing ' +
    'retirees naturally spend less as they age.',
  guyton_klinger:
    'Sets upper and lower withdrawal rate guardrails relative to your portfolio balance. ' +
    'When breached, spending adjusts up or down by the adjustment percentage. Accepts ' +
    'occasional income adjustments in exchange for higher normal-year withdrawals and ' +
    'improved portfolio longevity.',
  vanguard_dynamic:
    'Spending floats with the portfolio: each year’s tentative withdrawal is a constant ' +
    'percentage of the current portfolio (implied by Bucket 1 / starting balance), but ' +
    'real (today’s $) year-over-year change is bounded by a ceiling (max raise) and a ' +
    'floor (max cut). A middle ground between full-percentage and constant-dollar strategies.',
};

/* ============================================================
   Strategy Info Modal — content (Batch C4)
   ============================================================
   Rewritten to reflect the actual implemented behavior of each strategy
   (bucket-driven FI + G-K, bucket-1-only CD + AS, etc.) rather than the
   original v1.2 spec text which described the pre-Phase-3 carry-forward
   models that no longer exist in our worker.
   ============================================================ */
const STRATEGY_INFO_CONTENT = {
  none: {
    title: 'None — Use Expense Schedule',
    sections: [
      { heading: 'How it works',
        body: 'Each year’s withdrawal is whatever you entered in the bucket for that year, inflated forward from today’s dollars. No strategy logic, no guardrails, no inflation skipping. The model honors your planned spending exactly as written — the simulation tells you whether the portfolio can sustain it.' },
      { heading: 'Best for',
        body: 'Users who want to test their own specific spending plan — including planned changes across phases (e.g. higher spending in active early retirement, lower late). The most flexible option for letting your bucket schedule drive the model literally.' },
      { heading: 'Key trade-off',
        body: 'No protection mechanism. If markets perform poorly early in retirement, the model still withdraws your full planned amount each year. Pure stress test of the plan as written.' },
    ],
  },
  constant_dollar: {
    title: 'Constant Dollar — Bengen 4% Rule',
    sections: [
      { heading: 'How it works',
        body: 'Withdraw your Bucket 1 amount in year 1, then increase that exact dollar amount by inflation each year. No exceptions. The portfolio absorbs all market gains and losses silently. No decisions required after initial setup. Buckets 2-N are locked when this strategy is selected — only Bucket 1 drives every year’s withdrawal.' },
      { heading: 'Best for',
        body: 'Retirees who want total spending certainty and have Social Security or a pension covering baseline needs. Comfortable leaving money on the table in good markets. Focused on stable real purchasing power.' },
      { heading: 'What it feels like',
        scenarios: [
          { type: 'steady', label: 'Steady markets', text: 'Calm and predictable. Income rises slightly each year with inflation. The couple never thinks about their strategy — it just works.' },
          { type: 'bear',   label: 'Bear markets',   text: 'Income stays at the same real level — no panic, no decisions. But the portfolio quietly absorbs the full loss. If losses continue, the effective withdrawal rate on the shrinking portfolio climbs.' },
          { type: 'bull',   label: 'Bull markets',   text: 'Income stays the same real level even though the portfolio jumped. Good for building a bequest; less satisfying for those who want to enjoy a strong year in their spending.' },
        ] },
      { heading: 'Key risk',
        body: 'Sequence-of-returns risk. A major bear market early in retirement forces the same real withdrawal from a much smaller portfolio, dramatically increasing depletion risk if losses persist.' },
    ],
  },
  forgo_inflation: {
    title: 'Forgo Inflation Adjustment — T. Rowe Price Method',
    sections: [
      { heading: 'How it works',
        body: 'Each year’s baseline withdrawal = bucket[year] × the effective inflation index. The effective inflation index advances by that year’s inflation if your portfolio gained value, but does NOT advance after a portfolio-loss year. Skipped inflation raises are permanent — the index never catches up. Bucket transitions are honored at face value (planned spending changes still happen).' },
      { heading: 'Best for',
        body: 'Retirees who want a paycheck-like income stream and are comfortable skipping inflation raises after a down year. Identical to Constant Dollar in positive market years — the protection only activates when needed.' },
      { heading: 'What it feels like',
        scenarios: [
          { type: 'steady', label: 'Steady markets', text: 'Income rises with inflation — the protection mechanism never fires.' },
          { type: 'bear',   label: 'Bear markets',   text: 'Next year’s income holds flat instead of rising with inflation. A modest protection — but the skipped raise compounds forward through every remaining year, preserving meaningful portfolio value.' },
          { type: 'bull',   label: 'Bull markets',   text: 'Identical to Constant Dollar — income rises with inflation. The strategy only activates after losses.' },
        ] },
      { heading: 'Key advantage',
        body: 'Each skipped raise stays invested and compounds forward. Research shows this small, repeated protection meaningfully extends portfolio longevity over a 30+ year retirement without requiring any active decision-making.' },
    ],
  },
  actual_spending: {
    title: 'Actual Spending Decline — EBRI / Blanchett Method',
    sections: [
      { heading: 'How it works',
        body: 'Year 1 anchors at Bucket 1 in today’s dollars. Each subsequent year, withdrawal grows at (inflation − your selected real spending decline rate). At the default 2% real decline with 2.5% inflation, withdrawals grow only 0.5% per year in nominal terms — and decline in real terms. A floor (50% of Bucket 1’s inflated target) and ceiling (150%) guard against extreme drift. Buckets 2-N are locked under this strategy — only Bucket 1 drives the math.' },
      { heading: 'The research behind it',
        body: 'EBRI found that inflation-adjusted household spending declines roughly 19% from age 65 to 75, 34% from 65 to 85, and 52% from 65 to 95. David Blanchett modeled this as roughly 2% real decline per year. Morningstar 2025 research confirms this strategy supports meaningfully higher starting withdrawal rates at the same probability of success.' },
      { heading: 'Best for',
        body: 'Retirees who want to spend more in the active early years of retirement, with realistic acceptance that spending will naturally decline as they age. Requires honest self-assessment — the strategy assumes you genuinely will spend less at 80 than at 65.' },
      { heading: 'Key trade-off',
        body: 'Constant Dollar eventually catches up in nominal income — typically around age 73. But by then, spending research shows retirees’ actual needs have declined. The strategy is designed around how people actually live, not an inflation formula.' },
    ],
  },
  guyton_klinger: {
    title: 'Guyton-Klinger Guardrails',
    sections: [
      { heading: 'How it works',
        body: 'Year 1 anchors at Bucket 1 in today’s dollars. Each subsequent year starts from the prior year’s actual withdrawal — cuts and raises compound forward. Rule 1: if last year had a portfolio loss, the inflation raise is skipped (same mechanism as Forgo Inflation). Rule 2: compute the effective withdrawal rate = (gross expense − SS − Pension − Annuity) ÷ current portfolio. If it exceeds your upper guardrail, cut spending by the upper adjustment %. If it falls below your lower guardrail, raise by the lower adjustment %. The cut/raise is applied to the carry-forward, so its effect persists into all future years. Buckets 2-N act as rebase points: at a bucket transition the carry-forward is scaled by (new bucket / old bucket), so the user’s revised real-dollar plan becomes the new baseline. The upper-guardrail cut is suspended in the final 15 years (no point cutting late in life).' },
      { heading: 'Best for',
        body: 'Retirees who want to maximize lifetime spending and accept occasional income adjustments. Works best when Social Security or a pension covers essential expenses — so guardrail cuts affect discretionary spending rather than basic needs.' },
      { heading: 'What it feels like',
        scenarios: [
          { type: 'steady', label: 'Steady markets', text: 'Income rises with inflation — rate stays within the guardrail band. The couple earns significantly more than Constant Dollar with no decisions required.' },
          { type: 'bear',   label: 'Bear markets',   text: 'Both rules may activate. Rule 1 skips the inflation raise. Rule 2 may then fire a spending cut. A meaningful income reduction — but the couple still typically earns more than Constant Dollar even after the cut.' },
          { type: 'bull',   label: 'Bull markets',   text: 'Income rises with inflation. In a strong year the lower guardrail may fire, triggering a spending raise. Strong markets accumulate quietly until the lower threshold is reached.' },
        ] },
      { heading: 'Key advantage over Constant Dollar',
        body: 'Morningstar 2025 research shows Guyton-Klinger supports significantly higher starting safe withdrawal rates than Constant Dollar at the same probability of success. Lifetime spending is higher in the median scenario despite occasional cuts.' },
      { heading: 'Key risk',
        is_warning: true,
        body: 'In severe or prolonged bear markets, the upper guardrail may fire repeatedly, producing meaningful cumulative income cuts. Research shows this strategy can require cuts exceeding 40% of original income in the worst historical sequences. A minimum withdrawal floor helps protect against this.' },
    ],
  },
  vanguard_dynamic: {
    title: 'Vanguard Dynamic Spending',
    sections: [
      { heading: 'How it works',
        body: 'Year 1 anchors at Bucket 1 in today’s dollars. The implied target rate = Bucket 1 ÷ starting balance. Each subsequent year, a tentative withdrawal is computed as current portfolio × target rate. That tentative amount is then bounded by year-over-year caps applied in REAL (today’s $) terms: a ceiling (no more than +X% real raise) and a floor (no greater than −Y% real cut). Because the caps are in real dollars, the nominal ceiling/floor automatically scales with inflation — in a high-inflation year, the nominal cap is correspondingly higher. The final, bounded amount carries forward in real terms as the new base for next year’s caps. Buckets 2-N are locked — the strategy is purely portfolio-driven after the year-1 anchor.' },
      { heading: 'The research behind it',
        body: 'Vanguard’s Dynamic Spending model (Bruno, Zilbering, et al.) was designed as a middle ground between constant-dollar withdrawals (stable income, full sequence-of-returns risk) and pure percentage-of-portfolio withdrawals (no risk of depletion, but income swings wildly). The caps preserve most of the longevity advantage of percentage-of-portfolio while keeping year-to-year income volatility manageable.' },
      { heading: 'Best for',
        body: 'Retirees comfortable with some income variability who want their spending to participate in market gains and respond to market losses — but not too sharply in either direction. Particularly suited to portfolios with growth potential where letting spending track the portfolio reduces the risk of dying with far more than planned.' },
      { heading: 'What it feels like',
        scenarios: [
          { type: 'steady', label: 'Steady markets', text: 'Real income drifts close to the target rate × real portfolio. The ceiling and floor rarely bind. Year-over-year real changes are small.' },
          { type: 'bear',   label: 'Bear markets',   text: 'Portfolio drops, so target × portfolio would fall sharply in real terms. The floor activates and limits the real cut to −Y% per year. Spending glides down rather than plunging. Several consecutive bad years compound modest real cuts.' },
          { type: 'bull',   label: 'Bull markets',   text: 'Portfolio surges, so target × portfolio would jump well above last year in real terms. The ceiling activates and limits the real raise to +X% per year. Income grows steadily without overshooting; the "excess" gain stays invested and compounds.' },
        ] },
      { heading: 'Key trade-off',
        body: 'Unlike Constant Dollar, real purchasing power is not guaranteed — at a target rate higher than the portfolio’s sustainable real return, real spending will gradually decline. Unlike Guyton-Klinger, there is no inflation-skip rule and no portfolio-rate-based trigger — the caps are simply on real year-over-year change. Simpler than G-K, more responsive than CD, and the real-dollar caps mean the strategy behaves identically across high- and low-inflation regimes.' },
      { heading: 'Worked example — 6-year walkthrough',
        intro: 'Assumes a $1,000,000 starting portfolio, 5% target rate (so Bucket 1 = $50,000), and 0% inflation so real = nominal. Sequencing each year: withdraw first, then apply that year’s return. Cap test compares target ÷ prior_withdrawal (not the market return) — a strong market year can still trigger the floor if prior was high enough.',
        table: {
          columns: ['Year', 'Return', 'Start', 'Target (5%)', 'Floor (−2.5%)', 'Ceiling (+5%)', 'Cap', 'Withdrawal', 'End'],
          rows: [
            ['1', '−20%', '$1,000,000', 'anchor',  '—',        '—',         '—',          '$50,000', '$760,000'],
            ['2', '+20%', '$760,000',   '$38,000', '$48,750',  '$52,500',   'floor',      '$48,750', '$853,500'],
            ['3', '+40%', '$853,500',   '$42,675', '$47,531',  '$51,188',   'floor',      '$47,531', '$1,128,357'],
            ['4', '0%',   '$1,128,357', '$56,418', '$46,343',  '$49,907',   'ceiling',    '$49,907', '$1,078,450'],
            ['5', '0%',   '$1,078,450', '$53,923', '$48,659',  '$52,402',   'ceiling',    '$52,402', '$1,026,048'],
            ['6', '0%',   '$1,026,048', '$51,302', '$51,092',  '$55,022',   'none',       '$51,302', '$974,746'],
          ],
        },
        notes: [
          'Year 1 is the anchor — no cap test. The implicit target rate ($50K ÷ $1M = 5%) is what drives every subsequent year’s target.',
          'Year 3 illustrates the most common confusion: a +40% market year still triggers the floor cap because target ($42,675) is below prior × 0.975 ($47,531). The cap test compares target to prior, not to the return.',
          'In the actual implementation, the cap test runs in real (today’s $) dollars. With nonzero inflation, the nominal ceiling/floor automatically scales — at 10% inflation, the +5% real ceiling becomes roughly +15.5% nominal.',
          'Algebraically equivalent to Vanguard’s published nominal formulation. Vanguard often writes the caps as prior_actual_nominal × (1 + inflation_this_year) × (1 ± cap%). This implementation stores the post-cap value in real (today’s $) dollars, applies the ± cap% there, and multiplies by the current inflation index to get nominal. Substituting the definitions, both produce the same nominal ceiling and floor each year and the same carry-forward trajectory — including when caps fire, since the post-cap value (not a fixed baseline) is what propagates forward.',
        ],
      },
    ],
  },
};

function buildModalContent(strategy) {
  const content = STRATEGY_INFO_CONTENT[strategy];
  if (!content) return;
  document.getElementById('modal-title').textContent = content.title;
  let html = '';
  content.sections.forEach((section) => {
    html += `<h3>${escapeHtml(section.heading)}</h3>`;
    if (section.body) {
      const cls = section.is_warning ? 'modal-warning' : '';
      html += `<p class="${cls}">${escapeHtml(section.body)}</p>`;
    }
    if (section.intro) {
      html += `<p>${escapeHtml(section.intro)}</p>`;
    }
    if (section.table) {
      const tbl = section.table;
      html += `<div class="modal-table-wrap"><table class="modal-table"><thead><tr>`;
      tbl.columns.forEach((c) => { html += `<th>${escapeHtml(c)}</th>`; });
      html += `</tr></thead><tbody>`;
      tbl.rows.forEach((row) => {
        html += `<tr>`;
        row.forEach((cell, i) => {
          // Highlight the "Cap" column when it contains 'floor' or 'ceiling'
          let cls = i === 0 ? 'modal-table__year' : 'modal-table__num';
          const lower = String(cell).toLowerCase();
          if (lower === 'floor')   cls = 'modal-table__cap modal-table__cap--floor';
          if (lower === 'ceiling') cls = 'modal-table__cap modal-table__cap--ceiling';
          if (lower === 'none')    cls = 'modal-table__cap modal-table__cap--none';
          html += `<td class="${cls}">${escapeHtml(cell)}</td>`;
        });
        html += `</tr>`;
      });
      html += `</tbody></table></div>`;
    }
    if (section.notes) {
      html += `<ul class="modal-notes">`;
      section.notes.forEach((n) => { html += `<li>${escapeHtml(n)}</li>`; });
      html += `</ul>`;
    }
    if (section.scenarios) {
      section.scenarios.forEach((sc) => {
        html += `<div class="modal-scenario ${escapeHtml(sc.type)}"><span class="modal-scenario__label">${escapeHtml(sc.label)}</span><p>${escapeHtml(sc.text)}</p></div>`;
      });
    }
  });
  document.getElementById('modal-body').innerHTML = html;
}

function openStrategyModal() {
  const strategy = document.getElementById('distribution-strategy').value;
  buildModalContent(strategy);
  const modal = document.getElementById('strategy-info-modal');
  modal.hidden = false;
  // Move focus into the modal for keyboard users
  setTimeout(() => document.getElementById('modal-close-btn')?.focus(), 50);
  document.addEventListener('keydown', handleModalKeydown);
}

function closeStrategyModal() {
  document.getElementById('strategy-info-modal').hidden = true;
  document.removeEventListener('keydown', handleModalKeydown);
  document.getElementById('strategy-info-btn')?.focus();
}

function handleModalKeydown(e) {
  if (e.key === 'Escape') closeStrategyModal();
}

function bindStrategyModal() {
  document.getElementById('strategy-info-btn')?.addEventListener('click', openStrategyModal);
  document.getElementById('modal-close-btn')?.addEventListener('click', closeStrategyModal);
  document.getElementById('modal-close-footer-btn')?.addEventListener('click', closeStrategyModal);
  document.getElementById('strategy-info-modal')?.addEventListener('click', (e) => {
    // Click on the overlay background (not the panel) closes the modal
    if (e.target.id === 'strategy-info-modal') closeStrategyModal();
  });
}

/* ============================================================
   Terms of Use modal — opens from the "terms of use" hyperlink
   in the disclaimer checkbox. Mirrors the strategy info modal
   pattern (overlay-click closes, Esc closes, focus management).
   The hyperlink does NOT toggle the checkbox — clicking it only
   opens the modal so the user can read the full text first.
   ============================================================ */
function openTermsModal() {
  const modal = document.getElementById('terms-modal');
  if (!modal) return;
  modal.hidden = false;
  setTimeout(() => document.getElementById('terms-modal-close-btn')?.focus(), 50);
  document.addEventListener('keydown', handleTermsModalKeydown);
}
function closeTermsModal() {
  const modal = document.getElementById('terms-modal');
  if (!modal) return;
  modal.hidden = true;
  document.removeEventListener('keydown', handleTermsModalKeydown);
  document.getElementById('open-terms-link')?.focus();
}
function handleTermsModalKeydown(e) {
  if (e.key === 'Escape') closeTermsModal();
}
function bindTermsModal() {
  document.getElementById('open-terms-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    // Don't let the click bubble up to the surrounding <label>, which would
    // toggle the disclaimer checkbox. The user must explicitly check the box
    // after reading.
    e.stopPropagation();
    openTermsModal();
  });
  document.getElementById('methodology-open-terms')?.addEventListener('click', (e) => {
    e.preventDefault();
    openTermsModal();
  });
  document.getElementById('terms-modal-close-btn')?.addEventListener('click', closeTermsModal);
  document.getElementById('terms-modal-close-footer-btn')?.addEventListener('click', closeTermsModal);
  document.getElementById('terms-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'terms-modal') closeTermsModal();
  });
}

/* ============================================================
   Scenario Export (PDF + CSV + Clipboard)
   ============================================================
   Produces a one-row CSV per the producer contract in the project plan
   (file: ~/.claude/plans/buzzing-fluttering-kettle.md). Magic
   schema_version tag in column 1 lets the future comparison tool detect
   data rows reliably even when users paste fragments from clipboards
   or text editors. RFC 4180 escape rules; CRLF line endings.

   PDF export uses the browser's native print-to-PDF via @media print
   stylesheet. No third-party PDF library — keeps this app dependency-free.

   All export operations require `lastResults` to be populated (i.e. a
   simulation has completed). UI gates the buttons until then.
   ============================================================ */

const SCHEMA_VERSION = 'btn-mcsim-csv-v1';

// Internal strategy id -> human-readable label for the CSV strategy column
// (we keep the lowercase id in CSV per the producer contract, but use these
// labels in the PDF and auto-default scenario label).
const STRATEGY_DISPLAY_NAMES = {
  none:             'None — Use Expense Schedule',
  constant_dollar:  'Constant Dollar (Bengen 4% rule)',
  forgo_inflation:  'Forgo Inflation Adjustment',
  actual_spending:  'Actual Spending Decline',
  guyton_klinger:   'Guyton-Klinger Guardrails',
  vanguard_dynamic: 'Vanguard Dynamic Spending',
};

// Short display names used inside the auto-default scenario label so the
// label fits in a CSV cell / file name. Different from the modal title above.
const STRATEGY_SHORT_NAMES = {
  none:             'Expense Schedule',
  constant_dollar:  'Constant Dollar',
  forgo_inflation:  'Forgo Inflation',
  actual_spending:  'Actual Spending',
  guyton_klinger:   'Guyton-Klinger',
  vanguard_dynamic: 'Vanguard Dynamic',
};

function getAllocationSummary() {
  // "60% Large Cap Blend / 40% Intermediate Treasury" — uses the asset's
  // display name from STATE.data.assets, not the internal key.
  const parts = [];
  for (const a of INPUT_STATE.allocations) {
    if (!a.key || !(a.pct > 0)) continue;
    const meta = STATE.data && STATE.data.assets && STATE.data.assets[a.key];
    const name = (meta && meta.name) || a.key;
    parts.push(`${a.pct}% ${name}`);
  }
  return parts.join(' / ');
}

function getAutoDefaultLabel(results) {
  // "Constant Dollar 4.0% — modern era" style fallback when the user
  // hasn't typed a label of their own.
  const strat = STRATEGY_SHORT_NAMES[INPUT_STATE.distribution_strategy] || INPUT_STATE.distribution_strategy;
  const swr = (results && Number.isFinite(results.year1_withdrawal_rate_pct))
    ? results.year1_withdrawal_rate_pct.toFixed(2) + '%'
    : '';
  // Pull the period descriptor from the historical_period string,
  // e.g. "1972-2025 (modern era)" -> "modern era".
  const periodMatch = String(results?.inputs_summary?.historical_period || '').match(/\(([^)]+)\)/);
  const periodLabel = periodMatch ? periodMatch[1] : '';
  const parts = [strat];
  if (swr) parts.push(swr);
  let out = parts.join(' ');
  if (periodLabel) out += ` — ${periodLabel}`;
  return out;
}

function buildExportRow(results, userLabel) {
  // Snapshot the producer contract's 21 columns. Source mappings match
  // the table in the plan exactly. All money values are RAW numbers
  // (no $, no commas, no percentage scaling — consumer-side formatting).
  const label = (userLabel && String(userLabel).trim()) || getAutoDefaultLabel(results);
  const inp = INPUT_STATE;
  const inpSum = results.inputs_summary;
  const stats = results.statistics || {};
  const incomePaths = results.income_percentile_paths || {};

  // avg_annual_real_spending = mean of the p50 real-income path
  const realP50 = Array.isArray(incomePaths.real_p50) ? incomePaths.real_p50 : [];
  const avgAnnualRealSpending = realP50.length
    ? realP50.reduce((s, v) => s + v, 0) / realP50.length
    : 0;

  // lifetime_real_spending_p10/p50/p90 = sum of each real-income path
  const sumOf = (arr) => Array.isArray(arr) && arr.length ? arr.reduce((s, v) => s + v, 0) : 0;
  const lifetimeP10 = sumOf(incomePaths.real_p10);
  const lifetimeP50 = sumOf(incomePaths.real_p50);
  const lifetimeP90 = sumOf(incomePaths.real_p90);

  return {
    schema_version:               SCHEMA_VERSION,
    label:                        label,
    exported_at:                  new Date().toISOString(),
    strategy:                     inp.distribution_strategy,
    historical_period:            inpSum.historical_period,
    period_years:                 inp.period_years,
    initial_balance:              inp.initial_balance,
    starting_rate_pct:            +(results.year1_withdrawal_rate_pct || 0),
    success_rate_pct:             +(results.success_metrics?.success_rate_pct || 0),
    ending_balance_real_p10:      +(stats.p10?.ending_balance_real || 0),
    ending_balance_real_p50:      +(stats.p50?.ending_balance_real || 0),
    ending_balance_real_p90:      +(stats.p90?.ending_balance_real || 0),
    avg_annual_real_spending:     avgAnnualRealSpending,
    lifetime_real_spending_p10:   lifetimeP10,
    lifetime_real_spending_p50:   lifetimeP50,
    lifetime_real_spending_p90:   lifetimeP90,
    spouse_b_age:                 inp.spouse_b_age ?? null,
    ss_amount:                    inp.ss?.amount || 0,
    ss_start_age:                 inp.ss?.start_age ?? null,
    pension_amount:               inp.pension?.amount || 0,
    pension_start_age:            inp.pension?.start_age ?? null,
    ss_b_amount:                  inp.ss_b?.amount || 0,
    ss_b_start_age:               inp.ss_b?.start_age ?? null,
    pension_b_amount:             inp.pension_b?.amount || 0,
    pension_b_start_age:          inp.pension_b?.start_age ?? null,
    annuity_amount:               inp.annuity?.amount || 0,
    annuity_start_age:            inp.annuity?.start_age ?? null,
    annuity_stop_age:             inp.annuity?.stop_age ?? null,  // null = lifetime
    sor_active:                   !!inp.sequence_of_returns,
    sor_force_2008:               !!inp.sor_force_2008,
    allocation_summary:           getAllocationSummary(),
  };
}

function formatCsvField(value) {
  // RFC 4180 escape:
  //   * Quote-wrap if the value contains comma, quote, CR, or LF.
  //   * Double any embedded quote inside a quoted field.
  //   * Booleans render as lowercase true/false (no quotes).
  //   * Numbers render with toString — no $/comma formatting.
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const str = String(value);
  if (/[,"\r\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function buildCsvString(rowObj) {
  // Producer contract: header row always emitted, CRLF line endings.
  const cols = Object.keys(rowObj);
  const header = cols.join(',');
  const data = cols.map((c) => formatCsvField(rowObj[c])).join(',');
  return header + '\r\n' + data + '\r\n';
}

function slugForFilename(label) {
  // ASCII-safe slug for download filenames.
  return String(label || 'scenario')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'scenario';
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function getExportLabelValue() {
  // Read the user-supplied label (if any). The auto-default lives in the
  // placeholder, not the value, so an empty field means "use the default."
  const el = document.getElementById('export-label');
  return el ? el.value : '';
}

function showExportToast(message) {
  // Two channels of feedback so the user can't miss it:
  //  (1) Floating toast at bottom of viewport (existing pattern).
  //  (2) Inline status text inside the export card (impossible to miss
  //      even if the toast lands off-screen in an embedded preview pane).
  let toast = document.getElementById('export-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'export-toast';
    toast.className = 'export-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(showExportToast._t);
  showExportToast._t = setTimeout(() => toast.classList.remove('is-visible'), 4000);

  // Inline status mirror inside the export card so the user always sees
  // feedback, even if the floating toast is clipped by the preview pane.
  const inline = document.getElementById('export-status');
  if (inline) {
    inline.textContent = message;
    inline.classList.add('is-visible');
    clearTimeout(showExportToast._inlineT);
    showExportToast._inlineT = setTimeout(() => inline.classList.remove('is-visible'), 8000);
  }
}

function downloadCSV() {
  if (!lastResults) return;
  const label = getExportLabelValue();
  const row = buildExportRow(lastResults, label);
  const csv = buildCsvString(row);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `btn-${slugForFilename(row.label)}-${todayStamp()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showExportToast('CSV downloaded');
}

async function copyCSVToClipboard() {
  if (!lastResults) return;
  const label = getExportLabelValue();
  const row = buildExportRow(lastResults, label);
  const csv = buildCsvString(row);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(csv);
      showExportToast('Copied to clipboard');
      return;
    }
    // Legacy fallback (older browsers without async Clipboard API).
    const ta = document.createElement('textarea');
    ta.value = csv;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showExportToast('Copied to clipboard');
  } catch (e) {
    showExportToast('Copy failed — try Download CSV');
  }
}

function downloadPDF() {
  if (!lastResults) {
    showExportToast('Run a simulation first');
    return;
  }
  if (!window.jspdf || !window.jspdf.jsPDF) {
    showExportToast('PDF library not loaded — refresh the page');
    console.error('downloadPDF: jsPDF not available on window.jspdf');
    return;
  }

  showExportToast('Generating PDF…');

  // Defer the actual render to the next frame so the toast paints first.
  requestAnimationFrame(() => {
    try {
      const label = (getExportLabelValue() || getAutoDefaultLabel(lastResults)).trim();
      const inp = INPUT_STATE;
      const inpSum = lastResults.inputs_summary;
      const stats = lastResults.statistics || {};
      const sm = lastResults.success_metrics || {};
      const fmtMoney = (n) => fmtCurrencyShort(n);
      const fmtPct = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) + '%' : '—');
      const sumOf = (arr) => Array.isArray(arr) && arr.length ? arr.reduce((s, v) => s + v, 0) : 0;
      const realP50 = lastResults.income_percentile_paths?.real_p50 || [];
      const avgAnnualReal = realP50.length ? realP50.reduce((s, v) => s + v, 0) / realP50.length : 0;
      const lifeP50 = sumOf(lastResults.income_percentile_paths?.real_p50);

      const incomeRow = [];
      // Tag streams A/B only when Spouse B is actually in play, so single-filer
      // PDFs stay clean ("SS $30,000" rather than "SS (A) $30,000").
      const hasSpouseB = (inp.ss_b?.amount > 0) || (inp.pension_b?.amount > 0);
      const aTag = hasSpouseB ? ' (A)' : '';
      if (inp.ss.amount > 0)      incomeRow.push(`SS${aTag} ${fmtMoney(inp.ss.amount)}`);
      if (inp.pension.amount > 0) incomeRow.push(`Pension${aTag} ${fmtMoney(inp.pension.amount)}`);
      if (inp.ss_b?.amount > 0)      incomeRow.push(`SS (B) ${fmtMoney(inp.ss_b.amount)}`);
      if (inp.pension_b?.amount > 0) incomeRow.push(`Pension (B) ${fmtMoney(inp.pension_b.amount)}`);
      if (inp.annuity.amount > 0) {
        const annWindow = inp.annuity.stop_age != null
          ? ` (age ${inp.annuity.start_age}–${inp.annuity.stop_age})`
          : '';
        incomeRow.push(`Annuity ${fmtMoney(inp.annuity.amount)}${annWindow}`);
      }
      const incomeStr = incomeRow.length ? incomeRow.join(' / ') : 'None';
      const sorStr = inp.sequence_of_returns
        ? (inp.sor_force_2008 ? 'On (forced 2008)' : 'On (worst year)')
        : 'Off';

      // --- jsPDF setup. Letter, portrait, points (1 in = 72 pt). ---
      // Vertical budget (target usable height = PAGE_H - 2 * MARGIN_TOP = 720pt).
      //   Header block         ......  64
      //   Scenario + timestamp ......  36
      //   Success rate block   ......  98
      //   Key metrics          ......  74
      //   Portfolio chart      ......  128 (title 12 + chart 110 + gap 6)
      //   Income chart         ......  128
      //   Inputs (2-col grid)  ......  74
      //   Disclaimer + footer  ......  40
      //   Inter-section gaps   ......  28
      //   ---------------------------
      //   TOTAL                ......  670 (fits in 720 with 50pt buffer)
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
      const PAGE_W = 612, PAGE_H = 792;
      const MARGIN_X = 43, MARGIN_TOP = 36;
      const CONTENT_W = PAGE_W - MARGIN_X * 2;
      const SECTION_GAP = 8;   // padding between major sections

      // Brand colors as RGB triples (mirrors --ink, --gold, --navy, --soft, --teal, --clay)
      const INK  = [20, 24, 30];
      const GOLD = [181, 136, 32];
      const NAVY = [31, 61, 107];
      const TEAL = [26, 110, 110];
      const CLAY = [200, 74, 48];
      const SOFT = [90, 85, 76];
      const RULE = [205, 200, 192];

      let y = MARGIN_TOP;

      // === Header: gold dot + brand title + descriptor ===
      doc.setFillColor(...GOLD);
      doc.circle(MARGIN_X + 6, y + 8, 4.5, 'F');
      doc.setTextColor(...INK);
      doc.setFont('times', 'normal');
      doc.setFontSize(18);
      doc.text('Beyond the ', MARGIN_X + 18, y + 13);
      const beforeNoiseW = doc.getTextWidth('Beyond the ');
      doc.setFont('times', 'italic');
      doc.text('Noise', MARGIN_X + 18 + beforeNoiseW, y + 13);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...SOFT);
      doc.text('MONTE CARLO RETIREMENT SCENARIO', MARGIN_X + 18, y + 24);
      y += 34;

      // Rule under header
      doc.setDrawColor(...INK);
      doc.setLineWidth(1.0);
      doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
      y += 12;

      // Scenario label + timestamp
      doc.setFont('times', 'italic');
      doc.setFontSize(14);
      doc.setTextColor(...INK);
      doc.text(`Scenario: ${label}`, MARGIN_X, y);
      y += 12;
      doc.setFont('courier', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...SOFT);
      doc.text(`Exported ${new Date().toLocaleString()}  ·  Beyond the Noise MC Simulator`, MARGIN_X, y);
      y += SECTION_GAP + 10;

      // === Success rate block (compact) ===
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...SOFT);
      const eyebrow = 'PORTFOLIO SUCCESS RATE';
      doc.text(eyebrow, PAGE_W / 2 - doc.getTextWidth(eyebrow) / 2, y);
      y += 6;

      const pct = Number.isFinite(sm.success_rate_pct) ? sm.success_rate_pct : 0;
      const rateColor = pct >= 90 ? TEAL
                      : pct >= 75 ? NAVY
                      : pct >= 50 ? GOLD
                      : CLAY;
      doc.setFont('times', 'normal');
      doc.setFontSize(46);
      doc.setTextColor(...rateColor);
      const rateStr = `${pct.toFixed(1)}%`;
      doc.text(rateStr, PAGE_W / 2 - doc.getTextWidth(rateStr) / 2, y + 38);
      y += 46;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...SOFT);
      const countStr = `${(sm.success_count || 0).toLocaleString('en-US')} of ${(sm.total_simulations || 0).toLocaleString('en-US')} simulations ended with $1 or more`;
      doc.text(countStr, PAGE_W / 2 - doc.getTextWidth(countStr) / 2, y);
      y += 11;
      if (sm.failure_count > 0 && sm.median_depletion_year != null) {
        const sa = lastResults.inputs_summary.start_age;
        const medY = sm.median_depletion_year;
        const depStr = `Median depletion: Year ${medY} (Age ${sa + medY})`;
        doc.setFontSize(8.5);
        doc.text(depStr, PAGE_W / 2 - doc.getTextWidth(depStr) / 2, y);
        y += 10;
      }
      y += SECTION_GAP;
      doc.setDrawColor(...RULE);
      doc.setLineWidth(0.5);
      doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
      y += 12;

      // === Key Metrics table (real $, 4 rows) ===
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...SOFT);
      doc.text("KEY METRICS  (real, today's $)", MARGIN_X, y);
      y += 11;

      const metricsRows = [
        ['Starting safe withdrawal rate',          fmtPct(lastResults.year1_withdrawal_rate_pct)],
        ['Avg annual real spending',               fmtMoney(avgAnnualReal)],
        ['Lifetime real spending (p50)',           fmtMoney(lifeP50)],
        ['Real ending balance (p10 / p50 / p90)',  `${fmtMoney(stats.p10?.ending_balance_real || 0)} / ${fmtMoney(stats.p50?.ending_balance_real || 0)} / ${fmtMoney(stats.p90?.ending_balance_real || 0)}`],
      ];
      doc.setFontSize(9.5);
      for (const [k, v] of metricsRows) {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(...SOFT);
        doc.text(k, MARGIN_X, y);
        doc.setFont('courier', 'normal');
        doc.setTextColor(...INK);
        doc.text(v, PAGE_W - MARGIN_X - doc.getTextWidth(v), y);
        y += 12;
      }
      y += SECTION_GAP;
      doc.setDrawColor(...RULE);
      doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
      y += 12;

      // === Charts (via Chart.js toBase64Image) ===
      const CHART_W = CONTENT_W;
      const CHART_H = 110;
      const drawChart = (chartInstance, title) => {
        if (!chartInstance) return;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...SOFT);
        doc.text(title, MARGIN_X, y);
        y += 8;
        try {
          const dataUrl = chartInstance.toBase64Image('image/png', 1.0);
          doc.addImage(dataUrl, 'PNG', MARGIN_X, y, CHART_W, CHART_H, undefined, 'FAST');
        } catch (e) {
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(9);
          doc.setTextColor(...SOFT);
          doc.text('(chart could not be captured)', MARGIN_X, y + 14);
        }
        y += CHART_H + SECTION_GAP;
      };

      drawChart(portfolioFanChart, 'PROJECTED PORTFOLIO BALANCE (Nominal)');
      drawChart(incomeFanChart,    'PROJECTED ANNUAL SPENDING');

      doc.setDrawColor(...RULE);
      doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
      y += 12;

      // === Inputs (2-column grid, 4 rows × 2 columns) ===
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...SOFT);
      doc.text('INPUTS', MARGIN_X, y);
      y += 11;

      const inputsRows = [
        ['Starting balance',        fmtMoney(inp.initial_balance)],
        ['Age / horizon',           `${inp.current_age} / ${inp.period_years} yrs`],
        ['Period',                  inpSum.historical_period.replace(/\s*\([^)]+\)\s*/, '')], // trim parenthetical label
        ['Strategy',                STRATEGY_SHORT_NAMES[inp.distribution_strategy] || inp.distribution_strategy],
        ['Allocation',              getAllocationSummary() || '—'],
        ['Bucket 1 expense',        `${fmtMoney(inp.buckets[0]?.expense || 0)}/yr`],
        ['SS / Pension / Annuity',  incomeStr],
        ['Sequence of returns',     sorStr],
      ];
      // Render 2 columns: column A = rows 0–3, column B = rows 4–7
      const COL_W = (CONTENT_W - 18) / 2; // 18pt gutter between columns
      const COL_A_X = MARGIN_X;
      const COL_B_X = MARGIN_X + COL_W + 18;
      const VALUE_X_OFFSET = 95; // x offset from column origin where values start
      doc.setFontSize(8.5);
      for (let r = 0; r < 4; r++) {
        const yRow = y + r * 12;
        const drawRow = (col, idx) => {
          if (idx >= inputsRows.length) return;
          const [k, v] = inputsRows[idx];
          const colX = col === 'A' ? COL_A_X : COL_B_X;
          doc.setFont('helvetica', 'normal');
          doc.setTextColor(...SOFT);
          doc.text(k, colX, yRow);
          doc.setFont('courier', 'normal');
          doc.setTextColor(...INK);
          // Truncate long values to fit the column
          const maxValW = COL_W - VALUE_X_OFFSET - 2;
          let vStr = String(v);
          while (doc.getTextWidth(vStr) > maxValW && vStr.length > 6) {
            vStr = vStr.slice(0, -2) + '…';
          }
          doc.text(vStr, colX + VALUE_X_OFFSET, yRow);
        };
        drawRow('A', r);
        drawRow('B', r + 4);
      }
      y += 4 * 12 + 4;

      // Full-width Terms of Use acceptance row — paper trail showing the user
      // checked the disclaimer box before exporting this scenario.
      const acceptedAt = INPUT_STATE.terms_accepted_at;
      const termsStr = acceptedAt
        ? `Accepted ${new Date(acceptedAt).toLocaleString()}`
        : 'Not accepted';
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...SOFT);
      doc.text('Terms of use', MARGIN_X, y);
      doc.setFont('courier', 'normal');
      doc.setTextColor(...INK);
      doc.text(termsStr, PAGE_W - MARGIN_X - doc.getTextWidth(termsStr), y);
      y += SECTION_GAP + 4;

      // === Disclaimer + footer ===
      doc.setDrawColor(...RULE);
      doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);
      y += 8;
      // Eyebrow label
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(...SOFT);
      doc.text('DISCLAIMER & TERMS OF USE (SUMMARY)', MARGIN_X, y);
      y += 8;
      // Shortened, abstracted version of the 11-section Terms. Refers users
      // to the full Terms inside the simulator for the binding text.
      const disclaimer = (
        'The Tool is for educational and informational use only — not financial, ' +
        'investment, tax, legal, or accounting advice. Use does not create an ' +
        'advisory or fiduciary relationship. All results are hypothetical, based ' +
        'on user inputs, assumptions, and historical data; future outcomes are not ' +
        'guaranteed. The Tool is provided "as is" without warranties of accuracy ' +
        'or completeness and may be in beta. To the fullest extent permitted by ' +
        'law, the provider accepts no liability for losses arising from your use of ' +
        'or reliance on the Tool. By using the Tool you acknowledge and agree to ' +
        'the full Disclaimer & Terms of Use available within the simulator.'
      );
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...SOFT);
      const dLines = doc.splitTextToSize(disclaimer, CONTENT_W);
      for (const line of dLines) {
        doc.text(line, MARGIN_X, y);
        y += 8.5;
      }
      // Page footer (fixed at the bottom margin, not relative to y)
      doc.setFont('courier', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...SOFT);
      const footTxt = 'btn-monte-carlo-simulator';
      doc.text(footTxt, MARGIN_X, PAGE_H - 20);
      doc.text('Page 1 of 1', PAGE_W - MARGIN_X - doc.getTextWidth('Page 1 of 1'), PAGE_H - 20);

      // === Save ===
      const filename = `btn-${slugForFilename(label)}-${todayStamp()}.pdf`;
      doc.save(filename);
      showExportToast('PDF downloaded');
    } catch (e) {
      console.error('downloadPDF: jsPDF render threw', e);
      showExportToast('PDF generation failed — see console');
    }
  });
}

function bindExportButtons() {
  // Diagnostic console traces — helpful when the user reports "nothing
  // happens" so we can confirm whether the handler is firing or not.
  document.getElementById('download-pdf-btn')?.addEventListener('click', () => {
    console.log('[export] PDF button clicked', { hasResults: !!lastResults });
    downloadPDF();
  });
  document.getElementById('download-csv-btn')?.addEventListener('click', () => {
    console.log('[export] CSV button clicked', { hasResults: !!lastResults });
    downloadCSV();
  });
  document.getElementById('copy-csv-btn')?.addEventListener('click', () => {
    console.log('[export] Copy-CSV button clicked', { hasResults: !!lastResults });
    copyCSVToClipboard();
  });
}

function updateExportAvailability() {
  // Called after each run so the placeholder shows the current auto-default
  // and the buttons reflect "results available."
  const card = document.getElementById('export-card');
  const labelEl = document.getElementById('export-label');
  if (labelEl && lastResults) {
    labelEl.placeholder = `e.g. ${getAutoDefaultLabel(lastResults)}`;
  }
  if (card) card.hidden = !lastResults;
}

/* ============================================================
   End scenario export section
   ============================================================ */

function handleStrategyChange() {
  const strategy = document.getElementById('distribution-strategy').value;
  INPUT_STATE.distribution_strategy = strategy;
  document.getElementById('strategy-description').textContent = STRATEGY_DESCRIPTIONS[strategy] || '';
  document.getElementById('params-actual-spending').hidden = strategy !== 'actual_spending';
  document.getElementById('params-guyton-klinger').hidden = strategy !== 'guyton_klinger';
  document.getElementById('params-vanguard-dynamic').hidden = strategy !== 'vanguard_dynamic';
  // Hide the uniform-expense toggle for CD/AS/VDS — buckets 2-N are locked regardless
  // for those strategies, so the toggle has no effect there.
  const uniformRow = document.getElementById('uniform-expense-row');
  if (uniformRow) {
    uniformRow.hidden = (strategy === 'constant_dollar' || strategy === 'actual_spending' || strategy === 'vanguard_dynamic');
  }
  if (strategy === 'actual_spending')  updateActualSpendingPreview();
  if (strategy === 'guyton_klinger')   updateGKPreview();
  if (strategy === 'vanguard_dynamic') updateVDSPreview();
  renderBuckets(); // re-render to add/remove bucket-2+ strategy callouts
  // If the info modal is open, refresh its content for the new strategy
  const modal = document.getElementById('strategy-info-modal');
  if (modal && !modal.hidden) buildModalContent(strategy);
  refreshRunButtonState();
}

function updateActualSpendingPreview() {
  const decline = parseFloat(document.getElementById('real-spending-decline').value);
  if (Number.isFinite(decline)) INPUT_STATE.strategy_params.real_spending_decline_pct = decline;
  const r = INPUT_STATE.strategy_params.real_spending_decline_pct;
  const assumedInflation = 2.5;
  const netGrowth = assumedInflation - r;
  const year1 = getBucket1AnnualExpense();
  document.getElementById('preview-net-growth').textContent =
    `${netGrowth.toFixed(1)}%${netGrowth < 0 ? ' (real declining)' : ''}`;
  if (!(year1 > 0)) {
    document.getElementById('preview-as-year1').textContent = '—';
    document.getElementById('preview-as-year10-nominal').textContent = '—';
    document.getElementById('preview-as-year10-real').textContent    = '—';
    document.getElementById('preview-as-year20-nominal').textContent = '—';
    document.getElementById('preview-as-year20-real').textContent    = '—';
    return;
  }
  const y10n = year1 * Math.pow(1 + netGrowth / 100, 9);
  const y10r = y10n / Math.pow(1 + assumedInflation / 100, 9);
  const y20n = year1 * Math.pow(1 + netGrowth / 100, 19);
  const y20r = y20n / Math.pow(1 + assumedInflation / 100, 19);
  document.getElementById('preview-as-year1').textContent          = formatCurrency(year1);
  document.getElementById('preview-as-year10-nominal').textContent = formatCurrency(y10n);
  document.getElementById('preview-as-year10-real').textContent    = formatCurrency(y10r);
  document.getElementById('preview-as-year20-nominal').textContent = formatCurrency(y20n);
  document.getElementById('preview-as-year20-real').textContent    = formatCurrency(y20r);
}

function updateGKPreview() {
  const upper = parseFloat(document.getElementById('gk-upper-guardrail').value);
  const lower = parseFloat(document.getElementById('gk-lower-guardrail').value);
  const upAdj = parseFloat(document.getElementById('gk-upper-adjustment').value);
  const loAdj = parseFloat(document.getElementById('gk-lower-adjustment').value);
  if (Number.isFinite(upper)) INPUT_STATE.strategy_params.upper_guardrail_pct  = upper;
  if (Number.isFinite(lower)) INPUT_STATE.strategy_params.lower_guardrail_pct  = lower;
  if (Number.isFinite(upAdj)) INPUT_STATE.strategy_params.upper_adjustment_pct = upAdj;
  if (Number.isFinite(loAdj)) INPUT_STATE.strategy_params.lower_adjustment_pct = loAdj;

  const balance = INPUT_STATE.initial_balance;
  const expense = getBucket1AnnualExpense();
  if (!balance || !expense) {
    document.getElementById('gk-preview-rate').textContent              = '—';
    document.getElementById('gk-preview-upper-portfolio').textContent   = '—';
    document.getElementById('gk-preview-lower-portfolio').textContent   = '—';
    return;
  }
  // Year-1 income — only counts streams whose start age has been reached at year 1 (age = current_age + 1)
  const age1 = INPUT_STATE.current_age + 1;
  const age1B = INPUT_STATE.spouse_b_age + 1;
  let income = 0;
  if (INPUT_STATE.ss.amount        > 0 && age1  >= INPUT_STATE.ss.start_age)        income += INPUT_STATE.ss.amount;
  if (INPUT_STATE.pension.amount   > 0 && age1  >= INPUT_STATE.pension.start_age)   income += INPUT_STATE.pension.amount;
  if (INPUT_STATE.ss_b.amount      > 0 && age1B >= INPUT_STATE.ss_b.start_age)      income += INPUT_STATE.ss_b.amount;
  if (INPUT_STATE.pension_b.amount > 0 && age1B >= INPUT_STATE.pension_b.start_age) income += INPUT_STATE.pension_b.amount;
  if (INPUT_STATE.annuity.amount > 0 && age1 >= INPUT_STATE.annuity.start_age &&
      (INPUT_STATE.annuity.stop_age == null || age1 <= INPUT_STATE.annuity.stop_age)) income += INPUT_STATE.annuity.amount;
  const net = Math.max(0, expense - income);
  const u = INPUT_STATE.strategy_params.upper_guardrail_pct;
  const l = INPUT_STATE.strategy_params.lower_guardrail_pct;
  document.getElementById('gk-preview-rate').textContent =
    ((net / balance) * 100).toFixed(2) + '%';
  document.getElementById('gk-preview-upper-portfolio').textContent =
    u > 0 ? formatCurrency(net / (u / 100)) : '—';
  document.getElementById('gk-preview-lower-portfolio').textContent =
    l > 0 ? formatCurrency(net / (l / 100)) : '—';
}

function validateGKInputs() {
  if (INPUT_STATE.distribution_strategy !== 'guyton_klinger') return true;
  const u  = INPUT_STATE.strategy_params.upper_guardrail_pct;
  const l  = INPUT_STATE.strategy_params.lower_guardrail_pct;
  const ua = INPUT_STATE.strategy_params.upper_adjustment_pct;
  const la = INPUT_STATE.strategy_params.lower_adjustment_pct;
  let valid = true;
  const ue  = document.getElementById('gk-upper-error');
  const le  = document.getElementById('gk-lower-error');
  const ge  = document.getElementById('gk-gap-error');
  const uae = document.getElementById('gk-upper-adj-error');
  const lae = document.getElementById('gk-lower-adj-error');
  if (!Number.isFinite(u) || u < 4.0 || u > 8.0) {
    ue.textContent = 'Upper guardrail must be between 4.0% and 8.0%';
    ue.hidden = false; valid = false;
  } else { ue.hidden = true; }
  if (!Number.isFinite(l) || l < 3.0 || l > 5.5) {
    le.textContent = 'Lower guardrail must be between 3.0% and 5.5%';
    le.hidden = false; valid = false;
  } else { le.hidden = true; }
  if (Number.isFinite(u) && Number.isFinite(l) && (u - l) < 1.0) {
    ge.hidden = false; valid = false;
  } else { ge.hidden = true; }
  if (!Number.isFinite(ua) || ua < 5 || ua > 20) {
    uae.textContent = 'Upper adjustment must be between 5% and 20%';
    uae.hidden = false; valid = false;
  } else { uae.hidden = true; }
  if (!Number.isFinite(la) || la < 5 || la > 20) {
    lae.textContent = 'Lower adjustment must be between 5% and 20%';
    lae.hidden = false; valid = false;
  } else { lae.hidden = true; }
  return valid;
}

function updateVDSPreview() {
  const ceiling = parseFloat(document.getElementById('vds-ceiling').value);
  const floor   = parseFloat(document.getElementById('vds-floor').value);
  if (Number.isFinite(ceiling)) INPUT_STATE.strategy_params.vds_ceiling_pct = ceiling;
  if (Number.isFinite(floor))   INPUT_STATE.strategy_params.vds_floor_pct   = floor;

  const balance = INPUT_STATE.initial_balance;
  const year1   = getBucket1AnnualExpense();
  if (!balance || !year1) {
    document.getElementById('vds-preview-rate').textContent    = '—';
    document.getElementById('vds-preview-ceiling').textContent = '—';
    document.getElementById('vds-preview-floor').textContent   = '—';
    return;
  }
  const targetRate = (year1 / balance) * 100;
  document.getElementById('vds-preview-rate').textContent    = `${targetRate.toFixed(2)}%`;
  document.getElementById('vds-preview-ceiling').textContent =
    Number.isFinite(ceiling) ? formatCurrency(year1 * (1 + ceiling / 100)) : '—';
  document.getElementById('vds-preview-floor').textContent   =
    Number.isFinite(floor)   ? formatCurrency(year1 * (1 - floor   / 100)) : '—';
}

function validateVDSInputs() {
  if (INPUT_STATE.distribution_strategy !== 'vanguard_dynamic') return true;
  const c = INPUT_STATE.strategy_params.vds_ceiling_pct;
  const f = INPUT_STATE.strategy_params.vds_floor_pct;
  let valid = true;
  const ce = document.getElementById('vds-ceiling-error');
  const fe = document.getElementById('vds-floor-error');
  if (!Number.isFinite(c) || c < 1.0 || c > 15.0) {
    ce.textContent = 'Ceiling must be between 1.0% and 15.0% per year';
    ce.hidden = false; valid = false;
  } else { ce.hidden = true; }
  if (!Number.isFinite(f) || f < 0.5 || f > 10.0) {
    fe.textContent = 'Floor must be between 0.5% and 10.0% per year';
    fe.hidden = false; valid = false;
  } else { fe.hidden = true; }
  return valid;
}

function handleMinimumWithdrawalChange() {
  // currency-input already has attachCurrencyHandlers; this fires on blur after parse.
  const bucket1 = getBucket1AnnualExpense();
  const min = INPUT_STATE.minimum_withdrawal_annual;
  document.getElementById('minimum-withdrawal-warning').hidden =
    !(bucket1 > 0 && min > bucket1 * 0.5);
  refreshRunButtonState();
}

function getBucket1AnnualExpense() {
  const b = INPUT_STATE.buckets[0];
  if (!b || !(b.expense > 0)) return 0;
  return b.expense; // INPUT_STATE.buckets[i].expense is always stored as annual (monthly converted at edit time)
}

/* -----------------------------------------------------------
   Validation
   ----------------------------------------------------------- */
function computeValidation() {
  const errors = [];
  const allocTotal = INPUT_STATE.allocations.reduce((s, a) => s + (a.pct || 0), 0);
  const hasAsset = INPUT_STATE.allocations.some((a) => !!a.key);
  if (!hasAsset) errors.push('Select at least one asset class.');
  if (allocTotal !== 100) errors.push('Allocations must sum to 100%.');
  if (INPUT_STATE.initial_balance < 1000) errors.push('Starting balance below $1,000.');
  if (INPUT_STATE.initial_balance > 99_999_999) errors.push('Starting balance above $99,999,999.');
  if (!INPUT_STATE.buckets[0] || !(INPUT_STATE.buckets[0].expense > 0)) errors.push('Enter Bucket 1 expense.');
  if (INPUT_STATE.historical_period === 'custom') {
    if (INPUT_STATE.custom_end - INPUT_STATE.custom_start < 5) errors.push('Custom range too short.');
  }
  // Guyton-Klinger param validity
  if (INPUT_STATE.distribution_strategy === 'guyton_klinger') {
    const u  = INPUT_STATE.strategy_params.upper_guardrail_pct;
    const l  = INPUT_STATE.strategy_params.lower_guardrail_pct;
    const ua = INPUT_STATE.strategy_params.upper_adjustment_pct;
    const la = INPUT_STATE.strategy_params.lower_adjustment_pct;
    if (!Number.isFinite(u) || u < 4.0 || u > 8.0) errors.push('Upper guardrail out of range.');
    if (!Number.isFinite(l) || l < 3.0 || l > 5.5) errors.push('Lower guardrail out of range.');
    if (Number.isFinite(u) && Number.isFinite(l) && (u - l) < 1.0) errors.push('Guardrail gap < 1.0%.');
    if (!Number.isFinite(ua) || ua < 5 || ua > 20) errors.push('Upper adjustment out of range.');
    if (!Number.isFinite(la) || la < 5 || la > 20) errors.push('Lower adjustment out of range.');
  }
  // Vanguard Dynamic param validity
  if (INPUT_STATE.distribution_strategy === 'vanguard_dynamic') {
    const c = INPUT_STATE.strategy_params.vds_ceiling_pct;
    const f = INPUT_STATE.strategy_params.vds_floor_pct;
    if (!Number.isFinite(c) || c < 1.0 || c > 15.0) errors.push('VDS ceiling out of range.');
    if (!Number.isFinite(f) || f < 0.5 || f > 10.0) errors.push('VDS floor out of range.');
  }
  // Terms acceptance is handled once, up front, by the clickwrap gate
  // (initTermsGate) rather than a per-run checkbox — so it is no longer a
  // per-simulation validation requirement.
  return { valid: errors.length === 0, errors };
}

function refreshRunButtonState() {
  const btn = document.getElementById('run-sim');
  if (!btn) return;
  const v = computeValidation();
  btn.disabled = !v.valid || WORKER.busy;
  const status = document.getElementById('run-status');
  if (status) {
    if (WORKER.busy) status.textContent = 'Running simulation…';
    else if (!v.valid) status.textContent = v.errors[0];
    else status.textContent = 'Ready.';
  }
}

/* -----------------------------------------------------------
   Run Simulation (from form state)
   ----------------------------------------------------------- */
function runSimulationFromInputs() {
  if (WORKER.busy) return;
  const v = computeValidation();
  if (!v.valid) { refreshRunButtonState(); return; }
  const worker = initWorker();
  if (!worker) return;

  // Build inputs object the worker expects
  const allocations = INPUT_STATE.allocations
    .filter((a) => a.key && a.pct > 0)
    .map((a) => ({ key: a.key, pct: a.pct }));

  const inputs = {
    n_simulations:        INPUT_STATE.n_simulations,
    period_years:         INPUT_STATE.period_years,
    current_age:          INPUT_STATE.current_age,
    initial_balance:      INPUT_STATE.initial_balance,
    historical_period:    INPUT_STATE.historical_period,
    custom_start:         INPUT_STATE.custom_start,
    custom_end:           INPUT_STATE.custom_end,
    sequence_of_returns:  INPUT_STATE.sequence_of_returns,
    sor_force_2008:       INPUT_STATE.sor_force_2008,
    inflation_adjust:     INPUT_STATE.inflation_adjust,
    expense_mode:         'annual', // we always store annualized expenses
    spouse_b_age:         INPUT_STATE.spouse_b_age,
    allocations,
    ss:        { ...INPUT_STATE.ss },
    pension:   { ...INPUT_STATE.pension },
    ss_b:      { ...INPUT_STATE.ss_b },
    pension_b: { ...INPUT_STATE.pension_b },
    annuity:   { ...INPUT_STATE.annuity },
    buckets: INPUT_STATE.buckets.map((b) => ({ expense: b.expense || 0 })),
    // Distribution Strategy (v1.1 + v1.2)
    distribution_strategy:     INPUT_STATE.distribution_strategy,
    minimum_withdrawal_annual: INPUT_STATE.minimum_withdrawal_annual,
    strategy_params:           { ...INPUT_STATE.strategy_params },
  };

  WORKER.busy = true;
  WORKER.startedAt = performance.now();
  setRunButtonBusy(true);
  hideElement('dev-error');
  hideElement('dev-results');
  hideElement('results-placeholder');
  showElement('dev-progress');
  devUpdateProgress(0, inputs.n_simulations);

  worker.postMessage({ type: 'run', inputs, data: STATE.data });
}

/* -----------------------------------------------------------
   Reset
   ----------------------------------------------------------- */
function resetToDefaults() {
  if (!confirm('Are you sure you want to reset all inputs?')) return;
  // Reset INPUT_STATE
  INPUT_STATE.current_age        = DEFAULTS.current_age;
  INPUT_STATE.spouse_b_age       = DEFAULTS.spouse_b_age;
  INPUT_STATE.period_years       = DEFAULTS.period_years;
  INPUT_STATE.n_simulations      = DEFAULTS.n_simulations;
  INPUT_STATE.historical_period  = DEFAULTS.historical_period;
  INPUT_STATE.custom_start       = DEFAULTS.custom_start;
  INPUT_STATE.custom_end         = DEFAULTS.custom_end;
  INPUT_STATE.sequence_of_returns= DEFAULTS.sequence_of_returns;
  INPUT_STATE.sor_force_2008     = DEFAULTS.sor_force_2008;
  INPUT_STATE.inflation_adjust   = DEFAULTS.inflation_adjust;
  INPUT_STATE.expense_mode       = DEFAULTS.expense_mode;
  INPUT_STATE.expenses_uniform   = true;
  INPUT_STATE.initial_balance    = DEFAULTS.initial_balance;
  INPUT_STATE.allocations        = DEFAULTS.allocations.map((a) => ({ ...a }));
  INPUT_STATE.ss        = { ...DEFAULTS.ss };
  INPUT_STATE.pension   = { ...DEFAULTS.pension };
  INPUT_STATE.ss_b      = { ...DEFAULTS.ss_b };
  INPUT_STATE.pension_b = { ...DEFAULTS.pension_b };
  INPUT_STATE.annuity   = { ...DEFAULTS.annuity };
  INPUT_STATE.buckets = buildBucketsArray(INPUT_STATE.period_years, null);
  // Distribution Strategy
  INPUT_STATE.distribution_strategy   = DEFAULTS.distribution_strategy;
  INPUT_STATE.minimum_withdrawal_annual = DEFAULTS.minimum_withdrawal_annual;
  INPUT_STATE.strategy_params         = { ...DEFAULTS.strategy_params };

  // Terms acceptance is a one-time, site-level clickwrap (see initTermsGate) —
  // it intentionally persists across a Reset to Defaults.

  // Re-render
  renderAllocationRows();
  renderBuckets();
  syncSimpleInputsFromState();
  // Reset toggle-driven warnings
  const inflW = document.getElementById('inflation-warning');  if (inflW) inflW.hidden = true;
  refreshAllDerived();
}

// Expose for tests
window.__INPUT_STATE__ = INPUT_STATE;

/* -----------------------------------------------------------
   Dev panel — progress + results rendering
   ----------------------------------------------------------- */
function devUpdateProgress(completed, total) {
  const fill = document.getElementById('dev-progress-fill');
  const label = document.getElementById('dev-progress-label');
  if (fill)  fill.style.width = `${Math.min(100, (completed / total) * 100)}%`;
  if (label) label.textContent = `Simulating… ${completed.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}`;
}

function devShowError(message) {
  hideElement('dev-progress');
  hideElement('dev-results');
  const wrap = document.getElementById('dev-error');
  const msg  = document.getElementById('dev-error-msg');
  if (msg)  msg.textContent = message;
  if (wrap) wrap.hidden = false;
}

/* ============================================================
   Phase 4 — Headline Success Rate card
   ============================================================ */
function renderSuccessCard(results) {
  const sm = results.success_metrics;
  const startAge = results.inputs_summary.start_age;
  const pct = sm.success_rate_pct;
  const pctEl   = document.getElementById('success-card-pct');
  const countEl = document.getElementById('success-card-count');
  const divEl   = document.getElementById('success-card-divider');
  const deplEl  = document.getElementById('success-card-depletion');
  if (!pctEl) return;

  pctEl.textContent = `${pct.toFixed(1)}%`;
  pctEl.classList.remove('is-green','is-navy','is-gold','is-clay');
  if      (pct >= 90) pctEl.classList.add('is-green');
  else if (pct >= 75) pctEl.classList.add('is-navy');
  else if (pct >= 50) pctEl.classList.add('is-gold');
  else                pctEl.classList.add('is-clay');

  countEl.textContent =
    `${sm.success_count.toLocaleString('en-US')} of ${sm.total_simulations.toLocaleString('en-US')} simulations ended with $1 or more`;

  if (sm.failure_count > 0 && sm.avg_depletion_year != null && sm.median_depletion_year != null) {
    divEl.hidden  = false;
    deplEl.hidden = false;
    const avgY = Math.round(sm.avg_depletion_year);
    const avgAge = startAge + avgY;
    const medY = sm.median_depletion_year;
    const medAge = startAge + medY;
    document.getElementById('depl-avg').textContent    = `Year ${avgY} (Age ${avgAge})`;
    document.getElementById('depl-median').textContent = `Year ${medY} (Age ${medAge})`;
  } else {
    divEl.hidden  = true;
    deplEl.hidden = true;
  }

  // Constrained-data warning — mirror the message from the summary text block
  // so it's visible at the top of the results, not buried below. Use the
  // period's nominal start (what the user requested) — the worker's
  // historical_period string reflects the *truncated* range, which would
  // collapse the comparison to itself.
  const warnEl = document.getElementById('success-card-warning');
  if (warnEl) {
    const inp = results.inputs_summary;
    const period = INPUT_STATE.historical_period;
    let nominalStart;
    if      (period === 'custom')  nominalStart = INPUT_STATE.custom_start;
    else if (period === 'native')  nominalStart = 1871;
    else if (period === 'postwar') nominalStart = 1946;
    else if (period === 'modern')  nominalStart = 1972;
    else                           nominalStart = null;
    if (inp.constraining_asset && nominalStart != null && inp.constraining_asset_start > nominalStart) {
      warnEl.hidden = false;
      warnEl.innerHTML = `<strong>Heads up:</strong> the available historical data was constrained to <strong>${inp.constraining_asset_start}+</strong> because <em>${escapeHtml(inp.constraining_asset)}</em> only has native data from <strong>${inp.constraining_asset_start}</strong>. The ${nominalStart}–${inp.constraining_asset_start - 1} range (incl. major crises in those years) is not in the sample pool.`;
    } else {
      warnEl.hidden = true;
      warnEl.innerHTML = '';
    }
  }
}

/* ============================================================
   Phase 4 — Portfolio fan chart (Chart.js)
   ============================================================ */
let portfolioFanChart = null;
let currentPortfolioMode = 'nominal';
let lastResults = null;

function renderPortfolioFanChart(results, mode) {
  const canvas = document.getElementById('portfolio-fan-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (portfolioFanChart) { portfolioFanChart.destroy(); portfolioFanChart = null; }

  const sa = results.inputs_summary.start_age;
  const py = results.inputs_summary.period_years;
  const sims = results.inputs_summary.n_simulations;
  const paths = results.percentile_paths;
  const initial = results.inputs_summary.initial_balance;

  // X-axis labels: ages from start_age to start_age + period_years (year 0 = sa, year Y = sa+py)
  const labels = [];
  for (let i = 0; i <= py; i++) labels.push(sa + i);

  // Brand colors
  const NAVY      = '#1F3D6B';
  const NAVY_15   = 'rgba(31, 61, 107, 0.13)';
  const NAVY_25   = 'rgba(31, 61, 107, 0.22)';
  const GOLD      = '#B58820';
  const CLAY      = '#C84A30';
  const INK       = '#14181E';

  const p = (key) => mode === 'real' ? paths[`real_${key}`] : paths[key];

  // Build datasets — fan layered bottom-up so fills target the right previous dataset.
  // Order: p10 (transparent, no fill), p90 (fill to p10 = outer band),
  //        p25 (transparent, no fill), p75 (fill to p25 = inner band),
  //        p50 (median solid line).
  const datasets = [
    { label: '_p10', data: p('p10'),
      borderColor: 'transparent', backgroundColor: NAVY_15,
      pointRadius: 0, fill: false, tension: 0.2 },
    { label: '10–90% range', data: p('p90'),
      borderColor: 'transparent', backgroundColor: NAVY_15,
      pointRadius: 0, fill: 0, tension: 0.2 },
    { label: '_p25', data: p('p25'),
      borderColor: 'transparent', backgroundColor: NAVY_25,
      pointRadius: 0, fill: false, tension: 0.2 },
    { label: '25–75% range', data: p('p75'),
      borderColor: 'transparent', backgroundColor: NAVY_25,
      pointRadius: 0, fill: 2, tension: 0.2 },
    { label: 'Median (50th)', data: p('p50'),
      borderColor: NAVY, backgroundColor: 'transparent',
      borderWidth: 2.5, pointRadius: 0, fill: false, tension: 0.2 },
    // Year-0 starting balance dot — gold accent
    { label: '_year0', data: labels.map((_, i) => i === 0 ? initial : null),
      borderColor: 'transparent', backgroundColor: GOLD,
      pointRadius: labels.map((_, i) => i === 0 ? 5 : 0),
      pointBackgroundColor: GOLD, pointBorderColor: GOLD,
      fill: false, spanGaps: false },
    // $0 depleted line — clay dashed
    { label: '_zero', data: labels.map(() => 0),
      borderColor: CLAY, backgroundColor: 'transparent',
      borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false },
  ];

  portfolioFanChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            filter: (item) => !item.text.startsWith('_'),
            font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11 },
            color: INK,
            boxWidth: 22, boxHeight: 10, padding: 14,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => `Age ${items[0].label}`,
            label: (ctx) => {
              const lbl = ctx.dataset.label;
              if (lbl.startsWith('_')) return null;
              // For band datasets, look up the matching lower-bound dataset (_p10 / _p25)
              // so the tooltip shows BOTH ends of the band, not just the upper edge.
              if (lbl === '10–90% range' || lbl === '25–75% range') {
                const loLabel = lbl === '10–90% range' ? '_p10' : '_p25';
                const loDs = ctx.chart.data.datasets.find((d) => d.label === loLabel);
                const lo = loDs ? loDs.data[ctx.dataIndex] : null;
                const hi = ctx.parsed.y;
                if (lo != null) return `${lbl}: ${fmtCurrencyShort(lo)} – ${fmtCurrencyShort(hi)}`;
              }
              return `${lbl}: ${fmtCurrencyShort(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Age', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: {
            callback: (_, i) => i % 5 === 0 ? labels[i] : '',
            maxRotation: 0, color: INK,
            font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 },
          },
          grid: { color: 'rgba(20,24,30,0.05)' },
        },
        y: {
          min: 0,
          title: {
            display: true,
            text: mode === 'real' ? 'Portfolio Balance (Real, today’s $)' : 'Portfolio Balance (Nominal)',
            color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' },
          },
          ticks: {
            callback: (v) => fmtCurrencyShort(v),
            color: INK,
            font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 },
          },
          grid: { color: 'rgba(20,24,30,0.10)' },
        },
      },
    },
  });

  // Title + depletion note
  const titleEl = document.getElementById('portfolio-chart-title');
  if (titleEl) titleEl.textContent = `Projected Portfolio Balance — ${sims.toLocaleString('en-US')} Simulations`;
  const noteEl = document.getElementById('portfolio-chart-depletion-note');
  if (noteEl) {
    if (results.success_metrics.failure_count > 0) {
      noteEl.hidden = false;
      noteEl.textContent = `${results.success_metrics.failure_count.toLocaleString('en-US')} of ${results.success_metrics.total_simulations.toLocaleString('en-US')} simulations depleted before year ${py}.`;
    } else {
      noteEl.hidden = true;
    }
  }
}

function bindPortfolioChartToggle() {
  document.querySelectorAll('[data-chart="portfolio"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentPortfolioMode) return;
      currentPortfolioMode = mode;
      document.querySelectorAll('[data-chart="portfolio"]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (lastResults) renderPortfolioFanChart(lastResults, mode);
    });
  });
}

/* ============================================================
   Section 6.3 — Results Summary Text Block
   ============================================================ */
function renderResultsSummaryText(results) {
  const el = document.getElementById('results-summary');
  if (!el) return;
  const inp = results.inputs_summary;
  const sm  = results.success_metrics;
  const sims = inp.n_simulations.toLocaleString('en-US');
  const initBal = formatCurrency(inp.initial_balance);
  // Parse historical period e.g. "1972-2025 (modern era)" → start/end year
  const m = String(inp.historical_period).match(/(\d{4})\D+(\d{4})/);
  const startYear = m ? m[1] : '—';
  const endYear   = m ? m[2] : '—';
  const portMean = inp.portfolio_historical_mean.toFixed(2);
  const portCagr = inp.portfolio_historical_cagr.toFixed(2);
  const portStd  = inp.portfolio_historical_std.toFixed(2);
  const inflMean = inp.inflation_historical_mean.toFixed(2);
  const inflStd  = inp.inflation_historical_std.toFixed(2);
  const bucket1Expense = INPUT_STATE.buckets[0]?.expense || 0;
  const successRate = sm.success_rate_pct.toFixed(1);

  // Strategy-specific descriptor
  const stratName = {
    none: 'None — Use Expense Schedule',
    constant_dollar: 'Constant Dollar (Bengen 4% rule)',
    forgo_inflation: 'Forgo Inflation Adjustment',
    actual_spending: 'Actual Spending Decline',
    guyton_klinger: 'Guyton-Klinger Guardrails',
  }[INPUT_STATE.distribution_strategy] || INPUT_STATE.distribution_strategy;

  const stratDescription = (() => {
    const sp = INPUT_STATE.strategy_params || {};
    switch (INPUT_STATE.distribution_strategy) {
      case 'constant_dollar':
        return `Withdrawals followed the <strong>Constant Dollar</strong> method — Bucket 1’s amount (${formatCurrency(bucket1Expense)} in today’s dollars) inflation-adjusted each subsequent year.`;
      case 'forgo_inflation':
        return `Withdrawals followed the <strong>Forgo Inflation</strong> method — each year’s bucket × the effective inflation index. Inflation raises are skipped permanently after any portfolio-loss year.`;
      case 'actual_spending':
        return `Withdrawals followed the <strong>Actual Spending Decline</strong> method at ${(sp.real_spending_decline_pct || 2).toFixed(1)}% real decline per year — Bucket 1 anchored at year 1 (${formatCurrency(bucket1Expense)} in today’s dollars), then carry-forward growth at (inflation − decline). Floor and ceiling at 50% / 150% of Bucket 1’s inflated target.`;
      case 'guyton_klinger':
        return `Withdrawals followed <strong>Guyton-Klinger Guardrails</strong> — bucket-driven baseline, Rule 1 inflation skip after loss years, Rule 2 guardrails (cut ${(sp.upper_adjustment_pct || 10).toFixed(0)}% if rate > ${(sp.upper_guardrail_pct || 6).toFixed(1)}%; raise ${(sp.lower_adjustment_pct || 10).toFixed(0)}% if rate < ${(sp.lower_guardrail_pct || 4).toFixed(1)}%). Upper cut suspended in the final 15 years.`;
      case 'none':
      default:
        return `Withdrawals followed your expense schedule literally — each year’s bucket value, inflation-adjusted from today’s dollars.`;
    }
  })();

  let html = '';
  html += `<p>Monte Carlo simulation results for <em>${sims}</em> portfolios with a <em>${initBal}</em> initial balance, using historical returns data from <em>Jan ${startYear}</em> to <em>Dec ${endYear}</em> with annual sampling. The historical pre-tax return for the selected portfolio over this period was <em>${portMean}%</em> mean return (<em>${portCagr}%</em> CAGR) with <em>${portStd}%</em> standard deviation of annual returns.</p>`;
  html += `<p>${stratDescription} The inflation model used historical inflation with <em>${inflMean}%</em> mean and <em>${inflStd}%</em> standard deviation based on CPI-U data over the same window. Generated inflation samples were correlated with simulated asset returns based on row-level historical correlations.</p>`;
  if (inp.constraining_asset && inp.constraining_asset_start > parseInt(startYear, 10)) {
    html += `<p>The available historical data for the simulation inputs was constrained by <em>${escapeHtml(inp.constraining_asset)}</em>, whose native data begins in <em>${inp.constraining_asset_start}</em>.</p>`;
  }
  if (inp.sequence_of_returns_active) {
    if (inp.sor_mode === 'forced_2008') {
      html += `<p>This simulation applied <strong>2008’s actual returns</strong> to Year 1 of every portfolio path as a sequence-of-returns stress test.</p>`;
    } else if (inp.sor_mode === 'computed_worst') {
      html += `<p>This simulation applied a <strong>worst-year-first</strong> sequence-of-returns stress test — within each simulation’s random 30-year sequence, the year with the lowest weighted portfolio return was moved to Year 1.</p>`;
    }
  }
  if (results.minimum_withdrawal_annual > 0) {
    html += `<p>A minimum annual withdrawal floor of <em>${formatCurrency(results.minimum_withdrawal_annual)}</em> was active. The floor grows with inflation each year; it overrides the strategy’s output whenever the strategy would calculate a lower amount.</p>`;
  }
  html += `<p>All returns are pre-tax — users should account for income taxes within their expense inputs. Portfolio is rebalanced annually after each year’s withdrawal. Overall success rate: <strong>${successRate}%</strong> across <em>${sims}</em> simulations.</p>`;
  el.innerHTML = html;
}

/* ============================================================
   Income Variability Report (Batch C3)
   ============================================================ */
let incomeFanChart = null;
let guardrailHeatmapChart = null;
let currentIncomeMode = 'nominal';

function renderIncomeVariabilityReport(results) {
  const strategy = INPUT_STATE.distribution_strategy;
  renderIVRSubheader(strategy);
  renderIncomeFanChart(results, currentIncomeMode);
  bindIncomeChartToggle();
  renderIncomeSummaryCards(results);
  // Strategy-specific add-ons:
  //   G-K  → guardrail heatmap + G-K stats table
  //   VDS  → ceiling/floor heatmap (reuses the same card with relabeled bars)
  const isGK  = strategy === 'guyton_klinger'   && results.gk_statistics;
  const isVDS = strategy === 'vanguard_dynamic' && results.vds_statistics;
  document.getElementById('guardrail-heatmap-card').hidden = !(isGK || isVDS);
  document.getElementById('gk-stats-card').hidden = !isGK;
  if (isGK) {
    renderGuardrailHeatmap(results);
    renderGKStatsTable(results);
  } else if (isVDS) {
    renderVDSHeatmap(results);
  } else {
    if (guardrailHeatmapChart) { guardrailHeatmapChart.destroy(); guardrailHeatmapChart = null; }
  }
  renderIVRCallout(results);
}

function renderIVRSubheader(strategy) {
  const el = document.getElementById('ivr-subheader');
  if (!el) return;
  const subheaders = {
    none:            'With None (Use Expense Schedule), income tracks your plan literally — each year’s bucket value, inflated forward.',
    constant_dollar: 'With Constant Dollar, income is fully predictable — Bucket 1 inflated each year. The chart shows the resulting nominal/real path.',
    forgo_inflation: 'With Forgo Inflation Adjustment, income is nearly stable but permanently behind inflation after every loss year.',
    actual_spending: 'With Actual Spending Decline, income grows slowly nominally and declines in real terms — matching how retirees actually spend.',
    guyton_klinger:  'With Guyton-Klinger Guardrails, income varies based on market performance. The chart shows the full range of annual withdrawal outcomes.',
    vanguard_dynamic:'With Vanguard Dynamic Spending, income floats with the portfolio bounded by the real-dollar ceiling and floor. The chart shows the full range of annual withdrawal outcomes.',
  };
  el.textContent = subheaders[strategy] || '';
}

function renderIncomeFanChart(results, mode) {
  const canvas = document.getElementById('income-fan-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (incomeFanChart) { incomeFanChart.destroy(); incomeFanChart = null; }

  const sa = results.inputs_summary.start_age;
  const py = results.inputs_summary.period_years;
  const sims = results.inputs_summary.n_simulations;
  const paths = results.income_percentile_paths;
  const year1 = results.year1_withdrawal_nominal;
  const strategy = INPUT_STATE.distribution_strategy;

  // Income arrays are length period_years (one value per year, year 1 .. year Y).
  const labels = [];
  for (let i = 0; i < py; i++) labels.push(sa + i + 1);

  const NAVY    = '#1F3D6B';
  const NAVY_15 = 'rgba(31, 61, 107, 0.13)';
  const NAVY_25 = 'rgba(31, 61, 107, 0.22)';
  const GOLD    = '#B58820';
  const CLAY    = '#C84A30';
  const INK     = '#14181E';

  const p = (key) => mode === 'real' ? paths[`real_${key}`] : paths[key];
  // Whether to show filled bands: skip for near-deterministic strategies (None / CD)
  // where all percentiles overlap closely.
  const showBands = strategy === 'actual_spending' || strategy === 'guyton_klinger' || strategy === 'forgo_inflation' || strategy === 'vanguard_dynamic';

  const datasets = [];
  if (showBands) {
    datasets.push(
      { label: '_p10', data: p('p10'), borderColor: 'transparent', backgroundColor: NAVY_15, pointRadius: 0, fill: false, tension: 0.2 },
      { label: '10–90% range', data: p('p90'), borderColor: 'transparent', backgroundColor: NAVY_15, pointRadius: 0, fill: 0, tension: 0.2 },
      { label: '_p25', data: p('p25'), borderColor: 'transparent', backgroundColor: NAVY_25, pointRadius: 0, fill: false, tension: 0.2 },
      { label: '25–75% range', data: p('p75'), borderColor: 'transparent', backgroundColor: NAVY_25, pointRadius: 0, fill: 2, tension: 0.2 },
    );
  }
  datasets.push({
    label: 'Median (50th)', data: p('p50'),
    borderColor: NAVY, backgroundColor: 'transparent',
    borderWidth: 2.5, pointRadius: 0, fill: false, tension: 0.2,
  });
  // Year 1 reference line (gold dashed)
  datasets.push({
    label: `Year 1 (${fmtCurrencyShort(year1)})`,
    data: labels.map(() => year1),
    borderColor: GOLD, backgroundColor: 'transparent',
    borderWidth: 1, borderDash: [6, 4], pointRadius: 0, fill: false,
  });
  // G-K first-cut reference line (amber dashed)
  if (strategy === 'guyton_klinger') {
    const adj = INPUT_STATE.strategy_params.upper_adjustment_pct || 10;
    const firstCutLevel = year1 * (1 - adj / 100);
    datasets.push({
      label: `Cut reference (−${adj.toFixed(0)}% from Year 1)`,
      data: labels.map(() => firstCutLevel),
      borderColor: CLAY, backgroundColor: 'transparent',
      borderWidth: 1, borderDash: [3, 3], pointRadius: 0, fill: false,
    });
  }

  incomeFanChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            filter: (item) => !item.text.startsWith('_'),
            font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11 },
            color: INK, boxWidth: 22, boxHeight: 10, padding: 14,
          },
        },
        tooltip: {
          callbacks: {
            title: (items) => `Age ${items[0].label}`,
            label: (ctx) => {
              const lbl = ctx.dataset.label;
              if (lbl.startsWith('_')) return null;
              // For band datasets, show both ends — look up the matching lower-bound dataset.
              if (lbl === '10–90% range' || lbl === '25–75% range') {
                const loLabel = lbl === '10–90% range' ? '_p10' : '_p25';
                const loDs = ctx.chart.data.datasets.find((d) => d.label === loLabel);
                const lo = loDs ? loDs.data[ctx.dataIndex] : null;
                const hi = ctx.parsed.y;
                if (lo != null) return `${lbl}: ${fmtCurrencyShort(lo)} – ${fmtCurrencyShort(hi)}`;
              }
              return `${lbl}: ${fmtCurrencyShort(ctx.parsed.y)}`;
            },
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: 'Age', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: {
            callback: (_, i) => i % 5 === 0 ? labels[i] : '',
            maxRotation: 0, color: INK,
            font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 },
          },
          grid: { color: 'rgba(20,24,30,0.05)' },
        },
        y: {
          min: 0,
          title: {
            display: true,
            text: mode === 'real' ? 'Annual Withdrawal (Real, today’s $)' : 'Annual Withdrawal (Nominal)',
            color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' },
          },
          ticks: { callback: (v) => fmtCurrencyShort(v), color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.10)' },
        },
      },
    },
  });

  const titleEl = document.getElementById('income-chart-title');
  if (titleEl) titleEl.textContent = `Projected Annual Spending — ${sims.toLocaleString('en-US')} Simulations`;
  // Strategy-driven income sources note. Spending = portfolio withdrawal + SS + pension + annuity.
  const noteEl = document.getElementById('income-chart-sources-note');
  if (noteEl) {
    const inp = results.inputs_summary;
    const hasSS      = INPUT_STATE.ss.amount > 0 || INPUT_STATE.ss_b.amount > 0;
    const hasPension = INPUT_STATE.pension.amount > 0 || INPUT_STATE.pension_b.amount > 0;
    const hasAnnuity = INPUT_STATE.annuity.amount > 0;
    const sources = [];
    if (hasSS)      sources.push('Social Security');
    if (hasPension) sources.push('pension');
    if (hasAnnuity) sources.push('annuity');
    if (sources.length === 0) {
      noteEl.textContent = 'Total annual spending — entirely funded by portfolio withdrawals (no guaranteed-income inputs supplied).';
    } else {
      const list = sources.length === 1 ? sources[0]
                 : sources.length === 2 ? `${sources[0]} and ${sources[1]}`
                 : `${sources.slice(0, -1).join(', ')}, and ${sources[sources.length - 1]}`;
    noteEl.textContent = `Total annual spending — combines the portfolio withdrawal with ${list}. The portfolio funds (total spending − guaranteed income).`;
    }
  }
}

function bindIncomeChartToggle() {
  document.querySelectorAll('[data-chart="income"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentIncomeMode) return;
      currentIncomeMode = mode;
      document.querySelectorAll('[data-chart="income"]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      if (lastResults) renderIncomeFanChart(lastResults, mode);
    });
  });
}

function renderGuardrailHeatmap(results) {
  const canvas = document.getElementById('guardrail-heatmap-chart');
  if (!canvas || typeof Chart === 'undefined' || !results.gk_statistics) return;
  if (guardrailHeatmapChart) { guardrailHeatmapChart.destroy(); guardrailHeatmapChart = null; }
  // Set strategy-appropriate title and intro for G-K mode
  const titleEl = document.getElementById('guardrail-heatmap-title');
  const introEl = document.getElementById('guardrail-heatmap-intro');
  if (titleEl) titleEl.textContent = 'Guardrail Activity by Simulation Year';
  if (introEl) introEl.textContent = 'Red bars: % of simulations with a spending cut (upper guardrail) that year. Green bars: % with a spending raise (lower guardrail). Taller red bars early indicate years when poor markets most commonly triggered cuts.';

  const gk = results.gk_statistics;
  const py = results.inputs_summary.period_years;
  const sa = results.inputs_summary.start_age;
  const labels = [];
  for (let i = 0; i < py; i++) labels.push(sa + i + 1);

  const CLAY = '#C84A30';
  const TEAL = '#1A6E6E';
  const INK  = '#14181E';

  guardrailHeatmapChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Upper guardrail hit (spending cut)',
          data: gk.pct_cuts_by_year,
          backgroundColor: 'rgba(200, 74, 48, 0.75)', borderColor: CLAY, borderWidth: 1 },
        { label: 'Lower guardrail hit (spending raise)',
          data: gk.pct_raises_by_year,
          backgroundColor: 'rgba(26, 110, 110, 0.75)', borderColor: TEAL, borderWidth: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11 }, color: INK, boxWidth: 22, boxHeight: 10, padding: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}% of simulations` } },
      },
      scales: {
        x: {
          title: { display: true, text: 'Age', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: { callback: (_, i) => i % 5 === 0 ? labels[i] : '', maxRotation: 0, color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.05)' },
        },
        y: {
          min: 0, max: 100,
          title: { display: true, text: '% of Simulations', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: { callback: (v) => v + '%', color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.10)' },
        },
      },
    },
  });
}

function renderVDSHeatmap(results) {
  const canvas = document.getElementById('guardrail-heatmap-chart');
  if (!canvas || typeof Chart === 'undefined' || !results.vds_statistics) return;
  if (guardrailHeatmapChart) { guardrailHeatmapChart.destroy(); guardrailHeatmapChart = null; }

  const titleEl = document.getElementById('guardrail-heatmap-title');
  const introEl = document.getElementById('guardrail-heatmap-intro');
  if (titleEl) titleEl.textContent = 'Ceiling / Floor Activity by Simulation Year';
  if (introEl) introEl.textContent = 'Red bars: % of simulations where the floor cap activated that year (spending would have dropped more than the floor allows — the cap pulled it up). Green bars: % where the ceiling activated (spending would have risen more than the ceiling allows — the cap pulled it down). Tall red bars early signal bad markets where the floor kept spending from collapsing; tall green bars signal good markets where the ceiling kept the raise from overshooting.';

  const v = results.vds_statistics;
  const py = results.inputs_summary.period_years;
  const sa = results.inputs_summary.start_age;
  const labels = [];
  for (let i = 0; i < py; i++) labels.push(sa + i + 1);

  const CLAY = '#C84A30';
  const TEAL = '#1A6E6E';
  const INK  = '#14181E';

  guardrailHeatmapChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Floor cap active (cut limited)',
          data: v.pct_floor_by_year,
          backgroundColor: 'rgba(200, 74, 48, 0.75)', borderColor: CLAY, borderWidth: 1 },
        { label: 'Ceiling cap active (raise limited)',
          data: v.pct_ceiling_by_year,
          backgroundColor: 'rgba(26, 110, 110, 0.75)', borderColor: TEAL, borderWidth: 1 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11 }, color: INK, boxWidth: 22, boxHeight: 10, padding: 14 } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}% of simulations` } },
      },
      scales: {
        x: {
          title: { display: true, text: 'Age', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: { callback: (_, i) => i % 5 === 0 ? labels[i] : '', maxRotation: 0, color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.05)' },
        },
        y: {
          min: 0, max: 100,
          title: { display: true, text: '% of Simulations', color: INK, font: { family: "'IBM Plex Sans', system-ui, sans-serif", size: 11, weight: '700' } },
          ticks: { callback: (v) => v + '%', color: INK, font: { family: "'IBM Plex Mono', ui-monospace, monospace", size: 11 } },
          grid: { color: 'rgba(20,24,30,0.10)' },
        },
      },
    },
  });
}

function renderIncomeSummaryCards(results) {
  const container = document.getElementById('income-summary-cards');
  if (!container) return;
  const strategy = INPUT_STATE.distribution_strategy;
  const inp = results.inputs_summary;
  const sa = inp.start_age;
  const py = inp.period_years;
  const paths = results.income_percentile_paths;
  const year1 = results.year1_withdrawal_nominal;
  const endAge = sa + py;
  const midYearIdx = Math.min(14, py - 1); // year 15 if available
  const midAge = sa + midYearIdx + 1;

  // Card 4 is strategy-specific
  let card4Label, card4Value, card4Sub;
  if (strategy === 'constant_dollar') {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = 'Purchasing power in today’s dollars';
  } else if (strategy === 'forgo_inflation') {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = 'Erosion vs. Constant Dollar reflects skipped raises';
  } else if (strategy === 'actual_spending') {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = `Declining at ~${(INPUT_STATE.strategy_params.real_spending_decline_pct || 2).toFixed(1)}%/yr by design`;
  } else if (strategy === 'guyton_klinger' && results.gk_statistics) {
    card4Label = 'Simulations with at least 1 cut';
    card4Value = `${results.gk_statistics.pct_sims_with_any_cut.toFixed(1)}%`;
    card4Sub = 'Upper guardrail triggered at least once';
  } else if (strategy === 'vanguard_dynamic' && results.vds_statistics) {
    card4Label = 'Simulations with floor activation';
    card4Value = `${results.vds_statistics.pct_sims_with_any_floor.toFixed(1)}%`;
    card4Sub = `Floor cap stopped a deeper cut in at least one year`;
  } else {
    card4Label = 'Real income — final year (median)';
    card4Value = fmtCurrencyShort(paths.real_p50[py - 1]);
    card4Sub = 'Purchasing power in today’s dollars';
  }

  container.innerHTML = '';
  container.appendChild(ivrCard('Year 1 Withdrawal', fmtCurrencyShort(year1),
    `${(results.year1_withdrawal_rate_pct || 0).toFixed(2)}% of starting portfolio`));
  container.appendChild(ivrCard('Median Final Year Withdrawal', fmtCurrencyShort(paths.p50[py - 1]),
    `Age ${endAge} · 50th percentile (nominal)`));
  container.appendChild(ivrCard(`Income Range at Age ${midAge}`,
    `${fmtCurrencyShort(paths.p10[midYearIdx])} – ${fmtCurrencyShort(paths.p90[midYearIdx])}`,
    `10th to 90th percentile`));
  container.appendChild(ivrCard(card4Label, card4Value, card4Sub));
}

function ivrCard(label, value, sub) {
  const div = document.createElement('div');
  div.className = 'ivr-card';
  const l = document.createElement('div'); l.className = 'ivr-card__label'; l.textContent = label;
  const v = document.createElement('div'); v.className = 'ivr-card__value'; v.textContent = value;
  const s = document.createElement('div'); s.className = 'ivr-card__sub';   s.textContent = sub || '';
  div.appendChild(l); div.appendChild(v); div.appendChild(s);
  return div;
}

function renderGKStatsTable(results) {
  if (!results.gk_statistics) return;
  const tbody = document.querySelector('#gk-stats-table tbody');
  if (!tbody) return;
  const gk = results.gk_statistics;
  const sa = results.inputs_summary.start_age;
  const paths = results.income_percentile_paths;
  const totalSum = (arr) => arr.reduce((a, b) => a + b, 0);
  const rows = [
    ['Simulations with at least one spending cut',  `${gk.pct_sims_with_any_cut.toFixed(1)}%`],
    ['Simulations with at least one spending raise', `${gk.pct_sims_with_any_raise.toFixed(1)}%`],
    ['Average spending cuts per simulation',   gk.avg_cuts_per_sim.toFixed(2)],
    ['Average spending raises per simulation', gk.avg_raises_per_sim.toFixed(2)],
    ['Average year of first spending cut',
      gk.avg_year_of_first_cut != null ? `Year ${gk.avg_year_of_first_cut.toFixed(1)} (≈ Age ${Math.round(sa + gk.avg_year_of_first_cut)})` : 'No cuts occurred'],
    ['Median year of first spending cut',
      gk.median_year_of_first_cut != null ? `Year ${gk.median_year_of_first_cut} (Age ${sa + gk.median_year_of_first_cut})` : 'No cuts occurred'],
    ['Median total lifetime income (nominal)', fmtCurrencyShort(totalSum(paths.p50))],
    ['Median total lifetime income (real, today’s $)', fmtCurrencyShort(totalSum(paths.real_p50))],
  ];
  tbody.innerHTML = '';
  for (const [label, val] of rows) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.className = 'metric-label'; td1.textContent = label;
    const td2 = document.createElement('td'); td2.className = 'num'; td2.textContent = val;
    tr.appendChild(td1); tr.appendChild(td2);
    tbody.appendChild(tr);
  }
}

function renderIVRCallout(results) {
  const el = document.getElementById('ivr-callout');
  if (!el) return;
  const strategy = INPUT_STATE.distribution_strategy;
  const gk = results.gk_statistics;
  const callouts = {
    none:
      'With None, income variance comes entirely from inflation. Portfolio success depends on whether the inflation-adjusted draws are sustainable for your selected allocation.',
    constant_dollar:
      'With Constant Dollar, income is fully predictable in real terms. Portfolio success rate reflects whether the fixed real withdrawal schedule depleted the portfolio.',
    forgo_inflation:
      'With Forgo Inflation, each skipped raise stays invested and compounds forward — preserving meaningful portfolio value over a 30+ year retirement without active decision-making.',
    actual_spending:
      'With Actual Spending Decline, lower late-life withdrawals preserve the portfolio. Typically produces a higher success rate than Constant Dollar at the same starting balance, with more income in the active early years.',
    guyton_klinger:
      gk
        ? `Guardrail strategies trade income predictability for portfolio longevity. In these simulations, ${gk.pct_sims_with_any_cut.toFixed(1)}% of scenarios triggered at least one spending cut and ${gk.pct_sims_with_any_raise.toFixed(1)}% triggered at least one raise. Scenarios where the upper guardrail fires more frequently tend to have higher portfolio survival rates — the strategy is working as designed.`
        : 'Guardrail strategies trade income predictability for portfolio longevity. The guardrail rules cut spending in stressed markets and raise spending in strong ones.',
    vanguard_dynamic:
      results.vds_statistics
        ? `With Vanguard Dynamic Spending, income floats with the portfolio bounded by REAL year-over-year caps. In these simulations, ${results.vds_statistics.pct_sims_with_any_ceiling.toFixed(1)}% of scenarios had the ceiling cap activate at least once (smoothing a strong-market raise) and ${results.vds_statistics.pct_sims_with_any_floor.toFixed(1)}% had the floor activate (limiting a bad-market cut). The directional slope of real income is set mainly by the implied target rate vs. real portfolio returns — at rates the portfolio can sustain real income tends to rise; at higher rates real income gradually erodes.`
        : 'With Vanguard Dynamic Spending, income floats with the portfolio bounded by REAL year-over-year caps. A middle ground between Constant Dollar’s rigid stability and a pure percentage-of-portfolio strategy’s volatility.',
  };
  let text = callouts[strategy] || '';
  if (results.minimum_withdrawal_annual > 0 && results.floor_binding_percentiles) {
    const p50bind = results.floor_binding_percentiles.p50 || 0;
    text += ` A minimum annual withdrawal floor of ${formatCurrency(results.minimum_withdrawal_annual)} was active; in the median scenario it was binding in ${p50bind} of ${results.inputs_summary.period_years} years.`;
  }
  el.textContent = text;
}

function devRenderResults(results) {
  hideElement('dev-progress');
  hideElement('results-placeholder');
  showElement('dev-results');

  // Cache for chart toggle re-renders
  lastResults = results;
  // Render the new Phase-4 visuals (above the existing dev-style table)
  renderSuccessCard(results);
  renderPortfolioFanChart(results, currentPortfolioMode);
  bindPortfolioChartToggle();
  renderResultsSummaryText(results);
  renderIncomeVariabilityReport(results);
  updateExportAvailability();

  const elapsed = ((performance.now() - WORKER.startedAt) / 1000).toFixed(2);

  // ---- Results metrics table (Section 6.4)
  const tbody = document.querySelector('#dev-results-table tbody');
  if (tbody) {
    const s = results.statistics;
    const initial = results.inputs_summary.initial_balance;
    // Row spec: [label, val10, val25, val50, val75, val90, formatter, colorMode]
    //   colorMode: 'balance' tags cells by value vs initial (positive/eroded/zero)
    //              'plain' uses default
    const rows = [
      ['Ending balance (nominal)', s.p10.ending_balance_nominal, s.p25.ending_balance_nominal, s.p50.ending_balance_nominal, s.p75.ending_balance_nominal, s.p90.ending_balance_nominal, fmtCurrencyShort, 'balance'],
      ['Ending balance (real)',    s.p10.ending_balance_real,    s.p25.ending_balance_real,    s.p50.ending_balance_real,    s.p75.ending_balance_real,    s.p90.ending_balance_real,    fmtCurrencyShort, 'balance'],
      ['CAGR — nominal',           s.p10.cagr_nominal, s.p25.cagr_nominal, s.p50.cagr_nominal, s.p75.cagr_nominal, s.p90.cagr_nominal, fmtPctMaybe, 'plain'],
      ['CAGR — real',              s.p10.cagr_real,    s.p25.cagr_real,    s.p50.cagr_real,    s.p75.cagr_real,    s.p90.cagr_real,    fmtPctMaybe, 'plain'],
      ['Annualized volatility',    s.p10.annualized_volatility, s.p25.annualized_volatility, s.p50.annualized_volatility, s.p75.annualized_volatility, s.p90.annualized_volatility, fmtPctMaybe, 'plain'],
      ['Sharpe ratio',             s.p10.sharpe_ratio, s.p25.sharpe_ratio, s.p50.sharpe_ratio, s.p75.sharpe_ratio, s.p90.sharpe_ratio, (v) => v != null ? v.toFixed(3) : '—', 'plain'],
      ['Max drawdown — investment (Peak to Trough)', s.p10.max_drawdown_investment_pct, s.p25.max_drawdown_investment_pct, s.p50.max_drawdown_investment_pct, s.p75.max_drawdown_investment_pct, s.p90.max_drawdown_investment_pct, fmtPctMaybe, 'plain'],
      ['Max drawdown — account (Peak to Trough)',    s.p10.max_drawdown_pct,             s.p25.max_drawdown_pct,             s.p50.max_drawdown_pct,             s.p75.max_drawdown_pct,             s.p90.max_drawdown_pct,             fmtPctMaybe, 'plain'],
      ['Depleted?',                s.p10.depleted, s.p25.depleted, s.p50.depleted, s.p75.depleted, s.p90.depleted, (v) => v ? 'Yes' : 'No', 'plain'],
      ['Depletion year',           s.p10.depletion_year, s.p25.depletion_year, s.p50.depletion_year, s.p75.depletion_year, s.p90.depletion_year, (v) => v == null ? '—' : `Year ${v}`, 'plain'],
    ];
    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      const label = document.createElement('td');
      label.textContent = row[0];
      label.className = 'metric-label';
      tr.appendChild(label);
      const fmt = row[6];
      const colorMode = row[7];
      for (let i = 1; i <= 5; i++) {
        const td = document.createElement('td');
        td.className = 'num';
        if (i === 3) td.classList.add('is-median-col'); // p50 is the 3rd value column (index 1..5; 3 → p50)
        const v = row[i];
        td.textContent = fmt(v);
        if (colorMode === 'balance' && typeof v === 'number') {
          if (v <= 0)                td.classList.add('balance-zero');
          else if (v >= initial)     td.classList.add('balance-positive');
          else                       td.classList.add('balance-eroded');
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  // ---- Diagnostics
  const dl = document.getElementById('dev-diagnostics');
  if (dl) {
    const d = results.diagnostics;
    const c = d.crisis_year_coverage;
    const inputs = results.inputs_summary;
    const pairs = [
      ['Historical period',          inputs.historical_period],
      ['Eligible year pool size',    `${d.eligible_year_pool_size} rows (${d.eligible_year_first}–${d.eligible_year_last})`],
      ['Distinct years sampled',     `${d.distinct_years_sampled} of ${d.eligible_year_pool_size}`],
      ['Crisis-year coverage',       formatCrisisFlags(c)],
      ['Inflation × equity correlation', d.inflation_vs_equity_correlation != null
        ? `${d.inflation_vs_equity_correlation.toFixed(3)} (asset: ${d.correlation_asset_key})`
        : '—'],
      ['Portfolio historical mean',  `${inputs.portfolio_historical_mean.toFixed(2)}%`],
      ['Portfolio historical CAGR',  `${inputs.portfolio_historical_cagr.toFixed(2)}%`],
      ['Portfolio historical σ',     `${inputs.portfolio_historical_std.toFixed(2)}%`],
      ['Inflation mean / σ',         `${inputs.inflation_historical_mean.toFixed(2)}% / ${inputs.inflation_historical_std.toFixed(2)}%`],
      ['Constraining asset',         inputs.constraining_asset
        ? `${inputs.constraining_asset} (native ${inputs.constraining_asset_start})`
        : 'none'],
      ['Sequence-of-returns active', formatSorStatus(inputs)],
    ];
    dl.innerHTML = '';
    for (const [k, v] of pairs) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      dl.appendChild(dt); dl.appendChild(dd);
    }
  }

}

function devSummaryCell(label, value, hint) {
  const li = document.createElement('li');
  const l = document.createElement('span'); l.className = 'label'; l.textContent = label;
  const v = document.createElement('span'); v.className = 'value'; v.textContent = value;
  const h = document.createElement('span'); h.className = 'hint';  h.textContent = hint || '';
  li.appendChild(l); li.appendChild(v); li.appendChild(h);
  return li;
}

function formatSorStatus(inputs) {
  if (!inputs.sequence_of_returns_active) return 'no';
  const mode = inputs.sor_mode;
  const avg = inputs.sor_year1_avg_return;
  const avgStr = (avg != null && Number.isFinite(avg)) ? ` (avg year-1 weighted ${avg.toFixed(2)}%)` : '';
  if (mode === 'forced_2008') {
    const r = inputs.sor_year_portfolio_return;
    const rStr = (r != null && Number.isFinite(r)) ? ` (weighted ${r.toFixed(2)}%)` : '';
    return `yes — 2008 placed at year 1${rStr}`;
  }
  if (mode === 'computed_worst') {
    const top = inputs.sor_year1_top_years;
    const topStr = (top && top.length) ? ` · top year-1 picks: ${top.map(t => `${t.year} (${t.pct.toFixed(1)}%)`).join(', ')}` : '';
    return `yes — worst drawn year moved to year 1${avgStr}${topStr}`;
  }
  return 'yes';
}

function formatCrisisFlags(c) {
  const flags = [
    ['1929', c.has_1929], ['1931', c.has_1931], ['1973', c.has_1973], ['2008', c.has_2008],
  ];
  return flags.map(([yr, ok]) => `${yr}: ${ok ? '✓' : '—'}`).join('  ');
}

function fmtCurrencyShort(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v <= 0) return '$0';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
function fmtPctMaybe(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}
// Boot the dev panel after the data layer is ready.
// We piggyback on the existing DOMContentLoaded handler by polling
// briefly for STATE.data; loadData() resolves on its own timeline.
function whenDataReady(cb) {
  const tryNow = () => {
    if (STATE.data) { cb(); return true; }
    return false;
  };
  if (tryNow()) return;
  const iv = setInterval(() => { if (tryNow()) clearInterval(iv); }, 80);
}
// Guard: initDevPanel is an optional/dev-only hook that isn't defined in this
// build. A bare reference here throws a ReferenceError at load time, so only
// wire it up if it actually exists.
if (typeof initDevPanel === 'function') whenDataReady(initDevPanel);

/* ============================================================
   Clickwrap acceptance gate — one-time, versioned Terms wrapper.
   Replaces the old per-run disclaimer checkbox: the user accepts
   once on entry (stored in localStorage), and is re-prompted only
   when TERMS_VERSION changes. If storage is blocked, they are
   prompted every visit (fail-safe). Mirrors the Roth Conversion
   tool's gate.
   ============================================================ */
const TERMS_VERSION = '2026-08-03';               // bump whenever the Terms text changes
const TERMS_KEY = 'btn-mcsim-terms-accepted';
const TERMS_TS_KEY = 'btn-mcsim-terms-accepted-at';
function initTermsGate() {
  const gate = document.getElementById('termsGate');
  if (!gate) return;
  let accepted = null, acceptedAt = null;
  try {
    accepted = localStorage.getItem(TERMS_KEY);
    acceptedAt = localStorage.getItem(TERMS_TS_KEY);
  } catch (e) { /* storage blocked -> always prompt */ }
  if (accepted === TERMS_VERSION) {
    // Already accepted this version — seed the PDF paper-trail timestamp.
    INPUT_STATE.terms_accepted_at = acceptedAt || new Date().toISOString();
  } else {
    gate.classList.remove('hidden');
  }
  document.getElementById('gateAgree')?.addEventListener('click', () => {
    const now = new Date().toISOString();
    INPUT_STATE.terms_accepted_at = now;
    try {
      localStorage.setItem(TERMS_KEY, TERMS_VERSION);
      localStorage.setItem(TERMS_TS_KEY, now);
    } catch (e) { /* ok — they'll be prompted next visit */ }
    gate.classList.add('hidden');
  });
  // "Read the full Terms" opens the existing Terms modal on top of the gate.
  document.getElementById('gate-open-terms')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (typeof openTermsModal === 'function') openTermsModal();
  });
}
