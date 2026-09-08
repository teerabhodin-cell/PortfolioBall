import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, addDoc, collection, deleteDoc, doc, getDoc, onSnapshot, orderBy, query, serverTimestamp, updateDoc, where } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'REPLACE_WITH_FIREBASE_WEB_API_KEY',
  authDomain: 'REPLACE_WITH_PROJECT.firebaseapp.com',
  projectId: 'REPLACE_WITH_PROJECT_ID',
  storageBucket: 'REPLACE_WITH_PROJECT.appspot.com',
  messagingSenderId: 'REPLACE_WITH_MESSAGING_SENDER_ID',
  appId: 'REPLACE_WITH_FIREBASE_APP_ID'
};

const USERNAME_TO_EMAIL = { teerabhodin: 'teerabhodin@devsphere.local' };
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const state = { user: null, selectedPortfolioId: null, selectedPortfolio: null, portfolios: [], listeners: {}, points: [] };
const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function configured() { return !firebaseConfig.apiKey.startsWith('REPLACE_') && !firebaseConfig.projectId.startsWith('REPLACE_'); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c])); }
function formatMoney(value, currency = '') { return typeof value === 'number' ? `${value > 0 ? '+' : ''}${money.format(value)}${currency ? ` ${currency}` : ''}` : '—'; }
function formatTime(value) { if (!value) return '—'; const date = value.toDate ? value.toDate() : new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(); }
function maskLogin(value) { const valueText = String(value).trim(); return `${'*'.repeat(Math.max(0, valueText.length - 4))}${valueText.slice(-4)}`; }
function isAdmin() { return Boolean(state.user); }
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }
function setLoginMessage(text, isError = false) { $('loginMessage').textContent = text; $('loginMessage').style.color = isError ? '#ff8796' : '#fac957'; }

function stopPortfolioListeners() {
  Object.values(state.listeners).forEach((unsubscribe) => unsubscribe?.());
  state.listeners = {}; state.points = [];
}

function listenPublicPortfolios() {
  state.listeners.portfolios?.();
  state.listeners.portfolios = onSnapshot(collection(db, 'portfolios'), (snapshot) => {
    state.portfolios = snapshot.docs.map((item) => ({ id: item.id, data: item.data() }));
    renderPortfolioList();
    if (!state.selectedPortfolioId && state.portfolios.length) selectPortfolio(state.portfolios[0].id);
    if (!state.portfolios.length) { $('emptyPortfolio').classList.remove('hidden'); $('dashboard').classList.add('hidden'); setLive(false, 'NO PORTFOLIO', 'No public portfolio is available'); }
  }, (error) => { $('emptyPortfolio').classList.remove('hidden'); $('emptyPortfolio').querySelector('p:not(.eyebrow)').textContent = `Cannot load public portfolios: ${error.message}`; });
}

function renderPortfolioList() {
  const list = $('portfolioList');
  if (!state.portfolios.length) { list.innerHTML = '<p class="empty-side">No public portfolio yet</p>'; return; }
  list.innerHTML = state.portfolios.map(({ id, data }) => `<button class="portfolio-item ${id === state.selectedPortfolioId ? 'active' : ''} ${data.status === 'LIVE' ? 'live' : ''}" data-id="${escapeHtml(id)}"><b><i class="dot"></i>${escapeHtml(data.displayName)}</b><small>${escapeHtml(data.brokerServer || 'MT5')} · ${escapeHtml(data.status || 'SETUP_REQUIRED')}</small></button>`).join('');
  list.querySelectorAll('[data-id]').forEach((button) => button.addEventListener('click', () => selectPortfolio(button.dataset.id)));
}

function selectPortfolio(id) {
  if (state.selectedPortfolioId === id) return;
  stopPortfolioListeners();
  state.selectedPortfolioId = id;
  state.selectedPortfolio = state.portfolios.find((portfolio) => portfolio.id === id) || null;
  renderPortfolioList();
  $('emptyPortfolio').classList.add('hidden'); $('dashboard').classList.remove('hidden');
  $('selectedPortfolioName').textContent = state.selectedPortfolio?.data.displayName || 'Portfolio';
  $('selectedPortfolioMeta').textContent = `${state.selectedPortfolio?.data.brokerServer || 'MT5'} · Account ${state.selectedPortfolio?.data.mt5LoginMasked || 'hidden'}`;
  $('portfolioStatus').textContent = state.selectedPortfolio?.data.status || 'SETUP_REQUIRED';
  listenPublicSnapshot(id);
}

