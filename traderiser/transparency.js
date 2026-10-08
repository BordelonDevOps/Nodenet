'use strict';

// Only the sanitized, versioned public contract is consumed here. No private APIs.
const SUPPORTED_SCHEMA = '1.8.0';
const FRESHNESS_LIMIT_HOURS = 72; // Allows weekends, not a promise of market readiness.
const PAGE_SIZE = 50;
const byId = id => document.getElementById(id);
// Exported display strings are entity-escaped. Decode entities once as text, never HTML.
const publicText = value => String(value ?? '').replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#x27;':"'",'&#39;':"'"}[entity]));
const escapeText = value => publicText(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => value == null ? 'N/A' : new Intl.NumberFormat('en-US', {style:'currency', currency:'USD'}).format(value);
const pct = value => value == null ? 'N/A' : (value * 100).toFixed(2) + '%';
const date = value => value ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value+'T12:00:00' : value).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : 'N/A';
const table = (headers, rows, label) => '<div class="scroll-note">All columns shown. Scroll horizontally on small screens.</div><div class="table-scroll" tabindex="0" role="region" aria-label="'+escapeText(label)+'"><table><thead><tr>'+headers.map(h=>'<th scope="col">'+escapeText(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>';
const empty = message => '<div class="empty">'+escapeText(message)+'</div>';
const setHTML = (id, html) => { byId(id).innerHTML = html; };
const human = value => escapeText(String(value ?? 'not recorded').replaceAll('_',' '));
const actionLabel = value => ({
  staged_derisk_full_exit:'Full exit requested (not proof of closure)',
  persistent_eligibility_failure_exit:'Full exit requested (not proof of closure)',
  full_exit:'Full exit proposed (not proof of closure)',
  staged_derisk:'Staged reduction requested',
  persistent_eligibility_failure_reduction:'Staged reduction requested',
  partial_reduction:'Partial reduction proposed',
  blocked_missing_tax_evidence:'Blocked: missing tax evidence',
  blocked_order_constraints:'Blocked: order constraints'
}[value] || human(value));

let snapshot = null;
const renderedPanels = new Set();
const tabs = [...document.querySelectorAll('.tab')];
function activateTab(tab, focus = false) {
  tabs.forEach(button => {
    const active = button === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    const panel = byId(button.dataset.panel);
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
  if (snapshot) renderPanel(tab.dataset.panel);
  if (focus) tab.focus();
}
tabs.forEach((tab, index) => {
  tab.id = 'tab-'+tab.dataset.panel;
  tab.setAttribute('role','tab');
  tab.setAttribute('aria-controls', tab.dataset.panel);
  const panel = byId(tab.dataset.panel);
  panel.setAttribute('role','tabpanel');
  panel.setAttribute('aria-labelledby', tab.id);
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', event => {
    const next = event.key === 'ArrowRight' ? (index+1)%tabs.length :
      event.key === 'ArrowLeft' ? (index+tabs.length-1)%tabs.length :
      event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : null;
    if (next != null) { event.preventDefault(); activateTab(tabs[next], true); }
  });
});
activateTab(tabs[0]);

function validateSnapshot(data) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const fail = message => { throw new Error(message); };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const timestamp = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!object(data) || data.schema_version !== SUPPORTED_SCHEMA) fail('Unsupported public schema; expected '+SUPPORTED_SCHEMA+'.');
  if (!timestamp(data.published_at) || !timestamp(data.valuation_as_of)) fail('Publication or valuation timestamp is missing or invalid.');
  if ([data.published_at, data.valuation_as_of].some(value => Date.parse(value) > Date.now()+300000)) fail('Publication or valuation timestamp is in the future.');
  if (!object(data.account) || !object(data.experiment) || !object(data.research) || !object(data.performance)) fail('Required snapshot sections are missing.');
  for (const field of ['value','cash','invested','net_contributions']) {
    if (!finite(data.account[field])) fail('Invalid account '+field+'.');
  }
  for (const field of ['value','cash','invested']) if (data.account[field] < 0) fail('Negative account '+field+'.');
  if (Math.abs(data.account.value-data.account.cash-data.account.invested) > .010001) fail('Account components do not reconcile.');
  for (const key of ['holdings','trades','decisions','portfolio_history','disclosures']) if (!Array.isArray(data[key])) fail('Invalid '+key+' collection.');
  if (!Array.isArray(data.research.champion_rankings)) fail('Invalid champion rankings.');
  const symbols = new Set();
  let holdingsValue = 0;
  for (const holding of data.holdings) {
    if (!object(holding) || typeof holding.symbol !== 'string' || !holding.symbol || symbols.has(holding.symbol)) fail('Invalid or duplicate holding.');
    symbols.add(holding.symbol);
    for (const field of ['shares','average_price','cost_basis','current_value']) if (!finite(holding[field]) || holding[field]<0) fail('Invalid holding '+field+'.');
    holdingsValue += holding.current_value;
  }
  if (Math.abs(holdingsValue-data.account.invested) > .010001) fail('Holding values do not reconcile.');
  for (const decision of data.decisions) if (!object(decision) || !Array.isArray(decision.orders) || !Array.isArray(decision.selected) || !Array.isArray(decision.explanation)) fail('Invalid decision collection.');
  for (const trade of data.trades) {
    if (!object(trade) || trade.state!=='filled' || trade.authorized!==true || trade.orders_match!==true) fail('Trade is not a verified delegated fill.');
    for (const key of ['dollar_amount','quantity','average_price','fees']) if (!finite(trade[key]) || trade[key]<0) fail('Invalid fill economics.');
  }
  if (data.historical_trades!=null && !Array.isArray(data.historical_trades)) fail('Invalid historical fills collection.');
  for (const trade of data.historical_trades||[]) if (!object(trade) || trade.state!=='filled' || trade.authorized!=null || trade.orders_match!=null) fail('Invalid historical fill provenance.');
  const objectRows = new Set(['holdings','trades','historical_trades','decisions','portfolio_history','champion_rankings','challenger_rankings','orders','positions','blocked_orders','comparisons','approved_pairs','evidence']);
  const textRows = new Set(['selected','explanation','disclosures','rules','risk_controls','limitations']);
  const numericFields = new Set(['value','cash','invested','buying_power','net_contributions','investment_gain','simple_return_on_contributions','shares','average_price','cost_basis','current_value','return','time_weighted_return','actual_return','actual_excess_return','excess_return','change','change_pct','contributions','market_gain','withdrawals','quantity','dollars','dollar_amount','fees','score','momentum_12_1','annualized_volatility','cagr','maximum_drawdown','score_advantage','expected_edge_dollars','required_edge_dollars','estimated_tax_cost_dollars','required_sessions','score_hurdle','consecutive_ineligible_sessions','confirmation_sessions','full_exit_sessions','requested_dollars','live_days','champion_cycles','reconciled_trades']);
  const arrayFields = new Set(['holdings','trades','decisions','portfolio_history','disclosures','champion_rankings','challenger_rankings','orders','selected','explanation','rules','risk_controls','limitations','positions','blocked_orders','comparisons','approved_pairs','evidence']);
  const objectFields = new Set(['account','experiment','research','performance','money_weighted','live_benchmark','daily_briefing','plain_language','strategy_profile','backtest','strategy','benchmark','replacement_analysis','staged_derisk_analysis','deferred_follow_up']);
  // JSON can parse overflowing exponents as Infinity. Check nested shapes/numbers before rendering.
  function inspect(value) {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('Nonfinite public numeric value.');
    if (Array.isArray(value)) value.forEach(inspect);
    else if (object(value)) Object.entries(value).forEach(([key,item])=>{
      if (item!=null && numericFields.has(key) && !finite(item)) fail('Invalid numeric '+key+'.');
      if (item!=null && arrayFields.has(key) && !Array.isArray(item) && !(key==='evidence' && object(item))) fail('Invalid '+key+' collection.');
      if (Array.isArray(item) && objectRows.has(key) && item.some(row=>!object(row))) fail('Invalid '+key+' row.');
      if (Array.isArray(item) && textRows.has(key) && item.some(row=>typeof row!=='string')) fail('Invalid '+key+' text.');
      // Holding.strategy and evidence.benchmark are text labels; their research
      // counterparts are metrics objects.
      if (item!=null && objectFields.has(key) && !object(item) &&
          !(['strategy','benchmark'].includes(key) && typeof item==='string')) fail('Invalid '+key+' section.');
      inspect(item);
    });
  }
  inspect(data);
  return data;
}

