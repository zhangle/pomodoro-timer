/* =========================================================
   Pomodoro Timer
   Local-first: everything lives in localStorage.
   ========================================================= */
(function () {
  'use strict';

  const KEY = 'pomodoro.v1';
  const LEGACY_KEY = 'tempo.v1';
  const MODES = { focus: '专注', short: '短休息', long: '长休息' };
  const ACCENTS = ['vermilion', 'indigo', 'moss', 'amber'];
  const THEMES = ['paper', 'ink'];
  const RANGES = ['week', 'month', 'all'];

  const DEFAULT_SETTINGS = {
    focus: 25,
    short: 5,
    long: 15,
    interval: 4,
    autoBreaks: false,
    autoFocus: false,
    ticking: false,
    notify: true,
    sound: 'chime',
    volume: 60,
    theme: 'paper',
    accent: 'vermilion',
    reportRange: 'week'
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const uid = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const dateKey = (d) => {
    const x = d || new Date();
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  };
  const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------------- state ---------------- */
  const S = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    tasks: [],
    timer: { mode: 'focus', remaining: 25 * 60000, running: false, endAt: null, cycle: 0 },
    stats: {}
  };

  let lastTick = Date.now();
  let lastSave = 0;
  let activeTaskId = null;
  let addEst = 1;

  function load() {
    try {
      const raw = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (data.settings) Object.assign(S.settings, data.settings);
      if (Array.isArray(data.tasks)) S.tasks = data.tasks;
      if (data.stats && typeof data.stats === 'object') S.stats = data.stats;
      if (data.timer) Object.assign(S.timer, data.timer);
      activeTaskId = data.activeTaskId || null;
      if (!localStorage.getItem(KEY)) {
        // 从旧版键名迁移，避免改名前后的进度丢失
        save(true);
        localStorage.removeItem(LEGACY_KEY);
      }
      return true;
    } catch (err) {
      console.warn('Pomodoro Timer: 无法读取本地数据', err);
      return false;
    }
  }

  function save(force) {
    const now = Date.now();
    if (!force && now - lastSave < 4000) return;
    lastSave = now;
    try {
      localStorage.setItem(KEY, JSON.stringify({
        version: 1,
        settings: S.settings,
        tasks: S.tasks,
        timer: S.timer,
        stats: S.stats,
        activeTaskId: activeTaskId
      }));
    } catch (err) {
      console.warn('Pomodoro Timer: 无法保存', err);
      if (err && (err.name === 'QuotaExceededError' || err.code === 22)) {
        toast('本地存储空间已满，最新进度没能保存');
      }
    }
  }

  function statFor(key) {
    if (!S.stats[key]) S.stats[key] = { focus: 0, pomos: 0, tasks: {} };
    return S.stats[key];
  }
  const todayStat = () => statFor(dateKey());

  /* ---------------- audio ---------------- */
  let ac = null;
  function ctx() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function tone(freq, startAt, dur, type, peak, glideTo) {
    const c = ctx();
    if (!c) return;
    const t0 = c.currentTime + startAt;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    const vol = (peak == null ? 0.18 : peak);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function playAlarm(kind) {
    const s = S.settings;
    if (s.sound === 'none' || s.volume === 0) return;
    const v = (s.volume / 100) * 0.22;
    const k = kind || s.sound;
    if (k === 'chime') {
      [[523.25, 0], [659.25, 0.14], [783.99, 0.28], [1046.5, 0.44]].forEach(function (n, i) {
        tone(n[0], n[1], 1.5 - i * 0.1, 'sine', v * (1 - i * 0.12));
        tone(n[0] * 2, n[1], 0.7, 'sine', v * 0.14);
      });
    } else if (k === 'digital') {
      for (let i = 0; i < 4; i++) tone(1420, i * 0.22, 0.12, 'square', v * 0.5);
      tone(980, 0.9, 0.22, 'square', v * 0.4);
    } else if (k === 'wood') {
      tone(470, 0, 0.1, 'triangle', v * 0.9, 300);
      tone(470, 0.18, 0.1, 'triangle', v * 0.7, 300);
      tone(620, 0.36, 0.09, 'triangle', v * 0.5, 380);
    }
  }

  function playTick() {
    if (!S.settings.ticking) return;
    const v = (S.settings.volume / 100) * 0.05;
    if (v <= 0) return;
    tone(1750, 0, 0.025, 'square', v);
  }

  /* ---------------- timer ---------------- */
  const totalFor = (mode) => S.settings[mode] * 60000;

  function fmt(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function start() {
    if (S.timer.running) return;
    if (S.timer.remaining <= 0) S.timer.remaining = totalFor(S.timer.mode);
    S.timer.running = true;
    S.timer.endAt = Date.now() + S.timer.remaining;
    lastTick = Date.now();
    ctx();
    maybeAskNotify();
    renderTimer();
    save(true);
  }

  function pause() {
    if (!S.timer.running) return;
    S.timer.remaining = Math.max(0, S.timer.endAt - Date.now());
    S.timer.running = false;
    S.timer.endAt = null;
    renderTimer();
    save(true);
  }

  function reset() {
    S.timer.running = false;
    S.timer.endAt = null;
    S.timer.remaining = totalFor(S.timer.mode);
    renderTimer();
    save(true);
    toast('已重置');
  }

  function switchMode(mode, opts) {
    if (!MODES[mode]) return;
    if (mode === S.timer.mode && !(opts && opts.force)) return;
    S.timer.mode = mode;
    S.timer.running = false;
    S.timer.endAt = null;
    S.timer.remaining = totalFor(mode);
    renderTimer();
    if (!(opts && opts.silent)) save(true);
  }

  function requestMode(mode) {
    if (S.timer.running && mode !== S.timer.mode) {
      if (!confirm('正在计时，切换模式会中断当前进度。继续？')) return;
    }
    switchMode(mode);
  }

  function advance(completed) {
    const t = S.timer;
    t.running = false;
    t.endAt = null;
    let next;
    if (t.mode === 'focus') {
      if (completed) {
        const day = todayStat();
        day.pomos += 1;
        if (activeTaskId) {
          const task = S.tasks.find((x) => x.id === activeTaskId);
          if (task) {
            task.doneCount = (task.doneCount || 0) + 1;
            if (!task.completed && task.doneCount >= task.est) {
              task.completed = true;
              toast('任务完成：' + task.title);
              activeTaskId = null;
            }
          }
        }
        t.cycle += 1;
        const interval = S.settings.interval;
        next = t.cycle % interval === 0 ? 'long' : 'short';
        playAlarm();
        notifyEnd(next);
      } else {
        next = 'short';
      }
    } else {
      next = 'focus';
      if (completed) {
        playAlarm();
        notifyEnd(next);
      }
    }
    t.mode = next;
    t.remaining = totalFor(next);
    renderTimer();
    renderTasks();
    renderStats();
    if (reportOpen()) renderReport();
    save(true);

    if (completed) {
      const auto = next === 'focus' ? S.settings.autoFocus : S.settings.autoBreaks;
      if (auto) setTimeout(start, 700);
    }
  }

  function tick() {
    const t = S.timer;
    if (!t.running || !t.endAt) return;
    const now = Date.now();
    const before = t.remaining;
    const delta = Math.max(0, Math.min(now - lastTick, before));
    if (t.mode === 'focus' && delta > 0) {
      const day = todayStat();
      day.focus += delta / 1000;
      if (activeTaskId) {
        day.tasks[activeTaskId] = (day.tasks[activeTaskId] || 0) + delta / 1000;
      }
      if (Math.floor(before / 1000) !== Math.floor((before - delta) / 1000)) playTick();
    }
    lastTick = now;
    const rem = t.endAt - now;
    if (rem <= 0) {
      t.remaining = 0;
      renderTimer();
      advance(true);
    } else {
      t.remaining = rem;
      renderTimer();
      renderStats();
      if (now - lastSave > 5000) save();
    }
  }

  /* ---------------- notifications ---------------- */
  const Notify = {
    supported: typeof window !== 'undefined' && 'Notification' in window,
    reg: null,
    permission() {
      return this.supported ? Notification.permission : 'unsupported';
    },
    async init() {
      if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
      try {
        this.reg = await navigator.serviceWorker.register('sw.js');
      } catch (err) {
        this.reg = null; // file:// 或不支持时静默降级为 new Notification
      }
    },
    async request() {
      if (!this.supported) return 'unsupported';
      if (Notification.permission !== 'default') return Notification.permission;
      try {
        return await Notification.requestPermission();
      } catch (err) {
        return 'denied';
      }
    },
    async show(title, body) {
      if (this.permission() !== 'granted') return false;
      const opts = {
        body: body,
        tag: 'pomodoro-timer',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        silent: true,
        lang: 'zh-CN'
      };
      try {
        const reg = this.reg ||
          (('serviceWorker' in navigator) ? await navigator.serviceWorker.getRegistration() : null);
        if (reg && reg.showNotification) {
          await reg.showNotification(title, opts);
          return true;
        }
      } catch (err) { /* 回退到普通 Notification */ }
      try {
        new Notification(title, opts);
        return true;
      } catch (err) {
        return false;
      }
    }
  };

  function notifyEnd(next) {
    if (!S.settings.notify || Notify.permission() !== 'granted') return;
    const isBreak = next === 'short' || next === 'long';
    if (isBreak) {
      const mins = S.settings[next];
      Notify.show(
        '这一轮专注完成了',
        (next === 'long' ? '长休息 ' : '短休息 ') + mins + ' 分钟 · 起来走动一下，看看远处。'
      );
    } else {
      Notify.show('休息结束', '准备好就回来，开始下一个番茄。');
    }
  }

  // 首次开始专注时顺便申请权限（有用户手势，成功率最高）
  function maybeAskNotify() {
    if (!S.settings.notify || S.settings.notifyAsked) return;
    if (Notify.permission() !== 'default') return;
    S.settings.notifyAsked = true;
    save(true);
    Notify.request().then((result) => {
      renderNotifyState();
      if (result === 'granted') toast('通知已开启，结束时提醒你');
    });
  }

  /* ---------------- rendering: timer ---------------- */
  const el = {
    card: $('#timerCard'),
    digits: $('#digits'),
    bar: $('#bar'),
    note: $('#stageNote'),
    dots: $('#cycleDots'),
    startBtn: $('#startBtn'),
    startLabel: $('#startLabel'),
    glider: $('#modeGlider'),
    modesWrap: $('.modes'),
    activeBar: $('#activeTaskBar'),
    activeTitle: $('#activeTaskTitle'),
    statFocus: $('#statFocus'),
    statPomos: $('#statPomos'),
    statStreak: $('#statStreak'),
    navPomos: $('#navPomos'),
    list: $('#taskList'),
    empty: $('#emptyState'),
    meta: $('#tasksMeta')
  };

  function renderTimer() {
    const t = S.timer;
    const str = fmt(t.remaining);
    const parts = str.split(':');
    el.digits.innerHTML = parts[0] + '<span class="colon">:</span>' + parts[1];

    const total = totalFor(t.mode);
    const ratio = total > 0 ? clamp(1 - t.remaining / total, 0, 1) : 0;
    el.bar.style.width = (ratio * 100).toFixed(2) + '%';

    el.card.classList.toggle('is-running', t.running);
    el.card.classList.toggle('is-break', t.mode !== 'focus');

    const isFresh = Math.abs(t.remaining - total) < 800;
    if (t.running) el.startLabel.textContent = '暂停';
    else if (!isFresh) el.startLabel.textContent = '继续';
    else el.startLabel.textContent = t.mode === 'focus' ? '开始专注' : '开始休息';

    $$('.mode').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.mode === t.mode);
      b.setAttribute('aria-selected', b.dataset.mode === t.mode ? 'true' : 'false');
    });
    positionGlider();

    // cycle dots
    const interval = S.settings.interval;
    let done = t.cycle % interval;
    if (t.mode === 'long' && done === 0 && t.cycle > 0) done = interval;
    let html = '';
    for (let i = 0; i < interval; i++) {
      let cls = '';
      if (i < done) cls = 'done';
      else if (i === done && t.mode === 'focus') cls = 'now';
      html += '<i class="' + cls + '"></i>';
    }
    el.dots.innerHTML = html;

    if (t.mode === 'focus') {
      el.note.textContent = '第 ' + (done + 1) + ' 个番茄 · 共 ' + interval + ' 个';
    } else {
      el.note.textContent = '已完成 ' + done + ' / ' + interval + ' 个番茄';
    }

    const label = t.running ? fmt(t.remaining) + ' · ' + MODES[t.mode] : 'Pomodoro Timer · 番茄钟';
    if (document.title !== label) document.title = label;

    // active task
    const task = S.tasks.find((x) => x.id === activeTaskId);
    if (task && !task.completed) {
      el.activeBar.hidden = false;
      el.activeTitle.textContent = task.title;
      $('#activeLabel').textContent = t.mode === 'focus' ? '正在专注' : '下一轮';
    } else {
      el.activeBar.hidden = true;
      if (!task) activeTaskId = null;
    }
  }

  function positionGlider() {
    const active = $('.mode.is-active');
    if (!active || !el.glider) return;
    const wrapRect = el.modesWrap.getBoundingClientRect();
    const rect = active.getBoundingClientRect();
    el.glider.style.width = rect.width + 'px';
    el.glider.style.transform = 'translateX(' + (rect.left - wrapRect.left) + 'px)';
  }

  function renderStats() {
    const day = todayStat();
    const mins = Math.round(day.focus / 60);
    el.statFocus.innerHTML = mins + '<em>分钟</em>';
    el.statPomos.innerHTML = day.pomos + '<em>个</em>';
    el.statStreak.innerHTML = streak() + '<em>天</em>';
    el.navPomos.textContent = day.pomos;
  }

  function streak() {
    let count = 0;
    const d = new Date();
    if (!S.stats[dateKey(d)] || !S.stats[dateKey(d)].pomos) d.setDate(d.getDate() - 1);
    for (let i = 0; i < 400; i++) {
      const rec = S.stats[dateKey(d)];
      if (rec && rec.pomos > 0) {
        count++;
        d.setDate(d.getDate() - 1);
      } else break;
    }
    return count;
  }

  /* ---------------- rendering: tasks ---------------- */
  function taskChecked(id) {
    const t = S.tasks.find((x) => x.id === id);
    if (!t) return;
    t.completed = !t.completed;
    if (t.completed && activeTaskId === id) activeTaskId = null;
    renderTasks();
    renderTimer();
    save(true);
  }

  function renderTasks() {
    const tasks = S.tasks;
    el.list.innerHTML = tasks.map(function (t) {
      const done = t.doneCount || 0;
      const sub = done + '/' + t.est + ' 番茄';
      return '' +
        '<li class="task' + (t.completed ? ' is-done' : '') + (t.id === activeTaskId ? ' is-active' : '') + '" data-id="' + t.id + '" draggable="true">' +
          '<span class="grip" aria-hidden="true">⋮⋮</span>' +
          '<button class="check" data-act="check" aria-label="完成">' +
            '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<div class="task-main" data-act="select">' +
            '<span class="task-title" data-act="edit">' + escapeHtml(t.title) + '</span>' +
            '<span class="task-sub">' + sub + (t.id === activeTaskId ? ' · 进行中' : '') + '</span>' +
          '</div>' +
          '<div class="task-actions">' +
            '<button class="t-act" data-act="minus" title="减少预计番茄" aria-label="减少预计番茄">−</button>' +
            '<button class="t-act" data-act="plus" title="增加预计番茄" aria-label="增加预计番茄">+</button>' +
            '<button class="t-act del" data-act="del" title="删除" aria-label="删除">' +
              '<svg viewBox="0 0 24 24" fill="none"><path d="M6 7h12M9.5 7V5.2h5V7M7.5 7l.7 12h7.6l.7-12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</button>' +
          '</div>' +
        '</li>';
    }).join('');

    const doneCount = tasks.filter((t) => t.completed).length;
    el.meta.textContent = doneCount + ' / ' + tasks.length + ' 完成';
    el.empty.hidden = tasks.length > 0;
  }

  function addTask(title, est) {
    const clean = String(title || '').trim();
    if (!clean) return;
    S.tasks.unshift({
      id: uid(),
      title: clean.slice(0, 120),
      est: clamp(est || 1, 1, 20),
      doneCount: 0,
      completed: false,
      createdAt: Date.now()
    });
    if (!activeTaskId) activeTaskId = S.tasks[0].id;
    renderTasks();
    renderTimer();
    save(true);
  }

  /* ---------------- rendering: report ---------------- */
  function reportOpen() {
    return !$('#reportSheet').hidden;
  }

  let reportRange = 'week'; // week | month | all

  function parseDay(key) {
    return new Date(key + 'T00:00:00');
  }

  function rangeKeys(range) {
    const today = new Date();
    const keys = [];
    if (range === 'all') {
      const all = Object.keys(S.stats)
        .filter((k) => S.stats[k] && ((S.stats[k].focus || 0) > 0 || (S.stats[k].pomos || 0) > 0))
        .sort();
      if (!all.length) return keys;
      const first = parseDay(all[0]);
      const cursor = new Date(first.getFullYear(), first.getMonth(), first.getDate());
      const stop = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      while (cursor <= stop && keys.length < 1100) {
        keys.push(dateKey(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
    } else {
      const n = range === 'week' ? 7 : 30;
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        keys.push(dateKey(d));
      }
    }
    return keys;
  }

  function totalsFor(keys) {
    let focus = 0;
    let pomos = 0;
    let activeDays = 0;
    const byTask = {};
    keys.forEach((k) => {
      const rec = S.stats[k];
      if (!rec) return;
      focus += rec.focus || 0;
      pomos += rec.pomos || 0;
      if ((rec.focus || 0) > 0) activeDays++;
      Object.keys(rec.tasks || {}).forEach((id) => {
        byTask[id] = (byTask[id] || 0) + rec.tasks[id];
      });
    });
    return { focus: focus, pomos: pomos, activeDays: activeDays, byTask: byTask };
  }

  function fmtDur(seconds) {
    const m = Math.round(seconds / 60);
    if (m < 60) return m + ' 分钟';
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? h + ' 小时 ' + rest + ' 分' : h + ' 小时';
  }

  // 概览卡：>=60 分钟改用小时，避免出现 480 分钟这种难读的数
  function setBig(sel, minutes, emptyText) {
    const node = $(sel);
    if (emptyText != null) {
      node.textContent = emptyText;
      return;
    }
    if (minutes >= 60) {
      const h = minutes / 60;
      node.innerHTML = (h % 1 === 0 ? h : h.toFixed(1)) + '<em>小时</em>';
    } else {
      node.innerHTML = minutes + '<em>分钟</em>';
    }
  }

  function whenLabel(key) {
    if (key === dateKey(new Date())) return '今天';
    const d = parseDay(key);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function monthItems() {
    const bucket = {};
    Object.keys(S.stats).forEach((k) => {
      const rec = S.stats[k];
      if (!rec) return;
      const m = k.slice(0, 7);
      if (!bucket[m]) bucket[m] = { mins: 0 };
      bucket[m].mins += Math.round((rec.focus || 0) / 60);
    });
    return Object.keys(bucket).sort().slice(-12).map((m) => ({
      label: Number(m.slice(5)) + '月',
      mins: bucket[m].mins,
      isToday: false,
      title: m + ' · ' + bucket[m].mins + ' 分钟'
    }));
  }

  function renderChart(items, dense) {
    const chart = $('#chart');
    chart.classList.toggle('is-dense', !!dense);
    if (!items.length) {
      chart.innerHTML = '<p class="chart-empty">还没有专注记录。完成第一个番茄后，这里会开始积累。</p>';
      return;
    }
    const max = Math.max(30, ...items.map((x) => x.mins));
    chart.innerHTML = items.map(function (x) {
      const h = Math.round((x.mins / max) * 100);
      return '' +
        '<div class="chart-col' + (x.isToday ? ' is-today' : '') + '" title="' + (x.title || '') + '">' +
          '<span class="chart-val">' + x.mins + '</span>' +
          '<div class="chart-bar-wrap">' +
            (x.mins > 0
              ? '<div class="chart-bar has-val" style="height:' + Math.max(4, h) + '%"></div>'
              : '<div class="chart-bar is-zero"></div>') +
          '</div>' +
          '<span class="chart-day">' + (x.label || '') + '</span>' +
        '</div>';
    }).join('');
  }

  function renderReport() {
    const range = reportRange;
    const keys = rangeKeys(range);
    const totals = totalsFor(keys);
    const totalMin = Math.round(totals.focus / 60);
    const day = todayStat();
    const todayMins = Math.round((day.focus || 0) / 60);
    const todayKey = dateKey(new Date());

    $$('#rangeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.range === range));

    let rangeText;
    if (range === 'week') rangeText = '近 7 天';
    else if (range === 'month') rangeText = '近 30 天';
    else if (keys.length) rangeText = whenLabel(keys[0]) + ' 起 · ' + keys.length + ' 天';
    else rangeText = '暂无记录';
    $('#repRangeLabel').textContent = rangeText;

    // 概览
    setBig('#repFocus', totalMin);
    $('#repPomos').textContent = '共 ' + totals.pomos + ' 个番茄';
    const avg = totals.activeDays ? Math.round(totalMin / totals.activeDays) : 0;
    if (totals.activeDays) {
      $('#repAvg').innerHTML = avg + '<em>分钟</em>';
    } else {
      $('#repAvg').textContent = '—';
    }
    $('#repDays').textContent = totals.activeDays + ' 天有记录';

    let best = null;
    keys.forEach((k) => {
      const rec = S.stats[k];
      const m = rec ? Math.round((rec.focus || 0) / 60) : 0;
      if (!best || m > best.mins) best = { key: k, mins: m };
    });
    if (best && best.mins > 0) {
      setBig('#repBestDay', best.mins);
      $('#repBestWhen').textContent = whenLabel(best.key);
    } else {
      setBig('#repBestDay', 0, '—');
      $('#repBestWhen').textContent = '还没有记录';
    }

    $('#repStreak').innerHTML = streak() + '<em>天</em>';
    $('#repStreakNote').textContent = (day.pomos || 0) > 0
      ? '今天完成 ' + day.pomos + ' 个番茄'
      : '今天还没开始';

    // 图表：跨度很长时按月聚合，否则按天
    let items;
    let dense = false;
    if (range === 'all' && keys.length > 75) {
      items = monthItems();
      $('#repChartTitle').textContent = '每月专注时长';
      dense = items.length > 8;
    } else {
      items = keys.map((k, idx) => {
        let label;
        if (k === todayKey) label = '今天';
        else if (range === 'week') label = ['日', '一', '二', '三', '四', '五', '六'][parseDay(k).getDay()];
        else label = idx === keys.length - 1 || idx % 5 === 0
          ? (parseDay(k).getMonth() + 1) + '/' + parseDay(k).getDate()
          : '';
        const rec = S.stats[k];
        const mins = rec ? Math.round((rec.focus || 0) / 60) : 0;
        return { label: label, mins: mins, isToday: k === todayKey, title: k + ' · ' + mins + ' 分钟' };
      });
      $('#repChartTitle').textContent = '每日专注时长';
      dense = items.length > 7;
    }
    renderChart(items, dense);
    $('#repChartTotal').textContent = '合计 ' + fmtDur(totals.focus);

    // 任务分布（区间累计）
    const entries = Object.keys(totals.byTask)
      .map((id) => {
        const task = S.tasks.find((x) => x.id === id);
        return { name: task ? task.title : '已删除的任务', mins: Math.round(totals.byTask[id] / 60) };
      })
      .filter((x) => x.mins > 0)
      .sort((a, b) => b.mins - a.mins)
      .slice(0, 6);

    const taskSum = entries.reduce((sum, x) => sum + x.mins, 0);
    $('#repTaskTotal').textContent = taskSum ? '合计 ' + fmtDur(taskSum * 60) : '暂无记录';
    const dist = $('#dist');
    if (!entries.length) {
      dist.innerHTML = '<li class="dist-empty">还没有记录。开始第一个番茄后，这里会显示时间花在了哪里。</li>';
    } else {
      const peak = entries[0].mins;
      dist.innerHTML = entries.map(function (x) {
        const w = Math.max(2, Math.round((x.mins / peak) * 100));
        return '<li>' +
          '<div class="dist-top"><span class="dist-name">' + escapeHtml(x.name) + '</span><span class="dist-val">' + fmtDur(x.mins * 60) + '</span></div>' +
          '<div class="dist-track"><span class="dist-fill" style="width:' + w + '%"></span></div>' +
        '</li>';
      }).join('');
    }

    // 观察
    $('#repBest').textContent = best && best.mins > 0
      ? whenLabel(best.key) + ' · ' + best.mins + ' 分钟'
      : '—';
    $('#repAvgActive').textContent = totals.activeDays ? Math.round(totalMin / totals.activeDays) + ' 分钟' : '—';

    let tip;
    if (!totals.activeDays) {
      tip = '先完成一个番茄。这里会慢慢长成你专注过的证据。';
    } else if (todayMins === 0) {
      tip = '今天还没有开始。一个 25 分钟的番茄，通常就够把状态找回来。';
    } else if (best && todayMins >= best.mins) {
      tip = '今天是这段时间里状态最好的一天。收工时记得把这份节奏留个记号。';
    } else if (avg && todayMins < avg) {
      tip = '今天比日均少 ' + (avg - todayMins) + ' 分钟，再补一个番茄就能追平。';
    } else {
      tip = '稳定比爆发更值钱。休息的时候，真的离开一下屏幕。';
    }
    $('#repTip').textContent = tip;
  }

  /* ---------------- export ---------------- */
  function download(text, filename, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function exportCsv() {
    const rows = [['日期', '专注分钟', '番茄数', '任务数']];
    Object.keys(S.stats).sort().forEach((k) => {
      const rec = S.stats[k];
      if (!rec) return;
      rows.push([k, Math.round((rec.focus || 0) / 60), rec.pomos || 0, Object.keys(rec.tasks || {}).length]);
    });
    if (rows.length === 1) {
      toast('还没有数据可以导出');
      return;
    }
    const csv = '\ufeff' + rows.map((r) => r.join(',')).join('\r\n');
    download(csv, 'pomodoro-report-' + dateKey(new Date()) + '.csv', 'text/csv');
    toast('报表已导出');
  }

  /* ---------------- rendering: settings ---------------- */
  function applyTheme() {
    document.documentElement.dataset.theme = S.settings.theme;
    document.documentElement.dataset.accent = S.settings.accent;
  }

  function renderSettings() {
    const s = S.settings;
    $('#vFocus').textContent = s.focus;
    $('#vShort').textContent = s.short;
    $('#vLong').textContent = s.long;
    $('#vInterval').textContent = s.interval;
    $('#autoBreaks').checked = s.autoBreaks;
    $('#autoFocus').checked = s.autoFocus;
    $('#ticking').checked = s.ticking;
    $('#notify').checked = s.notify;
    $('#volume').value = s.volume;
    $('#volVal').textContent = s.volume;

    $$('#soundSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.sound === s.sound));
    $$('#themeSeg button').forEach((b) => b.classList.toggle('is-active', b.dataset.themeOpt === s.theme));
    $$('#swatches .sw').forEach((b) => b.classList.toggle('is-active', b.dataset.accentOpt === s.accent));

    const soundBtn = $('#soundBtn');
    soundBtn.classList.toggle('is-muted', s.sound === 'none' || s.volume === 0);

    renderNotifyState();
    renderDataNote();
  }

  function renderNotifyState() {
    const state = $('#notifyState');
    const btn = $('#notifyAsk');
    if (!state || !btn) return;
    const p = Notify.permission();
    btn.classList.remove('is-on');
    if (p === 'granted') {
      state.textContent = '已允许，结束时会在系统里提醒';
      btn.textContent = '已开启';
      btn.disabled = true;
      btn.classList.add('is-on');
    } else if (p === 'denied') {
      state.textContent = '已被浏览器拒绝，可在地址栏的站点设置里改回允许';
      btn.textContent = '已拒绝';
      btn.disabled = true;
    } else if (p === 'unsupported') {
      state.textContent = '当前浏览器不支持系统通知';
      btn.textContent = '不支持';
      btn.disabled = true;
    } else {
      state.textContent = '还没有授权，点右侧按钮开启';
      btn.textContent = '允许';
      btn.disabled = false;
    }
  }

  function storageSize() {
    try {
      const raw = localStorage.getItem(KEY) || '';
      return raw ? new Blob([raw]).size : 0;
    } catch (err) {
      return 0;
    }
  }

  function renderDataNote() {
    const bytes = storageSize();
    const size = bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B';
    $('#dataNote').textContent = '任务、设置与统计都保存在本机浏览器里，当前占用 ' + size + '。';
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  /* ---------------- sheets ---------------- */
  function openSheet(id) {
    const sheet = $('#' + id);
    sheet.hidden = false;
    if (id === 'reportSheet') renderReport();
    if (id === 'settingsSheet') renderSettings();
    document.body.style.overflow = 'hidden';
  }
  function closeSheets() {
    $$('.sheet-wrap').forEach((s) => (s.hidden = true));
    document.body.style.overflow = '';
  }

  /* ---------------- events ---------------- */
  function bind() {
    el.startBtn.addEventListener('click', () => (S.timer.running ? pause() : start()));
    $('#resetBtn').addEventListener('click', reset);
    $('#skipBtn').addEventListener('click', () => {
      advance(false);
      toast('已跳过');
    });
    $('#soundBtn').addEventListener('click', () => {
      S.settings.sound = S.settings.sound === 'none' ? 'chime' : 'none';
      renderSettings();
      save(true);
      toast(S.settings.sound === 'none' ? '已静音' : '声音已开启');
    });

    $$('.mode').forEach((b) => {
      b.addEventListener('click', () => requestMode(b.dataset.mode));
    });

    $('#clearActive').addEventListener('click', () => {
      activeTaskId = null;
      renderTasks();
      renderTimer();
      save(true);
    });

    // add form
    const form = $('#addForm');
    const input = $('#taskInput');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!input.value.trim()) { input.focus(); return; }
      addTask(input.value, addEst);
      input.value = '';
      addEst = 1;
      $('#estVal').textContent = '1';
      input.focus();
    });
    $$('[data-est]').forEach((b) => {
      b.addEventListener('click', () => {
        addEst = clamp(addEst + Number(b.dataset.est), 1, 20);
        $('#estVal').textContent = addEst;
      });
    });

    // task list delegation
    el.list.addEventListener('click', (e) => {
      const li = e.target.closest('.task');
      if (!li) return;
      const id = li.dataset.id;
      const actEl = e.target.closest('[data-act]');
      const act = actEl ? actEl.dataset.act : null;

      if (act === 'check') { taskChecked(id); return; }
      if (act === 'del') {
        S.tasks = S.tasks.filter((t) => t.id !== id);
        if (activeTaskId === id) activeTaskId = null;
        renderTasks();
        renderTimer();
        save(true);
        return;
      }
      if (act === 'plus' || act === 'minus') {
        const t = S.tasks.find((x) => x.id === id);
        if (!t) return;
        t.est = clamp(t.est + (act === 'plus' ? 1 : -1), 1, 20);
        renderTasks();
        save(true);
        return;
      }
      if (act === 'edit') { startEdit(li); return; }
      if (act === 'select') {
        const t = S.tasks.find((x) => x.id === id);
        if (!t || t.completed) return;
        activeTaskId = activeTaskId === id ? null : id;
        renderTasks();
        renderTimer();
        save(true);
      }
    });

    el.list.addEventListener('dblclick', (e) => {
      const li = e.target.closest('.task');
      if (li) startEdit(li);
    });

    // drag reorder
    let dragId = null;
    el.list.addEventListener('dragstart', (e) => {
      const li = e.target.closest('.task');
      if (!li) return;
      dragId = li.dataset.id;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', dragId); } catch (err) { /* ignore */ }
    });
    el.list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = el.list.querySelector('.dragging');
      if (!dragging) return;
      const after = afterElement(el.list, e.clientY);
      if (after == null) el.list.appendChild(dragging);
      else el.list.insertBefore(dragging, after);
    });
    el.list.addEventListener('dragend', () => {
      const li = el.list.querySelector('.dragging');
      if (li) li.classList.remove('dragging');
      const order = $$('.task', el.list).map((x) => x.dataset.id);
      S.tasks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      dragId = null;
      save(true);
    });

    $('#clearDone').addEventListener('click', () => {
      const before = S.tasks.length;
      S.tasks = S.tasks.filter((t) => !t.completed);
      if (before === S.tasks.length) { toast('没有已完成的任务'); return; }
      if (activeTaskId && !S.tasks.find((t) => t.id === activeTaskId)) activeTaskId = null;
      renderTasks();
      renderTimer();
      save(true);
      toast('已清空完成项');
    });
    $('#clearAll').addEventListener('click', () => {
      if (!S.tasks.length) return;
      if (!confirm('清空全部任务？（统计数据会保留）')) return;
      S.tasks = [];
      activeTaskId = null;
      renderTasks();
      renderTimer();
      save(true);
    });

    // sheets
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.open === 'report' ? 'reportSheet' : 'settingsSheet')));
    $$('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));

    $('#themeToggle').addEventListener('click', () => {
      S.settings.theme = S.settings.theme === 'paper' ? 'ink' : 'paper';
      applyTheme();
      renderSettings();
      save(true);
    });

    // settings inputs
    $$('[data-adjust]').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.dataset.adjust;
        const delta = Number(b.dataset.delta);
        if (key === 'interval') {
          S.settings.interval = clamp(S.settings.interval + delta, 2, 8);
        } else {
          const limits = { focus: [5, 120], short: [1, 30], long: [5, 60] };
          const lim = limits[key] || [1, 120];
          S.settings[key] = clamp(S.settings[key] + delta, lim[0], lim[1]);
          if (S.timer.mode === key && !S.timer.running) {
            S.timer.remaining = totalFor(key);
          }
        }
        renderSettings();
        renderTimer();
        save(true);
      });
    });

    $('#autoBreaks').addEventListener('change', (e) => { S.settings.autoBreaks = e.target.checked; save(true); });
    $('#autoFocus').addEventListener('change', (e) => { S.settings.autoFocus = e.target.checked; save(true); });
    $('#ticking').addEventListener('change', (e) => { S.settings.ticking = e.target.checked; save(true); if (e.target.checked) playTick(); });
    $('#notify').addEventListener('change', async (e) => {
      S.settings.notify = e.target.checked;
      save(true);
      if (e.target.checked) {
        if (Notify.permission() === 'default') {
          const result = await Notify.request();
          renderNotifyState();
          if (result === 'granted') {
            toast('通知已开启');
            Notify.show('通知已开启', '专注或休息结束时，我会提醒你。');
          } else if (result === 'denied') {
            S.settings.notify = false;
            renderSettings();
            save(true);
            toast('通知被拒绝，可在站点设置中修改');
          }
        } else if (Notify.permission() !== 'granted') {
          toast('需要先允许浏览器通知');
        }
      }
    });

    $('#notifyAsk').addEventListener('click', async () => {
      const result = await Notify.request();
      renderNotifyState();
      if (result === 'granted') {
        S.settings.notify = true;
        renderSettings();
        save(true);
        Notify.show('通知已开启', '专注或休息结束时，我会提醒你。');
        toast('通知已开启');
      } else if (result === 'denied') {
        toast('通知被拒绝，可在浏览器站点设置里改回允许');
      } else {
        toast('没有获得通知权限');
      }
    });

    $('#testNotify').addEventListener('click', async () => {
      if (Notify.permission() !== 'granted') {
        const result = await Notify.request();
        renderNotifyState();
        if (result !== 'granted') {
          toast('请先允许通知');
          return;
        }
      }
      const ok = await Notify.show('Pomodoro Timer', '这是一条测试通知，说明提醒已经可以正常工作。');
      toast(ok ? '测试通知已发送' : '发送失败，请检查浏览器权限');
    });

    // 统计区间
    $$('#rangeSeg button').forEach((b) => {
      b.addEventListener('click', () => {
        reportRange = b.dataset.range;
        S.settings.reportRange = reportRange;
        save(true);
        renderReport();
      });
    });
    $('#exportCsv').addEventListener('click', exportCsv);

    // 备份与恢复
    $('#exportData').addEventListener('click', () => {
      const payload = {
        app: 'pomodoro-timer',
        version: 1,
        exportedAt: new Date().toISOString(),
        data: { settings: S.settings, tasks: S.tasks, stats: S.stats, timer: S.timer, activeTaskId: activeTaskId }
      };
      download(JSON.stringify(payload, null, 2), 'pomodoro-backup-' + dateKey(new Date()) + '.json', 'application/json');
      toast('备份已导出');
    });

    $('#importData').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        let parsed;
        try {
          parsed = JSON.parse(String(reader.result));
        } catch (err) {
          toast('导入失败：不是有效的 JSON 文件');
          return;
        }
        const d = parsed && parsed.data ? parsed.data : parsed;
        if (!d || typeof d !== 'object' || (!d.settings && !Array.isArray(d.tasks) && !d.stats)) {
          toast('导入失败：文件里没有可识别的数据');
          return;
        }
        if (!confirm('导入会覆盖当前的任务、设置与统计，确定继续？')) return;

        S.settings = Object.assign({}, DEFAULT_SETTINGS, d.settings || {});
        S.tasks = Array.isArray(d.tasks)
          ? d.tasks.filter((t) => t && t.id).map((t) => ({
              id: t.id,
              title: String(t.title || '').slice(0, 120),
              est: clamp(Number(t.est) || 1, 1, 20),
              doneCount: Math.max(0, Number(t.doneCount) || 0),
              completed: !!t.completed,
              createdAt: Number(t.createdAt) || Date.now()
            }))
          : [];
        S.stats = d.stats && typeof d.stats === 'object' ? d.stats : {};
        S.timer = {
          mode: MODES[d.timer && d.timer.mode] ? d.timer.mode : 'focus',
          remaining: totalFor(MODES[d.timer && d.timer.mode] ? d.timer.mode : 'focus'),
          running: false,
          endAt: null,
          cycle: Math.max(0, Number(d.timer && d.timer.cycle) || 0)
        };
        activeTaskId = d.activeTaskId && S.tasks.some((t) => t.id === d.activeTaskId) ? d.activeTaskId : null;

        if (!THEMES.includes(S.settings.theme)) S.settings.theme = 'paper';
        if (!ACCENTS.includes(S.settings.accent)) S.settings.accent = 'vermilion';
        if (!RANGES.includes(S.settings.reportRange)) S.settings.reportRange = 'week';
        reportRange = S.settings.reportRange;
        applyTheme();
        renderAll();
        save(true);
        toast('备份已导入');
      };
      reader.onerror = () => toast('读取文件失败');
      reader.readAsText(file);
    });

    $$('#soundSeg button').forEach((b) => {
      b.addEventListener('click', () => {
        S.settings.sound = b.dataset.sound;
        renderSettings();
        save(true);
        if (S.settings.sound !== 'none') playAlarm(S.settings.sound);
      });
    });
    $('#volume').addEventListener('input', (e) => {
      S.settings.volume = Number(e.target.value);
      $('#volVal').textContent = S.settings.volume;
      renderSettings();
      save();
    });
    $('#volume').addEventListener('change', () => save(true));
    $('#testSound').addEventListener('click', () => playAlarm());

    $$('#themeSeg button').forEach((b) => {
      b.addEventListener('click', () => {
        S.settings.theme = b.dataset.themeOpt;
        applyTheme();
        renderSettings();
        save(true);
      });
    });
    $$('#swatches .sw').forEach((b) => {
      b.addEventListener('click', () => {
        S.settings.accent = b.dataset.accentOpt;
        applyTheme();
        renderSettings();
        save(true);
      });
    });

    $('#resetData').addEventListener('click', () => {
      if (!confirm('这会删除所有任务和统计记录，无法恢复。确定？')) return;
      localStorage.removeItem(KEY);
      S.tasks = [];
      S.stats = {};
      S.timer = { mode: 'focus', remaining: DEFAULT_SETTINGS.focus * 60000, running: false, endAt: null, cycle: 0 };
      S.settings = Object.assign({}, DEFAULT_SETTINGS);
      activeTaskId = null;
      reportRange = 'week';
      applyTheme();
      renderAll();
      toast('已清除全部数据');
    });

    // keyboard
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === 'Space') {
        // 焦点在按钮上时交给浏览器原生激活，避免重复触发
        if (e.target.closest && e.target.closest('button')) return;
        e.preventDefault();
        S.timer.running ? pause() : start();
      } else if (e.key === 'r' || e.key === 'R') {
        reset();
      } else if (e.key === 's' || e.key === 'S') {
        advance(false);
        toast('已跳过');
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        $('#taskInput').focus();
      } else if (e.key === '1') {
        requestMode('focus');
      } else if (e.key === '2') {
        requestMode('short');
      } else if (e.key === '3') {
        requestMode('long');
      } else if (e.key === 'Escape') {
        closeSheets();
      }
    });

    window.addEventListener('resize', positionGlider);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        lastTick = Date.now();
        tick();
        save(true);
        renderNotifyState();
      }
    });
    window.addEventListener('beforeunload', () => save(true));
    window.addEventListener('pagehide', () => save(true));

    // 多标签页同步：另一个标签页写入后，这里跟着更新
    window.addEventListener('storage', (e) => {
      if (e.key !== KEY || !e.newValue) return;
      const wasRunning = S.timer.running;
      const localTimer = Object.assign({}, S.timer);
      if (!load()) return;
      if (wasRunning) S.timer = localTimer;
      applyTheme();
      renderAll();
      if (reportOpen()) renderReport();
      toast('已同步另一个标签页的改动');
    });
  }

  function renderAll() {
    renderTimer();
    renderTasks();
    renderStats();
    renderSettings();
  }

  function afterElement(container, y) {
    const items = $$('.task:not(.dragging)', container);
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    items.forEach((child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) closest = { offset: offset, element: child };
    });
    return closest.element;
  }

  function startEdit(li) {
    const id = li.dataset.id;
    const task = S.tasks.find((t) => t.id === id);
    if (!task) return;
    const titleEl = $('.task-title', li);
    if (!titleEl || $('.task-edit', li)) return;
    const input = document.createElement('input');
    input.className = 'task-edit';
    input.value = task.title;
    input.maxLength = 120;
    titleEl.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    let finished = false;
    const commit = (keep) => {
      if (finished) return;
      finished = true;
      if (keep) {
        const v = input.value.trim();
        if (v) task.title = v.slice(0, 120);
      }
      renderTasks();
      renderTimer();
      save(true);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  /* ---------------- boot ---------------- */
  function seed() {
    const now = Date.now();
    S.tasks = [
      { id: uid(), title: '写下今天最重要的三件事', est: 1, doneCount: 0, completed: false, createdAt: now },
      { id: uid(), title: '处理收件箱，只做需要回复的', est: 2, doneCount: 0, completed: false, createdAt: now - 1 },
      { id: uid(), title: '读 20 页书', est: 1, doneCount: 0, completed: false, createdAt: now - 2 }
    ];
    activeTaskId = S.tasks[0].id;
  }

  function init() {
    const had = load();
    if (!had) seed();
    else if (!S.tasks.length) activeTaskId = null;

    if (!THEMES.includes(S.settings.theme)) S.settings.theme = 'paper';
    if (!ACCENTS.includes(S.settings.accent)) S.settings.accent = 'vermilion';
    if (!RANGES.includes(S.settings.reportRange)) S.settings.reportRange = 'week';
    reportRange = S.settings.reportRange;
    applyTheme();

    // restore timer
    const t = S.timer;
    if (!MODES[t.mode]) t.mode = 'focus';
    const total = totalFor(t.mode);
    if (t.running && t.endAt) {
      const rem = t.endAt - Date.now();
      if (rem > 0 && rem <= total) {
        t.remaining = rem;
      } else if (rem <= 0) {
        t.running = false;
        t.endAt = null;
        t.remaining = total;
      } else {
        t.remaining = total;
        t.running = false;
        t.endAt = null;
      }
    } else {
      t.running = false;
      t.endAt = null;
      if (!(t.remaining > 0) || t.remaining > total) t.remaining = total;
    }
    if (activeTaskId && !S.tasks.find((x) => x.id === activeTaskId)) activeTaskId = null;

    bind();
    renderAll();
    Notify.init();

    // fonts may shift pill widths
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionGlider);
    setTimeout(positionGlider, 120);

    setInterval(tick, 200);
    // roll over stats display at midnight
    setInterval(() => { renderStats(); if (reportOpen()) renderReport(); }, 60000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
