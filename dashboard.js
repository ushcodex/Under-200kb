/* Under 200KB: private analytics dashboard client. */
(function () {
  'use strict';

  var state = { range: '30', data: null, loading: false };

  function $(id) { return document.getElementById(id); }

  var el = {
    loginCard: $('loginCard'),
    loginForm: $('loginForm'),
    password: $('password'),
    loginButton: $('loginButton'),
    loginError: $('loginError'),
    dashboard: $('dashboard'),
    tabs: Array.prototype.slice.call(document.querySelectorAll('.tab')),
    refresh: $('refresh'),
    signOut: $('signOut'),
    rangeNote: $('rangeNote'),
    dashError: $('dashError'),
    kpis: $('kpis'),
    sources: $('sources'),
    devices: $('devices'),
    countries: $('countries'),
    actions: $('actions'),
    dailyChart: $('dailyChart'),
    dailyWrap: $('dailyTableWrap'),
    gscBody: $('gscBody'),
    footNote: $('footNote'),
    storageBox: $('storageBox'),
    storageBadge: $('storageBadge'),
    storageMessage: $('storageMessage'),
    receiverLine: $('receiverLine'),
    testResult: $('testResult'),
    sendTest: $('sendTest'),
    recheck: $('recheck')
  };

  var LABELS = {
    direct: 'Direct / typed',
    google: 'Google',
    bing: 'Bing',
    duckduckgo: 'DuckDuckGo',
    yahoo: 'Yahoo',
    'search-other': 'Other search',
    social: 'Social & chat',
    ushcodex: 'ushcodex.tech',
    'usman.engineer': 'usman.engineer',
    referral: 'Referral',
    mobile: 'Mobile',
    desktop: 'Desktop',
    tablet: 'Tablet',
    unknown: 'Unknown',
    'image-jpg': 'Image → JPG',
    'image-pdf': 'Image → PDF',
    'pdf-jpg': 'PDF → JPG',
    'pdf-pdf': 'PDF → PDF'
  };

  function label(name) { return LABELS[name] || name; }

  function number(value) {
    return new Intl.NumberFormat('en-GB').format(Math.round(value || 0));
  }

  function percent(value) {
    if (!isFinite(value)) return 'n/a';
    return (value * 100).toFixed(value >= 0.1 ? 0 : 1) + '%';
  }

  function showError(message) {
    if (!el.dashError) return;
    el.dashError.textContent = message;
    el.dashError.hidden = !message;
  }

  function showLogin(message) {
    el.dashboard.hidden = true;
    el.loginCard.hidden = false;
    showError('');
    if (message) {
      el.loginError.textContent = message;
      el.loginError.hidden = false;
    }
    if (el.password) el.password.focus();
  }

  function region(name) {
    try {
      if (typeof Intl.DisplayNames === 'function') {
        var display = new Intl.DisplayNames(['en'], { type: 'region' });
        return display.of(name) || name;
      }
    } catch (e) { /* ignore */ }
    return name === 'XX' ? 'Unknown' : name;
  }

  function table(title, rows, render, emptyText) {
    if (!rows || !rows.length) {
      return '<p class="empty">' + (emptyText || 'No data yet.') + '</p>';
    }
    var head = '<table class="data"><caption class="sr-only">' + title + '</caption><thead><tr><th scope="col">' +
      render.head[0] + '</th><th scope="col" class="num">' + render.head[1] + '</th></tr></thead><tbody>';
    var body = rows.map(function (row) {
      return '<tr><td>' + render.cell(row) + '</td><td class="num">' + number(row.count) + '</td></tr>';
    }).join('');
    return head + body + '</tbody></table>';
  }

  function barRows(rows, total) {
    if (!rows || !rows.length) return '<p class="empty">No data yet.</p>';
    var max = rows.reduce(function (max, row) { return Math.max(max, row.count); }, 1);
    return rows.map(function (row) {
      return '<div class="meter"><span>' + row.label + '</span>' +
        '<span class="track"><span class="fill" style="width:' + Math.max(2, Math.round((row.count / max) * 100)) + '%"></span></span>' +
        '<span class="num" style="font-family:var(--mono);min-width:3.5rem;text-align:right">' + number(row.count) + '</span></div>';
    }).join('') + (total ? '<p class="help">' + number(total) + ' recorded in this range.</p>' : '');
  }

  function renderKpis(data) {
    var totals = data.totals || {};
    var attempts = (totals.ok || 0) + (totals.fail || 0);
    var successRate = attempts ? totals.ok / attempts : 0;
    var cards = [
      { label: 'Visits', value: number(totals.visits), sub: data.range.days + ' day' + (data.range.days === 1 ? '' : 's') },
      { label: 'Unique visitors', value: number(totals.uniques), sub: 'approximate' },
      { label: 'Compressions', value: number(totals.ok), sub: percent(successRate) + ' success rate' },
      { label: 'Failures', value: number(totals.fail), sub: attempts ? 'of ' + number(attempts) + ' attempts' : 'no attempts yet' },
      { label: 'Downloads', value: number(totals.downloads), sub: 'download buttons clicked' },
      { label: 'Files chosen', value: number(totals.files), sub: 'before compressing' }
    ];
    el.kpis.innerHTML = cards.map(function (card) {
      return '<dl class="kpi"><dt>' + card.label + '</dt><dd>' + card.value + '</dd><div class="sub">' + card.sub + '</div></dl>';
    }).join('');
  }

  function renderBreakdowns(data) {
    el.sources.innerHTML = barRows((data.sources || []).map(function (row) {
      return { label: label(row.name), count: row.count };
    }), data.totals.visits);

    el.devices.innerHTML = barRows((data.devices || []).map(function (row) {
      return { label: label(row.name), count: row.count };
    }));

    el.countries.innerHTML = table('Countries', (data.countries || []).slice(0, 12), {
      head: ['Country', 'Visits'],
      cell: function (row) { return region(row.name); }
    }, 'No countries recorded yet. Countries come from the CDN edge, never from IP addresses we store.');

    var actions = [];
    (data.directions || []).forEach(function (row) {
      actions.push({ label: label(row.name), count: row.count });
    });
    if (!actions.length) actions = [];
    var targets = (data.targets || []).map(function (row) {
      return { label: 'Limit ' + row.name.replace('<=', '≤ ') + ' KB', count: row.count };
    });
    el.actions.innerHTML = barRows(actions) + (targets.length ? '<h4 style="margin:.75rem 0 .25rem;font-size:.8125rem;color:var(--ink-3)">Requested limits</h4>' + barRows(targets) : '');
  }

  function renderDaily(data) {
    var daily = data.daily || [];
    if (!daily.length) {
      el.dailyChart.innerHTML = '';
      el.dailyWrap.innerHTML = '<p class="empty">No visits recorded yet.</p>';
      return;
    }
    var max = daily.reduce(function (max, day) { return Math.max(max, day.visits); }, 1);
    el.dailyChart.innerHTML = daily.map(function (day) {
      var height = Math.round((day.visits / max) * 100);
      return '<span class="bar" style="height:' + Math.max(2, height) + '%" title="' + day.date + ': ' + day.visits + ' visits"></span>';
    }).join('');

    el.dailyWrap.innerHTML = '<table class="data"><caption>Daily totals (UTC)</caption>' +
      '<thead><tr><th scope="col">Date</th><th scope="col" class="num">Visits</th><th scope="col" class="num">Compressions</th><th scope="col" class="num">Failures</th></tr></thead><tbody>' +
      daily.slice().reverse().map(function (day) {
        return '<tr><td>' + day.date + '</td><td class="num">' + number(day.visits) + '</td><td class="num">' + number(day.ok) + '</td><td class="num">' + number(day.fail) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function renderGsc(report) {
    if (!report) {
      el.gscBody.innerHTML = '<p class="empty">Search Console data is unavailable right now.</p>';
      return;
    }
    if (!report.configured) {
      el.gscBody.innerHTML = '<p class="empty">Not configured. Add a verified property and a read-only service account to enable site-wide search reporting (<code>U200_GSC_SITE</code> and <code>U200_GSC_SERVICE_ACCOUNT_JSON</code>).</p>';
      return;
    }
    if (!report.ok) {
      el.gscBody.innerHTML = '<p class="msg msg-warn">' + (report.error || 'Search Console data could not be loaded.') + '</p>';
      return;
    }
    var totals = report.totals || {};
    var html = '<div class="kpis" style="margin-bottom:.5rem">' +
      '<dl class="kpi"><dt>Clicks</dt><dd>' + number(totals.clicks) + '</dd><div class="sub">' + report.startDate + ' → ' + report.endDate + '</div></dl>' +
      '<dl class="kpi"><dt>Impressions</dt><dd>' + number(totals.impressions) + '</dd><div class="sub">site-wide</div></dl>' +
      '<dl class="kpi"><dt>CTR</dt><dd>' + percent(totals.ctr) + '</dd><div class="sub">average</div></dl>' +
      '<dl class="kpi"><dt>Avg. position</dt><dd>' + (totals.position || 'n/a') + '</dd><div class="sub">impression-weighted</div></dl>' +
      '</div>';

    if (report.queries && report.queries.length) {
      html += '<table class="data"><caption>Top queries (aggregated, last 28 days)</caption><thead><tr><th scope="col">Query</th><th scope="col" class="num">Clicks</th><th scope="col" class="num">Impressions</th><th scope="col" class="num">Position</th></tr></thead><tbody>' +
        report.queries.map(function (row) {
          return '<tr><td>' + escapeHtml(row.query) + '</td><td class="num">' + number(row.clicks) + '</td><td class="num">' + number(row.impressions) + '</td><td class="num">' + (Math.round(row.position * 10) / 10) + '</td></tr>';
        }).join('') + '</tbody></table>';
    } else {
      html += '<p class="empty">No query data for this period yet.</p>';
    }
    el.gscBody.innerHTML = html;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function ago(iso) {
    if (!iso) return '';
    var seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 45) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return Math.round(seconds / 86400) + ' d ago';
  }

  function renderReceiver(health, options) {
    if (!el.receiverLine) return;
    var receiver = (health && health.receiver) || null;
    var container = options || {};
    if (!receiver) {
      el.receiverLine.textContent = 'Could not read the receiver status.';
      return;
    }
    if (receiver.received) {
      el.receiverLine.textContent = 'Last counter write: ' + ago(receiver.lastWriteAt) +
        (receiver.lastEvent ? ' (' + receiver.lastEvent + ')' : '') + '.';
      if (container.afterTest) {
        showTest('The server received the test event. Counting works from this browser.', true);
      }
      return;
    }
    el.receiverLine.textContent = 'No counter writes received yet. Load the tool once, then check again.';
    if (container.afterTest) {
      showTest('The server did not receive the test event. A blocker, or an extension, is stopping /api/collect.', false);
    }
  }

  function showTest(message, ok) {
    if (!el.testResult) return;
    el.testResult.textContent = message;
    el.testResult.hidden = false;
    el.testResult.className = 'msg ' + (ok ? 'msg-ok' : 'msg-warn');
  }

  function renderStorage(health) {
    if (!el.storageBox) return;
    el.storageBox.hidden = false;
    var ok = health && health.storage && health.storage.reachable;
    var counter = health && health.counters ? health.counters : {};
    var badge = el.storageBadge;
    badge.className = 'badge ' + (ok ? 'badge-ok' : 'badge-err');
    badge.textContent = ok ? 'Storage OK' : 'Storage problem';
    var message = health && health.storage && health.storage.message
      ? health.storage.message
      : 'Storage status unknown.';
    if (ok && counter.daysTracked !== null && counter.daysTracked !== undefined) {
      message += ' ' + counter.daysTracked + ' day' + (counter.daysTracked === 1 ? '' : 's') + ' recorded so far.';
    }
    el.storageMessage.textContent = message;
    renderReceiver(health);
  }

  function checkHealth() {
    if (!el.storageBox) return;
    el.storageBox.hidden = false;
    el.storageBadge.className = 'badge badge-idle';
    el.storageBadge.textContent = 'Checking';
    el.storageMessage.textContent = 'Checking the analytics database.';
    fetch('/api/health', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (response) { return response.json().catch(function () { return null; }); })
      .then(renderStorage)
      .catch(function () {
        el.storageBadge.className = 'badge badge-err';
        el.storageBadge.textContent = 'Storage problem';
        el.storageMessage.textContent = 'The storage check could not run.';
      });
  }

  if (el.recheck) el.recheck.addEventListener('click', checkHealth);

  if (el.sendTest) {
    el.sendTest.addEventListener('click', function () {
      if (el.testResult) el.testResult.hidden = true;
      el.sendTest.disabled = true;
      el.sendTest.textContent = 'Sending…';
      var payload = JSON.stringify({ e: 'ping' });
      fetch('/api/collect', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: payload
      }).then(function (response) {
        if (!response.ok) throw new Error('status ' + response.status);
        return new Promise(function (resolve) { setTimeout(resolve, 700); });
      }).then(function () {
        return fetch('/api/health', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      }).then(function (response) { return response.json(); })
        .then(function (health) {
          renderStorage(health);
          renderReceiver(health, { afterTest: true });
        })
        .catch(function () {
          showTest('The browser could not reach /api/collect. Check for a content blocker.', false);
        })
        .then(function () {
          el.sendTest.disabled = false;
          el.sendTest.textContent = 'Send test event';
        });
    });
  }

  function render(data) {
    state.data = data;
    el.loginCard.hidden = true;
    el.dashboard.hidden = false;
    showError('');
    renderKpis(data);
    renderBreakdowns(data);
    renderDaily(data);
    var range = data.range || {};
    el.rangeNote.textContent = range.from
      ? 'Showing ' + range.from + ' to ' + range.to + ' (UTC). Tracking started ' + (range.trackingSince || range.from) + '.'
      : 'No data recorded yet. Open the tool once to start counting.';
    if (range.truncated) showError('Showing the most recent 1500 days of an all-time range.');
    checkHealth();
    el.footNote.textContent = 'Updated ' + new Date(data.generatedAt).toLocaleString() +
      ' · Counts are aggregates only. No file names, file contents or IP addresses are stored.';
    loadGsc();
  }

  function loadGsc() {
    el.gscBody.innerHTML = '<p class="empty">Loading search data…</p>';
    fetch('/api/gsc', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (response) { return response.json().catch(function () { return null; }); })
      .then(function (report) { renderGsc(report); })
      .catch(function () { renderGsc(null); });
  }

  function fetchStats(range) {
    if (state.loading) return;
    state.loading = true;
    state.range = range;
    el.tabs.forEach(function (tab) {
      tab.setAttribute('aria-pressed', String(tab.getAttribute('data-range') === range));
    });
    el.refresh.disabled = true;
    showError('');
    fetch('/api/stats?range=' + encodeURIComponent(range), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (response.status === 401) {
          showLogin('');
          return null;
        }
        return response.json().catch(function () { return null; }).then(function (body) {
          if (response.status === 503) {
            // Storage is not wired up on this deployment: say so on the sign-in card.
            showLogin((body && body.error) || 'Analytics storage is not configured.');
            return null;
          }
          if (!response.ok || !body || body.ok === false) {
            if (response.status === 502) {
              // Signed in, but the database is not answering: keep the shell
              // visible so the storage check can explain why.
              el.loginCard.hidden = true;
              el.dashboard.hidden = false;
              el.rangeNote.textContent = '';
              checkHealth();
            }
            showError((body && body.error) || 'The dashboard could not load analytics data.');
            return null;
          }
          return body;
        });
      })
      .then(function (body) { if (body) render(body); })
      .catch(function () { showError('Network problem: the dashboard could not reach the analytics API.'); })
      .then(function () {
        state.loading = false;
        el.refresh.disabled = false;
      });
  }

  if (el.loginForm) {
    el.loginForm.addEventListener('submit', function (event) {
      event.preventDefault();
      el.loginError.hidden = true;
      var password = el.password.value;
      if (!password) {
        el.loginError.textContent = 'Enter the dashboard password.';
        el.loginError.hidden = false;
        return;
      }
      el.loginButton.disabled = true;
      el.loginButton.textContent = 'Checking…';
      fetch('/api/stats', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ password: password, range: state.range })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          if (response.status === 502) {
            // The cookie is set even when the database is down, so open the
            // dashboard and let the storage check explain the problem.
            el.loginCard.hidden = true;
            el.dashboard.hidden = false;
            showError(body.error || 'Analytics storage did not respond.');
            checkHealth();
            return null;
          }
          if (!response.ok || !body.ok) {
            throw new Error(body.error || 'Sign in failed.');
          }
          el.password.value = '';
          return body;
        });
      }).then(function (body) {
        if (!body) return;
        el.dashboard.hidden = false;
        render(body);
        el.loginCard.hidden = true;
      }).catch(function (error) {
        el.loginError.textContent = error.message || 'Sign in failed.';
        el.loginError.hidden = false;
      }).then(function () {
        el.loginButton.disabled = false;
        el.loginButton.textContent = 'Open dashboard';
      });
    });
  }

  el.tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      fetchStats(tab.getAttribute('data-range'));
    });
  });

  if (el.refresh) el.refresh.addEventListener('click', function () { fetchStats(state.range); });

  if (el.signOut) {
    el.signOut.addEventListener('click', function () {
      fetch('/api/stats', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logout: true })
      }).then(function () {
        state.data = null;
        showLogin('Signed out.');
      }).catch(function () {
        showLogin('Signed out.');
      });
    });
  }

  fetchStats('30');
})();
