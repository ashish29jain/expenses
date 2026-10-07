/* Expenses – offline-first app.
 * Everything you do is saved on the phone first (a queue of changes), shown right
 * away, and sent to the Google Sheet whenever there is internet. */
(function () {
  'use strict';

  const CFG = window.EXPENSES_CONFIG || {};
  const PEOPLE = ['Ashish', 'Shivani'];
  const FIELDS = ['date', 'subcategory', 'purpose', 'amount', 'spentBy', 'split', 'source'];
  const FIELD_LABELS = { date: 'Date', subcategory: 'Subcategory', purpose: 'Purpose', amount: 'Amount', spentBy: 'Spent by', split: 'Split between', source: 'Source' };
  const PAGE = 50;
  const $ = id => document.getElementById(id);
  const form = $('f');

  // ---------------- storage ----------------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('exp_' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('exp_' + k, JSON.stringify(v)); } catch (e) { /* storage full / blocked */ } },
  };
  let cache = store.get('cache', { options: null, entries: [], syncedAt: 0 });
  let queue = store.get('queue', []);
  const saveCache = () => store.set('cache', cache);
  const saveQueue = () => store.set('queue', queue);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------------- helpers ----------------
  const fmtMoney = n => n === '' || n == null ? '' : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const pad = n => String(n).padStart(2, '0');
  const isoOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => isoOf(new Date());
  const labelOf = iso => { const p = (iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const pick = (e) => Object.fromEntries(FIELDS.map(f => [f, e[f] == null ? '' : e[f]]));
  const norm = (f, v) => f === 'amount' ? Number(v) : String(v == null ? '' : v).trim();
  const same = (a, b) => FIELDS.every(f => norm(f, a[f]) === norm(f, b[f]));
  function setStatus(msg, cls) { $('status').textContent = msg || ''; $('status').className = cls || ''; }

  // Subcategory -> Category, learned from synced rows (used for entries not yet synced).
  function categoryMap() {
    const m = {};
    cache.entries.forEach(e => { if (e.subcategory && e.category) m[e.subcategory] = e.category; });
    return m;
  }

  // ---------------- the merged view: sheet + changes not yet synced ----------------
  // Every row has an ID (sheet column A). 's<row>' is only a stand-in for rows not yet given one.
  const idOf = e => e.id || 's' + e.row;
  const realId = id => id && !/^s\d+$/.test(id) ? id : undefined;
  const cached = id => cache.entries.find(e => idOf(e) === id);
  function findTarget(list, op) {
    const i = list.findIndex(e => e.id === op.targetId);
    return i >= 0 || realId(op.targetId) ? i : list.findIndex(e => !e.local && same(e, op.original));
  }
  function view() {
    const cats = categoryMap();
    const list = cache.entries.map(e => Object.assign({}, e, { id: idOf(e) }));
    queue.forEach(op => {
      const flag = op.status === 'pending' ? 'pending' : 'problem';
      if (op.type === 'add') {
        list.push(Object.assign({}, op.entry, { id: op.opId, local: true, state: flag, category: cats[op.entry.subcategory] || '', dateLabel: labelOf(op.entry.date) }));
        return;
      }
      const i = findTarget(list, op);
      if (i < 0) return;
      if (op.type === 'update') {
        list[i] = Object.assign({}, list[i], op.entry, { state: flag, category: cats[op.entry.subcategory] || list[i].category, dateLabel: labelOf(op.entry.date), opId: op.opId });
      } else if (op.status === 'pending') {
        list.splice(i, 1);
      } else {
        list[i] = Object.assign({}, list[i], { state: 'problem', opId: op.opId });
      }
    });
    return list;
  }

  // ---------------- queueing changes ----------------
  function queueAdd(entry) {
    queue.push({ opId: uid(), type: 'add', entry, status: 'pending' });
    saveQueue(); afterChange();
  }
  function queueEdit(target, entry) {
    const own = queue.find(o => o.opId === (target.local ? target.id : target.opId));
    if (own && !own.inflight && own.type !== 'delete') {
      own.entry = entry; own.status = 'pending'; own.error = null;
    } else if (own && own.inflight) {
      // Already on its way to the sheet: follow up with another change once it lands.
      queue.push({ opId: uid(), type: 'update', targetId: own.type === 'add' ? own.opId : own.targetId, row: own.row || 0, original: own.entry, entry, status: 'pending' });
    } else {
      queue.push({ opId: uid(), type: 'update', targetId: target.id, row: target.row, original: pick(cached(target.id) || target), entry, status: 'pending' });
    }
    saveQueue(); afterChange();
  }
  function queueDelete(target) {
    const own = queue.find(o => o.opId === (target.local ? target.id : target.opId));
    if (own && own.type === 'add' && !own.inflight) {
      queue = queue.filter(o => o !== own); // never reached the sheet – just forget it
    } else if (own && own.type === 'update' && !own.inflight) {
      own.type = 'delete'; own.entry = null; own.status = 'pending'; own.error = null;
    } else if (own && own.inflight) {
      queue.push({ opId: uid(), type: 'delete', targetId: own.type === 'add' ? own.opId : own.targetId, row: own.row || 0, original: own.entry, status: 'pending' });
    } else {
      queue.push({ opId: uid(), type: 'delete', targetId: target.id, row: target.row, original: pick(cached(target.id) || target), status: 'pending' });
    }
    saveQueue(); afterChange();
  }
  function afterChange() { renderAll(); sync(); }

  // ---------------- talking to the sheet ----------------
  let syncing = false, syncAgain = false, online = navigator.onLine, lastError = '';
  async function api(action, payload) {
    if (!CFG.API_URL || /PASTE/.test(CFG.API_URL)) throw new Error('setup');
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 60000); // Apps Script can be slow to start
    try {
      const res = await fetch(CFG.API_URL, {
        method: 'POST', signal: ctl.signal, redirect: 'follow',
        body: new URLSearchParams({ key: CFG.API_KEY || '', action, payload: JSON.stringify(payload || {}) }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  function applyResult(op, res) {
    if (op.type === 'add') {
      cache.entries.push(res.entry);
    } else if (op.type === 'update') {
      const i = cache.entries.findIndex(e => idOf(e) === idOf(res.entry) || e.row === res.entry.row);
      if (i >= 0) cache.entries[i] = res.entry; else cache.entries.push(res.entry);
    } else {
      cache.entries = cache.entries.filter(e => e.row !== res.row).map(e => e.row > res.row ? Object.assign({}, e, { row: e.row - 1 }) : e);
    }
    saveCache();
  }

  async function sync() {
    if (syncing) { syncAgain = true; return; } // a change arrived mid-sync: run once more afterwards
    syncing = true; renderSync();
    try {
      for (;;) {
        const op = queue.find(o => o.status === 'pending');
        if (!op) break;
        op.inflight = true;
        const payload = op.type === 'add' ? { opId: op.opId, entry: op.entry }
          : op.type === 'update' ? { opId: op.opId, id: realId(op.targetId), row: op.row, entry: op.entry, original: op.original }
          : { opId: op.opId, id: realId(op.targetId), row: op.row, original: op.original };
        let res;
        try { res = await api(op.type, payload); } finally { op.inflight = false; }
        online = true;
        if (res.ok) {
          queue = queue.filter(o => o !== op);
          applyResult(op, res);
        } else if (res.clash) {
          if (op.type === 'delete' && !res.current) { queue = queue.filter(o => o !== op); } // already gone: nothing to do
          else { op.status = 'clash'; op.current = res.current; }
        } else {
          op.status = 'error'; op.error = res.error || 'Unknown error';
        }
        saveQueue(); renderAll();
      }
      const boot = await api('bootstrap');
      if (!boot.ok) throw Object.assign(new Error(boot.error || 'Could not load'), { fromSheet: true });
      cache = { options: boot.options, entries: boot.entries, syncedAt: Date.now() };
      saveCache();
      online = true; lastError = '';
    } catch (err) {
      if (err.message === 'setup') lastError = 'The app is not connected to the sheet yet (config.js).';
      else if (/Invalid key/.test(err.message)) lastError = 'The key in config.js does not match Code.gs.';
      else if (err.fromSheet) lastError = 'The sheet replied: ' + err.message;
      else if (err.name === 'AbortError') { online = true; lastError = 'The sheet took more than a minute to answer. The app keeps trying.'; }
      else { online = false; lastError = ''; }
    } finally {
      syncing = false;
      renderAll();
      if (syncAgain) { syncAgain = false; if (online) setTimeout(sync, 0); }
    }
  }

  // ---------------- sync pill & problem dialog ----------------
  function renderSync() {
    const pill = $('sync');
    const waiting = queue.filter(o => o.status === 'pending').length;
    const problems = queue.filter(o => o.status !== 'pending').length;
    let text, cls;
    if (lastError) { text = 'Not connected'; cls = 'err'; }
    else if (problems) { text = problems + ' need' + (problems === 1 ? 's' : '') + ' attention'; cls = 'err'; }
    else if (syncing) { text = waiting ? 'Syncing ' + waiting + '…' : 'Syncing…'; cls = ''; }
    else if (!online) { text = waiting ? 'Offline · ' + waiting + ' waiting' : 'Offline'; cls = 'warn'; }
    else if (waiting) { text = waiting + ' waiting'; cls = 'warn'; }
    else { text = 'Synced'; cls = 'ok'; }
    pill.textContent = text;
    pill.className = 'pill ' + cls;
  }
  $('sync').addEventListener('click', () => {
    if (lastError) { alert(lastError + '\n\nSee SETUP.md.'); return; }
    const problem = queue.find(o => o.status !== 'pending');
    if (problem) showProblem(problem); else sync();
  });

  function closeDialog() { $('dlg').hidden = true; }
  function compareTable(mine, theirs) {
    const t = document.createElement('table');
    const h = t.createTHead().insertRow();
    ['', 'Your version', 'Sheet now'].forEach(x => { const th = document.createElement('th'); th.textContent = x; h.append(th); });
    const b = t.createTBody();
    FIELDS.forEach(f => {
      const tr = b.insertRow();
      const a = mine ? (f === 'amount' ? fmtMoney(mine[f]) : f === 'date' ? labelOf(mine[f]) : mine[f]) : '—';
      const c = theirs ? (f === 'amount' ? fmtMoney(theirs[f]) : f === 'date' ? labelOf(theirs[f]) : theirs[f]) : '—';
      [FIELD_LABELS[f], a, c].forEach((v, i) => { const td = tr.insertCell(); td.textContent = v || ''; if (i && mine && theirs && norm(f, mine[f]) !== norm(f, theirs[f])) td.className = 'diff'; });
    });
    return t;
  }
  function showProblem(op) {
    const title = $('dlg-title'), text = $('dlg-text'), table = $('dlg-table'), acts = $('dlg-actions');
    table.innerHTML = ''; acts.innerHTML = '';
    const button = (label, cls, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; if (cls) b.className = cls; b.onclick = () => { fn(); closeDialog(); saveQueue(); afterChange(); }; acts.append(b); };
    const drop = () => { queue = queue.filter(o => o !== op); };
    const retarget = cur => { op.original = pick(cur); op.row = cur.row; op.targetId = idOf(cur); op.status = 'pending'; op.current = null; };

    if (op.status === 'error') {
      title.textContent = 'This change could not be saved';
      text.textContent = op.error;
      if (op.entry) table.append(compareTable(op.entry, null));
      button('Try again', '', () => { op.status = 'pending'; op.error = null; });
      button('Discard this change', 'danger', drop);
    } else if (op.type === 'update' && op.current) {
      title.textContent = 'Changed by someone else';
      text.textContent = 'This expense was changed in the sheet (or on another phone) after you edited it. Which version should be kept?';
      table.append(compareTable(op.entry, op.current));
      button('Keep my version', '', () => retarget(op.current));
      button('Keep the sheet version', 'secondary', drop);
    } else if (op.type === 'update') {
      title.textContent = 'Deleted by someone else';
      text.textContent = 'You edited this expense, but it was deleted from the sheet (or on another phone).';
      table.append(compareTable(op.entry, null));
      button('Add my version back', '', () => { op.type = 'add'; op.opId = uid(); op.status = 'pending'; op.original = null; op.current = null; });
      button('Leave it deleted', 'secondary', drop);
    } else {
      title.textContent = 'Changed before you deleted it';
      text.textContent = 'You deleted this expense, but someone changed it in the meantime. Delete it anyway?';
      table.append(compareTable(op.original, op.current));
      button('Delete it anyway', 'danger', () => retarget(op.current));
      button('Keep it', 'secondary', drop);
    }
    $('dlg').hidden = false;
  }
  $('dlg').addEventListener('click', e => { if (e.target === $('dlg')) closeDialog(); });

  // ---------------- add / edit form ----------------
  let editing = null, formReady = false, optionsSig = '', autoDate = ''; // autoDate: the date the app filled in itself
  function fillSelect(sel, values, placeholder) {
    const cur = sel.value;
    sel.innerHTML = '';
    sel.add(new Option(placeholder || '— select —', ''));
    values.forEach(v => sel.add(new Option(v, v)));
    if (values.includes(cur)) sel.value = cur;
  }
  function buildSeg(container, name, values) {
    container.innerHTML = '';
    values.forEach(v => {
      const l = document.createElement('label');
      const i = document.createElement('input');
      i.type = 'radio'; i.name = name; i.value = v;
      const s = document.createElement('span');
      s.textContent = v;
      l.append(i, s);
      container.append(l);
    });
  }
  function setField(name, value) {
    const el = form.elements[name];
    if (!el) return;
    if (el instanceof HTMLSelectElement && value && ![...el.options].some(o => o.value === value)) el.add(new Option(value, value));
    if (typeof RadioNodeList !== 'undefined' && el instanceof RadioNodeList && value && ![...el].some(r => r.value === value)) return;
    el.value = value == null ? '' : value;
  }
  function setupForm() {
    const o = cache.options;
    if (!o) {
      setStatus(syncing ? 'Loading your Subcategory and Source lists from the sheet…'
        : lastError ? lastError + ' (the lists will load once this is fixed)'
        : !online ? 'No connection to the sheet yet. Your Subcategory and Source lists load the first time it connects.'
        : 'Loading your lists…', !syncing && (lastError || !online) ? 'err' : '');
      $('btn').disabled = true;
      return;
    }
    const opened = !formReady;
    const sig = JSON.stringify([o.subcategory, o.source]);
    if (sig !== optionsSig) { optionsSig = sig; fillSelect(form.subcategory, o.subcategory); fillSelect(form.source, o.source); }
    if (opened) {
      buildSeg($('seg-spentBy'), 'spentBy', o.spentBy);
      buildSeg($('seg-split'), 'split', o.split);
      formReady = true;
      const draft = store.get('draft', null);
      resetForm();
      if (draft) restoreDraft(draft);
    }
    $('btn').disabled = false;
    if (/lists/.test($('status').textContent)) setStatus('');
  }
  // ---- unfinished entry: saved as you type, so it survives the phone closing the app ----
  function saveDraft() {
    if (!formReady) return;
    const d = Object.fromEntries(new FormData(form));
    const empty = !editing && !d.subcategory && !d.purpose && !d.amount && d.date === autoDate;
    if (empty) { clearDraft(); return; }
    d.editingId = editing ? editing.id : null;
    d.dateAuto = d.date === autoDate; // still the date the app filled in (moves on to a new day)
    store.set('draft', d);
  }
  function clearDraft() { try { localStorage.removeItem('exp_draft'); } catch (e) { /* ignore */ } }
  function restoreDraft(d) {
    if (d.editingId) {
      const target = view().find(e => e.id === d.editingId);
      if (!target) return; // that expense no longer exists: nothing to continue
      startEdit(target);
    }
    FIELDS.forEach(f => { if (f !== 'date' && d[f] != null) setField(f, d[f]); });
    if (!d.dateAuto || d.editingId) setField('date', d.date);
    saveDraft();
    setStatus('Your unfinished entry was kept.', 'ok');
  }
  form.addEventListener('input', saveDraft);
  form.addEventListener('change', saveDraft);

  function resetForm() {
    clearDraft();
    editing = null;
    form.reset();
    form.date.value = autoDate = today();
    if (cache.options) {
      setField('split', cache.options.defaultSplit);
      setField('spentBy', cache.options.defaultSpentBy);
    }
    $('form-title').textContent = 'Add expense';
    $('btn').textContent = 'Add expense';
    $('cancel').hidden = true;
    $('delete').hidden = true;
    $('actions').classList.remove('editing');
  }
  function startEdit(e) {
    if (!formReady) return;
    editing = e;
    showTab('add');
    FIELDS.forEach(f => setField(f, e[f]));
    $('form-title').textContent = 'Edit expense' + (e.row && !e.local ? ' · row ' + e.row : '');
    $('btn').textContent = 'Save changes';
    $('cancel').hidden = false;
    $('delete').hidden = false;
    $('actions').classList.add('editing');
    setStatus('');
    window.scrollTo(0, 0);
    saveDraft();
  }
  $('cancel').addEventListener('click', () => { resetForm(); setStatus(''); showTab('list'); });
  $('delete').addEventListener('click', () => {
    if (!editing) return;
    if (!confirm('Delete this expense?\n\n' + editing.subcategory + ' · ' + fmtMoney(editing.amount) + ' · ' + labelOf(editing.date))) return;
    queueDelete(editing);
    setStatus('Deleted ' + editing.subcategory + ' · ' + fmtMoney(editing.amount), 'ok');
    resetForm();
    showTab('list');
  });
  form.addEventListener('submit', ev => {
    ev.preventDefault();
    const raw = Object.fromEntries(new FormData(form));
    const entry = pick(raw);
    entry.amount = Number(entry.amount);
    if (!(entry.amount > 0)) { setStatus('Enter an amount.', 'err'); return; }
    if (editing) {
      queueEdit(editing, entry);
      setStatus('Saved changes to ' + entry.subcategory + ' · ' + fmtMoney(entry.amount), 'ok');
      resetForm();
      showTab('list');
    } else {
      queueAdd(entry);
      setStatus('Added ' + entry.subcategory + ' · ' + fmtMoney(entry.amount) + (online ? '' : ' (will sync when online)'), 'ok');
      resetForm();
    }
  });

  // ---------------- tabs ----------------
  let tab = 'add';
  function showTab(name) {
    tab = name;
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    ['add', 'list', 'trends'].forEach(t => { $('view-' + t).hidden = t !== name; });
    if (name === 'list') renderList();
    if (name === 'trends') renderTrends();
  }
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
    setStatus('');
    if (b.dataset.tab === 'add' && editing) resetForm(); // the Add tab always means a new expense
    showTab(b.dataset.tab);
  }));

  // ---------------- entries list ----------------
  let shown = PAGE;
  const catOf = e => e.category || 'Uncategorised';
  function renderList() {
    const all = view();
    const cats = [...new Set(all.map(catOf))].sort();
    fillSelect($('cat'), cats, 'All categories');
    const q = $('q').value.trim().toLowerCase(), c = $('cat').value;
    const items = all.filter(e => (!c || catOf(e) === c) &&
      (!q || [e.subcategory, e.category, e.purpose, e.source, e.split, e.spentBy, e.dateLabel, String(e.amount)].some(v => String(v || '').toLowerCase().includes(q))))
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.row || 1e9) - (a.row || 1e9));
    const total = items.reduce((s, e) => s + (Number(e.amount) || 0), 0);
    $('summary').textContent = items.length + ' entr' + (items.length === 1 ? 'y' : 'ies') + ' · Total ' + fmtMoney(total) + ' · tap an entry to edit';
    const list = $('list');
    list.innerHTML = '';
    if (!items.length) list.innerHTML = '<div class="empty">No entries found</div>';
    items.slice(0, shown).forEach(e => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'entry';
      const tag = e.state === 'pending' ? ['wait', '⏳ waiting to sync'] : e.state === 'problem' ? ['bad', '⚠ needs attention'] : ['', 'row ' + e.row];
      [[e.purpose ? 't' : 't none', e.purpose || 'No purpose'], ['amt', fmtMoney(e.amount)],
       ['m', [e.category || 'Uncategorised', e.dateLabel || labelOf(e.date), 'By ' + (e.spentBy || '—')].join(' · ')],
       ['r ' + tag[0], tag[1]]]
        .forEach(([cls, text]) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; b.append(d); });
      b.addEventListener('click', () => {
        const problem = e.state === 'problem' && queue.find(o => o.opId === (e.local ? e.id : e.opId));
        if (problem) showProblem(problem); else startEdit(e);
      });
      list.append(b);
    });
    $('more').hidden = items.length <= shown;
  }
  $('q').addEventListener('input', () => { shown = PAGE; renderList(); });
  $('cat').addEventListener('change', () => { shown = PAGE; renderList(); });
  $('more').addEventListener('click', () => { shown += PAGE; renderList(); });

  // ---------------- trends ----------------
  // Validated categorical palette, fixed order; a category keeps its colour everywhere.
  const SERIES = {
    light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
  };
  const OTHER = { light: '#9b9a94', dark: '#6f6e69' };
  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const mode = () => darkMQ.matches ? 'dark' : 'light';
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const compact = v => '₹' + Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
  const sum = a => a.reduce((s, v) => s + v, 0);
  let charts = {};

  function lastMonths(n) {
    const now = new Date(), out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      out.push({ key: d.getFullYear() + '-' + pad(d.getMonth() + 1), label: d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' }) });
    }
    return out;
  }
  // Category -> {name, color}; more than 8 categories: top 7 by all-time spend keep a colour, the rest become "Other".
  function categorySeries(entries) {
    const tot = {};
    entries.forEach(e => { tot[catOf(e)] = (tot[catOf(e)] || 0) + (Number(e.amount) || 0); });
    const cats = Object.keys(tot).sort((a, b) => tot[b] - tot[a]);
    const fold = cats.length > 8, map = {};
    cats.forEach((c, i) => { map[c] = fold && i >= 7 ? { name: 'Other', color: OTHER[mode()] } : { name: c, color: SERIES[mode()][i] }; });
    return map;
  }
  const paidBy = (e, p) => e.spentBy === p ? Number(e.amount) || 0 : 0;
  const shareOf = (e, p) => {
    const a = Number(e.amount) || 0;
    if (e.split === 'Both') return a / 2;
    if (e.split === 'Ashish' || e.split === 'Shivani') return e.split === p ? a : 0;
    return paidBy(e, p); // no split recorded: counts for whoever paid
  };

  function baseOptions(stacked, yMax) {
    const muted = cssVar('--muted'), grid = cssVar('--grid'), text = cssVar('--text');
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked, grid: { display: false }, border: { color: grid }, ticks: { color: muted, font: { size: 11 }, autoSkip: false, maxRotation: 50 } },
        y: { stacked, beginAtZero: true, suggestedMax: yMax || undefined, grid: { color: grid }, border: { display: false }, ticks: { color: muted, font: { size: 11 }, maxTicksLimit: 5, callback: compact } },
      },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { color: text, boxWidth: 10, boxHeight: 10, font: { size: 11 }, padding: 10 } },
        tooltip: {
          filter: i => i.raw > 0, itemSort: (a, b) => b.raw - a.raw,
          callbacks: {
            label: i => ' ' + i.dataset.label + ': ' + fmtMoney(i.raw),
            footer: items => items.length > 1 ? 'Total: ' + fmtMoney(items.reduce((s, i) => s + i.raw, 0)) : '',
          },
        },
      },
    };
  }
  function barStyle(color, stacked) {
    return { backgroundColor: color, hoverBackgroundColor: color, borderColor: cssVar('--card'), borderSkipped: false, maxBarThickness: 36,
      borderWidth: stacked ? { top: 2, right: 0, bottom: 0, left: 0 } : { top: 0, right: 1, bottom: 0, left: 1 } };
  }
  function drawChart(id, labels, datasets, options) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), { type: 'bar', data: { labels, datasets }, options });
  }
  function table(el, firstCol, labels, rows) {
    const t = document.createElement('table');
    const head = t.createTHead().insertRow();
    [firstCol, ...rows.map(r => r.name), 'Total'].forEach(h => { const th = document.createElement('th'); th.textContent = h; head.append(th); });
    const body = t.createTBody();
    labels.forEach((l, i) => {
      const tr = body.insertRow();
      const vals = rows.map(r => r.data[i]);
      [l, ...vals.map(fmtMoney), fmtMoney(sum(vals))].forEach(v => { tr.insertCell().textContent = v; });
    });
    el.innerHTML = ''; el.append(t);
  }

  const dMonths = lastMonths(12);
  let dSelected = new Set(dMonths.slice(-2).map(m => m.key)); // current + previous month
  function buildMonthChips() {
    const box = $('d-months');
    box.innerHTML = '';
    dMonths.forEach(m => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip' + (dSelected.has(m.key) ? ' on' : ''); b.textContent = m.label;
      b.setAttribute('aria-pressed', dSelected.has(m.key));
      b.onclick = () => {
        if (dSelected.has(m.key)) { if (dSelected.size > 1) dSelected.delete(m.key); } else dSelected.add(m.key);
        buildMonthChips(); drawD(view());
      };
      box.append(b);
    });
  }

  function renderTrends() {
    if (!window.Chart) { $('tot-A').textContent = 'Charts need internet the first time.'; return; }
    const entries = view();
    const months = lastMonths(8), idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
    const labels = months.map(m => m.label);
    const series = categorySeries(entries);
    const order = [...new Map(Object.values(series).map(s => [s.name, s])).values()];

    // A & B: monthly, stacked by category, by who paid. Shared y-axis.
    const agg = { Ashish: {}, Shivani: {} };
    entries.forEach(e => {
      const i = idx[(e.date || '').slice(0, 7)];
      if (i == null) return;
      const s = series[catOf(e)];
      PEOPLE.forEach(p => { const v = paidBy(e, p); if (v) (agg[p][s.name] = agg[p][s.name] || Array(8).fill(0))[i] += v; });
    });
    const yMax = Math.max(0, ...PEOPLE.flatMap(p => months.map((_, i) => sum(Object.values(agg[p]).map(a => a[i])))));
    [['A', 'Ashish'], ['B', 'Shivani']].forEach(([k, p]) => {
      const ds = order.filter(s => agg[p][s.name]).map(s => Object.assign({ label: s.name, data: agg[p][s.name] }, barStyle(s.color, true)));
      $('tot-' + k).textContent = fmtMoney(sum(ds.map(d => sum(d.data)))) + ' total';
      drawChart('c-' + k, labels, ds, baseOptions(true, yMax));
      table($('tbl-' + k), 'Month', labels, ds.map(d => ({ name: d.label, data: d.data })));
    });

    // C: Ashish vs Shivani for the chosen categories (none chosen = all), by who paid.
    const cats = [...new Set(entries.map(catOf))].sort();
    cSelected.forEach(c => { if (!cats.includes(c)) cSelected.delete(c); });
    buildCategoryChips(cats);
    const cData = PEOPLE.map(() => Array(8).fill(0));
    entries.forEach(e => {
      const i = idx[(e.date || '').slice(0, 7)];
      if (i == null || (cSelected.size && !cSelected.has(catOf(e)))) return;
      PEOPLE.forEach((p, k) => { cData[k][i] += paidBy(e, p); });
    });
    const cDs = PEOPLE.map((p, k) => Object.assign({ label: p, data: cData[k] }, barStyle(SERIES[mode()][k], false)));
    $('tot-C').textContent = PEOPLE.map((p, k) => p + ' ' + fmtMoney(sum(cData[k]))).join(' · ');
    const cOpt = baseOptions(false);
    cOpt.datasets = { bar: { categoryPercentage: 0.7, barPercentage: 0.9 } };
    drawChart('c-C', labels, cDs, cOpt);
    table($('tbl-C'), 'Month', labels, cDs.map(d => ({ name: d.label, data: d.data })));

    buildMonthChips();
    drawD(entries);
  }

  // D: x = categories, stacked Ashish's share + Shivani's share, for the selected months.
  function drawD(entries) {
    const per = {};
    entries.forEach(e => {
      if (!dSelected.has((e.date || '').slice(0, 7))) return;
      const c = catOf(e);
      per[c] = per[c] || [0, 0];
      PEOPLE.forEach((p, k) => { per[c][k] += shareOf(e, p); });
    });
    const cats = Object.keys(per).sort((a, b) => sum(per[b]) - sum(per[a]));
    const ds = PEOPLE.map((p, k) => Object.assign({ label: p + "'s share", data: cats.map(c => per[c][k]) }, barStyle(SERIES[mode()][k], true)));
    const ta = sum(ds[0].data), ts = sum(ds[1].data);
    const n = dSelected.size;
    $('tot-D').textContent = n + ' month' + (n > 1 ? 's' : '') + ' · Total ' + fmtMoney(ta + ts) + ' · Ashish ' + fmtMoney(ta) + ' · Shivani ' + fmtMoney(ts);
    drawChart('c-D', cats, ds, baseOptions(true));
    table($('tbl-D'), 'Category', cats, ds.map(d => ({ name: d.label, data: d.data })));
  }
  const cSelected = new Set(); // empty = all categories
  function buildCategoryChips(cats) {
    const box = $('c-cats');
    box.innerHTML = '';
    const chip = (label, on, onClick) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip' + (on ? ' on' : ''); b.textContent = label;
      b.setAttribute('aria-pressed', on);
      b.onclick = onClick;
      box.append(b);
    };
    chip('All categories', !cSelected.size, () => { cSelected.clear(); renderTrends(); });
    cats.forEach(c => chip(c, cSelected.has(c), () => {
      if (cSelected.has(c)) cSelected.delete(c); else cSelected.add(c);
      if (cSelected.size === cats.length) cSelected.clear(); // everything ticked = all
      renderTrends();
    }));
  }
  darkMQ.addEventListener('change', () => { if (tab === 'trends') renderTrends(); });

  // ---------------- wiring ----------------
  function renderAll() {
    renderSync();
    setupForm();
    if (tab === 'list') renderList();
    if (tab === 'trends') renderTrends();
  }
  window.addEventListener('online', () => sync());
  window.addEventListener('offline', () => { online = false; renderSync(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // A new day since the app was last opened: move the date on, but only if it's still the one the
    // app filled in. A date you picked yourself is never changed.
    if (!editing && form.date.value === autoDate && autoDate !== today()) form.date.value = autoDate = today();
    sync();
  });
  setInterval(() => { if (!cache.options || lastError || queue.some(o => o.status === 'pending')) sync(); }, 30000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  renderAll();
  sync();
})();
