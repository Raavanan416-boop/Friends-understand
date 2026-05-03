/* ═══ MIND SYNC GAME — Client ═══ */

// ═══ FIREBASE CONFIG — Replace with YOUR Firebase project values ═══
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const socket = io();
const AVATARS = ['😀','😎','🤩','🥳','😈','👻','🤖','👽','🦊','🐱','🐶','🦁','🐸','🐧','🦄','🌟','🔥','💎','🎯','🎮','🐵','🐷','🐃','🐐','🐻'];
const SOUNDS = {};
let isInGame = false; // Track game state for shop restriction

// Timer constants (must match server)
const QUESTION_TIMER_MS = 60000;
const GUESS_TIMER_MS    = 25000;
const QUESTION_WARN_SEC = 10;
const GUESS_WARN_SEC    = 5;
// Advantage costs
const ADV_COST = { reveal: 25, hint: 15, extraTime: 10, doublePoints: 30, letterHint: 15 };

// ─── Profile Data ───
function loadProfile() {
  return JSON.parse(localStorage.getItem('ms-profile') || '{"matches":0,"wins":0,"opponents":{}}');
}
function saveProfile(p) { localStorage.setItem('ms-profile', JSON.stringify(p)); }

// ─── Task Data ───
function loadTasks() {
  const t = JSON.parse(localStorage.getItem('ms-tasks') || '{}');
  const today = new Date().toDateString();
  if (t.date !== today) return { date: today, winStreak: 0, perfectCount: 0, noAdvWin: false, claimed: [false,false,false] };
  return t;
}
function saveTasks(t) { localStorage.setItem('ms-tasks', JSON.stringify(t)); }

// ─── Secret Page ───
let secretTapCount = 0, secretTapTimer = null;
// Secret page can ALWAYS be opened via triple-tap
// Daily reward is tracked separately
function canClaimSecretReward() {
  const last = localStorage.getItem('ms-secret-reward-date');
  return last !== new Date().toDateString();
}

// ─── Daily Reward ───
function canClaimDaily() {
  const last = localStorage.getItem('ms-daily-date');
  return last !== new Date().toDateString();
}

// ─── Global Leaderboard (localStorage-based) ───
function loadGlobalLB() { return JSON.parse(localStorage.getItem('ms-global-lb') || '[]'); }
function saveGlobalLB(lb) { localStorage.setItem('ms-global-lb', JSON.stringify(lb)); }
function getWeekStart() {
  const d = new Date(); d.setHours(0,0,0,0);
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
}
function checkWeeklyReset() {
  const lastReset = parseInt(localStorage.getItem('ms-lb-reset') || '0');
  const weekStart = getWeekStart();
  if (lastReset < weekStart) { saveGlobalLB([]); localStorage.setItem('ms-lb-reset', weekStart.toString()); }
}
function getRankInfo(coins, wins) {
  if (coins >= 500 || wins >= 20) return { label: '🔥 Legend', cls: 'rank-legend' };
  if (coins >= 200 || wins >= 10) return { label: '🟡 Gold', cls: 'rank-gold' };
  if (coins >= 80 || wins >= 5) return { label: '⚪ Silver', cls: 'rank-silver' };
  return { label: '🟤 Bronze', cls: 'rank-bronze' };
}

let state = {
  playerName: localStorage.getItem('ms-name') || '',
  avatar: localStorage.getItem('ms-avatar') || '😀',
  roomCode: null, myId: null, timerInterval: null, pendingJoin: null,
  history: JSON.parse(localStorage.getItem('ms-history') || '[]'),
  lastRoomState: null,
  hasLeftRoom: false,
  coins: parseInt(localStorage.getItem('ms-coins') || '0'),
  usedReveal: false,
  usedHint: false,
  usedLetterHint: false,
  usedAnyAdvantage: false,
  doubleNext: false
};

// ─── Coin Helpers ───
function saveCoins() { localStorage.setItem('ms-coins', state.coins); }
function addCoins(n) {
  if (n <= 0) return;
  state.coins += n;
  saveCoins();
  updateCoinUI();
  // Pop animation on all coin count elements
  $$('.coin-count').forEach(el => { el.classList.remove('coin-pop'); void el.offsetWidth; el.classList.add('coin-pop'); });
  // Floating +N indicator near the game coin badge
  const badge = $('#game-coin-badge') || $('#home-coin-badge');
  if (badge) {
    const rect = badge.getBoundingClientRect();
    const fl = document.createElement('div');
    fl.className = 'coin-float';
    fl.textContent = `+${n} 💰`;
    fl.style.left = rect.left + 'px';
    fl.style.top = (rect.top - 5) + 'px';
    document.body.appendChild(fl);
    setTimeout(() => fl.remove(), 1300);
  }
}
function spendCoins(n) {
  if (state.coins < n) return false;
  state.coins -= n;
  saveCoins();
  updateCoinUI();
  return true;
}
function updateCoinUI() {
  $$('.coin-count').forEach(el => el.textContent = state.coins);
  const shopBal = $('#shop-coin-balance');
  if (shopBal) shopBal.textContent = state.coins;
}

// ─── Sound ───
function initSounds() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return; const ctx = new AC();
  function tone(f,d,t='sine',v=.12){const o=ctx.createOscillator(),g=ctx.createGain();o.type=t;o.frequency.value=f;g.gain.setValueAtTime(v,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+d);o.connect(g);g.connect(ctx.destination);o.start();o.stop(ctx.currentTime+d)}
  SOUNDS.click=()=>tone(800,.08);
  SOUNDS.timerWarn=()=>{tone(440,.15,'square',.1);setTimeout(()=>tone(440,.15,'square',.1),200)};
  SOUNDS.correct=()=>{tone(523,.15);setTimeout(()=>tone(659,.15),150);setTimeout(()=>tone(784,.2),300)};
  SOUNDS.wrong=()=>{tone(330,.2,'sawtooth',.1);setTimeout(()=>tone(260,.3,'sawtooth',.1),200)};
  SOUNDS.winner=()=>{[523,659,784,1047].forEach((f,i)=>setTimeout(()=>tone(f,.3),i*150))};
}
function sfx(n){
  if (localStorage.getItem('ms-sound-off') === '1') return;
  if(SOUNDS[n])try{SOUNDS[n]()}catch(e){}
}

// ─── Helpers ───
const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
function showScreen(id){$$('.screen').forEach(s=>s.classList.remove('active'));$(`#screen-${id}`).classList.add('active')}
function openPanel(id){$(`#panel-${id}`).classList.add('open');sfx('click')}
function closeAllPanels(){$$('.slide-panel').forEach(p=>p.classList.remove('open'))}
function openPopup(id){$(`#popup-${id}`).classList.add('open')}
function closePopup(id){$(`#popup-${id}`).classList.remove('open')}
function closeAllPopups(){$$('.popup-overlay').forEach(p=>p.classList.remove('open'))}
function showToast(m,d=2500){const t=$('#toast');t.textContent=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),d)}
function escHtml(s){return s?s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):''}

// Ripple effect
document.addEventListener('click', e => {
  const btn = e.target.closest('.btn-primary,.btn-secondary,.toggle-btn,.icon-btn,.game-top-btn,.emoji-btn');
  if (!btn) return;
  const r = document.createElement('span'); r.className = 'ripple';
  const rect = btn.getBoundingClientRect();
  r.style.left = (e.clientX - rect.left) + 'px';
  r.style.top = (e.clientY - rect.top) + 'px';
  btn.style.position = 'relative'; btn.style.overflow = 'hidden';
  btn.appendChild(r); setTimeout(() => r.remove(), 600);
});

// ─── Init ───
function initUI() {
  checkWeeklyReset();
  if (state.playerName) {
    showScreen('home'); updateHomeUI(); fetchRooms();
    // Sync profile to server for world leaderboard
    setTimeout(() => syncProfileToServer(), 500);
    // Daily reward check
    if (canClaimDaily()) setTimeout(() => openPopup('daily-reward'), 800);
  } else { showScreen('login'); }
  $('#btn-login').onclick = doLogin;
  $('#input-login-name').onkeydown = e => { if (e.key === 'Enter') doLogin(); };

  // Tabs
  $$('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  setupToggles();

  // Home
  $('#btn-history').onclick = () => { renderHistory(); openPanel('history'); };
  // Name and avatar editing is now ONLY inside the Profile page
  $('#btn-create-room').onclick = createRoom;
  $('#btn-refresh-rooms').onclick = fetchRooms;
  $('#btn-install-topbar').onclick = installApp;
  $('#btn-save-name').onclick = saveName;
  $('#btn-coin-shop').onclick = () => {
    if (isInGame) return showToast('🛒 Shop only available in Home screen!');
    updateCoinUI(); openPanel('coinshop');
  };
  $('#btn-profile').onclick = () => { renderProfile(); openPanel('profile'); };
  $('#btn-global-leaderboard').onclick = () => { renderGlobalLB(); openPanel('global-lb'); };
  $('#btn-question-packs').onclick = () => { renderQuestionPacks(); openPanel('qpacks'); };
  $('#btn-sound-shop').onclick = () => {
    renderSoundShop();
    openPanel('soundshop');
    // Set toggle state
    const toggle = $('#sound-toggle');
    if (toggle) toggle.checked = localStorage.getItem('ms-sound-off') !== '1';
  };
  $('#btn-world-lb').onclick = () => { renderWorldLB(); openPanel('world-lb'); };
  $('#btn-close-pub-profile').onclick = () => closePopup('public-profile');
  // Question pack tabs
  $$('.qp-tab').forEach(t => t.onclick = () => {
    $$('.qp-tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
    $$('.qp-tab-content').forEach(c => c.style.display = 'none');
    $('#qp-' + t.dataset.qptab).style.display = 'block';
    if (t.dataset.qptab === 'create') buildPackCreateForm();
    if (t.dataset.qptab === 'marketplace') renderMarketplace();
  });
  $('#btn-save-pack').onclick = saveCustomPack;

  // Profile name edit
  $('#btn-profile-edit-name').onclick = () => {
    $('#input-profile-name').value = state.playerName;
    $('#profile-name-edit').style.display = 'block';
  };
  $('#btn-profile-save-name').onclick = () => {
    const name = $('#input-profile-name').value.trim();
    if (!name) return showToast('Enter a name');
    state.playerName = name;
    localStorage.setItem('ms-name', name);
    updateHomeUI();
    $('#profile-name').textContent = name;
    $('#profile-name-edit').style.display = 'none';
    socket.emit('change-name', { newName: name });
    syncProfileToServer();
    showToast('✅ Name updated!');
  };
  $('#btn-profile-cancel-name').onclick = () => {
    $('#profile-name-edit').style.display = 'none';
  };

  // History detail modal
  $('#btn-close-history-detail').onclick = () => closePopup('history-detail');
  // Delete history confirmation
  $('#btn-delete-history').onclick = () => openPopup('confirm-delete-history');
  $('#btn-cancel-delete-history').onclick = () => closePopup('confirm-delete-history');
  $('#btn-confirm-delete-history').onclick = () => deleteAllHistory();
  // Pack selector in create room
  $$('.pack-option').forEach(b => b.onclick = () => {
    $$('.pack-option').forEach(x => x.classList.remove('active')); b.classList.add('active'); sfx('click');
  });

  // Secret coin tap — ALWAYS opens, coins only once per day
  const coinTap = $('#secret-coin-tap');
  if (coinTap) {
    coinTap.addEventListener('click', (e) => {
      e.stopPropagation();
      coinTap.classList.remove('tap-flash'); void coinTap.offsetWidth; coinTap.classList.add('tap-flash');
      secretTapCount++;
      clearTimeout(secretTapTimer);
      secretTapTimer = setTimeout(() => { secretTapCount = 0; }, 1500);
      if (secretTapCount >= 3) {
        secretTapCount = 0;
        // Always open the secret page
        renderSecretTasks();
        openPanel('secret');
        // Give coins only once per day
        if (canClaimSecretReward()) {
          localStorage.setItem('ms-secret-reward-date', new Date().toDateString());
          addCoins(10);
          showToast('🎉 Secret Vault opened! +10 bonus coins!', 3000);
          spawnCoinRain();
        } else {
          showToast('✨ Secret Vault opened!', 2000);
        }
      }
    });
  }

  // Menu dropdown toggle
  const menuToggle = $('#btn-menu-toggle');
  const dropdown = $('#topbar-dropdown');
  if (menuToggle && dropdown) {
    menuToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('open');
      sfx('click');
    });
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target) && e.target !== menuToggle) {
        dropdown.classList.remove('open');
      }
    });
    // Close dropdown when any item is clicked
    dropdown.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        dropdown.classList.remove('open');
      });
    });
  }

  // Daily reward
  $('#btn-claim-daily').onclick = () => {
    localStorage.setItem('ms-daily-date', new Date().toDateString());
    addCoins(3);
    closePopup('daily-reward');
    showToast('🎁 +3 daily coins claimed!', 2500);
    spawnCoinRain();
  };

  // Secret task claims
  $('#btn-claim-task1').onclick = () => claimTask(0, 25);
  $('#btn-claim-task2').onclick = () => claimTask(1, 50);
  $('#btn-claim-task3').onclick = () => claimTask(2, 100);

  // Panels
  $$('.panel-overlay').forEach(o => o.onclick = closeAllPanels);
  buildAvatarGrid();
  // Sound toggle
  const soundToggle = $('#sound-toggle');
  if (soundToggle) {
    soundToggle.checked = localStorage.getItem('ms-sound-off') !== '1';
    soundToggle.onchange = () => {
      localStorage.setItem('ms-sound-off', soundToggle.checked ? '0' : '1');
      showToast(soundToggle.checked ? '🔊 Sounds enabled' : '🔇 Sounds disabled');
    };
  }

  // Waiting
  $('#btn-leave-waiting').onclick = leaveRoom;
  $('#btn-start-game').onclick = startGame;

  // Game
  $('#btn-players-list').onclick = () => openPopup('players');
  $('#btn-leaderboard').onclick = () => openPopup('leaderboard');
  $('#btn-leave-game').onclick = () => openPopup('leave');
  $('#btn-keep-playing').onclick = () => closePopup('leave');
  $('#btn-confirm-leave').onclick = () => { closePopup('leave'); leaveRoom(); };
  $('#btn-close-players').onclick = () => closePopup('players');
  $('#btn-close-leaderboard').onclick = () => closePopup('leaderboard');

  // Game over
  $('#btn-play-again').onclick = requestPlayAgain;
  $('#btn-back-home').onclick = goHome;
  $('#btn-accept-play-again').onclick = acceptPlayAgain;
  $('#btn-reject-play-again').onclick = rejectPlayAgain;

  // Password popup
  $('#btn-cancel-password').onclick = () => { state.pendingJoin = null; closePopup('password'); };
  $('#btn-submit-password').onclick = submitPassword;

  // Emojis
  $$('.emoji-btn').forEach(b => b.onclick = () => {
    if (state.roomCode) socket.emit('emoji-reaction', { roomCode: state.roomCode, emoji: b.dataset.emoji });
  });
}