function listenPublicSnapshot(id) {
  state.listeners.account = onSnapshot(doc(db, 'portfolios', id, 'public', 'account'), (snapshot) => {
    if (!snapshot.exists()) { setLive(false, 'WAITING FOR AGENT', 'Agent has not sent a public snapshot yet'); clearDashboard(); return; }
    renderAccount(snapshot.data());
  }, (error) => addEvent('Public account listener error', error.message));

  state.listeners.history = onSnapshot(query(collection(db, 'portfolios', id, 'public', 'equityHistory'), orderBy('capturedAt', 'asc')), (snapshot) => {
    state.points = snapshot.docs.slice(-120).map((item) => item.data());
    $('snapshotCount').textContent = `${state.points.length} points`; $('chartEmpty').style.display = state.points.length ? 'none' : 'grid'; drawChart();
  });

  state.listeners.events = onSnapshot(query(collection(db, 'portfolios', id, 'public', 'events'), orderBy('occurredAt', 'desc')), (snapshot) => renderEvents(snapshot.docs.slice(0, 30).map((item) => item.data())));
}

function renderAccount(data) {
  const account = data.account || data, positions = data.positions || [], currency = account.currency || '', profit = typeof account.profit === 'number' ? account.profit : 0;
  $('balance').textContent = formatMoney(account.balance, currency); $('equity').textContent = formatMoney(account.equity, currency); $('profit').textContent = formatMoney(profit, currency); $('profit').className = profit > 0 ? 'positive' : profit < 0 ? 'negative' : '';
  $('marginLevel').textContent = account.marginLevel ? `${number.format(account.marginLevel)}%` : '—'; $('currency').textContent = `Currency: ${currency || '—'}`; $('freeMargin').textContent = `Free margin: ${formatMoney(account.freeMargin, currency)}`; $('positionHint').textContent = `${positions.length} open position${positions.length === 1 ? '' : 's'}`;
  $('agentStatus').textContent = 'Live'; $('sequence').textContent = data.sequence ?? '—'; $('openPositions').textContent = positions.length; $('pendingOrders').textContent = data.pendingOrders ?? '—'; $('positionCount').textContent = `${positions.length} positions`;
  $('portfolioStatus').textContent = 'LIVE'; setLive(true, 'LIVE · PUBLIC READ-ONLY', `Last sync ${formatTime(data.capturedAt)}`); renderPositions(positions, currency);
}

