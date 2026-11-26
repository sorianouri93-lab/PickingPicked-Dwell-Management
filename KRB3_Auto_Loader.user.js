// ==UserScript==
// @name         KRB3 Auto Loader
// @namespace    krb3.trickle
// @version      1.27.1
// @description  Drop a csX file or scrape Rodeo, verify each csX in Rodeo, look up the live SSP door, and trickle to the door UUID.
// @match        https://sortcenter-menu-na.amazon.com/containerization/trickle*
// @match        https://trans-logistics.amazon.com/ssp/dock/hrz/ob*
// @match        https://track.relay.amazon.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @grant        GM_addElement
// @grant        GM_info
// @connect      rodeo-iad.amazon.com
// @connect      qi-fcresearch-na.corp.amazon.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';
  if (location.host === 'track.relay.amazon.dev') { relayHelper(); return; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(MAIN, 300)); else MAIN();
  function MAIN() {

  const SITE = 'KRB3';
  const RODEO = 'https://rodeo-iad.amazon.com/' + SITE;

  // Door placard barcode UUIDs — verified by Uriel Soriano 2026-11-13 (OB Dock Door Data.xlsx).
  const DOOR_UUID = {
    DD202: 'fcbe2ba5-6095-e4df-8660-3cfa54015b66',
    DD203: '30be2ba5-9f89-ae5d-28d9-e07b3598dfab',
    DD204: '60be2ba6-2419-e912-6766-95f22cbafae8',
    DD205: '86be2ba6-3329-f426-77e0-7c7041b8956e',
    DD206: 'a6be2ba6-778d-68e3-b1f9-0319fa007c8a',
    DD207: '74be2ba6-45a8-e4f0-8a86-98b94e3a1eca',
    DD208: '5cbe2ba6-93b3-7c7e-d71d-e51462292f9b',
    DD209: 'bebe2ba6-b337-b3cd-62a0-fcab54053074',
    DD210: 'f6be2ba6-d859-fcbe-1d6a-12cb0e822c37',
    DD211: 'a8be2ba6-e799-b6fa-feff-01c8af426e00',
    DD212: '22be2bb1-382f-7ae0-14f0-8758d95a4612',
    DD213: '6ebe2bb1-471a-a61d-018d-85b73ecaeea7',
    DD214: '32be2bb1-7d86-239c-75fb-d7109710bd66',
  };


  // ---------- shared helpers ----------
  const MON = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
  // SSP "07-Nov-26 16:00" -> Rodeo "2026-11-07 16:00"
  const normCpt = s => { const m = (s || '').match(/(\d{2})-([A-Za-z]{3})-(\d{2})\s+(\d{2}:\d{2})/); return m ? `20${m[3]}-${MON[m[2]]}-${m[1]} ${m[4]}` : ''; };
  const isLoading = s => /Loading[\s_]*In[\s_]*Progress/i.test(s || '');
  const dwellMin = s => {
    const t = (s || '').trim();
    const exact = t.match(/^(\d+)m\|/);                     // "1221m|20h 21m" from Rodeo's hidden minutes span
    if (exact) return +exact[1];
    const bare = t.match(/^(\d+)\s+\d+\s*[dhm]/i);          // "1221 20h 21m": leading number = total MINUTES
    if (bare) return +bare[1];
    const d = t.match(/(\d+)\s*d/i), h = t.match(/(\d+)\s*h/i), mi = t.match(/(\d+)\s*m\b/i);
    return (d ? d[1] * 1440 : 0) + (h ? h[1] * 60 : 0) + (mi ? +mi[1] : 0);
  };

  const fmtMin = m => !m ? '-' : m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
  const fmtDwell = s => { const m = dwellMin(s); return m ? fmtMin(m) : (s || ''); };
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- Rodeo ----------
  function rodeoGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, timeout: 30000,
        onload: r => r.status === 200 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
        onerror: () => reject(new Error('network error (are you signed in to Rodeo?)')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }
  function parseItemList(html, all) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const t of doc.querySelectorAll('table')) {
      const heads = [...t.querySelectorAll('thead th, tr:first-child th')].map(h => h.textContent.trim());
      const iS = heads.indexOf('Scannable ID');
      if (iS < 0) continue;
      const col = n => heads.indexOf(n);
      const iD = col('Destination Warehouse ID'), iW = col('Work Pool'), iN = col('Need To Ship By Date'),
            iP = col('Process Path'), iO = col('Outer Scannable ID'), iOT = col('Outer Container Type'),
            iQ = col('Quantity'), iDw = col('Dwell Time'), iSt = col('Status');
      const visText = td => {
        const k = td.cloneNode(true);
        k.querySelectorAll('[hidden],[style*="display:none"],[style*="display: none"],.hidden,.hide,.sortValue,.sort-value,.sortkey').forEach(n => n.remove());
        return k.textContent.replace(/\s+/g, ' ').trim();
      };
      const parsed = [...t.querySelectorAll('tbody tr')].map(tr => {
        const tds = [...tr.querySelectorAll('td')];
        const c = tds.map(td => td.textContent.trim());
        let dwM = null;
        if (iDw >= 0 && tds[iDw]) {
          const sp = tds[iDw].querySelector('.dwell-time-minutes');
          if (sp && /^\d+$/.test(sp.textContent.trim())) dwM = +sp.textContent.trim();   // Rodeo's exact dwell in MINUTES
          const k = tds[iDw].cloneNode(true); k.querySelectorAll('.dwell-time-minutes').forEach(n => n.remove());
          c[iDw] = visText(k);
        }
        const g = i => (i >= 0 ? c[i] : '') || '';
        return { csx: g(iS), dest: g(iD), wp: g(iW), cpt: g(iN), pp: g(iP), outer: g(iO),
                 outerType: g(iOT), qty: g(iQ), dwell: dwM !== null ? `${dwM}m|${g(iDw)}` : g(iDw), status: g(iSt) };
      });
      const keep = parsed.filter(r => /^csX/.test(r.csx) || (all && /^paX/.test(r.outer)));
      keep.total = parsed.length;
      return keep;
    }
    return [];
  }
  // Rodeo pages ItemList at 1000 rows; walk every page (pager.<TYPE>.currentPage=N).
  async function rodeoAllPages(baseUrl, maxPages = 15, all = false) {
    const type = (baseUrl.match(/shipmentType=([A-Z_]+)/) || [])[1] || 'TRANSSHIPMENTS';
    const out = [], seen = new Set();
    let pages = 0;
    for (let n = 1; n <= maxPages; n++) {
      const url = baseUrl + `&pager.${type}.pageSize=1000&pager.${type}.currentPage=${n}`;
      const rows = parseItemList(await rodeoGet(url), all);
      pages = n;
      let added = 0;
      rows.forEach(r => {
        const k = /^csX/.test(r.csx) ? r.csx : 'pa:' + r.outer + '|' + r.dest;   // no csX -> count the paX once
        if (!seen.has(k)) { seen.add(k); out.push(r); added++; }
      });
      if ((rows.total ?? rows.length) < 990 || added === 0) break;
    }
    out.pages = pages;
    out.capped = pages >= maxPages;
    return out;
  }
  // ---------- VRID compliance (from the SSP feed; set SSP's date range to cover the week) ----------
  function vridCompliance() {
    const ssp = GM_getValue('ssp_doors', null);
    if (!ssp || !ssp.rows.length) return alert('No SSP data yet — open SSP OB Dock in another tab.');
    const norm = s => (s || '').replace(/SSP_DM_/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const st = r => norm(r.rawStatus || r.status) || '-';
    const done = s => /complet|departed/i.test(s), cancelled = s => /cancel/i.test(s);
    const started = s => /loading|finished|complet|departed|ready/i.test(s);
    const today = new Date().toLocaleDateString('en-CA');
    const day = r => (normCpt(r.sdt) || normCpt(r.cpt)).slice(0, 10);
    const seen = new Set(), rows = ssp.rows.filter(r => { const k = r.vrid || (r.dest + r.cpt + r.door); if (seen.has(k)) return false; seen.add(k); return true; })
      .map(r => ({ ...r, s: st(r), d: day(r) })).filter(r => r.d)
      .sort((a, b) => (normCpt(a.sdt) || normCpt(a.cpt)).localeCompare(normCpt(b.sdt) || normCpt(b.cpt)) || a.dest.localeCompare(b.dest));
    const past = rows.filter(r => r.d < today && !done(r.s));                 // not completed — includes Cancelled
    const tod = rows.filter(r => r.d === today);
    const hrsOut = r => { const t = Date.parse((normCpt(r.sdt) || normCpt(r.cpt)).replace(' ', 'T')); return isNaN(t) ? NaN : (t - Date.now()) / 3600000; };
    const futAll = rows.filter(r => r.d > today);
    const fut = futAll.filter(r => cancelled(r.s) || (started(r.s) && hrsOut(r) > 24));   // NOT compliant: cancelled, or started/loading/completed >24h before departure
    const futOk = futAll.filter(r => !cancelled(r.s) && started(r.s) && !(hrsOut(r) > 24));
    futAll.forEach(r => r.h = hrsOut(r));
    const todC = tod.filter(r => cancelled(r.s)).length;
    const days = rows.map(r => r.d); const range = days.length ? `${days[0]} → ${days[days.length - 1]}` : '-';
    const badge = s => { const c = done(s) ? '#188038' : cancelled(s) ? '#a50e0e' : /loading/i.test(s) ? '#1a73e8' : /finished/i.test(s) ? '#7a5c00' : '#333';
      return `<span style="color:${c};font-weight:700">${esc(s)}</span>`; };
    const myVer = (typeof GM_info !== 'undefined' && GM_info.script.version) || '';
    const sspOld = (ssp.ver || '') !== myVer || (rows.length && !rows.some(r => r.sdt));
    const needCase = new Set([...past, ...fut].map(r => r.vrid).filter(Boolean));
    const caseCell = r => needCase.has(r.vrid) ? `<td class="case" data-v="${esc(r.vrid)}"><span class="g">checking Relay…</span></td>` : '<td></td>';
    const tbl = (list, flag, showH) => !list.length ? '<p class="ok">✓ None</p>' : `<table><thead><tr><th>#</th><th>VRID</th><th>Dest</th><th>SDT</th>${showH ? '<th>Hrs to SDT</th>' : ''}<th>CPT</th><th>Status</th><th>Relay case</th><th>Since</th><th>Door</th><th>Trailer</th><th>Carrier</th></tr></thead><tbody>
      ${list.map((r, i) => `<tr class="${flag ? flag(r) : ''}"><td>${i + 1}</td><td class="m b"><a href="${relayUrl(r.vrid)}" target="_blank">${esc(r.vrid)}</a></td><td class="b">${esc(r.dest)}</td><td>${esc(r.sdt)}</td>${showH ? `<td class="b">${isNaN(r.h) ? '-' : r.h.toFixed(1) + 'h'}</td>` : ''}<td>${esc(r.cpt)}</td>
        <td>${badge(r.s)}</td>${caseCell(r)}<td>${esc(r.since)}</td><td>${esc(r.door)}</td><td>${esc(r.trailer)}</td><td>${esc(r.carrier)}</td></tr>`).join('')}</tbody></table>`;
    const relayUrl = v => `https://track.relay.amazon.dev/view/NA:VR:${encodeURIComponent(v)}?m=trip&type=vehicleRun&r=na&q=${encodeURIComponent(v)}`;
    // ---- Rodeo DA backlog: RTP + PNYP + PickingPicked csX on future CPTs, by destination, vs. a VRID departing within 24h ----
    const sdtMs = r => Date.parse((normCpt(r.sdt) || normCpt(r.cpt)).replace(' ', 'T'));
    const POOLS = [['ReadyToPick', 'RTP'], ['PickingNotYetPicked', 'PNYP'], ['PickingPicked', 'PP']];
    const buildDa = items => {
      const nowS = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', ' ');
      const seenC = new Set(), map = {};
      items.forEach(p => {
        if (!p.cpt || p.cpt < nowS || seenC.has(p.uid)) return;            // future CPTs only; one count per csX (or per paX when no csX)
        seenC.add(p.uid);
        const d = map[p.dest] = map[p.dest] || { dest: p.dest, n: 0, nCsx: 0, nPa: 0, units: 0, RTP: 0, PNYP: 0, PP: 0, cpts: new Set() };
        d.n++; p.isPa ? d.nPa++ : d.nCsx++; d.units += +p.qty || 0; d[p.pool]++; d.cpts.add(p.cpt);
      });
      return Object.values(map).map(d => {
        const v = rows.filter(r => r.dest === d.dest && !cancelled(r.s) && !done(r.s))
          .map(r => ({ r, h: (sdtMs(r) - Date.now()) / 3600000 })).filter(x => !isNaN(x.h)).sort((a, b) => a.h - b.h);
        const in24 = v.filter(x => x.h <= 24 && (x.h >= 0 || /loading|finished/i.test(x.r.s)));
        const next = in24[0] || v.find(x => x.h >= 0) || null;
        const cp = [...d.cpts].sort();
        return { ...d, cptFirst: cp[0] || '', next, ok: in24.length > 0, n24: in24.length };
      }).sort((a, b) => (a.ok - b.ok) || b.n - a.n);
    };
    const daTblOf = da => !da.length ? '<p class="g">No RTP / PNYP / PickingPicked csX or paX on future CPTs.</p>' : `<table><thead><tr><th>#</th><th>Dest</th><th title="csX, plus paX for items with no csX">Containers</th><th>csX</th><th>paX</th><th>RTP</th><th>PNYP</th><th>PP</th><th>Units</th><th>Next CPT</th>
        <th>VRID</th><th>SDT</th><th>Hrs to SDT</th><th>VRID status</th><th>Door</th><th>Compliant</th></tr></thead><tbody>
      ${da.map((d, i) => { const x = d.next, r = x && x.r;
        return `<tr class="${d.ok ? 'good' : 'flag'}"><td>${i + 1}</td><td class="b">${esc(d.dest)}</td><td class="b">${d.n}</td><td>${d.nCsx}</td><td>${d.nPa || ''}</td><td>${d.RTP}</td><td>${d.PNYP}</td><td>${d.PP}</td><td>${d.units}</td>
        <td>${esc(d.cptFirst.slice(5))}</td>
        <td class="m b">${r ? `<a href="${relayUrl(r.vrid)}" target="_blank">${esc(r.vrid)}</a>${d.n24 > 1 ? ` <small>+${d.n24 - 1}</small>` : ''}` : '-'}</td>
        <td>${r ? esc(r.sdt || r.cpt) : '-'}</td><td class="b">${x ? x.h.toFixed(1) + 'h' : '-'}</td><td>${r ? badge(r.s) : '-'}</td><td>${r ? esc(r.door) : '-'}</td>
        <td class="b">${d.ok ? '✓ VRID within 24h' : r ? '✗ next VRID &gt;24h out' : '✗ no VRID scheduled'}</td></tr>`; }).join('')}</tbody></table>`;
    const w = window.open('', '_blank'); if (!w) return alert('Pop-up blocked — allow pop-ups for this site.');
    w.document.write(`<!doctype html><html><head><title>KRB3 VRID Compliance</title><style>
      body{font:12px Arial,sans-serif;margin:14px;color:#000} h1{font-size:18px;margin:0} .sub{color:#444;margin:3px 0 10px}
      h2{font-size:14px;color:#fff;padding:5px 8px;margin:14px 0 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .past{background:#a50e0e}.tod{background:#232f3e}.fut{background:#b06000}.da{background:#1a4d8f}
      table{border-collapse:collapse;width:100%} th,td{border:1px solid #999;padding:3px 6px;text-align:left;white-space:nowrap}
      th{background:#eee} tbody tr:nth-child(even){background:#f7f7f7} .m{font-family:Consolas,monospace}.b{font-weight:700}
      tr.flag td{background:#fde0dc!important} tr.good td{background:#d4f5d4!important} .g{color:#777} td.case{white-space:normal;min-width:2.2in;font-size:11px} .nocase{color:#fff;background:#a50e0e;font-weight:700;padding:0 4px} .hascase{color:#146c2e;font-weight:700} .cl{display:block} .ok{color:#188038;font-weight:700;margin:6px 0}
      .cards{display:flex;gap:10px;margin:8px 0} .card{border:2px solid;border-radius:6px;padding:6px 12px;font-size:13px}
      .card b{font-size:22px;display:block} @media print{.np{display:none}}
    </style></head><body>
      <button class="np" onclick="print()" style="float:right;padding:6px 14px;font-weight:700">Print</button>
      <h1>KRB3 VRID Compliance</h1>
      <div class="sub">Generated ${esc(new Date().toLocaleString())} · SSP data ${((Date.now() - ssp.ts) / 60000).toFixed(0)} min old · ${rows.length} VRIDs, ${esc(range)}<br>
        Covers whatever date range SSP is set to — set SSP From/To to the past day through next 7 days and Show 100.<br>
        ${sspOld ? `<b style="color:#a50e0e">SSP tab is running an older copy of the tool (${esc(ssp.ver || 'unknown')}) — refresh the SSP tab, wait 30 seconds, then reopen this report. SDT and Carrier stay blank until then.</b><br>` : ''}
        <span id="relaySt" class="g"></span></div>
      <div class="cards">
        <div class="card" style="border-color:#a50e0e;color:#a50e0e"><b>${past.length}</b>Past, not completed</div>
        <div class="card" style="border-color:#232f3e"><b>${tod.length}</b>Today</div>
        <div class="card" style="border-color:#a50e0e;color:#a50e0e"><b>${fut.length}</b>Future, cancelled or started &gt;24h early<br><small>not compliant</small></div>
        <div class="card" style="border-color:#188038;color:#188038"><b>${futOk.length}</b>Future, started within 24h<br><small>compliant</small></div>
        <div class="card" id="daCard" style="border-color:#1a4d8f;color:#1a4d8f"><b id="daN">…</b>DA BL dests with no VRID in 24h<br><small id="daOf">loading Rodeo…</small></div></div>
      <h2 class="da">RODEO DA BACKLOG — RTP / PNYP / PickingPicked csX (or paX when no csX) on future CPTs, by destination · <span style="background:#d4f5d4;color:#146c2e;padding:0 4px">green</span> = VRID departing within 24h · <span style="background:#fde0dc;color:#a50e0e;padding:0 4px">red</span> = none</h2><div id="daBox"><p class="g">Pulling Rodeo ReadyToPick, PickingNotYetPicked and PickingPicked (all pages)…</p></div>
      <h2 class="past">PAST VRIDs — not completed in SSP, incl. cancelled (${past.length})</h2>${tbl(past, () => 'flag')}
      <h2 class="tod">TODAY'S VRIDs (${tod.length})${todC ? ` — <span style="background:#fde0dc;color:#a50e0e;padding:0 4px">${todC} cancelled</span>` : ''}</h2>${tbl(tod, r => cancelled(r.s) ? 'flag' : '')}
      
      <h2 class="fut">FUTURE VRIDs (${futAll.length}) — <span style="background:#fde0dc;color:#a50e0e;padding:0 4px">red</span> = cancelled, or started/loading/completed more than 24h before SDT (${fut.length}) · <span style="background:#d4f5d4;color:#146c2e;padding:0 4px">green</span> = started within 24h (${futOk.length})</h2>
      ${tbl(futAll, r => cancelled(r.s) ? 'flag' : started(r.s) ? (r.h > 24 ? 'flag' : 'good') : '', true)}
    </body></html>`);
    w.document.close();
    (async () => {
      const box = () => w.document.getElementById('daBox');
      try {
        const all = [];
        for (const [wp, tag] of POOLS) {
          if (box()) box().innerHTML = `<p class="g">Pulling Rodeo ${tag}…</p>`;
          const list = await rodeoAllPages(`${RODEO}/ItemList?_enabledColumns=on&WorkPool=${wp}&enabledColumns=OUTER_SCANNABLE_ID&shipmentType=TRANSSHIPMENTS`, 40, true);
          list.forEach(r => all.push({ ...r, pool: tag, isPa: !/^csX/.test(r.csx || ''), uid: /^csX/.test(r.csx || '') ? r.csx : 'pa:' + r.outer + '|' + r.dest }));
          if (list.capped && box()) box().insertAdjacentHTML('beforeend', `<p class="warn">${tag}: hit 40-page limit, counts may be low.</p>`);
        }
        const da = buildDa(all), bad = da.filter(d => !d.ok).length;
        if (w.closed) return;
        box().innerHTML = daTblOf(da);
        const c = w.document.getElementById('daCard'); const col = bad ? '#a50e0e' : '#188038';
        c.style.borderColor = col; c.style.color = col;
        w.document.getElementById('daN').textContent = bad;
        w.document.getElementById('daOf').textContent = `of ${da.length} dests · ${da.reduce((t, d) => t + d.nCsx, 0)} csX + ${da.reduce((t, d) => t + d.nPa, 0)} paX`;
      } catch (e) { if (box()) box().innerHTML = `<p class="warn">Rodeo error: ${esc(e.message)} — make sure you're signed in to Rodeo.</p>`; }
    })();
    // ---- Relay case check for every non-compliant VRID ----
    const items = rows.filter(r => needCase.has(r.vrid)).map(r => { const t = Date.parse((normCpt(r.sdt) || normCpt(r.cpt)).replace(' ', 'T')); return { vrid: r.vrid, t: isNaN(t) ? '' : t }; });
    const sEl = () => w.document.getElementById('relaySt');
    if (!items.length) { if (sEl()) sEl().textContent = 'No non-compliant VRIDs to check in Relay.'; return; }
    const reqId = 'r' + Date.now();
    GM_setValue('relay_req', { id: reqId, ts: Date.now(), items });
    const t0 = Date.now();
    const paint = () => {
      if (w.closed) return clearInterval(tm);
      const alive = GM_getValue('relay_alive', null), live = alive && Date.now() - alive.ts < 12000;
      const res = GM_getValue('relay_cases', null);
      const by = res && res.id === reqId ? res.byVrid || {} : {};
      let n = 0, withCase = 0, noCase = 0;
      w.document.querySelectorAll('td.case').forEach(td => {
        const x = by[td.dataset.v]; if (!x) return; n++;
        if (x.err) { td.innerHTML = `<span class="g" title="${esc(x.raw || '')}">Relay: ${esc(x.err)}</span>`; return; }
        if (!x.cases.length) { noCase++; td.innerHTML = '<span class="nocase">NO CASE</span>'; return; }
        withCase++;
        td.innerHTML = `<span class="hascase">✓ ${x.cases.length} case${x.cases.length > 1 ? 's' : ''}</span>` +
          x.cases.map(c => `<span class="cl"><b class="m">${esc(c.id)}</b> ${esc(c.status)} — ${esc(c.title)}</span>`).join('');
      });
      const done = res && res.id === reqId && res.done === reqId;
      const s = sEl(); if (!s) return;
      if (!live && !n) s.innerHTML = `<b style="color:#a50e0e">Relay not open:</b> open <a href="https://track.relay.amazon.dev/" target="_blank">Relay Track &amp; Trace</a> in another tab (signed in), search any trip once, then reopen this report.`;
      else if (alive && !alive.haveAuth && !n) s.innerHTML = '<b style="color:#b06000">Relay tab is open but hasn\'t loaded a trip yet</b> — search any VRID in Relay once so the tool can use its sign-in.';
      else s.innerHTML = `Relay case check: ${n}/${items.length} checked · <span class="hascase">${withCase} with case</span> · <span class="nocase">${noCase} no case</span>${done ? '' : ' · checking…'}`;
      if (done || Date.now() - t0 > 6 * 60000) clearInterval(tm);
    };
    const tm = setInterval(paint, 1500); paint();
  }

  // =========================================================
  // PART 1 — SSP page: background capture only (destination -> door).
  //          Keep this tab open; everything is shown on the Trickle page.
  // =========================================================
  if (location.host === 'trans-logistics.amazon.com') {
    const badge = document.createElement('div');
    badge.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;background:#232f3e;color:#fff;padding:4px 8px;border-radius:5px;font:11px sans-serif;opacity:.85';
    document.body.appendChild(badge);
    // Read ALL loads, ignoring whatever is typed in SSP's search box or which table page is showing.
    // 1) Prefer the DataTables API (every row, unfiltered, all pages).
    // 2) If that isn't available and the SSP search box has text, keep the last full capture instead.
    const sspFilterText = () => [...document.querySelectorAll('.dataTables_filter input, input[aria-controls="dashboard"]')]
      .map(i => i.value.trim()).filter(Boolean).join(' ');
    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const allRowNodes = () => {
      for (const $j of [W.jQuery, W.$, W.$j].filter(Boolean)) {
        try {
          if (!$j.fn || !$j.fn.dataTable) continue;
          const tbl = $j('#dashboard');
          if ($j.fn.dataTable.isDataTable && $j.fn.dataTable.isDataTable('#dashboard') && tbl.DataTable) {
            const n = tbl.DataTable().rows({ search: 'none', page: 'all', order: 'index' }).nodes().toArray();
            if (n.length) return { nodes: n, full: true };
          }
          const legacy = tbl.dataTable();
          if (legacy && legacy.fnGetNodes) { const n = legacy.fnGetNodes(); if (n && n.length) return { nodes: [...n], full: true }; }
        } catch (e) { /* try next */ }
      }
      return { nodes: [...document.querySelectorAll('#dashboard tbody tr')], full: false };
    };
    // If the table API isn't reachable, show every load on one page so nothing on page 2+ is missed.
    let lengthBumped = false;
    const showAllRows = () => {
      if (lengthBumped) return;
      const sel = document.querySelector('select[name="dashboard_length"]');
      if (!sel) return;
      const opts = [...sel.options].map(o => o.value);
      const best = opts.includes('-1') ? '-1' : opts.sort((a, b) => +b - +a)[0];
      if (sel.value !== best) { sel.value = best; sel.dispatchEvent(new Event('change', { bubbles: true })); if (W.jQuery) try { W.jQuery(sel).trigger('change'); } catch (e) {} }
      lengthBumped = true;
    };
    const paged = () => { const t = document.querySelector('#dashboard_info, .dataTables_info'); const m = t && t.textContent.match(/of\s+([\d,]+)\s+entries/i); const shown = document.querySelectorAll('#dashboard tbody tr').length; return m ? { total: +m[1].replace(/,/g, ''), shown } : null; };
    const capture = () => {
      const t = document.querySelector('#dashboard');
      if (!t) return;
      let { nodes, full } = allRowNodes();
      if (!full) showAllRows();
      const filterText = sspFilterText();
      if (!full && filterText) {
        const prev = GM_getValue('ssp_doors', null);
        badge.textContent = `Trickle feed: paused while SSP search "${filterText}" is active — keeping last full capture` +
          (prev ? ` (${new Date(prev.ts).toLocaleTimeString()})` : '');
        return;
      }
      const heads = [...t.querySelectorAll('thead tr:first-child th, thead th')].map(h => h.textContent.replace(/\s+/g, ' ').trim());
      const iT = heads.indexOf('Trailer'), iC = heads.indexOf('CPT'), iV = heads.indexOf('VR Id'), iSD = heads.indexOf('SDT'), iCa = heads.indexOf('Carrier'), iSt = heads.indexOf('Status');
      const parseNodes = list => {
        const out = []; let windowStart = '';
        list.forEach(tr => {
          // join cell texts with separators; rows from the table API are often detached, where innerText runs cells together
          const cells = [...tr.querySelectorAll('td,th')].map(td => (td.textContent || '').replace(/\s+/g, ' ').trim());
          const txt = cells.length ? cells.join(' | ') : (tr.textContent || '').replace(/\s+/g, ' ');
          const win = txt.match(/Scheduled[\s_]*Departure[\s_]*Window:?\s*(\d{2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2})/i);
          if (win && !/->/.test(txt)) { windowStart = win[1]; return; }
          const m = txt.match(/KRB3\s*-(?:>|&gt;)\s*([A-Z0-9]{4})(?![A-Z0-9])/);
          if (!m) return;
          const door = (txt.match(/(?:^|[^A-Z0-9])(DD\d{3}|PS\d{3,4})(?![0-9])/) || [])[1] || '-';
          const status = (txt.match(/(SSP_DM_)?[A-Za-z_ ]*?(Loading[\s_]*In[\s_]*Progress|Finished[\s_]*Loading|SCHEDULED|Scheduled|Cancelled|Departed|Completed)/) || [''])[0];
          const since = (txt.match(/Since\s+((?:\d+d\s*)?\d+h\s*\d+m|\d+\s*Hours?(?:\s*\d+m)?)/i) || [])[1] || '';
          const cptCell = iC >= 0 ? cells[iC] || '' : '';
          const cpt = (cptCell.match(/\d{2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}/) || [])[0] || windowStart;
          const DRE = /\d{2}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}/;
          let sdt = ((iSD >= 0 ? cells[iSD] : '') || '').match(DRE);
          if (!sdt) {                                   // fallback: date cells run TRT, SDT, CPT (, ADT) — SDT is the 2nd
            const dc = cells.map(c => (c.match(DRE) || [])[0]).filter(Boolean);
            if (dc.length >= 2) sdt = [dc[1]];
          }
          let carrier = iCa >= 0 ? cells[iCa] || '' : '';
          if (!carrier) carrier = (txt.match(/([A-Z0-9]{3,6})\s*\[(ATS_[A-Z_]+)\]/) || []).slice(1).join(' ');
          const rawSt = (iSt >= 0 ? cells[iSt] || '' : status).replace(/Since.*$/i, '').trim();
          out.push({ dest: m[1], door, cpt, status, since, sdt: sdt ? sdt[0] : '', carrier, rawStatus: rawSt || status,
            trailer: iT >= 0 ? cells[iT] || '' : '', vrid: (iV >= 0 ? cells[iV] || '' : '').split(' ')[0] });
        });
        return out;
      };
      let rows = parseNodes(nodes);
      if (full && !rows.length) { full = false; rows = parseNodes([...document.querySelectorAll('#dashboard tbody tr')]); }
      let out = rows;
      if (!full) {
        const prev = (GM_getValue('ssp_doors', null) || { rows: [] }).rows;
        const now = Date.now(), key = r => r.vrid || (r.dest + '|' + r.door + '|' + r.cpt);
        const seen = new Set(rows.map(key));
        rows.forEach(r => r.seen = now);
        out = rows.concat(prev.filter(r => !seen.has(key(r)) && now - (r.seen || 0) < 10 * 60000));
      }
      GM_setValue('ssp_doors', { ts: Date.now(), rows: out, ver: (typeof GM_info !== 'undefined' && GM_info.script.version) || '' });
      const pg = paged();
      badge.textContent = `Trickle feed: ${out.filter(r => isLoading(r.status)).length} loading / ${out.length} loads` +
        `${full ? ' (all pages)' : pg && pg.total > pg.shown ? ` — WARNING: SSP shows ${pg.shown} of ${pg.total}, set "Show" to All/100` : ''} · ${new Date().toLocaleTimeString()}`;
    };
    // re-capture when the SSP search box changes (so clearing it updates right away)
    document.addEventListener('input', e => { if (e.target.closest && e.target.closest('.dataTables_filter')) setTimeout(capture, 800); }, true);
    const vb = document.createElement('button');
    vb.textContent = '📋 VRID compliance';
    vb.title = 'Open the VRID compliance report from this SSP page';
    vb.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;font:700 12px sans-serif;padding:5px 10px;border:2px solid #232f3e;border-radius:5px;background:#fff;cursor:pointer';
    badge.style.left = '170px';
    document.body.appendChild(vb);
    vb.onclick = () => { capture(); vridCompliance(); };
    capture();
    setInterval(capture, 30000);
    let mo; new MutationObserver(() => { clearTimeout(mo); mo = setTimeout(capture, 1500); })
      .observe(document.querySelector('#dashboard') || document.body, { childList: true, subtree: true });
    return;
  }

  // =========================================================
  // PART 2 — Trickle page: control panel + runner
  // =========================================================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = [];
  let stopFlag = false;
  let queue = []; // {csx, dest, wp, door, uuid, status, note}

  async function verifyInRodeo(csx) {
    const html = await rodeoGet(`${RODEO}/ItemList?_enabledColumns=on&enabledColumns=OUTER_SCANNABLE_ID&scannableId=${encodeURIComponent(csx)}`);
    const rows = parseItemList(html).filter(r => r.csx === csx);
    return rows[0] || null;
  }
  async function scrapeRodeo(dateStr, timeStr, processPath) {
    const cpt = new Date(`${dateStr}T${timeStr}:00`).getTime(); // local (site) time
    const url = `${RODEO}/ItemList?_enabledColumns=on&WorkPool=PickingPicked` +
      `&enabledColumns=OUTER_SCANNABLE_ID&ExSDRange.RangeStartMillis=${cpt - 1}` +
      `&ExSDRange.RangeEndMillis=${cpt + 60000}&ProcessPath=${encodeURIComponent(processPath)}` +
      `&shipmentType=TRANSSHIPMENTS`;
    return rodeoAllPages(url);
  }

  // ---------- Door resolution ----------
  function overrides() {
    const map = {};
    (el('#tk-ovr').value || '').split(/[\n,;]+/).forEach(s => {
      const m = s.trim().toUpperCase().match(/^([A-Z0-9]{4})\s*[=:]\s*(DD\d{3})$/);
      if (m) map[m[1]] = m[2];
    });
    return map;
  }
  function resolveDoor(dest, prefer) {
    const ov = overrides();
    if (ov[dest]) return { door: ov[dest], src: 'override' };
    if (prefer && /^DD\d{3}$/.test(prefer)) return { door: prefer, src: 'trailer row ' + prefer };
    const ssp = GM_getValue('ssp_doors', null);
    if (!ssp) return { door: null, src: 'no SSP data — open the SSP OB page in another tab' };
    const ageMin = (Date.now() - ssp.ts) / 60000;
    if (ageMin > 30) return { door: null, src: `SSP data is ${ageMin.toFixed(0)} min old — refresh SSP tab` };
    const live = ssp.rows.filter(r => r.dest === dest && /Loading[\s_]*In[\s_]*Progress/i.test(r.status) && /^DD\d{3}$/.test(r.door));
    const doors = [...new Set(live.map(r => r.door))];
    if (doors.length === 1) return { door: doors[0], src: 'SSP' };
    if (doors.length > 1) {
      const first = live.slice().sort((a, b) => normCpt(a.cpt).localeCompare(normCpt(b.cpt)))[0];
      return { door: first.door, src: `SSP (${doors.join('/')} both loading — using ${first.door}, earliest CPT; queue from a trailer row to pick)` };
    }
    return { door: null, src: 'no active DD door on SSP' };
  }

  // ---------- Trickle page driving ----------
  const bodyText = () => {
    const mine = document.getElementById('tk-wrap');
    const own = mine ? mine.parentElement : null;
    return [...document.body.children].filter(e => e !== own && e.tagName !== 'SCRIPT')
      .map(e => e.innerText || '').join(' ').replace(/\s+/g, ' ');
  };
  function getInput() { return document.querySelector('input[type=text]'); }
  async function scan(value) {
    const inp = getInput();
    if (!inp) throw new Error('scan input not found');
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, value);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    for (const type of ['keydown', 'keypress', 'keyup']) {
      inp.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
    await sleep(700);
    // Fallback if the page ignored the synthetic Enter
    if (getInput() === inp && inp.value === value) {
      const btn = document.querySelector('form input[type=submit]');
      if (btn) btn.click(); else if (inp.form) inp.form.requestSubmit();
    }
  }
  async function waitFor(fn, timeout = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const v = fn(); if (v) return v;
      await sleep(250);
    }
    return null;
  }
  const TRICKLE_URL = 'https://sortcenter-menu-na.amazon.com/containerization/trickle';
  const pageState = () => {
    const t = bodyText();
    if (/Scan destination/i.test(t)) return 'dest';          // previous container still waiting for a door
    if (/Scan container to move/i.test(t)) return 'ready';
    return 'unknown';
  };
  // Make sure Trickle is back at "Scan container to move" before scanning a csX.
  // Try the page's own [X] first; if that doesn't reset it, reload and resume the run.
  async function ensureReady(remaining) {
    if (pageState() === 'ready' && !/wrong barcode|Error occurred/i.test(bodyText())) return true;
    const x = [...document.querySelectorAll('div,a,span,button')].find(e => e.textContent.trim() === '[X]' && !e.closest('#tk-wrap'));
    if (x) { x.click(); const ok = await waitFor(() => pageState() === 'ready', 4000); if (ok && !/wrong barcode/i.test(bodyText())) return true; }
    const prev = GM_getValue('tk_resume', null) || {};
    const tries = (prev.tries || 0) + 1;
    if (tries > 2) {
      GM_setValue('tk_resume', null);
      setStatus('Stopped: Trickle screen would not reset after 2 reloads. Click Trickle\'s [X] or refresh, then Run again.');
      return false;
    }
    GM_setValue('tk_resume', { ts: Date.now(), queue, remaining: remaining.map(q => q.csx), tries });
    setStatus('Resetting Trickle screen (reload) — the run will continue automatically…');
    location.href = TRICKLE_URL;
    await sleep(15000);   // page is unloading
    return false;
  }
  async function trickleOne(item) {
    const before = bodyText();
    await scan(item.csx);
    // wait for a NEW destination prompt for THIS csX (not stale text from a previous container)
    const s1 = await waitFor(() => {
      const t = bodyText();
      if (t === before) return null;
      if (/wrong barcode|Error occurred|not found|invalid/i.test(t)) return 'error';
      if (/Scan destination/i.test(t) && t.includes(item.csx)) return 'dest';
      return null;
    });
    if (s1 !== 'dest') return { ok: false, note: s1 === 'error' ? 'rejected on csX scan: ' + snippet() : 'no destination prompt for this csX (timeout)', halt: s1 !== 'error', reset: true };
    const sf = (bodyText().match(/Stacking filter\s+([A-Z0-9]{4})_/i) || [])[1];
    if (sf && sf.toUpperCase() !== item.dest) {
      return { ok: false, note: `STOPPED: Trickle shows ${sf}, expected ${item.dest}. Not scanned to a door.`, halt: true, reset: true };
    }
    const before2 = bodyText();
    await scan(item.uuid);
    const s2 = await waitFor(() => {
      const t = bodyText();
      const m = t.match(new RegExp('Moved container\\W+' + item.csx + '\\W+To\\W+(\\S+?)`?\\s'));
      if (m) return 'moved:' + m[1].replace(/`/g, '');
      if (t !== before2 && /wrong barcode|Error occurred/i.test(t)) return 'error';
      return null;
    }, 10000);
    if (s2 && s2.startsWith('moved:')) return { ok: true, note: 'moved -> ' + s2.slice(6) };
    return { ok: false, note: s2 === 'error' ? `door ${item.door} UUID rejected ("wrong barcode") — check that door's placard` : 'no confirmation (timeout)', halt: true, reset: true };
  }
  const snippet = () => bodyText().slice(0, 160);

  // ---------- Pipeline ----------
  function parseDropped(text) {
    const out = [], seen = new Set();
    text.split(/\r?\n/).forEach(line => {
      const ids = line.match(/csX[A-Za-z0-9]{8}/g) || [];
      const dest = (line.toUpperCase().match(/\b(?!CSX)[A-Z]{3}\d\b/) || [])[0] || '';
      ids.forEach(id => { if (!seen.has(id)) { seen.add(id); out.push({ csx: id, dest }); } });
    });
    return out;
  }
  async function buildPlan(items) {
    queue = [];
    setStatus(`Verifying ${items.length} csX in Rodeo...`);
    for (const it of items) {
      if (stopFlag) break;
      const q = { csx: it.csx, dest: it.dest, wp: '', door: '', uuid: '', status: 'skip', note: '' };
      try {
        const r = it.wp ? it : await verifyInRodeo(it.csx);
        if (!r) q.note = 'not found in Rodeo (typo / ICQA / deleted / re-stowed?)';
        else {
          q.wp = r.wp || '';
          if (q.dest && r.dest && q.dest !== r.dest) q.note = `dest mismatch: list ${q.dest} vs Rodeo ${r.dest} — using Rodeo`;
          q.dest = r.dest || q.dest;
          if (/^Loaded$/i.test(q.wp)) q.note = 'already Loaded — skip';
          else if (!/^PickingPicked/i.test(q.wp)) q.note = `work pool ${q.wp} — skip`;
          else {
            const d = resolveDoor(q.dest, it.door);
            if (!d.door) q.note = d.src;
            else if (!DOOR_UUID[d.door]) q.note = `${d.door} has no trusted UUID`;
            else { q.door = d.door; q.uuid = DOOR_UUID[d.door]; q.status = 'ready'; q.note = (q.note ? q.note + '; ' : '') + 'door via ' + d.src; }
          }
        }
      } catch (e) { q.note = 'Rodeo error: ' + e.message; }
      queue.push(q); render();
    }
    const n = queue.filter(q => q.status === 'ready').length;
    setStatus(`Plan ready: ${n} to trickle, ${queue.length - n} skipped. Review, then Run.`);
  }
  async function run(limit, resumed) {
    stopFlag = false;
    const todo = queue.filter(q => q.status === 'ready').slice(0, limit || undefined);
    if (!todo.length) { GM_setValue('tk_resume', null); return setStatus('Nothing ready to run.'); }
    if (!resumed && !confirm(`Trickle ${todo.length} container(s)? These are REAL moves.`)) return;
    for (let n = 0; n < todo.length; n++) {
      const q = todo[n];
      if (stopFlag) { setStatus('Stopped by user.'); break; }
      if (!queue.includes(q) || q.status !== 'ready') continue; // removed with ✕
      if (!(await ensureReady(todo.slice(n)))) return;           // page reloading; run resumes after load
      setStatus(`Trickling ${q.csx} -> ${q.dest}/${q.door}...`);
      let res;
      try { res = await trickleOne(q); } catch (e) { res = { ok: false, note: e.message, halt: true, reset: true }; }
      q.status = res.ok ? 'moved' : 'failed'; q.note = res.note;
      log.push({ time: new Date().toISOString(), ...q }); render();
      if (res.reset) {
        // clear the half-finished screen so nothing carries into the next scan
        const x = [...document.querySelectorAll('div,a,span,button')].find(e => e.textContent.trim() === '[X]' && !e.closest('#tk-wrap'));
        if (x) { x.click(); await waitFor(() => pageState() === 'ready', 4000); }
      }
      if (res.halt) { setStatus('Halted for safety: ' + res.note); break; }
      await sleep(1200);
    }
    GM_setValue('tk_resume', null);
    const m = queue.filter(q => q.status === 'moved').length;
    setStatus(`Done. Moved ${m}. See table / export log.`);
  }
  function exportLog() {
    const rows = [['time', 'csx', 'dest', 'work_pool', 'door', 'uuid', 'status', 'note']]
      .concat(queue.map(q => [new Date().toISOString(), q.csx, q.dest, q.wp, q.door, q.uuid, q.status, q.note]));
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `trickle_log_${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.csv`;
    a.click();
  }

  // ---------- UI ----------
  const el = s => document.querySelector(s);
  function setStatus(s) { el('#tk-status').textContent = s; }
  function render() {
    const color = { ready: '#1a73e8', moved: '#188038', failed: '#d93025', skip: '#80868b' };
    el('#tk-rows').innerHTML = queue.map(q =>
      `<tr><td>${q.csx}</td><td>${q.dest}</td><td>${q.wp}</td><td>${q.door}</td>
       <td style="color:${color[q.status]};font-weight:600">${q.status}</td><td>${q.note}</td>
       <td style="text-align:center"><button class="tk-x" data-c="${q.csx}" title="Remove from queue" style="color:#d93025;font-weight:700;padding:0 6px">✕</button></td></tr>`).join('');
    el('#tk-rows').querySelectorAll('button.tk-x').forEach(b => b.onclick = () => {
      queue = queue.filter(q => q.csx !== b.dataset.c); render();
      const n = queue.filter(q => q.status === 'ready').length;
      setStatus(`Removed ${b.dataset.c}. ${n} ready.`);
    });
  }
  const panel = document.createElement('div');
  panel.innerHTML = `
  <div id="tk-wrap" style="position:fixed;top:8px;right:8px;width:900px;height:88vh;box-sizing:border-box;min-width:480px;min-height:120px;resize:both;overflow:auto;z-index:99999;
       background:#fff;border:2px solid #232f3e;border-radius:8px;font:13px sans-serif;box-shadow:0 4px 16px #0005">
    <div id="tk-hdr" title="Drag to move · drag any edge or corner to resize · double-click to reset" style="position:sticky;top:0;z-index:3;background:#232f3e;color:#fff;padding:6px 10px;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none">
      <b style="font-size:14px">⠿ KRB3 Auto Loader</b>
      <span><button id="tk-vrid" title="VRID compliance: past not completed, today, future already started" style="font-weight:700">📋 VRID compliance</button> <button id="tk-ref">Refresh Rodeo</button>
        <button id="tk-zo" title="Smaller text">A−</button><button id="tk-zi" title="Bigger text">A+</button>
        <button id="tk-min" title="Collapse">–</button></span></div>
    <div id="tk-body" style="padding:8px">

      <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;padding:6px;background:#e8f0fe;border-radius:6px">
        <b>🔍 Search csX</b>
        <input id="tk-find" placeholder="csX… (Enter to look up in Rodeo)" style="flex:1;font-family:monospace;padding:3px">
        <button id="tk-find-go">Search</button><button id="tk-find-x">✕</button></div>
      <div id="tk-find-out" style="margin-bottom:8px"></div>
      <div style="font-weight:700;font-size:14px;margin-bottom:4px">Loading trailers × Rodeo PickingPicked</div>
      <div id="sp-s" style="color:#333;margin-bottom:4px"></div>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="4">
        <thead style="background:#f1f3f4"><tr>
          <th></th><th>Dest</th><th>Door</th><th>VRID</th><th>CPT</th><th>Loading since</th>
          <th title="PickingPicked csX with this trailer's CPT">csX this CPT</th>
          <th title="All PickingPicked csX for this destination">csX all CPTs</th>
          <th>AtDest / InTransit / Other</th><th>Oldest dwell</th><th>Units</th><th></th></tr></thead>
        <tbody id="sp-r"></tbody></table>

      <div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:6px">
        <span id="tk-dw-info" style="color:#555"></span>
        <button id="tk-dwell" title="PickingPicked csX with a CPT before today, for destinations with a loading trailer" style="font-weight:700;background:#fde0dc;border:1px solid #a50e0e;padding:4px 10px">🖨 Past CPTs</button>
        <button id="tk-dwell2" title="csX on any CPT from today on (current or future) with Rodeo dwell of 1 hour or more" style="font-weight:700;background:#fff3b0;border:1px solid #7a5c00;padding:4px 10px">🖨 Current CPT &gt;1h</button></div>
      <details style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">Load from file / paste / Rodeo scrape</summary>
        <div id="tk-drop" style="border:2px dashed #999;padding:10px;text-align:center;margin:6px 0">
          Drop a .txt / .csv with csX IDs (optional dest per line, e.g. <code>csXA4GjXNV7 - SCK6</code>)<br>
          <input type="file" id="tk-file" accept=".txt,.csv"></div>
        <textarea id="tk-paste" rows="3" style="width:100%" placeholder="...or paste csX list here"></textarea>
        <button id="tk-plan-list">Verify list</button>
        <div style="margin-top:6px">Date <input id="tk-date" type="date"> CPT <input id="tk-time" type="time" value="16:00">
          Process path <input id="tk-pp" value="PPTransConDays2CasePicking" style="width:200px">
          <button id="tk-plan-rodeo">Scrape + verify</button></div>
        <div style="margin-top:6px">Door overrides (e.g. <code>LGB7=DD208</code>): <input id="tk-ovr" style="width:60%"></div>
      </details>

      <div style="font-weight:700;font-size:14px;margin:10px 0 4px">Trickle queue</div>
      <div id="tk-ssp" style="color:#555;margin-bottom:4px"></div>
      <button id="tk-test">Run FIRST only</button>
      <button id="tk-run">Run all ready</button>
      <button id="tk-stop" style="color:#d93025">Stop</button>
      <button id="tk-export">Export log</button>
      <button id="tk-clear" title="Empty the queue (does not undo moves)">Clear</button>
      <div id="tk-status" style="margin:6px 0;font-weight:600">Idle.</div>
      <table style="width:100%;border-collapse:collapse" border="1" cellpadding="3">
        <thead style="background:#f1f3f4"><tr><th>csX</th><th>Dest</th><th>Work pool</th><th>Door</th><th>Status</th><th>Note</th><th style="width:32px"></th></tr></thead>
        <tbody id="tk-rows"></tbody></table>
    </div></div>`;
  document.body.appendChild(panel);

  // ---------- Loading-trailer board (SSP feed + Rodeo PickingPicked) ----------
  let picked = [], pickedTs = 0, pickedErr = '';
  const openRows = new Set();
  async function refreshRodeo() {
    el('#sp-s').textContent = 'Pulling Rodeo PickingPicked…';
    try {
      picked = await rodeoAllPages(`${RODEO}/ItemList?_enabledColumns=on&WorkPool=PickingPicked&enabledColumns=OUTER_SCANNABLE_ID&enabledColumns=OUTER_CONTAINER_TYPE&shipmentType=TRANSSHIPMENTS`);
      pickedTs = Date.now(); pickedErr = '';
    } catch (e) { pickedErr = e.message; }
    renderBoard();
  }
  const rowFilter = {};
  const isPastCpt = c => (c || '').slice(0, 10) < new Date().toLocaleDateString('en-CA');   // CPT before today (same rule as the Past CPTs print list)
  const ppCache = {}, ppPending = new Set();
  function loadPP(list) {
    const todo = list.filter(r => !ppCache[r.csx] && !ppPending.has(r.csx));
    if (!todo.length) return;
    todo.forEach(r => ppPending.add(r.csx));
    let i = 0, done = 0;
    const worker = async () => {
      while (i < todo.length) {
        const r = todo[i++];
        try { const b = await lastBinFor(r.csx); ppCache[r.csx] = { iso: b.pickIso || '' }; }
        catch (e) { ppCache[r.csx] = { err: e.message }; }
        ppPending.delete(r.csx);
        if (++done % 10 === 0) renderBoard();
      }
    };
    Promise.all([1, 2, 3, 4].map(worker)).then(() => renderBoard());
  }
  const dwellBadge = s => {
    const m = dwellMin(s);
    if (!m && !s) return '-';
    const st = m >= 1440 ? 'background:#fde0dc;color:#a50e0e' : m >= 60 ? 'background:#fff3b0;color:#7a5c00' : 'background:#d4f5d4;color:#146c2e';
    const txt = (s || '').replace(/^\d+m\|/, '').trim();
    return `<span style="${st};font-weight:600;padding:1px 6px;border-radius:4px;display:inline-block">${esc(txt || (m < 60 ? m + 'm' : fmtMin(m)))}</span>`;
  };
  const ppCell = r => {
    const pp = ppCache[r.csx];
    if (!pp) return '<span style="color:#888">…</span>';
    if (pp.err) return `<span style="color:#d93025" title="${esc(pp.err)}">FCR?</span>`;
    if (!pp.iso) return '<span style="color:#888" title="No pick-from-bin move in FC Research history">n/a</span>';
    const m = Math.max(0, Math.round((Date.now() - Date.parse(pp.iso)) / 60000));
    const st = m >= 1440 ? 'background:#fde0dc;color:#a50e0e' : m >= 60 ? 'background:#fff3b0;color:#7a5c00' : 'background:#d4f5d4;color:#146c2e';
    return `<span style="${st};font-weight:600;padding:1px 6px;border-radius:4px;display:inline-block" title="Picked from bin ${esc(new Date(pp.iso).toLocaleString())}">${m < 60 ? m + 'm' : fmtMin(m)}</span>`;
  };
  const selOvr = {};  // key -> Map(csX -> true/false) set by the user
  const isSel = (key, r, cpt) => { const m = selOvr[key]; return m && m.has(r.csx) ? m.get(r.csx) : false; };  // nothing checked until the user checks it
  const setSel = (key, csx, v) => { (selOvr[key] = selOvr[key] || new Map()).set(csx, v); };
  function detail(list, key, cpt) {
    if (!list.length) return '<i style="color:#888">No PickingPicked csX for this destination.</i>';
    const cur = list.filter(r => r.cpt === cpt).sort((a, b) => dwellMin(b.dwell) - dwellMin(a.dwell));
    const byCpt = (a, b) => (a.cpt || '').localeCompare(b.cpt || '') || dwellMin(b.dwell) - dwellMin(a.dwell);
    const past = list.filter(r => r.cpt !== cpt && isPastCpt(r.cpt)).sort(byCpt);
    const later = list.filter(r => r.cpt !== cpt && !isPastCpt(r.cpt)).sort(byCpt);
    const sorted = cur.concat(past, later);
    const curOver = list.filter(r => !isPastCpt(r.cpt) && dwellMin(r.dwell) >= 60).length;
    const pastN = past.length;
    const row = r => {
      const isCur = r.cpt === cpt, isPast = !isCur && isPastCpt(r.cpt), other = !isCur;
      const tag = isCur ? ' current' : isPast ? ' past' : ' other';
      return `<tr class="sp-dr" style="${isPast ? 'background:#f3e8fd' : other ? 'background:#f1f3f4' : ''}" data-s="${esc((r.csx + ' ' + r.outer + ' ' + r.wp + ' ' + r.pp + ' ' + r.status + ' ' + r.cpt + tag).toLowerCase())}">
        <td style="font-family:monospace">${esc(r.csx)}</td>
        <td style="${isPast ? 'color:#6a1b9a;font-weight:600' : other ? 'color:#555' : ''}">${esc((r.cpt || '').replace(/^\d{4}-/, ''))}${isPast ? ' <small>(past CPT)</small>' : other ? ' <small>(current CPT)</small>' : ''}</td>
        <td>${esc((r.wp || '').replace('PickingPicked', 'PP·'))}</td>
        <td>${esc(r.pp)}</td><td style="font-family:monospace">${esc(r.outer)}</td><td>${esc(r.outerType)}</td>
        <td style="text-align:center"><input type="checkbox" class="sp-one" data-k="${esc(key)}" data-c="${esc(r.csx)}" ${isSel(key, r, cpt) ? 'checked' : ''}></td>
        <td title="Rodeo dwell: ${esc((r.dwell || '').replace(/^\d+m\|/, ''))}">${dwellBadge(r.dwell)}</td><td>${esc(r.status)}</td></tr>`;
    };
    return `<button class="sp-copy" data-ids="${esc(sorted.map(r => r.csx).join('\n'))}">Copy ${sorted.length} csX</button>
      <button class="sp-cur" data-k="${esc(key)}" ${cur.length ? '' : 'disabled'} title="Check every csX on this trailer's CPT">Check ${cur.length} this-CPT</button>
      <button class="sp-past" data-k="${esc(key)}" ${past.length ? '' : 'disabled'} title="Check every csX from past CPTs">Check ${past.length} past-CPT</button>
      <button class="sp-print" data-d="${esc(key.split('|')[0])}" ${pastN ? '' : 'disabled'} title="Print this destination's csX with a CPT before today" style="font-weight:700;background:#fde0dc;border:1px solid #a50e0e">🖨 ${esc(key.split('|')[0])} past CPTs (${pastN})</button>
      <button class="sp-print2" data-d="${esc(key.split('|')[0])}" ${curOver ? '' : 'disabled'} title="Print this destination's current csX (any CPT from today on) with Rodeo dwell 1 hour or more" style="font-weight:700;background:#fff3b0;border:1px solid #7a5c00">🖨 current CPT &gt;1h (${curOver})</button>
      <input class="sp-filter" data-k="${esc(key)}" value="${esc(rowFilter[key] || '')}" placeholder="Filter (csX, outer, pool, CPT, 'past'…)" style="width:240px;margin-left:8px;font-family:monospace">
      <span class="sp-fcount" style="color:#555;margin-left:6px"></span>
      <div style="margin-top:3px;color:#555">${cur.length} on this CPT · <span style="color:#6a1b9a;font-weight:600">${past.length} on past CPTs</span> (purple, before today)${later.length ? ` · <span style="color:#555">${later.length} on another current CPT</span> (grey)` : ''}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:4px;font-size:12px" border="1" cellpadding="3">
      <thead style="background:#fafafa"><tr><th>csX</th><th>CPT</th><th>Work pool</th><th>Process path</th><th>Outer</th><th>Outer type</th>
        <th title="Select / clear all shown"><input type="checkbox" class="sp-all" data-k="${esc(key)}" ${sorted.every(r => isSel(key, r, cpt)) ? 'checked' : ''}></th><th title="Rodeo dwell time">Dwell</th><th>Status</th></tr></thead>
      <tbody>${sorted.map(row).join('')}</tbody></table>`;
  }
  function renderBoard() {
    if (document.activeElement && document.activeElement.classList.contains('sp-filter')) return; // don't wipe while typing
    const ssp = GM_getValue('ssp_doors', null);
    const loads = ssp ? ssp.rows.filter(r => isLoading(r.status)) : [];
    const sspAge = ssp ? (Date.now() - ssp.ts) / 60000 : null;
    const rAge = pickedTs ? `${((Date.now() - pickedTs) / 60000).toFixed(0)} min ago` : 'never';
    let s = !ssp
      ? '<span style="color:#d93025">No SSP feed — open the SSP OB Dock page in another tab and leave it open.</span>'
      : `<b>${loads.length}</b> trailers Loading In Progress (SSP ${sspAge.toFixed(0)} min ago${sspAge > 30 ? ' — <span style="color:#d93025">STALE, refresh SSP tab</span>' : ''})`;
    s += pickedErr ? ` · <span style="color:#d93025">Rodeo error: ${esc(pickedErr)}</span>`
      : ` · <b>${picked.length}</b> PickingPicked csX (Rodeo ${rAge})` + (` · ${picked.pages || 1} Rodeo page(s)`) + (picked.capped ? ' · <span style="color:#b06000">hit page limit — counts may be low</span>' : '');
    el('#sp-s').innerHTML = s;
    const rows = loads.slice().sort((a, b) => normCpt(a.cpt).localeCompare(normCpt(b.cpt)) || a.dest.localeCompare(b.dest));
    el('#sp-r').innerHTML = rows.map((l, i) => {
      const cpt = normCpt(l.cpt), key = l.dest + '|' + l.door;
      const all = picked.filter(p => p.dest === l.dest);
      const atCpt = all.filter(p => p.cpt === cpt);
      const atDest = atCpt.filter(p => /AtDestination/.test(p.wp)).length;
      const inTr = atCpt.filter(p => /InTransit/.test(p.wp)).length;
      const oldest = atCpt.reduce((m, p) => Math.max(m, dwellMin(p.dwell)), 0);
      const units = atCpt.reduce((t, p) => t + (+p.qty || 0), 0);
      const hasUuid = !!DOOR_UUID[l.door];
      const isOpen = openRows.has(key);
      const nSel = all.filter(p => isSel(key, p, cpt)).length;
      const nPast = all.filter(p => p.cpt !== cpt && isPastCpt(p.cpt)).length;
      const nLater = all.length - atCpt.length - nPast;
      const cptMs = cpt ? Date.parse(cpt.replace(' ', 'T')) : NaN;
      const farOut = !isNaN(cptMs) && cptMs - Date.now() > 24 * 3600000;   // loading a VRID whose CPT is >24h away
      return `<tr style="${farOut ? 'background:#fde0dc;outline:2px solid #a50e0e' : atCpt.length ? 'background:#fef7e0' : nPast ? 'background:#f3e8fd' : 'background:#d4f5d4'}" title="${farOut ? 'Loading a VRID whose CPT is more than 24 hours away' : !atCpt.length && !nPast ? 'All loaded: no PickingPicked csX left for this destination' : ''}">
        <td><button class="sp-x" data-k="${esc(key)}">${isOpen ? '▾' : '▸'}</button></td>
        <td><b>${esc(l.dest)}</b>${!atCpt.length && !nPast ? '<br><span style="color:#146c2e;font-weight:700;font-size:11px">✓ all loaded</span>' : ''}</td>
        <td style="color:${hasUuid ? '#188038' : '#d93025'};font-weight:600" title="${hasUuid ? 'door UUID known' : 'no trusted UUID — cannot trickle'}">${esc(l.door)}</td>
        <td style="font-family:monospace" title="Trailer: ${esc(l.trailer || '-')}">${esc(l.vrid || '-')}${farOut ? '<br><b style="color:#a50e0e;font-size:11px">⚠ CPT &gt;24h out</b>' : ''}</td><td>${esc(l.cpt)}</td><td>${esc(l.since)}</td>
        <td style="text-align:center;font-weight:700;font-size:14px">${atCpt.length}</td>
        <td style="text-align:center">${all.length}${nPast ? `<br><small style="color:#6a1b9a">${nPast} past CPT</small>` : ''}${all.length - nPast ? `<br><small style="color:#7a5c00">${all.length - nPast} current CPT</small>` : ''}</td>
        <td style="text-align:center">${atDest} / ${inTr} / ${atCpt.length - atDest - inTr}</td>
        <td style="${oldest > 1440 ? 'color:#d93025;font-weight:600' : ''}">${oldest ? fmtMin(oldest) : '-'}</td>
        <td style="text-align:right">${units || '-'}</td>
        <td><button class="sp-q" data-i="${i}" ${nSel && hasUuid ? '' : 'disabled'} title="Verify the checked csX (any CPT) and add them to the queue below">Queue ${nSel}</button></td></tr>
        ${isOpen ? `<tr><td></td><td colspan="11">${detail(all, key, cpt)}</td></tr>` : ''}`;
    }).join('') || '<tr><td colspan="12" style="text-align:center;color:#888;padding:10px">No trailers Loading In Progress</td></tr>';
    el('#sp-r').querySelectorAll('button.sp-x').forEach(b => b.onclick = () => { const k = b.dataset.k; openRows.has(k) ? openRows.delete(k) : openRows.add(k); renderBoard(); });
    const applyFilter = inp => {
      const q = inp.value.trim().toLowerCase(); rowFilter[inp.dataset.k] = inp.value;
      const tbl = inp.parentElement.querySelectorAll('tr.sp-dr'); let n = 0;
      tbl.forEach(tr => { const hit = !q || tr.dataset.s.includes(q); tr.style.display = hit ? '' : 'none'; if (hit) n++; });
      inp.nextElementSibling.textContent = q ? `${n} of ${tbl.length}` : '';
    };
    el('#sp-r').querySelectorAll('input.sp-filter').forEach(inp => { inp.oninput = () => applyFilter(inp); applyFilter(inp); });
    el('#sp-r').querySelectorAll('input.sp-one').forEach(cb => cb.onchange = () => { setSel(cb.dataset.k, cb.dataset.c, cb.checked); renderBoard(); });
    el('#sp-r').querySelectorAll('input.sp-all').forEach(cb => cb.onchange = () => {
      cb.closest('table').querySelectorAll('tr.sp-dr').forEach(tr => {
        if (tr.style.display === 'none') return;     // only rows shown by the filter
        setSel(cb.dataset.k, tr.querySelector('input.sp-one').dataset.c, cb.checked);
      });
      renderBoard();
    });
    el('#sp-r').querySelectorAll('button.sp-print').forEach(b => b.onclick = () => printDwell(b.dataset.d, b, 'past'));
    el('#sp-r').querySelectorAll('button.sp-print2').forEach(b => b.onclick = () => printDwell(b.dataset.d, b, 'current'));
    el('#sp-r').querySelectorAll('button.sp-cur').forEach(b => b.onclick = () => {
      b.parentElement.querySelectorAll('tr.sp-dr').forEach(tr => { if (/ current$/.test(tr.dataset.s)) setSel(b.dataset.k, tr.querySelector('input.sp-one').dataset.c, true); });
      renderBoard();
    });
    el('#sp-r').querySelectorAll('button.sp-past').forEach(b => b.onclick = () => {
      b.parentElement.querySelectorAll('tr.sp-dr').forEach(tr => { if (/ past$/.test(tr.dataset.s)) setSel(b.dataset.k, tr.querySelector('input.sp-one').dataset.c, true); });
      renderBoard();
    });
    el('#sp-r').querySelectorAll('button.sp-copy').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.ids); b.textContent = 'Copied'; });
    el('#sp-r').querySelectorAll('button.sp-q').forEach(b => b.onclick = () => {
      const l = rows[+b.dataset.i], cpt = normCpt(l.cpt);
      const key = l.dest + '|' + l.door;
      const items = picked.filter(p => p.dest === l.dest && isSel(key, p, cpt));
      if (!items.length) return setStatus('No csX checked for this trailer.');
      stopFlag = false;
      setStatus(`Verifying ${items.length} csX for ${l.dest} ${l.door} ${l.cpt}…`);
      buildPlan(items.map(p => ({ csx: p.csx, dest: p.dest, door: l.door })));
    });
  }
  async function findCsx() {
    const raw = el('#tk-find').value.trim();
    const out = el('#tk-find-out');
    if (!raw) { out.innerHTML = ''; return; }
    const ssp = GM_getValue('ssp_doors', null);
    const loadsNow = ssp ? ssp.rows.filter(r => isLoading(r.status)) : [];
    const show = (r, src) => {
      const door = resolveDoor(r.dest);
      const trl = loadsNow.filter(l => l.dest === r.dest);
      const movable = /^PickingPicked/i.test(r.wp || '') && door.door && DOOR_UUID[door.door];
      return `<tr><td style="font-family:monospace;font-weight:700">${esc(r.csx)}</td><td><b>${esc(r.dest)}</b></td><td>${esc(r.wp)}</td>
        <td>${esc(r.cpt)}</td><td>${esc(r.pp || '')}</td><td style="font-family:monospace">${esc(r.outer || '')}</td><td>${esc(r.qty || '')}</td>
        <td style="${dwellMin(r.dwell) > 1440 ? 'color:#d93025;font-weight:600' : ''}" title="Rodeo: ${esc(r.dwell || '')}">${esc(fmtDwell(r.dwell))}</td>
        <td>${door.door ? `<b style="color:${DOOR_UUID[door.door] ? '#188038' : '#d93025'}">${esc(door.door)}</b>` : `<span style="color:#d93025">${esc(door.src)}</span>`}
          ${trl.length ? `<br><small>${trl.map(l => esc(l.door + ' ' + l.cpt)).join('<br>')}</small>` : ''}</td>
        <td><small>${src}</small></td>
        <td><button class="tk-fq" data-c="${esc(r.csx)}" data-d="${esc(r.dest)}" ${movable ? '' : 'disabled'}>Queue</button></td></tr>`;
    };
    const head = '<table style="width:100%;border-collapse:collapse;font-size:12px" border="1" cellpadding="3"><thead style="background:#fafafa"><tr><th>csX</th><th>Dest</th><th>Work pool</th><th>CPT</th><th>Process path</th><th>Outer</th><th>Qty</th><th>Dwell</th><th>Door (SSP)</th><th>Source</th><th></th></tr></thead><tbody>';
    // partial match against the loaded PickingPicked list
    const q = raw.toLowerCase();
    const local = picked.filter(r => r.csx.toLowerCase().includes(q) || (r.outer || '').toLowerCase().includes(q)).slice(0, 50);
    let html = '';
    if (local.length) html = head + local.map(r => show(r, 'loaded list')).join('') + '</tbody></table>' + (local.length === 50 ? '<small>first 50 matches</small>' : '');
    // exact Rodeo lookup for a full csX (case-sensitive), to catch anything past the 1000-row limit / other pools
    const exact = (raw.match(/csX[A-Za-z0-9]{8}/) || [])[0];
    if (exact && !local.some(r => r.csx === exact)) {
      out.innerHTML = (html || '') + `<div style="color:#555">Looking up ${esc(exact)} in Rodeo…</div>`;
      try {
        const r = await verifyInRodeo(exact);
        html += r ? head + show(r, 'Rodeo exact') + '</tbody></table>'
          : `<div style="color:#d93025;font-weight:600">${esc(exact)} not found in Rodeo ItemList (typo — check O/0, l/I, case — or ICQA / re-stowed / deleted).</div>`;
      } catch (e) { html += `<div style="color:#d93025">Rodeo error: ${esc(e.message)}</div>`; }
    }
    if (!html) html = `<div style="color:#888">No match in the loaded list. Type a full 11-character csX to look it up in Rodeo.</div>`;
    out.innerHTML = html;
    out.querySelectorAll('button.tk-fq').forEach(b => b.onclick = () => {
      stopFlag = false;
      const keep = queue.filter(x => x.csx !== b.dataset.c);
      buildPlan([{ csx: b.dataset.c, dest: b.dataset.d }]).then(() => { queue = keep.concat(queue); render(); setStatus(`${b.dataset.c} added to the queue.`); });
      b.textContent = 'Queued'; b.disabled = true;
    });
  }
  el('#tk-find-go').onclick = findCsx;
  el('#tk-find').addEventListener('keydown', e => { if (e.key === 'Enter') findCsx(); });
  el('#tk-find').addEventListener('input', () => { const v = el('#tk-find').value.trim(); if (v.length >= 4 && !/^csX[A-Za-z0-9]{8}$/.test(v)) findCsx(); });
  el('#tk-find-x').onclick = () => { el('#tk-find').value = ''; el('#tk-find-out').innerHTML = ''; };
  // ---------- Dwell paper pick list: csX for dests with a loading trailer, NOT on that trailer's current CPT ----------
  function dwellRows(mode) {
    const ssp = GM_getValue('ssp_doors', null);
    const loads = ssp ? ssp.rows.filter(r => isLoading(r.status)) : [];
    const byDest = {};
    loads.forEach(l => { (byDest[l.dest] = byDest[l.dest] || { doors: new Set(), cpts: new Set() }); byDest[l.dest].doors.add(l.door); byDest[l.dest].cpts.add(normCpt(l.cpt)); });
    const today = new Date().toLocaleDateString('en-CA');               // site-local YYYY-MM-DD
    const rows = picked.filter(p => {
        const d = byDest[p.dest]; if (!d) return false;
        if (mode === 'current') return (p.cpt || '').slice(0, 10) >= today && dwellMin(p.dwell) >= 60;   // current = any CPT from today on (incl. future VRIDs), Rodeo dwell 1h+
        return (p.cpt || '').slice(0, 10) < today;                                      // past: CPT before today
      })
      .map(p => ({ ...p, onCur: byDest[p.dest].cpts.has(p.cpt), doors: [...byDest[p.dest].doors].join(' / '), curCpt: [...byDest[p.dest].cpts].join(', ') }));
    rows.sort((a, b) => a.dest.localeCompare(b.dest) || (a.outer || '').localeCompare(b.outer || '') || dwellMin(b.dwell) - dwellMin(a.dwell));
    return rows;
  }
  // ---------- FC Research: last bin from Container history ----------
  const FCR = 'https://qi-fcresearch-na.corp.amazon.com/' + SITE;
  const isBin = c => /^P-\d+-[A-Z]\d{3}[A-Z]\d{3}/.test(c || '');
  function fcrHistory(csx) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url: FCR + '/results/container-history', timeout: 20000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, data: 's=' + encodeURIComponent(csx),
        onload: r => {
          if (r.status !== 200) return reject(new Error('HTTP ' + r.status));
          if (/midway|Authentication Portal/i.test(r.finalUrl || '') || /midway-auth/i.test(r.responseText.slice(0, 3000))) return reject(new Error('FC Research sign-in needed'));
          const rows = (r.responseText.match(/<tr[^>]*data-row-id="[^"]*"[^>]*>[\s\S]*?<\/tr>/g) || []).map(tr => {
            const tds = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(td => td.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
            return { iso: (tr.match(/data-row-id="([^"]*)"/) || [])[1] || '', date: tds[0] || '', by: tds[2] || '', oldC: tds[3] || '', newC: tds[4] || '', client: tds[5] || '' };
          }).sort((a, b) => b.iso.localeCompare(a.iso));
          resolve(rows);
        },
        onerror: () => reject(new Error('network error')), ontimeout: () => reject(new Error('timeout')),
      });
    });
  }
  async function lastBinFor(csx) {
    const cache = GM_getValue('fcr_bins', {});
    const c = cache[csx];
    if (c && c.pickIso !== undefined && c.pickedBy !== undefined && Date.now() - c.ts < 30 * 60000) return c;
    let rows, wait = 1500;
    for (let a = 0; ; a++) {
      try { rows = await fcrHistory(csx); break; }
      catch (e) {
        if (a < 4 && /HTTP (429|5\d\d)|timeout|network/.test(e.message)) { await sleep(wait + Math.random() * 500); wait *= 2; continue; }
        throw e;
      }
    }
    const hit = rows.find(r => isBin(r.oldC)) || rows.find(r => isBin(r.newC));
    const latest = rows[0];
    const res = { ts: Date.now(),
      bin: hit ? (isBin(hit.oldC) ? hit.oldC : hit.newC) : '',
      binWhen: hit ? hit.date.replace(/:\d\d MST$/, '') : '',
      nowAt: latest ? latest.newC : '', nowWhen: latest ? latest.date.replace(/:\d\d MST$/, '') : '',
      pickIso: hit && isBin(hit.oldC) ? hit.iso : '',
      lastBy: latest ? latest.by : '', lastByWhen: latest ? latest.date.replace(/:\d\d MST$/, '') : '',
      ...(() => { const pk = rows.find(r => /PickComplete/i.test(r.client)) || rows.find(r => isBin(r.oldC) && !isBin(r.newC));
        return { pickedBy: pk ? pk.by : '', pickedWhen: pk ? pk.date.replace(/:\d\d MST$/, '') : '' }; })() };
    const all = GM_getValue('fcr_bins', {}); all[csx] = res;
    for (const k of Object.keys(all)) if (Date.now() - all[k].ts > 6 * 3600000) delete all[k];
    GM_setValue('fcr_bins', all);
    return res;
  }
  async function lookupBins(rows, onProgress) {
    let i = 0, done = 0, authErr = '';
    const worker = async () => {
      while (i < rows.length && !authErr) {
        const r = rows[i++];
        try {
          Object.assign(r, await lastBinFor(r.csx)); await sleep(150);
          if (isBin(r.outer)) { r.bin = r.outer; r.binErr = ''; r.nowAt = r.outer + ' (Rodeo)'; r.nowWhen = ''; }   // Rodeo shows it sitting in a bin
        }
        catch (e) {
          if (isBin(r.outer)) { r.bin = r.outer; r.binErr = ''; r.nowAt = r.outer + ' (Rodeo)'; r.nowWhen = ''; }
          else { r.bin = ''; r.binErr = /429/.test(e.message) ? 'FC Research busy — reprint' : e.message; }
          r.lastBy = ''; r.pickedBy = ''; if (/sign-in/.test(e.message)) authErr = e.message;
        }
        onProgress(++done, rows.length);
      }
    };
    await Promise.all([1, 2].map(worker));
    return authErr;
  }

  async function printDwell(onlyDest, btnEl, mode) {
    mode = mode || 'past';
    let rows = dwellRows(mode).filter(r => !onlyDest || r.dest === onlyDest);
    if (!rows.length) return alert(onlyDest ? `No ${mode === 'current' ? 'current-CPT csX over 1h' : 'past-CPT csX'} for ${onlyDest}.` : (mode === 'current' ? 'No current-CPT csX dwelling 1 hour or more.' : 'No past-CPT csX for the loading destinations.'));
    const w = window.open('', '_blank'); // open now so the pop-up isn't blocked
    if (!w) return alert('Pop-up blocked — allow pop-ups for this site.');
    // ---- choose which CPT hours and dwell times to pull ----
    const hourOf = r => ((r.cpt || '').match(/\d{2}:\d{2}$/) || ['??'])[0];
    const BK = [['lt1', '< 1h', 0, 60], ['1-2', '1–2h', 60, 120], ['2-4', '2–4h', 120, 240], ['4-8', '4–8h', 240, 480],
                ['8-24', '8–24h', 480, 1440], ['1-3d', '1–3 days', 1440, 4320], ['3d', '3+ days', 4320, Infinity]];
    const bkOf = r => { const m = dwellMin(r.dwell) || 0; return (BK.find(b => m >= b[2] && m < b[3]) || BK[0])[0]; };
    const hours = {};
    rows.forEach(r => { const h = hourOf(r); (hours[h] = hours[h] || { n: 0, dates: new Set() }).n++; hours[h].dates.add((r.cpt || '').slice(5, 10)); });
    const hk = Object.keys(hours).sort();
    const bkUsed = BK.filter(b => rows.some(r => bkOf(r) === b[0]));
    w.document.write(`<!doctype html><html><head><title>Pick CPT hours and dwell</title><style>
      body{font:14px Arial,sans-serif;margin:20px} h1{font-size:18px;margin:0 0 4px} .sub{color:#555;margin-bottom:12px}
      h3{font-size:14px;margin:14px 0 4px}
      label.h{display:flex;align-items:center;gap:10px;border:1px solid #ccc;border-radius:6px;padding:8px 12px;margin:6px 0;cursor:pointer;max-width:520px}
      label.h:hover{background:#f6f6f6} label.h b{font-size:16px;min-width:80px} .n{margin-left:auto;font-weight:700}
      .dw{display:flex;flex-wrap:wrap;gap:6px;max-width:560px}
      label.d{border:1px solid #ccc;border-radius:6px;padding:6px 10px;cursor:pointer;display:flex;gap:6px;align-items:center}
      label.d:hover{background:#f6f6f6} label.d .c{color:#555;font-weight:700}
      button{font-size:14px;padding:6px 14px;margin-right:6px} #go{font-weight:700;background:#fef7e0;border:1px solid #b06000}
    </style></head><body>
      <h1>KRB3 Dwell Pick List${onlyDest ? ' — ' + esc(onlyDest) : ''}: choose what to pull</h1>
      <div class="sub">${mode === 'current' ? 'Current CPTs (today + future), dwell 1h+' : 'Past CPTs (before today)'} · ${rows.length} csX total</div>
      <h3>CPT hour <button class="sm" data-g="hr" data-v="1">All</button><button class="sm" data-g="hr" data-v="0">None</button></h3>
      ${hk.map(h => `<label class="h"><input type="checkbox" class="hr" value="${esc(h)}" checked><b>${esc(h)}</b>
        <span style="color:#666">${[...hours[h].dates].sort().join(', ')}</span><span class="n" data-h="${esc(h)}">${hours[h].n} csX</span></label>`).join('')}
      <h3>Dwell time (Rodeo) <button class="sm" data-g="dw" data-v="1">All</button><button class="sm" data-g="dw" data-v="0">None</button></h3>
      <div class="dw">${bkUsed.map(b => `<label class="d"><input type="checkbox" class="dw" value="${b[0]}" checked>${esc(b[1])} <span class="c" data-b="${b[0]}"></span></label>`).join('')}</div>
      <div style="margin-top:14px"><button id="go">Build pick list (<span id="cnt">${rows.length}</span> csX)</button></div>
    </body></html>`);
    w.document.close();
    const picks = await new Promise(resolve => {
      const d = w.document, hb = [...d.querySelectorAll('input.hr')], db = [...d.querySelectorAll('input.dw')];
      const sel = () => ({ h: new Set(hb.filter(b => b.checked).map(b => b.value)), b: new Set(db.filter(b => b.checked).map(b => b.value)) });
      const upd = () => {
        const s = sel();
        d.getElementById('cnt').textContent = rows.filter(r => s.h.has(hourOf(r)) && s.b.has(bkOf(r))).length;
        d.querySelectorAll('[data-b]').forEach(x => x.textContent = rows.filter(r => s.h.has(hourOf(r)) && bkOf(r) === x.dataset.b).length);
        d.querySelectorAll('[data-h]').forEach(x => x.textContent = rows.filter(r => hourOf(r) === x.dataset.h && s.b.has(bkOf(r))).length + ' csX');
      };
      [...hb, ...db].forEach(b => b.onchange = upd);
      d.querySelectorAll('button.sm').forEach(btn => btn.onclick = () => { (btn.dataset.g === 'hr' ? hb : db).forEach(b => b.checked = btn.dataset.v === '1'); upd(); });
      d.getElementById('go').onclick = () => { const s = sel(); if (!s.h.size || !s.b.size) return w.alert('Pick at least one CPT hour and one dwell range.');
        if (!rows.some(r => s.h.has(hourOf(r)) && s.b.has(bkOf(r)))) return w.alert('No csX match that selection.'); resolve(s); };
      upd();
      const t = setInterval(() => { if (w.closed) { clearInterval(t); resolve(null); } }, 500);
    });
    if (!picks) return;
    rows = rows.filter(r => picks.h.has(hourOf(r)) && picks.b.has(bkOf(r)));
    const hrsLabel = (picks.h.size === hk.length ? 'all CPT hours' : 'CPT ' + [...picks.h].sort().join(', ')) +
      (picks.b.size === bkUsed.length ? '' : ' · dwell ' + BK.filter(b => picks.b.has(b[0])).map(b => b[1]).join(', '));
    w.document.open();
    w.document.write('<p style="font:14px Arial">Looking up last bin locations in FC Research… <span id="p">0</span>/' + rows.length + '</p>');
    const btn = btnEl || el('#tk-dwell'); const btnLabel = btn.textContent; btn.disabled = true;
    const authErr = await lookupBins(rows, (d, n) => { btn.textContent = `🖨 FC Research ${d}/${n}…`; const s = w.document.getElementById('p'); if (s) s.textContent = d; });
    btn.disabled = false; btn.textContent = btnLabel;
    const now = new Date().toLocaleString();
    const dests = [...new Set(rows.map(r => r.dest))];
    // Walk order for one-way aisle pairs: P-<floor>-<mod><aisle><level><position>, e.g. P-1-V202A505.
    // Aisles pair up (201-202, 203-204, ...). Pairs alternate direction:
    // 201-202 high->low position, 203-204 low->high, 205-206 high->low, ...
    const binParts = b => { const m = (b || '').match(/^P-(\d+)-([A-Z])(\d+)([A-Z])(\d+)/); return m ? { floor: +m[1], mod: m[2], aisle: +m[3], level: m[4], pos: +m[5] } : null; };
    const walkKey = b => {
      const x = binParts(b); if (!x) return null;
      const pair = Math.ceil(x.aisle / 2);           // 201,202 -> 101 ; 203,204 -> 102
      const desc = pair % 2 === 1;                   // 101 (201-202) descending, 102 ascending, ...
      return { floor: x.floor, mod: x.mod, pair, pos: desc ? -x.pos : x.pos, aisle: x.aisle, level: x.level };
    };
    const byBin = (a, b) => {
      if (!a.bin !== !b.bin) return a.bin ? -1 : 1;              // no-bin rows last
      const ka = walkKey(a.bin), kb = walkKey(b.bin);
      if (ka && kb) return ka.floor - kb.floor || ka.mod.localeCompare(kb.mod) || ka.pair - kb.pair ||
        ka.pos - kb.pos || ka.aisle - kb.aisle || ka.level.localeCompare(kb.level) || dwellMin(b.dwell) - dwellMin(a.dwell);
      if (ka !== kb) return ka ? -1 : 1;                         // odd-format bins after normal ones
      return (a.bin < b.bin ? -1 : a.bin > b.bin ? 1 : 0) || dwellMin(b.dwell) - dwellMin(a.dwell);
    };
    const sd = t => (t || '').replace(/^\d{4}-/, '');
    const rowHtml = (r, i, withDest) => `<tr data-w="${i}" data-dw="${dwellMin(r.dwell) || 0}" data-bin="${esc(r.bin || '~')}"><td>${i + 1}</td>${withDest ? `<td class="b">${esc(r.dest)}</td><td>${esc(r.doors)}</td>` : ''}
        <td class="m b big">${r.bin ? esc(r.bin) : `<span class="g">${esc(r.binErr || 'no bin in history')}</span>`}</td>
        <td class="m b">${esc(r.csx)}</td>
        <td class="m" title="${esc(r.nowAt || '')} ${esc(r.nowWhen || '')}">${esc(r.nowAt || '')} <span class="s">${esc(sd(r.nowWhen).replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, ''))}</span></td>
        <td>${esc(sd(r.cpt))}${r.onCur ? ' <b class="cur">CURRENT</b>' : ''}</td>
        <td class="${dwellMin(r.dwell) >= 1440 ? 'red' : ''}">${esc((r.dwell || '').replace(/^\d+m\|/, '') || '-')}</td><td class="bx">☐</td><td class="bx">☐</td><td class="m" title="${esc(r.lastByWhen || '')}">${r.lastBy ? esc(r.lastBy) : '<span class="g">-</span>'}</td><td class="m" title="${esc(r.pickedWhen || '')}">${r.pickedBy ? esc(r.pickedBy) : '<span class="g">-</span>'}</td></tr>`;
    const thead = withDest => `
      <thead><tr><th>#</th>${withDest ? '<th>Dest</th><th>Door</th>' : ''}<th>Last bin</th><th>csX</th><th>Now at</th><th>Orig CPT</th><th>Dwell (Rodeo)</th><th style="text-align:center">Found</th><th style="text-align:center">Not found</th><th title="Login of the last move in FC Research container history">Last Touched</th><th title="Login on the FCPickCompleteService move (picked out of the bin) in FC Research">Picked By</th></tr></thead>`;
    const overall = () => {
      const rs = rows.slice().sort(byBin);
      return `<h2>All destinations &nbsp;·&nbsp; ${rs.length} csX / ${rs.reduce((t, r) => t + (+r.qty || 0), 0)} units </h2>
        <table>${thead(true)}<tbody>${rs.map((r, i) => rowHtml(r, i, true)).join('')}</tbody></table>`;
    };
    const section = d => {
      const rs = rows.filter(r => r.dest === d).sort(byBin);
      return `<h2>${esc(d)} &nbsp;·&nbsp; Door ${esc(rs[0].doors)} &nbsp;·&nbsp; loading CPT ${esc(rs[0].curCpt)} &nbsp;·&nbsp; ${rs.length} csX / ${rs.reduce((t, r) => t + (+r.qty || 0), 0)} units</h2>
      <table>${thead(false)}<tbody>${rs.map((r, i) => rowHtml(r, i, false)).join('')}</tbody></table>`;
    };
    const missing = rows.filter(r => !r.bin).length;
    w.document.open();
    w.document.write(`<!doctype html><html><head><title>KRB3 Dwell Pick List</title><style>
      @page{size:letter portrait;margin:0.3in}
      *{box-sizing:border-box}
      body{font:10px Arial,sans-serif;margin:12px auto;color:#000;max-width:7.9in}
      h1{font-size:14px;margin:0} .sub{color:#333;margin:2px 0 6px;font-size:9.5px}
      h2{font-size:11px;background:#232f3e;color:#fff;padding:3px 6px;margin:8px 0 0;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      table{width:100%;border-collapse:collapse;table-layout:auto}
      thead{display:table-header-group} tr{page-break-inside:avoid;break-inside:avoid}
      th,td{border:1px solid #888;padding:2px 4px;text-align:left;vertical-align:middle;white-space:nowrap;width:1%}
      th:last-child,td:last-child{width:1%}
      th{background:#e6e6e6;font-size:9px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      td{height:18px}
      tbody tr:nth-child(even){background:#f6f6f6;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .m{font-family:Consolas,'Courier New',monospace}.b{font-weight:700}.big{font-size:10.5px}
      .red{color:#c00;font-weight:700}.g{color:#777;font-weight:400}.s{font-size:8.5px;color:#555}
      .bx{text-align:center;font-size:12px}.cur{font-size:8px;border:1px solid #000;padding:0 2px;margin-left:2px}.warn{color:#b00;font-weight:700}
      @media print{.np{display:none!important} body{margin:0;max-width:none} h2{page-break-after:avoid;break-after:avoid}}
    </style></head><body>
      <div class="np" style="float:right;display:flex;gap:6px">
        <span style="align-self:center;font-weight:700">Sort:</span>
        <button id="b-dest" onclick="v('dest')" style="font-size:12px;padding:4px 10px">By destination</button>
        <button id="b-all" onclick="v('all')" style="font-size:12px;padding:4px 10px">Overall (walk order)</button>
        <select id="srt" onchange="srt(this.value)" style="font-size:12px;padding:4px">
          <option value="walk">Walk order (one-way aisles)</option>
          <option value="dwd">Dwell: longest first</option>
          <option value="dwa">Dwell: shortest first</option>
          <option value="vna">VNA bin: ascending</option>
          <option value="vnd">VNA bin: descending</option>
        </select>
        <button onclick="print()" style="font-size:12px;padding:4px 10px;font-weight:700">Print</button></div>
      <h1>KRB3 Dwell Pick List${onlyDest ? ' — ' + esc(onlyDest) : ''} — ${mode === 'current' ? 'CURRENT CPTs (today and future), Rodeo dwell 1 hour or more' : 'PAST CPTs (before today)'}</h1>
      <div class="sub">Generated ${esc(now)} · ${rows.length} csX across ${dests.length} destinations with a trailer Loading In Progress (${dests.map(esc).join(', ')}) · <b>${esc(hrsLabel)}</b> · <span id="mode"></span>
        ${picked.capped ? '<br><span class="warn">Rodeo page limit reached — list may be incomplete.</span>' : ''}
        ${authErr ? `<br><span class="warn">${esc(authErr)} — open FC Research in a tab, sign in, and print again.</span>` : missing ? `<br>${missing} csX had no bin in FC Research container history.` : ''}</div>
      <div id="v-dest">${dests.map(section).join('')}</div>
      <div id="v-all" style="display:none">${overall()}</div>
      <script>
        function v(m){document.getElementById('v-dest').style.display=m==='dest'?'':'none';
          document.getElementById('v-all').style.display=m==='all'?'':'none';
          document.getElementById('b-dest').style.background=m==='dest'?'#fef7e0':'';
          document.getElementById('b-all').style.background=m==='all'?'#fef7e0':'';
          document.getElementById('mode').textContent=m==='dest'?'grouped by destination, in walk order':'all destinations together, in walk order';}
        var SL={walk:'in walk order',dwd:'dwell longest first',dwa:'dwell shortest first',vna:'VNA bin ascending',vnd:'VNA bin descending'}, cur='walk', curV='dest';
        function srt(k){cur=k;
          document.querySelectorAll('tbody').forEach(function(tb){
            var rs=[].slice.call(tb.querySelectorAll('tr'));
            rs.sort(function(a,b){
              var nb=(a.dataset.bin==='~')-(b.dataset.bin==='~'); if(k.slice(0,2)==='vn'&&nb) return nb;
              if(k==='dwd') return b.dataset.dw-a.dataset.dw || a.dataset.w-b.dataset.w;
              if(k==='dwa') return a.dataset.dw-b.dataset.dw || a.dataset.w-b.dataset.w;
              if(k==='vna') return a.dataset.bin.localeCompare(b.dataset.bin,undefined,{numeric:true}) || b.dataset.dw-a.dataset.dw;
              if(k==='vnd') return b.dataset.bin.localeCompare(a.dataset.bin,undefined,{numeric:true}) || b.dataset.dw-a.dataset.dw;
              return a.dataset.w-b.dataset.w;});
            rs.forEach(function(r,i){r.firstElementChild.textContent=i+1; tb.appendChild(r);});
          });
          lbl();}
        function lbl(){document.getElementById('mode').textContent=(curV==='dest'?'grouped by destination, ':'all destinations together, ')+SL[cur];}
        var _v=v; v=function(m){curV=m;_v(m);lbl();};
        v('dest');
      <\/script>
      <div class="sub" style="margin-top:12px">Picker: __________________ &nbsp; Date/Time: __________________ &nbsp; Reviewed by: __________________</div>
    </body></html>`);
    w.document.close();
  }
  const dwInfo = () => {
    const n = dwellRows('past').length, n2 = dwellRows('current').length;
    el('#tk-dw-info').textContent = 'Dwell lists:';
    el('#tk-dwell').textContent = `🖨 Past CPTs (${n})`;
    el('#tk-dwell2').textContent = `🖨 Current CPT >1h (${n2})`;
  };
  el('#tk-dwell').onclick = () => printDwell(null, el('#tk-dwell'), 'past');
  el('#tk-dwell2').onclick = () => printDwell(null, el('#tk-dwell2'), 'current');
  setInterval(dwInfo, 15000);
  (() => {
    const r = GM_getValue('tk_resume', null);
    if (!r || Date.now() - r.ts > 3 * 60000) { if (r) GM_setValue('tk_resume', null); return; }
    if (!(r.queue || []).some(q => q.status === 'ready')) { GM_setValue('tk_resume', null); return; }
    queue = r.queue; render();
    GM_setValue('tk_resume', { ...r, queue: [], ts: Date.now() });   // keep the reload count until the run finishes
    setStatus('Trickle screen reset — resuming run…');
    setTimeout(() => run(0, true), 2500);
  })();
  el('#tk-vrid').onclick = vridCompliance;
  el('#tk-ref').onclick = refreshRodeo;
  refreshRodeo();
  setInterval(refreshRodeo, 5 * 60000);
  setInterval(renderBoard, 15000);
  // ---------- Move (drag header) / resize (drag any edge or corner); remembered between page loads ----------
  const wrap = el('#tk-wrap');
  const DEF = { left: null, top: 16, width: Math.round(innerWidth * 0.66), height: Math.round(innerHeight * 0.86), zoom: 1 };
  let saved = GM_getValue('tk_layout', {});
  if (saved.v !== 2) saved = {};                       // start once at the new default size
  let lay = Object.assign({}, DEF, saved, { v: 2 });
  if (typeof lay.zoom !== 'number') lay.zoom = 1;
  let collapsed = false;
  const MINW = 420, MINH = 120;
  function applyLayout() {
    lay.width = Math.min(Math.max(lay.width, MINW), innerWidth);
    lay.height = Math.min(Math.max(lay.height, MINH), innerHeight);
    if (lay.left === null) lay.left = innerWidth - lay.width - 8;
    lay.left = Math.min(Math.max(lay.left, -lay.width + 120), innerWidth - 120);
    lay.top = Math.min(Math.max(lay.top, 0), innerHeight - 40);
    Object.assign(wrap.style, { left: lay.left + 'px', top: lay.top + 'px', right: 'auto', width: lay.width + 'px',
      height: collapsed ? 'auto' : lay.height + 'px', resize: 'none' });
    // text scales with panel width, so dragging the panel bigger/smaller also sizes the text
    el('#tk-body').style.zoom = lay.zoom;
  }
  const saveLayout = () => GM_setValue('tk_layout', lay);
  applyLayout();
  const drag = (e, onMove) => {
    const sx = e.clientX, sy = e.clientY, o = { ...lay };
    document.body.style.userSelect = 'none';
    const mv = ev => { onMove(ev.clientX - sx, ev.clientY - sy, o); applyLayout(); };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); document.body.style.userSelect = ''; saveLayout(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up); e.preventDefault(); e.stopPropagation();
  };
  el('#tk-hdr').addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;
    drag(e, (dx, dy, o) => { lay.left = o.left + dx; lay.top = o.top + dy; });
  });
  el('#tk-hdr').addEventListener('dblclick', e => { if (e.target.closest('button')) return; lay = Object.assign({}, DEF, { left: null, v: 2 }); applyLayout(); saveLayout(); });
  // edge + corner handles
  const H = 7, handles = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', ne: 'nesw', sw: 'nesw', nw: 'nwse', se: 'nwse' };
  Object.entries(handles).forEach(([dir, cur]) => {
    const h = document.createElement('div');
    const st = { position: 'absolute', zIndex: 5, cursor: cur + '-resize' };
    if (dir.includes('n')) st.top = -H / 2 + 'px'; if (dir.includes('s')) st.bottom = -H / 2 + 'px';
    if (dir.includes('w')) st.left = -H / 2 + 'px'; if (dir.includes('e')) st.right = -H / 2 + 'px';
    if (dir === 'n' || dir === 's') { st.left = H + 'px'; st.right = H + 'px'; st.height = H + 'px'; }
    else if (dir === 'e' || dir === 'w') { st.top = H + 'px'; st.bottom = H + 'px'; st.width = H + 'px'; }
    else { st.width = H * 2 + 'px'; st.height = H * 2 + 'px'; }
    Object.assign(h.style, st);
    if (dir === 'se') h.innerHTML = '<svg width="14" height="14" style="position:absolute;right:4px;bottom:4px;opacity:.5"><path d="M13 1L1 13M13 6L6 13M13 11L11 13" stroke="#232f3e" stroke-width="1.5"/></svg>';
    h.addEventListener('mousedown', e => {
      if (collapsed && dir !== 'e' && dir !== 'w') return;
      drag(e, (dx, dy, o) => {
        if (dir.includes('e')) lay.width = o.width + dx;
        if (dir.includes('s')) lay.height = o.height + dy;
        if (dir.includes('w')) { const w = Math.max(MINW, o.width - dx); lay.left = o.left + (o.width - w); lay.width = w; }
        if (dir.includes('n')) { const hh = Math.max(MINH, o.height - dy); lay.top = o.top + (o.height - hh); lay.height = hh; }
      });
    });
    wrap.appendChild(h);
  });
  Object.assign(wrap.style, { overflow: 'hidden', display: 'flex', flexDirection: 'column' });
  Object.assign(el('#tk-body').style, { overflow: 'auto', flex: '1 1 auto', minHeight: '0' });
  el('#tk-hdr').style.flex = '0 0 auto';
  el('#tk-zi').onclick = () => { lay.zoom = Math.min(1.6, +(lay.zoom + 0.1).toFixed(1)); applyLayout(); saveLayout(); };
  el('#tk-zo').onclick = () => { lay.zoom = Math.max(0.6, +(lay.zoom - 0.1).toFixed(1)); applyLayout(); saveLayout(); };
  el('#tk-min').onclick = () => { collapsed = !collapsed; el('#tk-body').style.display = collapsed ? 'none' : 'block'; applyLayout(); };
  addEventListener('resize', applyLayout);
  // Clear queue
  el('#tk-clear').onclick = () => {
    if (queue.some(q => q.status === 'ready') && !confirm('Clear the queue? (Already-moved containers are not affected.)')) return;
    stopFlag = true; queue = []; render(); setStatus('Queue cleared.');
  };

  el('#tk-date').value = new Date().toLocaleDateString('en-CA');

  const showSsp = () => {
    const s = GM_getValue('ssp_doors', null);
    el('#tk-ssp').textContent = s
      ? `SSP door data: ${s.rows.length} loads, captured ${((Date.now() - s.ts) / 60000).toFixed(0)} min ago`
      : 'SSP door data: none — open https://trans-logistics.amazon.com/ssp/dock/hrz/ob in another tab';
  };
  showSsp(); setInterval(showSsp, 15000);

  const fromText = t => { stopFlag = false; buildPlan(parseDropped(t)); };
  el('#tk-file').onchange = e => e.target.files[0] && e.target.files[0].text().then(fromText);
  const drop = el('#tk-drop');
  drop.ondragover = e => { e.preventDefault(); drop.style.background = '#eef'; };
  drop.ondragleave = () => drop.style.background = '';
  drop.ondrop = e => { e.preventDefault(); drop.style.background = ''; const f = e.dataTransfer.files[0]; if (f) f.text().then(fromText); };
  el('#tk-plan-list').onclick = () => fromText(el('#tk-paste').value);
  el('#tk-plan-rodeo').onclick = async () => {
    stopFlag = false;
    try {
      setStatus('Scraping Rodeo...');
      const rows = await scrapeRodeo(el('#tk-date').value, el('#tk-time').value, el('#tk-pp').value.trim());
      setStatus(`Rodeo returned ${rows.length} csX.`);
      buildPlan(rows);
    } catch (e) { setStatus('Rodeo scrape failed: ' + e.message); }
  };
  el('#tk-test').onclick = () => run(1);
  el('#tk-run').onclick = () => run(0);
  el('#tk-stop').onclick = () => { stopFlag = true; setStatus('Stopping after current container...'); };
  el('#tk-export').onclick = exportLog;

  }  // end MAIN

  // ===================== Relay helper (runs inside a track.relay.amazon.dev tab) =====================
  // Borrows Relay's own sign-in (it captures the auth header Relay attaches to its /api calls) and
  // answers "does this VRID have a case?" requests from the VRID compliance page.
  function relayHelper() {
    const PAGE = `(() => {
      let H = null;
      const of = window.fetch;
      window.fetch = function (input, init) {
        try {
          const u = typeof input === 'string' ? input : (input && input.url) || '';
          if (u.includes('/api/')) {
            const h = {}; const s = (init && init.headers) || (input && input.headers);
            if (s) { if (typeof s.forEach === 'function') s.forEach((v, k) => h[k] = v); else Object.assign(h, s); }
            if (Object.keys(h).length) H = h;
          }
        } catch (e) {}
        return of.apply(this, arguments);
      };
      const P = XMLHttpRequest.prototype, oo = P.open, os = P.setRequestHeader;
      P.open = function (m, u) { this.__u = String(u); this.__h = {}; return oo.apply(this, arguments); };
      P.setRequestHeader = function (k, v) { try { this.__h[k] = v; if (this.__u.includes('/api/')) H = Object.assign({}, this.__h); } catch (e) {} return os.apply(this, arguments); };
      const pick = j => {
        const out = [];
        const walk = o => {
          if (Array.isArray(o)) return o.forEach(walk);
          if (!o || typeof o !== 'object') return;
          const id = o.caseId || o.caseID || o.displayId || o.id;
          const title = o.title || o.subject || o.summary || o.name;
          const st = o.status || o.caseStatus || o.state;
          if (id && (title || st)) out.push({ id: String(id), title: String(title || ''), status: typeof st === 'object' ? JSON.stringify(st) : String(st || '') });
          else Object.values(o).forEach(walk);
        };
        walk(j); return out;
      };
      window.addEventListener('message', async ev => {
        const d = ev.data; if (!d || d.__krb3 !== 'cases') return;
        for (const it of d.items) {
          let res;
          try {
            const tries = it.t ? ['?firstStopArrivalTime=' + it.t, ''] : [''];
            for (const q of tries) {
              const r = await of('/api/cases/search/NA:VR:' + encodeURIComponent(it.vrid) + q, { credentials: 'include', headers: H || {} });
              const txt = await r.text();
              if (r.status !== 200) { res = { err: 'HTTP ' + r.status }; continue; }
              let j; try { j = JSON.parse(txt); } catch (e) { res = { err: 'bad JSON' }; continue; }
              res = { cases: pick(j), raw: txt.slice(0, 300) };
              if (res.cases.length) break;
            }
          } catch (e) { res = { err: String(e) }; }
          window.postMessage({ __krb3: 'casesRes', id: d.id, vrid: it.vrid, res, haveAuth: !!H }, '*');
          await new Promise(r => setTimeout(r, 250));
        }
        window.postMessage({ __krb3: 'casesDone', id: d.id, haveAuth: !!H }, '*');
      });
      setInterval(() => window.postMessage({ __krb3: 'alive', haveAuth: !!H }, '*'), 4000);
    })();`;
    try { GM_addElement('script', { textContent: PAGE }); }
    catch (e) { const s = document.createElement('script'); s.textContent = PAGE; (document.head || document.documentElement).appendChild(s); }

    let busyId = null;
    window.addEventListener('message', ev => {
      const d = ev.data; if (!d || !d.__krb3) return;
      if (d.__krb3 === 'alive') GM_setValue('relay_alive', { ts: Date.now(), haveAuth: d.haveAuth });
      if (d.__krb3 === 'casesRes') {
        const cur = GM_getValue('relay_cases', null) || {};
        if (cur.id !== d.id) { cur.id = d.id; cur.byVrid = {}; }
        cur.byVrid[d.vrid] = { ...d.res, ts: Date.now() }; cur.ts = Date.now(); cur.haveAuth = d.haveAuth;
        GM_setValue('relay_cases', cur);
      }
      if (d.__krb3 === 'casesDone') { const cur = GM_getValue('relay_cases', null) || {}; cur.done = d.id; GM_setValue('relay_cases', cur); busyId = null; }
    });
    setInterval(() => {
      const req = GM_getValue('relay_req', null);
      if (!req || req.id === busyId || Date.now() - req.ts > 5 * 60000) return;
      const cur = GM_getValue('relay_cases', null);
      if (cur && cur.done === req.id) return;
      busyId = req.id;
      window.postMessage({ __krb3: 'cases', id: req.id, items: req.items }, '*');
    }, 1500);
  }
})();