function doLogin() {
  const name = $('#input-login-name').value.trim();
  if (!name) return showToast('Please enter your name');
  state.playerName = name;
  localStorage.setItem('ms-name', name);
  showScreen('home');
  updateHomeUI();
  fetchRooms();
  sfx('click');
  // Sync profile to server on login
  syncProfileToServer();
}

function saveName() {
  const name = $('#input-new-name').value.trim();
  if (!name) return showToast('Enter a name');
  const oldName = state.playerName;
  state.playerName = name;
  localStorage.setItem('ms-name', name);
  updateHomeUI();
  closeAllPanels();
  showToast('Name updated!');
  // Notify server if in a room
  socket.emit('change-name', { newName: name });
}

function updateHomeUI() {
  $('#home-avatar').textContent = state.avatar;
  $('#home-player-name').textContent = state.playerName;
  updateCoinUI();
}

function switchTab(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.tab-pane').forEach(p => p.classList.remove('active'));
  $(`#tab-${tab}`).classList.add('active');
  const idx = tab === 'create' ? 0 : 1;
  $('.tab-indicator').style.left = (idx * 50) + '%';
  if (tab === 'join') fetchRooms();
  sfx('click');
}

function setupToggles() {
  $$('.toggle-group').forEach(g => g.querySelectorAll('.toggle-btn').forEach(b => {
    b.onclick = () => { g.querySelectorAll('.toggle-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); sfx('click'); };
  }));
}

function buildAvatarGrid() {
  const grid = $('#avatar-grid'); grid.innerHTML = '';
  AVATARS.forEach(a => {
    const d = document.createElement('div');
    d.className = 'avatar-option' + (a === state.avatar ? ' active' : '');
    d.textContent = a;
    d.onclick = () => {
      state.avatar = a; localStorage.setItem('ms-avatar', a);
      $$('.avatar-option').forEach(o => o.classList.remove('active')); d.classList.add('active');
      updateHomeUI(); sfx('click'); setTimeout(closeAllPanels, 300);
    };
    grid.appendChild(d);
  });
}

function renderHistory() {
  const l = $('#history-list');
  const deleteBtn = $('#btn-delete-history');
  if (!state.history.length) {
    l.innerHTML = '<p class="empty-state">No games played yet</p>';
    if (deleteBtn) deleteBtn.style.display = 'none';
    return;
  }
  // Show delete button when there's history
  if (deleteBtn) deleteBtn.style.display = 'block';
  l.innerHTML = state.history.slice(0, 20).map((h, idx) => `<div class="history-item" data-hidx="${idx}">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div class="h-date">${h.date}</div>
      <button class="history-delete-single" data-hidx="${idx}" title="Delete this match" style="background:none;border:none;cursor:pointer;font-size:18px;padding:4px 8px;border-radius:8px;transition:.2s;line-height:1">🗑</button>
    </div>
    <div class="h-result">${h.winner ? '🏆 Winner: ' + escHtml(h.winner) : h.result}</div>
    <div class="h-score">Score: ${h.score} | Players: ${h.players}</div>
  </div>`).join('');
  // Click on item to view details
  l.querySelectorAll('.history-item').forEach(el => el.onclick = (e) => {
    // Don't open detail if delete button was clicked
    if (e.target.closest('.history-delete-single')) return;
    const idx = parseInt(el.dataset.hidx);
    openHistoryDetail(idx);
  });
  // Wire up single delete buttons
  l.querySelectorAll('.history-delete-single').forEach(btn => btn.onclick = (e) => {
    e.stopPropagation();
    const idx = parseInt(btn.dataset.hidx);
    deleteSingleHistory(idx);
  });
}

function deleteSingleHistory(idx) {
  if (!confirm('Delete this match?')) return;
  state.history.splice(idx, 1);
  localStorage.setItem('ms-history', JSON.stringify(state.history));
  renderHistory();
  showToast('✅ Match deleted!');
  sfx('click');
}

function deleteAllHistory() {
  // Clear from state
  state.history = [];
  // Clear from localStorage
  localStorage.removeItem('ms-history');
  // Close confirmation popup
  closePopup('confirm-delete-history');
  // Re-render the history list
  renderHistory();
  showToast('✅ History Cleared!');
  sfx('click');
}

function openHistoryDetail(idx) {
  const h = state.history[idx];
  if (!h) return;
  let html = '<div class="history-detail-result">';
  html += `<div class="hd-winner">🏆 ${escHtml(h.winner || h.result)}</div>`;
  if (h.packName && h.packName !== 'default') html += `<div class="hd-pack">📦 Pack: ${escHtml(h.packName)}</div>`;
  html += '</div>';
  if (h.allScores && h.allScores.length) {
    html += '<div class="history-detail-scores">';
    h.allScores.forEach((s, i) => {
      html += `<div class="hd-score-row${i === 0 ? ' hd-winner-row' : ''}">
        <span class="hd-name">${i === 0 ? '🏆 ' : ''}${escHtml(s.name)}</span>
        <span class="hd-pts">${s.score} pts</span>
      </div>`;
    });
    html += '</div>';
  } else {
    html += `<p style="color:var(--text3);font-size:13px;text-align:center;margin-top:8px">Detailed scores not available for older matches</p>`;
  }
  $('#history-detail-content').innerHTML = html;
  openPopup('history-detail');
}

// ─── Room Actions ───
function createRoom() {
  const roomName = $('#input-room-name').value.trim() || 'Room';
  const password = $('#input-room-password').value.trim();
  const maxPlayers = parseInt($('#player-count-toggle .toggle-btn.active')?.dataset.value || '2');
  const totalRounds = parseInt($('#round-count-toggle .toggle-btn.active')?.dataset.value || '4');
  const selectedPack = $('.pack-option.active')?.dataset.pack || 'default';

  // Build create-room payload
  const payload = {
    playerName: state.playerName,
    avatar: state.avatar,
    maxPlayers,
    totalRounds,
    roomName,
    password,
    questionPack: selectedPack
  };

  // For custom packs, send the pack questions to the server
  if (selectedPack.startsWith('custom-')) {
    const customIdx = parseInt(selectedPack.replace('custom-', ''));
    const customPacks = loadCustomPacks();
    const pack = customPacks[customIdx];
    if (!pack || !pack.questions || pack.questions.length < 5) {
      return showToast('❌ Invalid pack data. Please re-create the pack.');
    }
    payload.packQuestions = pack.questions;
    payload.packName = pack.name;
  }

  socket.emit('create-room', payload);
  sfx('click');
}

async function fetchRooms() {
  const list = $('#rooms-list');
  list.innerHTML = '<div class="rooms-loading"><div class="spinner"></div><p>Loading rooms…</p></div>';
  try {
    const res = await fetch('/api/rooms');
    let rooms = await res.json();
    // Client-side filtering: remove rooms with no name or 0 players
    rooms = rooms.filter(r => r && r.roomName && r.players > 0);
    // Deduplicate by roomCode
    const seen = new Set();
    rooms = rooms.filter(r => {
      if (seen.has(r.roomCode)) return false;
      seen.add(r.roomCode);
      return true;
    });
    if (!rooms.length) { list.innerHTML = '<p class="rooms-empty">No rooms available. Create one!</p>'; return; }
    list.innerHTML = rooms.map(r => `
      <div class="room-item" data-code="${r.roomCode}" data-has-pw="${r.hasPassword}">
        <div class="room-item-left">
          <div class="room-item-name">${escHtml(r.roomName)}</div>
          <div class="room-item-info">${r.players}/${r.maxPlayers} players · ${r.totalRounds} rounds</div>
        </div>
        <div class="room-item-right">
          ${r.hasPassword ? '<span class="room-item-lock">🔒</span>' : ''}
          <span class="room-item-badge">JOIN</span>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.room-item').forEach(el => el.onclick = () => handleRoomClick(el));
  } catch (e) { list.innerHTML = '<p class="rooms-empty">Could not load rooms</p>'; }
}

function handleRoomClick(el) {
  const code = el.dataset.code;
  const hasPw = el.dataset.hasPw === 'true';
  if (hasPw) {
    state.pendingJoin = code;
    $('#input-join-password').value = '';
    openPopup('password');
  } else {
    socket.emit('join-room', { roomCode: code, playerName: state.playerName, avatar: state.avatar, password: '' });
  }
  sfx('click');
}

function submitPassword() {
  if (!state.pendingJoin) return;
  const pw = $('#input-join-password').value;
  socket.emit('join-room', { roomCode: state.pendingJoin, playerName: state.playerName, avatar: state.avatar, password: pw });
  closePopup('password');
  state.pendingJoin = null;
}

function leaveRoom() {
  state.hasLeftRoom = true;
  if (state.roomCode) socket.emit('leave-room', { roomCode: state.roomCode });
  cleanupAndGoHome();
}

function cleanupAndGoHome() {
  state.roomCode = null;
  state.lastRoomState = null;
  state.hasLeftRoom = true;
  isInGame = false;
  clearInterval(state.timerInterval);
  closeAllPanels();
  closeAllPopups();
  showScreen('home');
  fetchRooms();
}

function goHome() {
  state.roomCode = null;
  state.lastRoomState = null;
  state.hasLeftRoom = false;
  isInGame = false;
  clearInterval(state.timerInterval);
  closeAllPanels();
  closeAllPopups();
  showScreen('home');
  fetchRooms();
}

function startGame() { socket.emit('start-game', { roomCode: state.roomCode }); sfx('click'); }

// ─── Timer ───
function startTimer(endTime, totalMs, warnSec) {
  clearInterval(state.timerInterval);
  if (state._lastWarnSfxSec) state._lastWarnSfxSec = 0;
  const fill = $('#timer-fill'), text = $('#timer-text');
  const warnThreshold = warnSec || 5;
  function tick() {
    const rem = Math.max(0, endTime - Date.now());
    const pct = (rem / totalMs) * 100, secs = Math.ceil(rem / 1000);
    fill.style.width = pct + '%'; text.textContent = secs + 's';
    if (secs <= warnThreshold && secs > 0) {
      fill.classList.add('warning');
      text.classList.add('warning');
      // Play warning sound once when entering the warning zone
      if (secs === warnThreshold && state._lastWarnSfxSec !== warnThreshold) {
        sfx('timerWarn');
        state._lastWarnSfxSec = warnThreshold;
      }
    } else {
      fill.classList.remove('warning');
      text.classList.remove('warning');
    }
    if (rem <= 0) clearInterval(state.timerInterval);
  }
  tick(); state.timerInterval = setInterval(tick, 200);
}

// ─── Game Render ───
function renderGameContent(data) {
  const gc = $('#game-content');
  const isMyTurn = data.players?.[data.currentTurnPlayerIndex]?.id === state.myId;
  const tp = data.turnPlayerName || 'Someone';
  const isPackMode = data.isPackMode; // Server tells us if pack question is active
  const packQ = data.packQuestion || null;

  if (data.phase === 'question') {
    if (isMyTurn) {
      if (isPackMode && packQ) {
        // ═══ PACK MODE: Show auto-question, only answer input ═══
        gc.innerHTML = `<p class="game-phase-label">Your Turn</p>
          <p class="game-turn-info">Answer this pack question!</p>
          <div class="game-question-display" style="margin-bottom:12px">
            <div class="q-label">📦 ${escHtml(data.packDisplayName || 'Pack Question')}</div>
            <div class="q-text">${escHtml(packQ)}</div>
          </div>
          <div class="game-input-area">
            <input type="text" id="input-answer" class="input-field" placeholder="Type your answer…" maxlength="60" autocomplete="off">
            <button class="btn-primary btn-neon" id="btn-submit-qa">Submit Answer</button>
          </div>`;
        $('#btn-submit-qa').onclick = () => {
          const a = $('#input-answer').value.trim();
          if (!a) return showToast('Type your answer!');
          // Send the pack question + answer (server will use stored pack question)
          socket.emit('submit-qa', { roomCode: state.roomCode, question: packQ, answer: a });
          sfx('click');
        };
      } else {
        // ═══ DEFAULT MODE: Question + Answer input ═══
        gc.innerHTML = `<p class="game-phase-label">Your Turn</p>
          <p class="game-turn-info">Write a question and its answer</p>
          <div class="game-input-area">
            <input type="text" id="input-question" class="input-field" placeholder="Type your question…" maxlength="120" autocomplete="off">
            <input type="text" id="input-answer" class="input-field" placeholder="The answer…" maxlength="60" autocomplete="off">
            <button class="btn-primary btn-neon" id="btn-submit-qa">Submit</button>
          </div>`;
        $('#btn-submit-qa').onclick = () => {
          const q = $('#input-question').value.trim();
          const a = $('#input-answer').value.trim();
          if (!q || !a) return showToast('Fill both fields');
          socket.emit('submit-qa', { roomCode: state.roomCode, question: q, answer: a });
          sfx('click');
        };
      }
    } else {
      // Non-turn player: show waiting message
      if (isPackMode && packQ) {
        // In pack mode, show the question to ALL players while waiting
        gc.innerHTML = `<div class="game-question-display" style="margin-bottom:12px">
            <div class="q-label">📦 ${escHtml(data.packDisplayName || 'Pack Question')}</div>
            <div class="q-text">${escHtml(packQ)}</div>
          </div>
          <div class="waiting-turn-msg"><span class="wtm-emoji">✍️</span><p><strong>${escHtml(tp)}</strong> is writing the answer…</p></div>`;
      } else {
        gc.innerHTML = `<div class="waiting-turn-msg"><span class="wtm-emoji">🤔</span><p><strong>${escHtml(tp)}</strong> is writing a question…</p></div>`;
      }
    }
    startTimer(data.timerEnd, QUESTION_TIMER_MS, QUESTION_WARN_SEC);
  } else if (data.phase === 'guess') {
    // Reset per-round advantage flags
    state.usedReveal = false;
    state.usedHint = false;
    state.usedLetterHint = false;
    if (isMyTurn) {
      gc.innerHTML = `<div class="game-question-display"><div class="q-label">Your Question</div><div class="q-text">${escHtml(data.question)}</div></div>
        <div class="waiting-turn-msg"><span class="wtm-emoji">⏳</span><p>Others are guessing…</p></div>`;
    } else {
      // Build masked answer hint
      const ansLen = data.answerLength || 0;
      const maskedChars = ansLen > 0 ? '•'.repeat(Math.min(ansLen, 20)) : '• • • • •';
      gc.innerHTML = `<div class="game-question-display"><div class="q-label">${escHtml(tp)}'s Question</div><div class="q-text">${escHtml(data.question)}</div></div>
        <div class="answer-card-wrapper">
          <div class="answer-card" id="answer-card">
            <div class="answer-card-inner">
              <div class="answer-card-front">
                <div class="answer-card-icon">🔒</div>
                <div class="answer-card-label">Answer Hidden</div>
                <div class="answer-card-masked">${maskedChars}</div>
              </div>
              <div class="answer-card-back">
                <div class="answer-card-icon">🔓</div>
                <div class="answer-card-label">Answer</div>
                <div class="answer-card-value" id="answer-card-value">—</div>
              </div>
            </div>
          </div>
        </div>
        <div id="advantage-hint-area"></div>
        <div class="advantage-bar" id="advantage-bar">
          <button class="advantage-btn" id="btn-adv-reveal" ${state.coins < ADV_COST.reveal ? 'disabled' : ''}>
            <span class="adv-icon">👀</span> Reveal <span class="adv-cost">(${ADV_COST.reveal}💰)</span>
          </button>
          <button class="advantage-btn" id="btn-adv-hint" ${state.coins < ADV_COST.hint ? 'disabled' : ''}>
            <span class="adv-icon">🔤</span> Hint <span class="adv-cost">(${ADV_COST.hint}💰)</span>
          </button>
          <button class="advantage-btn" id="btn-adv-letter" ${state.coins < ADV_COST.letterHint ? 'disabled' : ''}>
            <span class="adv-icon">🔍</span> 2 Letters <span class="adv-cost">(${ADV_COST.letterHint}💰)</span>
          </button>
        </div>
        <div class="game-input-area">
          <input type="text" id="input-guess" class="input-field" placeholder="Your guess…" maxlength="60" autocomplete="off">
          <button class="btn-primary btn-neon" id="btn-submit-guess">Submit Guess</button>
        </div>`;
      // Wire advantage buttons
      $('#btn-adv-reveal').onclick = () => {
        if (state.usedReveal) return;
        if (!spendCoins(ADV_COST.reveal)) return showToast('Not enough coins!');
        state.usedReveal = true; state.usedAnyAdvantage = true;
        $('#btn-adv-reveal').disabled = true;
        $('#btn-adv-reveal').classList.add('used');
        $('#btn-adv-reveal').innerHTML = '<span class="adv-icon">✅</span> Revealed';
        socket.emit('use-reveal', { roomCode: state.roomCode });
        sfx('click');
      };
      $('#btn-adv-hint').onclick = () => {
        if (state.usedHint) return;
        if (!spendCoins(ADV_COST.hint)) return showToast('Not enough coins!');
        state.usedHint = true; state.usedAnyAdvantage = true;
        $('#btn-adv-hint').disabled = true;
        $('#btn-adv-hint').classList.add('used');
        $('#btn-adv-hint').innerHTML = '<span class="adv-icon">✅</span> Hinted';
        const area = $('#advantage-hint-area');
        area.innerHTML = `<div class="revealed-answer-hint"><div class="hint-label">Hint</div><div class="hint-value">${ansLen} letters<br><small style="color:var(--text2);font-size:12px">First & last letter hint</small></div></div>`;
        sfx('click');
      };
      // Letter Hint — reveal first 2 letters
      $('#btn-adv-letter').onclick = () => {
        if (state.usedLetterHint) return;
        if (!spendCoins(ADV_COST.letterHint)) return showToast('Not enough coins!');
        state.usedLetterHint = true; state.usedAnyAdvantage = true;
        $('#btn-adv-letter').disabled = true;
        $('#btn-adv-letter').classList.add('used');
        $('#btn-adv-letter').innerHTML = '<span class="adv-icon">✅</span> Shown';
        socket.emit('use-letter-hint', { roomCode: state.roomCode });
        sfx('click');
      };
      $('#btn-submit-guess').onclick = () => {
        const g = $('#input-guess').value.trim();
        if (!g) return showToast('Type your guess');
        socket.emit('submit-guess', { roomCode: state.roomCode, guess: g });
        $('#btn-submit-guess').disabled = true; $('#btn-submit-guess').textContent = 'Submitted ✓'; sfx('click');
      };
    }
    startTimer(data.timerEnd, GUESS_TIMER_MS, GUESS_WARN_SEC);
  } else if (data.phase === 'waiting') {
    gc.innerHTML = `<div class="waiting-turn-msg"><span class="wtm-emoji">🎮</span><p>Waiting for host…</p></div>`;
  }
}

// ─── Socket Events ───
socket.on('connect', () => { state.myId = socket.id; });

// ─── Reveal Answer (advantage response) ───
socket.on('reveal-answer', ({ answer }) => {
  // Show the real answer in the hint area
  const area = $('#advantage-hint-area');
  if (area) {
    area.innerHTML = `<div class="revealed-answer-hint"><div class="hint-label">🔓 Answer Revealed</div><div class="hint-value">${escHtml(answer)}</div></div>`;
  }
  // Also update the answer card back to show real answer
  const cardVal = $('#answer-card-value');
  if (cardVal) cardVal.textContent = answer;
  // Flip the answer card
  const card = document.getElementById('answer-card');
  if (card) card.classList.add('flipped');
  sfx('correct');
  showToast('Answer revealed! 👀', 2000);
});

// ─── Timer Sync (server-driven lockstep) ───
socket.on('timer-sync', ({ timerEnd, phase, serverTime }) => {
  // Calculate offset between server time and local time
  const offset = Date.now() - serverTime;
  const correctedEnd = timerEnd + offset;
  const fill = $('#timer-fill'), text = $('#timer-text');
  if (!fill || !text) return;
  // Only update if we're in the matching phase
  const totalMs = phase === 'question' ? QUESTION_TIMER_MS : GUESS_TIMER_MS;
  const warnSec = phase === 'question' ? QUESTION_WARN_SEC : GUESS_WARN_SEC;
  const rem = Math.max(0, correctedEnd - Date.now());
  const pct = (rem / totalMs) * 100;
  const secs = Math.ceil(rem / 1000);
  fill.style.width = pct + '%';
  text.textContent = secs + 's';
  if (secs <= warnSec && secs > 0) {
    fill.classList.add('warning');
    text.classList.add('warning');
  } else {
    fill.classList.remove('warning');
    text.classList.remove('warning');
  }
});

socket.on('room-created', ({ roomCode }) => {
  state.roomCode = roomCode; state.hasLeftRoom = false; closeAllPanels(); showScreen('waiting'); showToast('Room created!');
});
socket.on('room-joined', ({ roomCode }) => {
  state.roomCode = roomCode; state.hasLeftRoom = false; closeAllPanels(); showScreen('waiting'); showToast('Joined!');
});
socket.on('join-error', m => showToast('❌ ' + m));
socket.on('game-error', m => showToast('❌ ' + m));
socket.on('rooms-updated', () => { if ($('#tab-join')?.classList.contains('active')) fetchRooms(); });

socket.on('room-state', data => {
  // ═══ GUARD: If player has left, ignore ALL room-state events (prevents ghost re-entry) ═══
  if (state.hasLeftRoom) return;
  if (!state.roomCode) return;
  if (data.roomCode !== state.roomCode) return;

  // Check if this player is even in the player list
  const meInRoom = data.players.some(p => p.id === state.myId);
  if (!meInRoom && data.phase !== 'waiting') return;

  state.lastRoomState = data;
  if (data.phase === 'waiting') {
    $('#waiting-room-code').textContent = data.roomCode;
    // Show room name instead of code
    const nameEl = $('#waiting-room-name');
    if (nameEl) nameEl.textContent = data.roomName || data.roomCode;
    $('#waiting-players').innerHTML = data.players.map(p => `<div class="waiting-player"><span class="wp-avatar">${p.avatar}</span><span class="wp-name">${escHtml(p.name)}</span>${p.isHost ? '<span class="wp-host">Host</span>' : ''}</div>`).join('');
    const me = data.players.find(p => p.id === state.myId);
    if (me?.isHost && data.players.length >= 2) {
      $('#btn-start-game').style.display = 'flex';
      $('#btn-start-game').textContent = `🚀 Start Game (${data.players.length}/${data.maxPlayers})`;
    } else { $('#btn-start-game').style.display = 'none'; }
  } else if (['question','guess'].includes(data.phase)) {
    showScreen('game');
    isInGame = true;
    $('#game-round-badge').textContent = `Round ${data.currentRound}/${data.totalRounds}`;
    // Show pack banner if using a pack
    const packBanner = $('#game-pack-banner');
    if (packBanner) {
      if (data.packDisplayName && data.questionPack !== 'default') {
        packBanner.style.display = 'flex';
        $('#game-pack-name').textContent = `Playing: ${data.packDisplayName}`;
      } else {
        packBanner.style.display = 'none';
      }
    }
    renderGameContent(data);
    updateLB(data.players); updatePL(data.players);
  }
});

socket.on('guess-results', ({ results, correctAnswer, question, scores, anyCorrect, turnPlayerName, turnPlayerId, turnPlayerAnswer }) => {
  clearInterval(state.timerInterval);

  // Determine if I am the question creator
  const isQuestionCreator = (state.myId === turnPlayerId);

  // ─── Helper functions ───
  function matchBadge(r) {
    if (r.matchType === 'exact') return '<span class="match-badge match-exact">Perfect Match 🔥 +3</span>';
    if (r.matchType === 'partial') return '<span class="match-badge match-partial">Close Match 👍 +1</span>';
    return '<span class="match-badge match-none">No Match ❌ 0</span>';
  }
  function matchScoreLabel(r) {
    if (r.matchScore === 3) return '<span class="rr-points rr-points-full">+3</span><span class="bonus-badge">🔥 BONUS</span>';
    if (r.matchScore === 2) return '<span class="rr-points rr-points-full">+2</span>';
    if (r.matchScore === 1) return '<span class="rr-points rr-points-half">+1</span>';
    return '<span class="rr-points rr-points-zero">+0</span>';
  }

  const my = results[state.myId];
  const myGuess = my ? (my.guess || '—') : '—';
  const myMatchType = my ? my.matchType : 'none';

  // Determine result text for guessers
  let resultLabel = 'No Match ❌ 0', resultClass = 'result-none', resultSub = 'Better luck next time!';
  if (myMatchType === 'exact') { resultLabel = 'Perfect Match 🔥 +3'; resultClass = 'result-exact'; resultSub = 'You nailed it! +2 base + 1 bonus = +3 points'; }
  else if (myMatchType === 'partial') { resultLabel = 'Close Match 👍 +1'; resultClass = 'result-partial'; resultSub = 'Almost there! +1 point'; }

  let h = '';

  if (isQuestionCreator) {
    // ════════════════════════════════════════════════════════════
    // QUESTION CREATOR VIEW: Full result UI with answer comparison
    // ════════════════════════════════════════════════════════════
    h += `<div class="game-question-display"><div class="q-label">Your Question</div><div class="q-text">${escHtml(question)}</div></div>`;

    // Answer card — flip to reveal
    h += `<div class="answer-card-wrapper">
      <div class="answer-card" id="answer-card-reveal">
        <div class="answer-card-inner">
          <div class="answer-card-front">
            <div class="answer-card-icon">🔒</div>
            <div class="answer-card-label">Answer Hidden</div>
            <div class="answer-card-masked">• • • • •</div>
          </div>
          <div class="answer-card-back">
            <div class="answer-card-icon">✨</div>
            <div class="answer-card-label">Your Answer</div>
            <div class="answer-card-value">${escHtml(correctAnswer)}</div>
          </div>
        </div>
      </div>
    </div>`;

    // All guesses with comparison — ONLY for question creator
    h += `<div class="results-card"><h4>All Guesses</h4>`;
    Object.values(results).forEach(r => {
      h += `<div class="result-row">
        <span class="rr-name">${escHtml(r.playerName)}</span>
        <span class="rr-guess">${escHtml(r.guess||'—')}</span>
        <span class="rr-score-slot phase-hidden">${matchScoreLabel(r)}</span>
        <span class="rr-badge-slot phase-hidden">${matchBadge(r)}</span>
      </div>`;
    });
    h += '</div>';

    // All answers revealed section — ONLY for creator
    h += '<div class="both-answers-section" id="both-answers-section" style="display:none">';
    h += '<div class="both-answers-title">👁️ All Answers Revealed</div>';
    h += `<div class="answer-pair">
      <div class="answer-pair-card ap-creator">
        <div class="ap-label">${escHtml(turnPlayerName || 'Creator')}'s Answer</div>
        <div class="ap-value">${escHtml(correctAnswer)}</div>
      </div>
    </div>`;
    Object.values(results).forEach(r => {
      h += `<div class="answer-pair">
        <div class="answer-pair-card ap-guesser">
          <div class="ap-label">${escHtml(r.playerName)}'s Guess</div>
          <div class="ap-value">${escHtml(r.guess || '—')}</div>
        </div>
      </div>`;
    });
    h += '</div>';

  } else {
    // ════════════════════════════════════════════════════════════
    // GUESSER VIEW: Simple result — only their own guess vs answer
    // ════════════════════════════════════════════════════════════
    h += `<div class="game-question-display"><div class="q-label">Question</div><div class="q-text">${escHtml(question)}</div></div>`;

    // Answer card — flip to reveal
    h += `<div class="answer-card-wrapper">
      <div class="answer-card" id="answer-card-reveal">
        <div class="answer-card-inner">
          <div class="answer-card-front">
            <div class="answer-card-icon">🔒</div>
            <div class="answer-card-label">Answer Hidden</div>
            <div class="answer-card-masked">• • • • •</div>
          </div>
          <div class="answer-card-back">
            <div class="answer-card-icon">✨</div>
            <div class="answer-card-label">Answer Revealed</div>
            <div class="answer-card-value">${escHtml(correctAnswer)}</div>
          </div>
        </div>
      </div>
    </div>`;

    // Comparison cards — only for guessers who submitted
    if (my) {
      h += `<div class="answer-compare-row" id="compare-row" style="display:none">
        <div class="answer-compare-card card-friend">
          <div class="compare-card-icon">💬</div>
          <div class="compare-card-label">Correct Answer</div>
          <div class="compare-card-value">${escHtml(correctAnswer)}</div>
        </div>
        <div class="compare-vs">VS</div>
        <div class="answer-compare-card card-mine" id="my-answer-card">
          <div class="compare-card-icon">🎯</div>
          <div class="compare-card-label">Your Guess</div>
          <div class="compare-card-value">${escHtml(myGuess)}</div>
        </div>
      </div>`;

      // Result score text
      h += `<div class="compare-result-text" id="compare-result-text">
        <div class="compare-result-label ${resultClass}">${resultLabel}</div>
        <div class="compare-result-sub">${resultSub}</div>
      </div>`;
    }

    // Simple scoreboard — no detailed badge/score breakdown for guessers
    h += `<div class="results-card" id="simple-results" style="display:none"><h4>Results</h4>`;
    Object.values(results).forEach(r => {
      const icon = r.matchType === 'exact' ? '🔥' : r.matchType === 'partial' ? '👍' : '❌';
      h += `<div class="result-row">
        <span class="rr-name">${escHtml(r.playerName)}</span>
        <span class="rr-guess">${escHtml(r.guess||'—')}</span>
        <span class="rr-score-slot">${icon}</span>
      </div>`;
    });
    h += '</div>';
  }

  $('#game-content').innerHTML = h;

  // ═══════════════════════════════════════════════════════════
  // PHASE 2 (800ms): FLIP the answer card to reveal correct answer
  // ═══════════════════════════════════════════════════════════
  setTimeout(() => {
    const card = document.getElementById('answer-card-reveal');
    if (card) card.classList.add('flipped');
    sfx('click');
  }, 800);

  // ═══════════════════════════════════════════════════════════
  // PHASE 2.5 (1800ms): Show comparison cards (guesser) or comparison rows (creator)
  // ═══════════════════════════════════════════════════════════
  setTimeout(() => {
    const row = document.getElementById('compare-row');
    if (row) row.style.display = 'flex';
  }, 1800);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3 (3500ms): Apply color feedback + reveal scores
  // ═══════════════════════════════════════════════════════════
  setTimeout(() => {
    if (isQuestionCreator) {
      // Creator: reveal all score badges
      document.querySelectorAll('.phase-hidden').forEach(el => {
        el.classList.remove('phase-hidden');
        el.classList.add('phase-reveal');
      });
      // Show both answers section
      const bothSection = document.getElementById('both-answers-section');
      if (bothSection) bothSection.style.display = 'block';
    } else {
      // Guesser: apply color to their answer card + reveal result text
      const myCard = document.getElementById('my-answer-card');
      if (myCard) myCard.classList.add(`match-result-${myMatchType}`);

      const resultText = document.getElementById('compare-result-text');
      if (resultText) resultText.classList.add('revealed');

      // Show simple results card
      const simpleResults = document.getElementById('simple-results');
      if (simpleResults) simpleResults.style.display = 'block';
    }

    // Sound effects based on match result
    if (isQuestionCreator) {
      sfx('click');
    } else if (my?.matchType === 'exact') {
      playSoundPack('correct');
    } else if (my?.matchType === 'partial') {
      sfx('click');
    } else if (my) {
      playSoundPack('wrong');
    }

    // ─── COIN EARNING: Only for guessers, matchScore from server already includes bonus ───
    if (!isQuestionCreator && my && my.matchScore > 0) {
      let earned = state.doubleNext ? my.matchScore * 2 : my.matchScore;
      state.doubleNext = false;
      addCoins(earned);
      // Track perfect matches for secret tasks
      if (my.matchType === 'exact') {
        const tasks = loadTasks();
        tasks.perfectCount = (tasks.perfectCount || 0) + 1;
        saveTasks(tasks);
      }
    }

    // Update leaderboard data
    if (anyCorrect) updateLB(scores, results);
  }, 3500);

  // ═══════════════════════════════════════════════════════════
  // PHASE 4 (6500ms): Show leaderboard briefly if someone scored
  // ═══════════════════════════════════════════════════════════
  if (anyCorrect) {
    setTimeout(() => openPopup('leaderboard'), 6500);
    setTimeout(() => closePopup('leaderboard'), 8500);
  }

  // Server auto-advances to next question at 10000ms
});

socket.on('game-over', ({ winner, scores, packName, totalRounds }) => {
  clearInterval(state.timerInterval); playSoundPack('win');
  isInGame = false;
  $('#gameover-title').textContent = winner.id === state.myId ? '🎉 You Won!' : 'Game Over!';
  $('#gameover-winner').innerHTML = `${winner.avatar} <strong>${escHtml(winner.name)}</strong> wins with ${winner.score} pts!`;
  $('#gameover-scores').innerHTML = scores.map((s,i) => `<div class="lb-row${s.id===winner.id?' highlight':''}"><span class="lb-rank ${['gold','silver','bronze'][i]||''}">#${i+1}</span><span class="lb-avatar">${s.avatar}</span><div class="lb-info"><div class="lb-name">${escHtml(s.name)}</div></div><span class="lb-score">${s.score}</span></div>`).join('');
  openPopup('gameover');
  // HISTORY DETAILS: Save rich history data with all player scores
  const hi = {
    date: new Date().toLocaleString(),
    result: winner.id === state.myId ? '🏆 Won!' : `${winner.name} won`,
    winner: winner.name,
    score: scores.find(s => s.id === state.myId)?.score || 0,
    players: scores.length,
    allScores: scores.map(s => ({ name: s.name, score: s.score, avatar: s.avatar })),
    packName: packName || 'default',
    totalRounds: totalRounds || 0
  };
  state.history.unshift(hi); if (state.history.length > 30) state.history.pop();
  localStorage.setItem('ms-history', JSON.stringify(state.history));

  // ─── PROFILE STATS UPDATE ───
  const prof = loadProfile();
  prof.matches = (prof.matches || 0) + 1;
  const iWon = winner.id === state.myId;
  if (iWon) prof.wins = (prof.wins || 0) + 1;
  // Track opponents for Best Friend
  scores.forEach(s => {
    if (s.id !== state.myId) {
      if (!prof.opponents) prof.opponents = {};
      prof.opponents[s.name] = (prof.opponents[s.name] || 0) + 1;
      // ─── FRIEND LEVEL TRACKING ───
      updateFriendData(s.name);
    }
  });
  saveProfile(prof);

  // ─── TASK TRACKING ───
  const tasks = loadTasks();
  if (iWon) {
    tasks.winStreak = (tasks.winStreak || 0) + 1;
    if (!state.usedAnyAdvantage) tasks.noAdvWin = true;
  } else {
    tasks.winStreak = 0;
  }
  saveTasks(tasks);
  state.usedAnyAdvantage = false;

  // ─── GLOBAL LEADERBOARD UPDATE ───
  updateGlobalLeaderboard();
  // ─── SYNC PROFILE TO SERVER (World LB) ───
  syncProfileToServer();
});

// ── Emoji with name ──
socket.on('emoji-reaction', ({ playerName, emoji }) => {
  // Floating emoji
  const el = document.createElement('div'); el.className = 'floating-emoji';
  el.innerHTML = `<span style="font-size:32px">${emoji}</span><span style="font-size:11px;display:block;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.7);margin-top:-4px">${escHtml(playerName)}</span>`;
  el.style.left = (15 + Math.random() * 70) + '%'; el.style.bottom = '12%';
  $('#emoji-float-container').appendChild(el); setTimeout(() => el.remove(), 2200);
  // Toast
  showToast(`${playerName} sent ${emoji}`, 1500);
});

// ── Player left ──
socket.on('player-left', ({ playerName, remainingPlayers }) => {
  showToast(`${playerName} left the game`, 3000);
  // Close play-again popup if open (opponent left while showing play-again prompt)
  closePopup('play-again');
  closePopup('gameover');
  clearInterval(state._pat);
  clearTimeout(state._playAgainTimeout);
  // If opponent left, immediately notify and go home
  if (remainingPlayers < 2 && state.lastRoomState) {
    clearInterval(state.timerInterval);
    closeAllPopups();
    showToast('⚠️ Opponent left. Game ended.', 4000);
    setTimeout(() => goHome(), 2000);
  }
});

// ── Force exit game (server removed this player) ──
socket.on('force-exit-game', ({ reason }) => {
  clearInterval(state.timerInterval);
  closeAllPopups();
  clearTimeout(state._playAgainTimeout);
  showToast(reason || 'Game ended', 4000);
  cleanupAndGoHome();
});

// ── Game ended (not enough players etc) ──
socket.on('game-ended', ({ reason }) => {
  clearInterval(state.timerInterval);
  closeAllPopups();
  clearTimeout(state._playAgainTimeout);
  showToast(reason || 'Game ended', 4000);
  setTimeout(() => goHome(), 1500);
});

// ── Remove player from room (cleanup event) ──
socket.on('remove-player-from-room', ({ playerId }) => {
  if (playerId === state.myId) {
    state.hasLeftRoom = true;
    state.roomCode = null;
  }
});

// ── Update turn queue ──
socket.on('update-turn-queue', ({ activePlayers }) => {
  // Update player list display if popup is open
  if (state.lastRoomState) {
    state.lastRoomState.players = activePlayers;
  }
});

// ── Room closed (force exit) ──
socket.on('room-closed', ({ reason }) => {
  if (state.hasLeftRoom) return;
  clearInterval(state.timerInterval);
  closeAllPopups();
  showToast(reason || 'Room closed', 4000);
  setTimeout(() => goHome(), 1500);
});

// ── Name changed ──
socket.on('name-changed', ({ oldName, newName }) => {
  if (newName !== state.playerName) showToast(`${oldName} → ${newName}`, 2000);
});

// ── Play again ──
socket.on('play-again-request', ({ fromName }) => {
  $('#play-again-text').textContent = `${fromName} wants to play again!`;
  openPopup('play-again');
  let t = 4000; const f = $('#play-again-timer-fill'); f.style.width = '100%';
  const iv = setInterval(() => { t -= 100; f.style.width = (t/4000*100)+'%'; if (t <= 0) { clearInterval(iv); closePopup('play-again'); socket.emit('play-again-reject', { roomCode: state.roomCode }); } }, 100);
  state._pat = iv;
});
socket.on('play-again-start', () => { clearTimeout(state._playAgainTimeout); closeAllPopups(); showToast('New game starting!'); });
socket.on('play-again-rejected', ({ byName }) => { clearTimeout(state._playAgainTimeout); showToast(`${byName} declined`); setTimeout(() => goHome(), 1500); });
socket.on('play-again-error', msg => { clearTimeout(state._playAgainTimeout); showToast('❌ ' + msg); setTimeout(() => goHome(), 1500); });

function requestPlayAgain() {
  // Validate: check if there are other active & connected players
  if (state.lastRoomState) {
    const others = state.lastRoomState.players.filter(p => p.id !== state.myId && p.connected !== false);
    if (others.length < 1) {
      showToast('❌ No player available. Returning home.', 3000);
      setTimeout(() => goHome(), 1500);
      return;
    }
  }
  // Server auto-accepts the requester, so no need to send play-again-accept separately
  socket.emit('play-again-request', { roomCode: state.roomCode });
  showToast('Waiting for others…');
  sfx('click');

  // Timeout: if no response in 4 seconds, cancel and go home
  state._playAgainTimeout = setTimeout(() => {
    showToast('⏱ Player not interested. Returning home.', 3000);
    setTimeout(() => goHome(), 1500);
  }, 4000);
}
function acceptPlayAgain() {
  clearInterval(state._pat);
  clearTimeout(state._playAgainTimeout);
  closePopup('play-again');
  socket.emit('play-again-accept', { roomCode: state.roomCode });
  showToast('Accepted!');
}
function rejectPlayAgain() {
  clearInterval(state._pat);
  clearTimeout(state._playAgainTimeout);
  closePopup('play-again');
  socket.emit('play-again-reject', { roomCode: state.roomCode });
}

function updateLB(scores, results) {
  const sorted = [...(Array.isArray(scores)?scores:[])].sort((a,b)=>b.score-a.score);
  $('#leaderboard-list').innerHTML = sorted.map((s,i) => {
    const r = results && results[s.id];
    const got = r && (r.matchType === 'exact' || r.matchType === 'partial');
    const plusLabel = r?.matchType === 'exact' ? '+2' : r?.matchType === 'partial' ? '+1' : '';
    return `<div class="lb-row${got?' highlight':''}"><span class="lb-rank ${['gold','silver','bronze'][i]||''}">#${i+1}</span><span class="lb-avatar">${s.avatar}</span><div class="lb-info"><div class="lb-name">${escHtml(s.name)}</div><div class="lb-score-label">${s.score} pts</div></div><span class="lb-score">${s.score}</span>${got?`<span class="lb-plus">${plusLabel}</span>`:''}</div>`;
  }).join('');
}
function updatePL(players) {
  const list = $('#players-popup-list');
  list.innerHTML = (Array.isArray(players)?players:[]).map(p => `<div class="pl-row" data-pid="${p.id}" data-pname="${escHtml(p.name)}" data-pavatar="${p.avatar}" data-pscore="${p.score}"><span class="lb-avatar">${p.avatar}</span><div class="lb-info"><div class="lb-name">${escHtml(p.name)}</div></div><span class="lb-score">${p.score}</span></div>`).join('');
  list.querySelectorAll('.pl-row').forEach(row => row.onclick = () => {
    openPublicProfile(row.dataset.pname, row.dataset.pavatar);
  });
}

// ─── Letter Hint Response ───
socket.on('letter-hint', ({ hint }) => {
  const area = $('#advantage-hint-area');
  if (area) {
    area.innerHTML = `<div class="letter-hint-display"><div class="lh-label">🔍 First 2 Letters</div><div class="lh-value">${escHtml(hint)}</div></div>`;
  }
  sfx('click');
  showToast('Letter hint revealed! 🔍', 2000);
});

// ─── Profile Rendering ───
function renderProfile() {
  const prof = loadProfile();
  const rank = getRankInfo(state.coins, prof.wins || 0);
  $('#profile-avatar').textContent = state.avatar;
  $('#profile-name').textContent = state.playerName;
  $('#profile-name-edit').style.display = 'none';
  $('#profile-rank-badge').textContent = rank.label;
  $('#profile-rank-badge').className = 'profile-rank-badge';
  $('#profile-coins').textContent = state.coins;
  $('#profile-matches').textContent = prof.matches || 0;
  $('#profile-wins').textContent = prof.wins || 0;
  const wr = prof.matches > 0 ? Math.round((prof.wins||0)/(prof.matches)*100) : 0;
  $('#profile-winrate').textContent = wr + '%';
  // Build avatar selector in profile
  buildProfileAvatarGrid();
  // Best Friend detection
  const bfEl = $('#profile-best-friend');
  if (prof.opponents && Object.keys(prof.opponents).length > 0) {
    const sorted = Object.entries(prof.opponents).sort((a,b) => b[1]-a[1]);
    $('#bf-name').textContent = sorted[0][0];
    bfEl.style.display = 'flex';
  } else {
    bfEl.style.display = 'none';
  }
  // ─── Pack Earnings (Firebase) ───
  fetchPackEarnings();
  // ─── Friends List with Levels ───
  renderFriendsList();
}

function buildProfileAvatarGrid() {
  const grid = $('#profile-avatar-grid');
  if (!grid) return;
  grid.innerHTML = '';
  AVATARS.forEach(a => {
    const d = document.createElement('div');
    d.className = 'profile-avatar-option' + (a === state.avatar ? ' active' : '');
    d.textContent = a;
    d.onclick = () => {
      state.avatar = a; localStorage.setItem('ms-avatar', a);
      $$('.profile-avatar-option').forEach(o => o.classList.remove('active')); d.classList.add('active');
      $$('.avatar-option').forEach(o => o.classList.toggle('active', o.textContent === a));
      $('#profile-avatar').textContent = a;
      updateHomeUI(); sfx('click');
    };
    grid.appendChild(d);
  });
}

// ─── Pack earnings from Firebase ───
function fetchPackEarnings() {
  const container = $('#profile-pack-earnings');
  if (!container) return;

  db.ref('purchases').orderByChild('creator').equalTo(state.playerName)
    .once('value').then(snapshot => {
      const data = snapshot.val();
      if (!data) {
        container.innerHTML = '<p class="empty-state">No pack earnings yet</p>';
        return;
      }
      const earnings = Object.values(data).sort((a, b) => (b.date || 0) - (a.date || 0));
      const totalEarned = earnings.reduce((sum, e) => sum + (e.coins || 0), 0);
      let h = `<div class="earning-total">💰 Total Earned: ${totalEarned} coins</div>`;
      earnings.slice(0, 10).forEach(e => {
        h += `<div class="earning-row">
          <div><div class="er-buyer">${escHtml(e.buyer || 'Someone')} bought</div><div class="er-pack">${escHtml(e.packName || 'A pack')}</div></div>
          <div class="er-amount">+${e.coins || 0} 💰</div>
        </div>`;
      });
      container.innerHTML = h;
    }).catch(() => {
      container.innerHTML = '<p class="empty-state">No pack earnings yet</p>';
    });
}

function renderFriendsList() {
  const container = $('#profile-friends-list');
  if (!container) return;
  const fd = loadFriendData();
  const entries = Object.entries(fd).sort((a,b) => b[1] - a[1]);
  if (!entries.length) { container.innerHTML = '<p class="empty-state">Play matches to make friends!</p>'; return; }
  container.innerHTML = entries.map(([name, matches]) => {
    const fl = getFriendLevel(name);
    return `<div class="friend-row">
      <div class="friend-info"><span class="friend-name">${escHtml(name)}</span>
      <span class="friend-matches">${matches} matches</span></div>
      <span class="friend-level-badge ${fl.cls}">${fl.label}</span>
    </div>`;
  }).join('');
}

// ─── Global Leaderboard ───
function updateGlobalLeaderboard() {
  checkWeeklyReset();
  const lb = loadGlobalLB();
  const prof = loadProfile();
  const me = lb.find(e => e.name === state.playerName);
  if (me) {
    me.coins = state.coins; me.wins = prof.wins||0; me.avatar = state.avatar;
  } else {
    lb.push({ name: state.playerName, coins: state.coins, wins: prof.wins||0, avatar: state.avatar });
  }
  saveGlobalLB(lb);
}

function renderGlobalLB() {
  checkWeeklyReset();
  updateGlobalLeaderboard();
  const lb = loadGlobalLB().sort((a,b) => b.coins - a.coins);
  const list = $('#global-lb-list');
  // Reset timer display
  const weekStart = getWeekStart();
  const nextReset = weekStart + 7*24*60*60*1000;
  const daysLeft = Math.max(0, Math.ceil((nextReset - Date.now())/(24*60*60*1000)));
  $('#global-lb-reset').textContent = `Resets in ${daysLeft} day${daysLeft!==1?'s':''}`;
  if (lb.length === 0) {
    list.innerHTML = '<p class="empty-state">No players yet. Play to join!</p>';
    return;
  }
  list.innerHTML = lb.slice(0,20).map((p,i) => {
    const rank = getRankInfo(p.coins, p.wins);
    const isMe = p.name === state.playerName;
    const top3 = i < 3;
    return `<div class="glb-row${isMe?' glb-me':''}${top3?' glb-top3':''}">
      <span class="glb-rank" style="color:${i===0?'#ffd700':i===1?'#c0c0c0':i===2?'#cd7f32':'var(--text3)'}">#${i+1}</span>
      <span class="glb-avatar">${p.avatar||'😀'}</span>
      <div class="glb-info"><div class="glb-name">${escHtml(p.name)}${isMe?' (You)':''}</div>
      <div class="glb-rank-label" style="color:${rank.cls==='rank-legend'?'#ff6b6b':rank.cls==='rank-gold'?'#ffd700':rank.cls==='rank-silver'?'#c0c0c0':'#cd7f32'}">${rank.label}</div></div>
      <span class="glb-coins">${p.coins} 💰</span>
      <span class="glb-wins">${p.wins}W</span>
    </div>`;
  }).join('');
}

// ─── Secret Tasks ───
function renderSecretTasks() {
  const tasks = loadTasks();
  // Task 1: Win 2 in a row
  const t1prog = Math.min(tasks.winStreak||0, 2);
  $('#task1-progress').style.width = (t1prog/2*100)+'%';
  $('#task1-progress-text').textContent = `${t1prog} / 2 wins`;
  updateTaskStatus(1, t1prog >= 2, tasks.claimed[0]);
  // Task 2: 3 perfect matches
  const t2prog = Math.min(tasks.perfectCount||0, 3);
  $('#task2-progress').style.width = (t2prog/3*100)+'%';
  $('#task2-progress-text').textContent = `${t2prog} / 3 perfect matches`;
  updateTaskStatus(2, t2prog >= 3, tasks.claimed[1]);
  // Task 3: Win without advantage
  const t3done = tasks.noAdvWin || false;
  $('#task3-progress').style.width = t3done ? '100%' : '0%';
  $('#task3-progress-text').textContent = t3done ? 'Completed!' : 'Not completed';
  updateTaskStatus(3, t3done, tasks.claimed[2]);
}

function updateTaskStatus(num, completed, claimed) {
  const statusEl = $(`#task${num}-status`);
  const claimBtn = $(`#btn-claim-task${num}`);
  if (claimed) {
    statusEl.textContent = 'Claimed'; statusEl.className = 'stc-status claimed';
    claimBtn.style.display = 'none';
  } else if (completed) {
    statusEl.textContent = 'Complete!'; statusEl.className = 'stc-status completed';
    claimBtn.style.display = 'block';
  } else {
    statusEl.textContent = 'In Progress'; statusEl.className = 'stc-status active';
    claimBtn.style.display = 'none';
  }
}

function claimTask(idx, reward) {
  const tasks = loadTasks();
  if (tasks.claimed[idx]) return showToast('Already claimed!');
  tasks.claimed[idx] = true;
  saveTasks(tasks);
  addCoins(reward);
  spawnCoinRain();
  showToast(`🎉 Task reward: +${reward} coins!`, 3000);
  renderSecretTasks();
}

// ─── Coin Rain Animation ───
function spawnCoinRain() {
  const container = $('#coin-rain-container');
  if (!container) return;
  for (let i = 0; i < 15; i++) {
    setTimeout(() => {
      const coin = document.createElement('div');
      coin.className = 'coin-rain';
      coin.textContent = '💰';
      coin.style.left = (Math.random() * 90 + 5) + '%';
      coin.style.animationDuration = (1 + Math.random()) + 's';
      container.appendChild(coin);
      setTimeout(() => coin.remove(), 2000);
    }, i * 100);
  }
}

// ─── PWA ───
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#btn-install-topbar').style.display = 'flex'; });
function installApp() { if (!deferredPrompt) return showToast('Not available'); deferredPrompt.prompt(); deferredPrompt.userChoice.then(() => { deferredPrompt = null; $('#btn-install-topbar').style.display = 'none'; }); }
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(()=>{});

// ═══════════════════════════════════════════════════
// ═══ 1. QUESTION PACKS SYSTEM (Buy/Unlock) ═══
// ═══════════════════════════════════════════════════
const DEFAULT_PACKS = {
  love: { name: '❤️ Love Pack', emoji: '❤️', cost: 50, questions: [
    'What is your partner\'s favorite color?','What is your first date memory?','What gift would make you happiest?',
    'What song reminds you of love?','What is your love language?','What is the most romantic place?',
    'What nickname do you use for your partner?','What movie makes you cry?','What is your dream honeymoon?',
    'What is the sweetest thing someone said to you?'
  ]},
  school: { name: '😂 School Memories', emoji: '😂', cost: 50, questions: [
    'Who was the class clown?','What was your favorite subject?','Who was your best friend in school?',
    'What was your most embarrassing moment?','Which teacher was the strictest?','What did you eat for lunch?',
    'What was your school crush\'s name?','What sport did you play?','What was your nickname?',
    'What was your favorite school event?'
  ]},
  crazy: { name: '😈 Crazy Truth', emoji: '😈', cost: 50, questions: [
    'What is the craziest thing you\'ve done?','What secret have you never told?','What is your guilty pleasure?',
    'What would you do with a million dollars?','What is your weirdest habit?','Who would you swap lives with?',
    'What is the most daring thing on your bucket list?','What is your biggest fear?','What lie do you tell most?',
    'If you could break one law, what would it be?'
  ]}
};
function loadOwnedPacks() { return JSON.parse(localStorage.getItem('ms-owned-packs') || '[]'); }
function saveOwnedPacks(p) { localStorage.setItem('ms-owned-packs', JSON.stringify(p)); }
function isPackOwned(key) { return loadOwnedPacks().includes(key); }
function buyPack(key) {
  const pack = DEFAULT_PACKS[key]; if (!pack) return;
  if (isPackOwned(key)) return showToast('Already owned!');
  if (!spendCoins(pack.cost)) return showToast('Not enough coins!');
  const owned = loadOwnedPacks(); owned.push(key); saveOwnedPacks(owned);
  showToast(`✅ ${pack.name} unlocked!`); spawnCoinRain(); renderQuestionPacks(); refreshPackSelector();
}
function loadCustomPacks() { return JSON.parse(localStorage.getItem('ms-custom-packs') || '[]'); }
function saveCustomPacks(p) { localStorage.setItem('ms-custom-packs', JSON.stringify(p)); }

function renderQuestionPacks() {
  const list = $('#qp-list'); if (!list) return;
  const custom = loadCustomPacks();
  const owned = loadOwnedPacks();
  let h = '';
  // Default packs with buy/unlock
  Object.entries(DEFAULT_PACKS).forEach(([key, pack]) => {
    const isOwned = owned.includes(key);
    h += `<div class="qp-card${isOwned?' qp-owned':''}">
      <div class="qp-card-header"><div class="qp-card-name">${pack.name}</div>
      <div class="qp-card-count">${pack.questions.length} Q</div></div>
      <div class="qp-card-questions">${pack.questions.slice(0,3).map(q=>'• '+q).join('<br>')}...</div>
      <div class="qp-card-actions">${isOwned
        ? '<span class="qp-owned-badge">✅ Owned</span>'
        : `<button class="qp-buy-btn" data-pack="${key}">🔓 Unlock (${pack.cost} 💰)</button>`
      }</div></div>`;
  });
  // Local custom packs
  custom.forEach((pack, i) => {
    h += `<div class="qp-card qp-owned"><div class="qp-card-header"><div class="qp-card-name">✨ ${escHtml(pack.name)}</div><div class="qp-card-count">${pack.questions.length} Q</div></div>
    <div class="qp-card-questions">${pack.questions.slice(0,3).map(q=>'• '+escHtml(q)).join('<br>')}</div>
    <div class="qp-card-actions"><button class="qp-delete-btn" data-idx="${i}">🗑 Delete</button></div></div>`;
  });

  // ═══ FIREBASE PACKS: Show ALL packs from Firebase (visible to ALL users) ═══
  const fbPacks = _firebasePacksCache || {};
  const fbEntries = Object.entries(fbPacks);
  if (fbEntries.length > 0) {
    h += '<div style="margin-top:16px;font-size:13px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:2px;margin-bottom:10px">🌐 Community Packs</div>';
    fbEntries.forEach(([id, p]) => {
      const isMine = p.creator === state.playerName;
      const buyerNames = Object.keys(p.buyers || {});
      const isOwned = buyerNames.includes(state.playerName) || isMine;
      // Check if already in local custom packs (by serverPackId)
      const alreadyLocal = custom.some(cp => cp.serverPackId === id);
      if (alreadyLocal) return; // Skip if already shown as local pack
      let actionHtml = '';
      if (isMine) actionHtml = '<span class="qp-owned-badge">✨ Your Pack</span>';
      else if (isOwned) actionHtml = '<span class="qp-owned-badge">✅ Owned</span>';
      else actionHtml = `<button class="qp-buy-btn-firebase" data-fpid="${id}" ${state.coins < (p.price || 50) ? 'disabled' : ''}>🔓 Buy (${p.price || 50} 💰)</button>`;
      h += `<div class="qp-card${isOwned?' qp-owned':''}">
        <div class="qp-card-header"><div class="qp-card-name">${escHtml(p.name || 'Unnamed')}</div><div class="qp-card-count">${(p.questions || []).length} Q</div></div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">by ${escHtml(p.creator || 'Unknown')}</div>
        <div class="qp-card-questions">${(p.questions || []).slice(0,3).map(q=>'• '+escHtml(q)).join('<br>')}...</div>
        <div class="qp-card-actions">${actionHtml}</div>
      </div>`;
    });
  }

  list.innerHTML = h || '<p class="empty-state">No packs yet</p>';
  list.querySelectorAll('.qp-buy-btn').forEach(b => b.onclick = () => buyPack(b.dataset.pack));
  list.querySelectorAll('.qp-delete-btn').forEach(b => b.onclick = () => { const c = loadCustomPacks(); c.splice(parseInt(b.dataset.idx),1); saveCustomPacks(c); renderQuestionPacks(); showToast('Pack deleted'); refreshPackSelector(); });
  // Wire Firebase buy buttons
  list.querySelectorAll('.qp-buy-btn-firebase').forEach(b => b.onclick = () => {
    const pid = b.dataset.fpid;
    const packData = _firebasePacksCache[pid];
    if (!packData) return showToast('❌ Pack not found');
    firebaseBuyPack(pid, {
      ...packData,
      id: pid,
      price: packData.price || 50,
      buyers: packData.buyers || {}
    });
  });
  console.log('[Packs] Rendered', fbEntries.length, 'Firebase packs +', custom.length, 'local packs');
}

function buildPackCreateForm() {
  const cont = $('#qp-questions-inputs'); if (!cont) return;
  cont.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    cont.innerHTML += `<div class="qp-q-input"><span class="qp-q-num">${i}.</span><input type="text" class="input-field qp-q-field" placeholder="Question ${i}" maxlength="120" autocomplete="off"></div>`;
  }
}

function saveCustomPack() {
  const name = $('#input-pack-name').value.trim();
  if (!name) return showToast('❌ Enter a pack name');
  const fields = $$('.qp-q-field');
  const questions = [];
  let hasShortQ = false;
  let shortIdx = -1;
  fields.forEach((f, i) => {
    const q = f.value.trim();
    if (q) {
      if (q.length <= 3) {
        hasShortQ = true;
        shortIdx = i + 1;
      }
      questions.push(q);
    }
  });
  // Validate: exactly 10 questions
  if (questions.length !== 10) return showToast(`❌ Add exactly 10 questions (you have ${questions.length})`);
  // Validate: each question > 3 chars
  if (hasShortQ) return showToast(`❌ Question ${shortIdx} is too short (must be > 3 characters)`);

  // Save locally
  const packs = loadCustomPacks();
  packs.push({ name, questions });
  saveCustomPacks(packs);

  // ═══ FIREBASE: Publish pack to database for ALL players to see ═══
  const packRef = db.ref('packs').push();
  const packId = packRef.key;
  packRef.set({
    name,
    creator: state.playerName,
    price: 50,
    questions,
    createdAt: Date.now(),
    buyers: {}
  }).then(() => {
    showToast('✅ Pack saved & published to marketplace!', 3000);
    // Save the Firebase pack ID against the last custom pack
    const updatedPacks = loadCustomPacks();
    if (updatedPacks.length > 0) {
      updatedPacks[updatedPacks.length - 1].serverPackId = packId;
      saveCustomPacks(updatedPacks);
    }
    refreshPackSelector();
  }).catch(err => {
    showToast('❌ Failed to publish: ' + err.message);
    console.error('[Firebase] Pack save error:', err);
  });

  refreshPackSelector();
  // Switch to browse tab
  $$('.qp-tab').forEach(x => x.classList.remove('active'));
  $$('.qp-tab')[0].classList.add('active');
  $$('.qp-tab-content').forEach(c => c.style.display = 'none');
  $('#qp-browse').style.display = 'block';
  renderQuestionPacks();
}

// ═══ FIREBASE PACK SYSTEM — Real-time sync, no socket.io ═══
// Cache of marketplace packs from Firebase (updated in real-time)
let _firebasePacksCache = {};

// ─── Real-time Firebase listener: auto-updates ALL pack UIs ───
db.ref('packs').on('value', snapshot => {
  _firebasePacksCache = snapshot.val() || {};
  console.log('[Firebase] Packs updated:', Object.keys(_firebasePacksCache).length, 'total packs');
  // Auto-refresh marketplace UI if visible
  const mpList = $('#qp-marketplace-list');
  if (mpList && mpList.offsetParent !== null) {
    displayMarketplacePacks(_firebasePacksCache);
  }
  // Auto-refresh browse tab to show community packs
  const browseList = $('#qp-list');
  if (browseList && browseList.offsetParent !== null) {
    renderQuestionPacks();
  }
});

// ─── MARKETPLACE: Browse & Buy shared packs ───
function renderMarketplace() {
  // If we already have cached data, display immediately
  if (Object.keys(_firebasePacksCache).length > 0) {
    displayMarketplacePacks(_firebasePacksCache);
  } else {
    // Fetch once if no cache yet
    db.ref('packs').once('value').then(snapshot => {
      _firebasePacksCache = snapshot.val() || {};
      displayMarketplacePacks(_firebasePacksCache);
    });
  }
}

function displayMarketplacePacks(packsObj) {
  const list = $('#qp-marketplace-list');
  if (!list) return;

  const packsArr = Object.entries(packsObj).map(([id, p]) => ({
    id,
    name: p.name || 'Unnamed',
    creator: p.creator || 'Unknown',
    price: p.price || 50,
    questions: p.questions || [],
    questionCount: (p.questions || []).length,
    previewQuestions: (p.questions || []).slice(0, 3),
    buyers: p.buyers || {},
    createdAt: p.createdAt || 0
  })).sort((a, b) => b.createdAt - a.createdAt); // Newest first

  if (!packsArr.length) {
    list.innerHTML = '<p class="empty-state">No shared packs yet. Create one!</p>';
    return;
  }

  list.innerHTML = packsArr.map(p => {
    const isMine = p.creator === state.playerName;
    const buyerNames = Object.keys(p.buyers || {});
    const isOwned = buyerNames.includes(state.playerName) || isMine;
    let actionHtml = '';
    if (isMine) actionHtml = '<span class="mp-owned-badge">✨ Your Pack</span>';
    else if (isOwned) actionHtml = '<span class="mp-owned-badge">✅ Owned</span>';
    else actionHtml = `<button class="mp-buy-btn" data-pid="${p.id}" ${state.coins < p.price ? 'disabled' : ''}>🔓 Buy (${p.price} 💰)</button>`;
    return `<div class="marketplace-pack-card">
      <div class="mp-header"><div class="mp-name">${escHtml(p.name)}</div><div class="qp-card-count">${p.questionCount} Q</div></div>
      <div class="mp-creator">by ${escHtml(p.creator)}</div>
      <div class="mp-preview">${p.previewQuestions.map(q => '• ' + escHtml(q)).join('<br>')}...</div>
      ${actionHtml}
    </div>`;
  }).join('');

  // Wire buy buttons
  list.querySelectorAll('.mp-buy-btn').forEach(b => b.onclick = () => {
    const pid = b.dataset.pid;
    const pack = packsArr.find(p => p.id === pid);
    if (!pack) return;
    firebaseBuyPack(pid, pack);
  });
}

// ─── Buy Pack via Firebase ───
function firebaseBuyPack(packId, packData) {
  if (!packData) return showToast('❌ Pack not found');
  if (state.coins < packData.price) return showToast('❌ Not enough coins!');

  // Check if already owned
  const buyerNames = Object.keys(packData.buyers || {});
  if (buyerNames.includes(state.playerName)) return showToast('Already owned!');
  if (packData.creator === state.playerName) return showToast('You created this pack!');

  // Deduct coins locally
  if (!spendCoins(packData.price)) return showToast('Not enough coins!');

  // ═══ FIREBASE: Record buyer on the pack ═══
  db.ref(`packs/${packId}/buyers/${state.playerName}`).set(true);

  // ═══ FIREBASE: Record purchase ═══
  db.ref('purchases').push({
    buyer: state.playerName,
    creator: packData.creator,
    packId,
    packName: packData.name,
    coins: packData.price,
    date: Date.now()
  });

  // Save as owned local pack (with full questions)
  const localPacks = loadCustomPacks();
  localPacks.push({ name: '🛒 ' + packData.name, questions: packData.questions, serverPackId: packId });
  saveCustomPacks(localPacks);

  showToast(`✅ Pack "${packData.name}" purchased!`, 3000);
  spawnCoinRain();
  refreshPackSelector();
  // Marketplace auto-updates via Firebase listener
}

function refreshPackSelector() {
  const sel = $('#pack-selector'); if (!sel) return;
  const owned = loadOwnedPacks();
  // Update default pack options to show lock/unlock state
  sel.querySelectorAll('.pack-option[data-pack]').forEach(btn => {
    const pk = btn.dataset.pack;
    if (pk === 'default') return; // default always available
    if (pk.startsWith('custom-')) { btn.remove(); return; }
    if (!owned.includes(pk)) {
      btn.classList.add('pack-locked');
      btn.disabled = true;
      btn.title = 'Buy from Question Packs menu';
    } else {
      btn.classList.remove('pack-locked');
      btn.disabled = false;
      btn.title = '';
    }
  });
  // Add custom packs
  sel.querySelectorAll('.pack-option[data-pack^="custom-"]').forEach(e => e.remove());
  const custom = loadCustomPacks();
  custom.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'pack-option';
    btn.dataset.pack = 'custom-' + i;
    btn.textContent = '✨ ' + p.name;
    btn.onclick = () => { $$('.pack-option').forEach(x => x.classList.remove('active')); btn.classList.add('active'); sfx('click'); };
    sel.appendChild(btn);
  });
}