function clearDashboard() { ['balance','equity','profit','marginLevel','sequence','openPositions','pendingOrders'].forEach((id) => $(id).textContent = '—'); $('positions').innerHTML = '<tr><td colspan="7" class="empty">Waiting for agent snapshot</td></tr>'; }
function renderPositions(positions, currency) { $('positions').innerHTML = positions.length ? positions.map((p) => `<tr><td><b>${escapeHtml(p.symbol)}</b><br><small>#${escapeHtml(p.ticket)}</small></td><td><span class="${p.side === 'BUY' ? 'buy' : 'sell'}">${escapeHtml(p.side)}</span></td><td>${number.format(p.volume)}</td><td>${number.format(p.openPrice)}</td><td>${number.format(p.currentPrice)}</td><td class="${p.profit > 0 ? 'positive' : p.profit < 0 ? 'negative' : ''}">${formatMoney(p.profit, currency)}</td><td>${formatTime(p.openedAt)}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">No active positions</td></tr>'; }
function renderEvents(events) { if (!events.length) return; $('events').innerHTML = events.map((event) => `<div class="event"><i></i><div><b>${escapeHtml(event.type || 'Monitoring event')}</b><p>${escapeHtml(event.message || event.summary || '')}</p></div><time>${formatTime(event.occurredAt)}</time></div>`).join(''); }
function addEvent(title, message) { const node = document.createElement('div'); node.className = 'event'; node.innerHTML = `<i></i><div><b>${escapeHtml(title)}</b><p>${escapeHtml(message)}</p></div><time>${new Date().toLocaleTimeString()}</time>`; $('events').prepend(node); }
function setLive(live, label, details) { $('liveDot').classList.toggle('live', live); $('liveLabel').textContent = label; $('lastSync').textContent = details; }

function drawChart() { const canvas=$('chart'),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;canvas.width=Math.max(1,rect.width*dpr);canvas.height=Math.max(1,rect.height*dpr);const c=canvas.getContext('2d');c.scale(dpr,dpr);c.clearRect(0,0,rect.width,rect.height);if(state.points.length<2)return;const values=state.points.flatMap((p)=>[p.balance,p.equity]),min=Math.min(...values),max=Math.max(...values),pad=Math.max((max-min)*.12,1),low=min-pad,high=max+pad,x=(i)=>10+i*(rect.width-20)/(state.points.length-1),y=(v)=>rect.height-12-(v-low)*(rect.height-24)/(high-low);c.strokeStyle='rgba(140,161,196,.16)';for(let i=1;i<5;i++){const gy=rect.height*i/5;c.beginPath();c.moveTo(0,gy);c.lineTo(rect.width,gy);c.stroke()}line(c,state.points.map((p,i)=>[x(i),y(p.balance)]),'#638dff');line(c,state.points.map((p,i)=>[x(i),y(p.equity)]),'#29d8e9');}
function line(c,points,color){c.strokeStyle=color;c.lineWidth=2;c.shadowColor=color;c.shadowBlur=8;c.beginPath();points.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.stroke();c.shadowBlur=0}

async function login(event) { event.preventDefault(); if(!configured()){setLoginMessage('กรุณาใส่ Firebase Web Config ใน app.js ก่อน',true);return;} const email=USERNAME_TO_EMAIL[$('username').value.trim().toLowerCase()];if(!email){setLoginMessage('Username นี้ไม่ได้รับอนุญาต',true);return;}try{setLoginMessage('Signing in…');await signInWithEmailAndPassword(auth,email,$('password').value);$('password').value='';closeModal('loginModal');}catch{setLoginMessage('Login ไม่สำเร็จ: ตรวจสอบรหัสผ่านอีกครั้ง',true)}}
async function savePortfolio(event) { event.preventDefault(); if(!isAdmin())return; const mode=$('portfolioMode').value, name=$('displayName').value.trim(), broker=$('brokerServer').value.trim(), login=$('mt5Login').value.trim();try{$('portfolioMessage').textContent=mode==='create'?'Creating portfolio…':'Saving changes…';if(mode==='create'){const ref=await addDoc(collection(db,'portfolios'),{ownerUid:state.user.uid,displayName:name,brokerServer:broker,mt5LoginMasked:maskLogin(login),status:'SETUP_REQUIRED',createdAt:serverTimestamp(),updatedAt:serverTimestamp()});$('portfolioMessage').textContent=`Created. Portfolio ID: ${ref.id}`;setTimeout(()=>{closeModal('portfolioModal');selectPortfolio(ref.id)},800)}else{await updateDoc(doc(db,'portfolios',state.selectedPortfolioId),{displayName:name,brokerServer:broker,mt5LoginMasked:maskLogin(login),updatedAt:serverTimestamp()});$('portfolioMessage').textContent='Saved.';setTimeout(()=>closeModal('portfolioModal'),600)}}catch(error){$('portfolioMessage').textContent=error.message}}
function openAdd(){ $('portfolioMode').value='create';$('portfolioModalTitle').textContent='Add Portfolio';$('portfolioSubmit').textContent='Create Portfolio Setup →';$('portfolioForm').reset();$('portfolioMessage').textContent='';openModal('portfolioModal'); }
function openEdit(){if(!state.selectedPortfolio)return;$('portfolioMode').value='edit';$('portfolioModalTitle').textContent='Edit Portfolio';$('portfolioSubmit').textContent='Save Portfolio Changes';$('displayName').value=state.selectedPortfolio.data.displayName||'';$('brokerServer').value=state.selectedPortfolio.data.brokerServer||'';$('mt5Login').value='';$('mt5Login').placeholder=`Current: ${state.selectedPortfolio.data.mt5LoginMasked||'hidden'} — enter full login to change`;$('portfolioMessage').textContent='';openModal('portfolioModal');}
async function deletePortfolio(){if(!state.selectedPortfolioId)return;try{await deleteDoc(doc(db,'portfolios',state.selectedPortfolioId));closeModal('deleteModal');state.selectedPortfolioId=null;state.selectedPortfolio=null;stopPortfolioListeners();}catch(error){$('deleteDescription').textContent=error.message;}}

['loginButton','loginButtonTop','loginButtonEmpty'].forEach((id)=>$(id).addEventListener('click',()=>openModal('loginModal')));document.querySelectorAll('[data-close]').forEach((button)=>button.addEventListener('click',()=>closeModal(button.dataset.close)));$('loginForm').addEventListener('submit',login);$('portfolioForm').addEventListener('submit',savePortfolio);$('signOutButton').addEventListener('click',()=>signOut(auth));$('openAddModal').addEventListener('click',openAdd);$('openEditModal').addEventListener('click',openEdit);$('deletePortfolio').addEventListener('click',()=>{if(state.selectedPortfolio){$('deleteDescription').textContent=`Delete “${state.selectedPortfolio.data.displayName}”? This removes portfolio metadata only. Agent-written subcollection data may remain.`;openModal('deleteModal')}});$('confirmDelete').addEventListener('click',deletePortfolio);$('refreshButton').addEventListener('click',()=>{if(state.selectedPortfolioId){const id=state.selectedPortfolioId;state.selectedPortfolioId=null;selectPortfolio(id)}});window.addEventListener('resize',drawChart);

onAuthStateChanged(auth,(user)=>{state.user=user;const admin=Boolean(user);$('identityLabel').textContent=admin?(user.email||'Admin'):'Public visitor';$('loginButton').classList.toggle('hidden',admin);$('loginButtonTop').classList.toggle('hidden',admin);$('signOutButton').classList.toggle('hidden',!admin);$('refreshButton').classList.toggle('hidden',!admin);$('adminControls').classList.toggle('hidden',!admin);if(!configured()){setLive(false,'CONFIG REQUIRED','Update Firebase Web Config in app.js');return;}if(!state.listeners.portfolios)listenPublicPortfolios();});