function status(state, message) {
  byId('snapshot-status').dataset.state = state;
  byId('snapshot-status').textContent = message;
  byId('snapshot-badge').dataset.state = state;
  byId('snapshot-badge').textContent = state === 'available' ? 'Published snapshot · trading readiness not assessed' :
    state === 'stale' ? 'Stale snapshot · not current account data' : 'Snapshot unavailable · trading readiness not assessed';
}
function holdings(items) {
  if (!items.length) return empty('No published positions.');
  return table(['Symbol','Shares','Average purchase','Cost basis','Current value','Strategy'], items.map(x=>[escapeText(x.symbol),escapeText(x.shares),money(x.average_price),money(x.cost_basis),money(x.current_value),escapeText(x.strategy)]), 'Published holdings, all six columns');
}
function decisionLedger(items) {
  if (!items.length) return empty('No published decisions.');
  return items.map(x=>'<article class="decision"><div class="pill">'+human(x.kind)+' · '+human(x.status)+'</div><h3>'+
    (x.kind==='historical_trade' ? 'Historical broker fill (delegated authorization not established)' : x.kind==='executed_trade' ? 'Recorded delegated broker fill' : (x.selected.length ? 'Selected '+escapeText(x.selected.join(', ')) : 'No allocation change'))+
    '</h3><div class="decision-time">'+date(x.generated_at)+'</div>'+
    (x.orders.length ? '<ul class="orders">'+x.orders.map(o=>'<li>'+human(o.side)+' '+money(o.dollars)+' of '+escapeText(o.symbol)+' · '+actionLabel(o.decision_class)+' · '+human(o.status||x.status)+
      (o.quantity!=null ? ' · '+escapeText(o.quantity)+' shares at '+money(o.average_price)+' · fees '+money(o.fees) : '')+
      (o.reason ? '<div class="sub">'+actionLabel(o.reason)+'</div>' : '')+'</li>').join('')+'</ul>' : '<p class="sub">No order was proposed in this cycle.</p>')+
    (['executed_trade','historical_trade'].includes(x.kind) ? '<div class="reason">Decision source: '+human(x.decision_source)+' · Broker submission: '+human(x.broker_submission_source)+' · Authorization: '+human(x.authorization_label)+' · Reconciliation: '+(x.reconciled===true ? 'matched' : x.reconciled===false ? 'mismatch' : 'not recorded')+'</div>' : '')+
    deferredFollowUp(x.deferred_follow_up)+
    x.explanation.slice(0,2).map(reason=>'<div class="reason">'+escapeText(reason)+'</div>').join('')+'</article>').join('');
}
function tradeLedger(items) {
  if (!items.length) return empty('No reconciled fills have been published.');
  return table(['Time','Symbol','Side','Amount','Shares','Fill price','Fees','Decision source','Broker submission','Status'],
    items.map(x=>[date(x.reconciled_at),escapeText(x.symbol),human(x.side),money(x.dollar_amount),escapeText(x.quantity??'N/A'),money(x.average_price),money(x.fees),human(x.decision_source),human(x.broker_submission_source),human(x.state)+deferredFollowUp(x.deferred_follow_up)]),
    'Reconciled trade fills, all ten columns');
}
function deferredFollowUp(followUp) {
  return followUp ? '<div class="sub">Deferred follow-up: '+escapeText(followUp.symbol)+' '+money(followUp.dollars)+' · '+human(followUp.status)+'</div>' : '';
}
function historyRows(items) {
  return items.length ? items.map((x,index)=>'<details class="day" data-history-index="'+index+'"><summary><span class="day-date">'+date(x.date)+'</span><span class="day-value">'+money(x.value)+'</span><span class="change">'+(x.change==null?'Starting value':money(x.change)+' ('+pct(x.change_pct)+')')+'</span></summary><div class="day-detail"></div></details>').join('') : empty('No daily portfolio history has been published.');
}
function historyDetail(x) {
  return '<div class="day-note">'+escapeText(x.note)+'</div><div class="flow-grid">'+
    [['Total change',money(x.change)],['Contributions',money(x.contributions)],['Market gain/loss',money(x.market_gain)],['Estimated time-weighted return',pct(x.time_weighted_return)]].map(([label,val])=>'<div>'+label+'<b>'+val+'</b></div>').join('')+'</div>'+
    ((x.holdings||[]).length ? table(['Symbol','Shares','Value'],x.holdings.map(h=>[escapeText(h.symbol),escapeText(h.shares??'N/A'),money(h.value)]),'Daily holdings, all three columns') : empty('No holdings were captured.'))+
    '<div class="sub">Cash '+money(x.cash)+' · Withdrawals '+money(x.withdrawals)+' · Source: '+human(x.source)+'</div>';
}
function paginate(id, items, renderer, history = false) {
  const container = byId(id);
  let page = 0;
  function draw() {
    const start = page*PAGE_SIZE, shown = items.slice(start,start+PAGE_SIZE);
    container.innerHTML = renderer(shown)+(items.length ? '<div class="pager"><button type="button" data-prev '+(page===0?'disabled':'')+' aria-label="Previous '+id+' page">Previous</button><span role="status">Showing '+(start+1)+'–'+(start+shown.length)+' of '+items.length+'</span><button type="button" data-next '+(start+PAGE_SIZE>=items.length?'disabled':'')+' aria-label="Next '+id+' page">Next</button></div>' : '');
    container.querySelector('[data-prev]')?.addEventListener('click',()=>{page--;draw();container.querySelector('[data-prev]').focus();});
    container.querySelector('[data-next]')?.addEventListener('click',()=>{page++;draw();container.querySelector('[data-next]').focus();});
    if (history) container.querySelectorAll('details').forEach(details=>details.addEventListener('toggle',()=>{
      if (details.open && !details.dataset.loaded) {details.querySelector('.day-detail').innerHTML=historyDetail(shown[Number(details.dataset.historyIndex)]);details.dataset.loaded='true';}
    }));
  }
  draw();
}
function renderPanel(id) {
  if (renderedPanels.has(id)) return;
  renderedPanels.add(id);
  const d = snapshot;
  if (id==='ledger') {
    paginate('portfolio-history',d.portfolio_history.slice().reverse(),historyRows,true);
    paginate('trades',d.trades.slice().reverse(),tradeLedger);
    paginate('historical-trades',(d.historical_trades||[]).slice().reverse(),tradeLedger);
    paginate('decisions',d.decisions,decisionLedger);
  }
  if (id==='holdings') {
    setHTML('holdings-table',holdings(d.holdings));
    setHTML('holding-reasons',d.holdings.map(x=>'<article class="why"><h3>'+escapeText(x.symbol)+'</h3><p>This is a published holding, not confirmation that it still passes the latest eligibility screen.</p><div class="sub">Current value '+money(x.current_value)+' · Average purchase '+money(x.average_price)+'</div></article>').join(''));
  }
  if (id==='briefing') {
    const brief=d.daily_briefing||{};
    setHTML('daily-briefing','<div class="callout"><b>'+escapeText(brief.headline||'No briefing available.')+'</b></div>'+['portfolio_context','market_context','champion','challenger'].map(key=>'<div class="reason">'+escapeText(brief[key])+'</div>').join('')+'<p class="sub">'+escapeText(brief.disclosure)+'</p>');
    setHTML('dictionary',Object.entries(d.plain_language||{}).map(([term,meaning])=>'<div class="reason"><b>'+escapeText(term)+'</b><div class="plain">'+escapeText(meaning)+'</div></div>').join(''));
  }
  if (id==='research') renderResearch(d);
}
function metricRows(rows) { return rows.map(([label,val])=>'<div class="reason">'+escapeText(label)+' <b>'+val+'</b></div>').join(''); }
function benchmark(d) {
  const mw=d.performance?.money_weighted||{}, lb=d.performance?.live_benchmark||{};
  const matched = lb.actual_return_basis && lb.return_basis === lb.actual_return_basis;
  return metricRows([
    ['TradeRiser estimated money-weighted return (Modified Dietz)',pct(mw.return)],
    [(lb.symbol||'Provider benchmark')+' return ('+(lb.return_basis||'basis not published')+')',pct(lb.return)],
    ['Excess return (matched basis required)',matched?pct(lb.actual_excess_return):'N/A']
  ])+'<p class="sub">'+escapeText(lb.note||'A synchronized live benchmark is not available.')+'</p>';
}
function renderResearch(d) {
  const sp=d.strategy_profile||{}, ev=d.evidence||{}, b=d.research.backtest||{};
  setHTML('strategy-profile','<div class="callout"><b>'+escapeText(sp.name||'Strategy')+'</b><div class="plain">'+escapeText(sp.best_for)+'</div></div>'+['rules','risk_controls'].map(key=>'<h3>'+human(key)+'</h3><ul class="strategy-list">'+(sp[key]||[]).map(x=>'<li>'+escapeText(x)+'</li>').join('')+'</ul>').join(''));
  setHTML('evidence',metricRows([['Live days',escapeText(ev.live_days??'N/A')],['Champion cycles',escapeText(ev.champion_cycles??'N/A')],['Reconciled trades',escapeText(ev.reconciled_trades??'N/A')]])+(ev.limitations||[]).map(x=>'<div class="warning">'+escapeText(x)+'</div>').join(''));
  setHTML('live-benchmark',benchmark(d));
  setHTML('backtest',['strategy','benchmark'].map(key=>'<h3>'+ (key==='strategy'?'Challenger':'Equal-weight provider universe')+'</h3>'+metricRows([['Annualized return',pct(b[key]?.cagr)],['Volatility',pct(b[key]?.annualized_volatility)],['Max drawdown',pct(b[key]?.maximum_drawdown)]])).join('')+'<p class="sub">Historical backtests are hypothetical, not live or out-of-sample proof.</p>');
  const replacement=d.research.replacement_analysis||{};
  setHTML('replacement-analysis',!Object.keys(replacement).length?empty('No replacement analysis was published for this cycle.'):'<div class="callout"><b>'+(replacement.passed?'Passed analysis (not execution)':'Blocked')+'</b><div class="plain">'+human(replacement.reason)+'</div></div>'+metricRows([['Confirmation sessions',escapeText(replacement.required_sessions??'N/A')],['Approved pairs',escapeText((replacement.approved_pairs||[]).length)]])+
    ((replacement.comparisons||[]).length?table(['Sell candidate','Buy candidate','Score advantage','Estimated benefit','Required benefit','Estimated tax'],replacement.comparisons.map(r=>[escapeText(r.outgoing_symbol),escapeText(r.incoming_symbol),r.score_advantage?.toFixed(3)??'N/A',money(r.expected_edge_dollars),money(r.required_edge_dollars),money(r.estimated_tax_cost_dollars)]),'Replacement analysis, all six columns'):''));
  const risk=d.research.staged_derisk_analysis||{};
  setHTML('derisk-analysis',!Object.keys(risk).length?empty('Staged de-risking analysis is unavailable.'):!risk.enabled?empty('Staged de-risking is disabled.'):(risk.positions||[]).length?table(['Symbol','Consecutive failures','Proposed action','Estimated tax'],risk.positions.map(r=>[escapeText(r.symbol),escapeText(r.consecutive_ineligible_sessions),actionLabel(r.action),money(r.estimated_tax_cost_dollars)]),'Staged de-risking proposals, all four columns'):empty('No held position qualified for a staged reduction in this published cycle.'));
  if ((risk.blocked_orders||[]).length) byId('derisk-analysis').insertAdjacentHTML('beforeend','<h3>Blocked requests</h3>'+table(['Symbol','Requested amount','Decision','Block reason'],risk.blocked_orders.map(r=>[escapeText(r.symbol),money(r.requested_dollars),actionLabel(r.decision_class),human(r.reason)]),'Blocked de-risking requests'));
  paginate('rankings',d.research.champion_rankings,items=>table(['Symbol','Eligible','Score','12-to-1 momentum','Volatility'],items.map(x=>[escapeText(x.symbol),x.eligible?'Yes':'No',x.score?.toFixed(3)??'N/A',pct(x.momentum_12_1),pct(x.annualized_volatility)]),'Champion ranking, all five columns'));
}
function renderSnapshot(d) {
  const publicationAge=(Date.now()-Date.parse(d.published_at))/3600000;
  const valuationAge=(Date.now()-Date.parse(d.valuation_as_of))/3600000;
  const stale = publicationAge>FRESHNESS_LIMIT_HOURS || valuationAge>FRESHNESS_LIMIT_HOURS;
  status(stale?'stale':'available',(stale?'Stale snapshot. ':'')+'Publication: '+d.published_at+' · Account valuation: '+d.valuation_as_of+'. Freshness limit: '+FRESHNESS_LIMIT_HOURS+' hours. Process, broker connectivity, and trading readiness are not assessed here.');
  byId('value').textContent=money(d.account.value);
  byId('contributions').textContent=money(d.account.net_contributions);
  byId('gain').textContent=money(d.account.investment_gain);
  byId('gain-rate').textContent=pct(d.account.simple_return_on_contributions)+' simple return on contributed funds';
  byId('experiment-funding').textContent=money(d.account.net_contributions)+' contributed live trading test';
  byId('invested').textContent=money(d.account.invested);
  byId('cash').textContent=money(d.account.cash);
  byId('ends').textContent=date(d.experiment.ends);
  byId('objective').textContent=publicText(d.experiment.objective)||'No objective published.';
  const perf=d.performance||{};
  setHTML('performance-summary',metricRows([['Simple return on contributions',pct(perf.simple_return_on_contributions)],['Estimated time-weighted return',pct(perf.time_weighted_return)]])+benchmark(d));
  byId('performance-note').textContent='Attribution quality: '+(perf.time_weighted_quality||'unavailable')+'. '+(perf.money_weighted?.note||'');
  setHTML('overview-holdings',holdings(d.holdings));
  setHTML('disclosures',d.disclosures.map(x=>'<div class="disclosure">'+escapeText(x)+'</div>').join(''));
  byId('published').textContent='Snapshot published '+d.published_at+' | Account valuation '+d.valuation_as_of+' | Public schema '+d.schema_version;
  renderPanel(document.querySelector('.tab.active').dataset.panel);
}