// ═══════════════════════════════════════════════════
// ═══ 2. FRIEND LEVEL SYSTEM ═══
// ═══════════════════════════════════════════════════
function loadFriendData() { return JSON.parse(localStorage.getItem('ms-friends') || '{}'); }
function saveFriendData(d) { localStorage.setItem('ms-friends', JSON.stringify(d)); }

function updateFriendData(opponentName) {
  const fd = loadFriendData();
  fd[opponentName] = (fd[opponentName] || 0) + 1;
  saveFriendData(fd);
}

function getFriendLevel(opponentName) {
  const fd = loadFriendData();
  const matches = fd[opponentName] || 0;
  if (matches > 10) return { label: '🥇 Best Friend', cls: 'fl-bestfriend', matches };
  if (matches >= 6) return { label: '😎 Close', cls: 'fl-close', matches };
  if (matches >= 3) return { label: '🙂 Normal', cls: 'fl-normal', matches };
  return { label: '😐 Stranger', cls: 'fl-stranger', matches };
}

// ═══════════════════════════════════════════════════
// ═══ 3. SOUND PACK SYSTEM ═══
// ═══════════════════════════════════════════════════
const SOUND_PACKS = [
  { id: 'default', name: '🎵 Default Sounds', desc: 'Basic game sounds', price: 0, sounds: ['Beep','Ding','Buzz'], owned: true },
  { id: 'funny', name: '😂 Funny Sounds', desc: 'Hilarious sound effects for every moment', price: 30, sounds: ['Boing','Slide Whistle','Honk'] },
  { id: 'victory', name: '🎉 Victory Music', desc: 'Epic victory fanfares and celebrations', price: 50, sounds: ['Fanfare','Confetti','Triumph'] },
  { id: 'troll', name: '😈 Troll Sounds', desc: 'Maximum trolling potential', price: 40, sounds: ['Sad Trombone','Bruh','Oof'] }
];
function loadSoundPacks() { return JSON.parse(localStorage.getItem('ms-sound-packs') || '{"owned":["default"],"active":"default"}'); }
function saveSoundPacks(d) { localStorage.setItem('ms-sound-packs', JSON.stringify(d)); }

// Track active preview so we can stop it
let _previewCtx = null;

function previewSoundPack(packId) {
  // Stop any previous preview
  if (_previewCtx) {
    try { _previewCtx.close(); } catch(e) {}
    _previewCtx = null;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return showToast('Audio not supported');
  const ctx = new AC();
  _previewCtx = ctx;

  function tone(f, d, t='sine', v=0.15, delay=0) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = t; o.frequency.value = f;
    g.gain.setValueAtTime(v, ctx.currentTime + delay);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + d);
    o.connect(g); g.connect(ctx.destination);
    o.start(ctx.currentTime + delay);
    o.stop(ctx.currentTime + delay + d);
  }

  if (packId === 'default') {
    // Simple beep-ding-buzz sequence
    tone(440, 0.15, 'sine', 0.12, 0);
    tone(880, 0.15, 'sine', 0.12, 0.2);
    tone(660, 0.2, 'sine', 0.12, 0.4);
  } else if (packId === 'funny') {
    // Boing + slide whistle effect
    tone(200, 0.1, 'sine', 0.15, 0);
    tone(600, 0.1, 'sine', 0.15, 0.05);
    tone(900, 0.15, 'sine', 0.12, 0.1);
    tone(1200, 0.1, 'sine', 0.1, 0.15);
    // Slide whistle down
    tone(1400, 0.1, 'sine', 0.1, 0.3);
    tone(1000, 0.1, 'sine', 0.1, 0.4);
    tone(600, 0.15, 'sine', 0.1, 0.5);
    tone(300, 0.2, 'sawtooth', 0.08, 0.65);
  } else if (packId === 'victory') {
    // Epic fanfare melody
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => {
      tone(f, 0.25, 'sine', 0.12, i * 0.13);
    });
    // Add harmony
    [262, 330, 392, 523].forEach((f, i) => {
      tone(f, 0.3, 'triangle', 0.06, i * 0.13);
    });
  } else if (packId === 'troll') {
    // Sad trombone + bruh effect
    [400, 380, 350, 300, 250, 200, 150].forEach((f, i) => {
      tone(f, 0.18, 'sawtooth', 0.1, i * 0.12);
    });
    // "Oof" bass hit
    tone(80, 0.4, 'square', 0.1, 0.9);
    tone(60, 0.3, 'sawtooth', 0.08, 1.0);
  }

  // Auto-close audio context after preview finishes
  setTimeout(() => {
    if (_previewCtx === ctx) {
      try { ctx.close(); } catch(e) {}
      _previewCtx = null;
    }
  }, 2000);

  showToast('🎵 Preview: ' + SOUND_PACKS.find(p => p.id === packId)?.name || packId, 1500);
}