byId('goal-form').addEventListener('submit', event=>{
  event.preventDefault();
  const years=Number(byId('horizon').value), monthly=Number(byId('monthly').value), loss=Number(byId('loss').value);
  if (!Number.isFinite(years)||years<1||years>50||!Number.isFinite(monthly)||monthly<0) {setHTML('profile-result',empty('Enter a valid horizon and monthly amount.'));return;}
  const name=loss<10?'Cautious':loss<25?'Balanced growth':'Growth';
  const reserve=Math.max(years<3?40:0,loss<10?30:loss<25?10:5);
  setHTML('profile-result','<div class="callout"><b>'+name+'</b><div class="plain">For '+escapeText(byId('goal').value.toLowerCase())+' over '+years+' years with '+money(monthly)+' added monthly.</div></div>'+metricRows([['Suggested cash reserve',reserve+'%'],['Borrowed leverage','Not allowed'],['Status','Educational draft requiring review']])+(byId('emergency').value==='no'?'<div class="warning">Build accessible emergency savings before relying on invested money.</div>':'')+(years<3?'<div class="warning">A short timeline can force a sale during a market decline.</div>':''));
  setHTML('projection',table(['Scenario','Assumed annual return','Projected value'],[0,.04,.07].map((r,i)=>[ ['Contributions only','Lower-growth illustration','Higher-growth illustration'][i],pct(r),money(r?monthly*(Math.pow(1+r/12,years*12)-1)/(r/12):monthly*years*12)]),'Illustrative projection, all three columns'));
});

async function loadSnapshot() {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch('data.json',{cache:'no-store',signal:controller.signal});
    if (!response.ok) throw new Error('Snapshot request failed (HTTP '+response.status+').');
    snapshot=validateSnapshot(await response.json());
    renderSnapshot(snapshot);
  } catch (error) {
    snapshot=null;
    status('unavailable','The public snapshot could not be loaded or validated. '+(error.name==='AbortError'?'Request timed out.':error.message)+' No current account or trading-health claim is available.');
    byId('published').textContent='Public snapshot unavailable.';
  } finally {clearTimeout(timer);}
}
loadSnapshot();