function renderSoundShop() {
  const spData = loadSoundPacks();
  const bal = $('#sound-coin-balance'); if (bal) bal.textContent = state.coins;
  const list = $('#sound-packs-list'); if (!list) return;
  list.innerHTML = SOUND_PACKS.map(p => {
    const owned = spData.owned.includes(p.id);
    const active = spData.active === p.id;

    // Action buttons: Preview always available + Buy/Select/Selected
    let actionHtml = '';
    const previewBtn = `<button class="sp-action-btn sp-preview-btn" data-sp="${p.id}" title="Preview sounds">▶️ Preview</button>`;

    if (active) {
      actionHtml = `<div class="sp-action-row">${previewBtn}<button class="sp-action-btn sp-selected-btn">✅ Selected</button></div>`;
    } else if (owned) {
      actionHtml = `<div class="sp-action-row">${previewBtn}<button class="sp-action-btn sp-select-btn" data-sp="${p.id}">Select</button></div>`;
    } else {
      actionHtml = `<div class="sp-action-row">${previewBtn}<button class="sp-action-btn sp-buy-btn" data-sp="${p.id}" data-cost="${p.price}" ${state.coins < p.price ? 'disabled' : ''}>🔓 Unlock (${p.price} 💰)</button></div>`;
    }

    return `<div class="sound-pack-card${active?' sp-active':''}">
      <div class="sp-header"><div class="sp-name">${p.name}</div><div class="sp-price${owned?' sp-owned':''}">${owned?'✅ Owned':p.price+' 💰'}</div></div>
      <div class="sp-desc">${p.desc}</div>
      <div class="sp-sounds-preview">${p.sounds.map(s=>`<span class="sp-sound-chip">${s}</span>`).join('')}</div>
      ${actionHtml}
    </div>`;
  }).join('');

  // Wire preview buttons
  list.querySelectorAll('.sp-preview-btn').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    previewSoundPack(b.dataset.sp);
  });
  // Wire buy buttons
  list.querySelectorAll('.sp-buy-btn').forEach(b => b.onclick = () => {
    const cost = parseInt(b.dataset.cost);
    if (!spendCoins(cost)) return showToast('Not enough coins!');
    const d = loadSoundPacks(); d.owned.push(b.dataset.sp); d.active = b.dataset.sp; saveSoundPacks(d);
    showToast('🎧 Sound pack unlocked!'); spawnCoinRain(); renderSoundShop();
  });
  // Wire select buttons
  list.querySelectorAll('.sp-select-btn').forEach(b => b.onclick = () => {
    const d = loadSoundPacks(); d.active = b.dataset.sp; saveSoundPacks(d);
    showToast('🎧 Sound pack selected!'); renderSoundShop();
  });
}

function playSoundPack(type) {
  if (localStorage.getItem('ms-sound-off') === '1') return;
  const spData = loadSoundPacks();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  function tone(f,d,t='sine',v=.12){const o=ctx.createOscillator(),g=ctx.createGain();o.type=t;o.frequency.value=f;g.gain.setValueAtTime(v,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+d);o.connect(g);g.connect(ctx.destination);o.start();o.stop(ctx.currentTime+d)}
  if (spData.active === 'funny') {
    if (type==='correct'){tone(600,.1,'sine',.15);setTimeout(()=>tone(900,.15,'sine',.12),100);setTimeout(()=>tone(1200,.1,'sine',.1),200)}
    else if(type==='wrong'){tone(200,.3,'sawtooth',.1);setTimeout(()=>tone(150,.4,'sawtooth',.08),200)}
    else if(type==='win'){[800,1000,1200,1400,1600].forEach((f,i)=>setTimeout(()=>tone(f,.2,'sine',.1),i*100))}
  } else if (spData.active === 'victory') {
    if(type==='correct'){[523,659,784].forEach((f,i)=>setTimeout(()=>tone(f,.2),i*120))}
    else if(type==='wrong'){tone(300,.3,'square',.08)}
    else if(type==='win'){[523,659,784,1047,1319,1568].forEach((f,i)=>setTimeout(()=>tone(f,.25),i*130))}
  } else if (spData.active === 'troll') {
    if(type==='correct'){tone(880,.1);setTimeout(()=>tone(1100,.12),80)}
    else if(type==='wrong'){[400,350,300,250,200].forEach((f,i)=>setTimeout(()=>tone(f,.15,'sawtooth',.1),i*120))}
    else if(type==='win'){tone(523,.15);setTimeout(()=>tone(659,.15),150);setTimeout(()=>tone(784,.2),300);setTimeout(()=>tone(1047,.3),500)}
  } else { sfx(type === 'win' ? 'winner' : type); }
}

// ═══════════════════════════════════════════════════
// ═══ 4. WORLD LEADERBOARD ═══
// ═══════════════════════════════════════════════════
function renderWorldLB() {
  socket.emit('get-world-leaderboard');
}

socket.on('world-leaderboard', (data) => {
  const list = $('#world-lb-list');
  if (!list) return;
  if (!data || !data.length) { list.innerHTML = '<p class="empty-state">No players yet. Play to join!</p>'; return; }
  list.innerHTML = data.sort((a,b) => b.score - a.score).slice(0,50).map((p,i) => {
    const isMe = p.name === state.playerName;
    const top3 = i < 3;
    const rank = getRankInfo(p.score, p.wins || 0);
    return `<div class="glb-row${isMe?' glb-me':''}${top3?' glb-top3':''}" style="cursor:pointer" data-wname="${escHtml(p.name)}" data-wavatar="${p.avatar||'😀'}">
      <span class="glb-rank" style="color:${i===0?'#ffd700':i===1?'#c0c0c0':i===2?'#cd7f32':'var(--text3)'}">#${i+1}</span>
      <span class="glb-avatar">${p.avatar||'😀'}</span>
      <div class="glb-info"><div class="glb-name">${escHtml(p.name)}${isMe?' (You)':''}</div>
      <div class="glb-rank-label" style="color:${rank.cls==='rank-legend'?'#ff6b6b':rank.cls==='rank-gold'?'#ffd700':rank.cls==='rank-silver'?'#c0c0c0':'#cd7f32'}">${rank.label}</div></div>
      <span class="glb-coins">${p.score} 💰</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.glb-row').forEach(row => row.onclick = () => {
    openPublicProfile(row.dataset.wname, row.dataset.wavatar);
  });
});

// ═══════════════════════════════════════════════════
// ═══ 5. PUBLIC PROFILE VIEW ═══
// ═══════════════════════════════════════════════════
function openPublicProfile(name, avatar) {
  socket.emit('get-player-profile', { name });
  // Set what we know immediately
  $('#pub-avatar').textContent = avatar || '😀';
  $('#pub-name').textContent = name;
  const fl = getFriendLevel(name);
  const flEl = $('#pub-friend-level');
  flEl.textContent = fl.label;
  flEl.className = 'pub-friend-level ' + fl.cls;
  // Default values until server responds
  $('#pub-coins').textContent = '—';
  $('#pub-matches').textContent = '—';
  $('#pub-wins').textContent = '—';
  $('#pub-winrate').textContent = '—';
  openPopup('public-profile');
}

socket.on('player-profile', (data) => {
  if (!data) return;
  $('#pub-coins').textContent = data.coins || 0;
  $('#pub-matches').textContent = data.matches || 0;
  $('#pub-wins').textContent = data.wins || 0;
  const wr = data.matches > 0 ? Math.round((data.wins||0)/data.matches*100) : 0;
  $('#pub-winrate').textContent = wr + '%';
});

// ═══════════════════════════════════════════════════
// ═══ 6. PROFILE UPDATE ON GAME OVER (Friend tracking) ═══
// ═══════════════════════════════════════════════════
// Emit profile data to server for world LB
function syncProfileToServer() {
  const prof = loadProfile();
  socket.emit('sync-profile', {
    name: state.playerName, avatar: state.avatar, coins: state.coins,
    matches: prof.matches || 0, wins: prof.wins || 0
  });
}

// ─── Boot ───
document.addEventListener('DOMContentLoaded', () => { initUI(); refreshPackSelector(); document.addEventListener('click', () => initSounds(), { once: true }); });

