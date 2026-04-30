/* ═══ MIND SYNC GAME — Client ═══ */
const socket = io();
const AVATARS = ['😀','😎','🤩','🥳','😈','👻','🤖','👽','🦊','🐱','🐶','🦁','🐸','🐧','🦄','🌟','🔥','💎','🎯','🎮'];
const SOUNDS = {};

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
function canOpenSecret() {
  const last = localStorage.getItem('ms-secret-date');
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
function sfx(n){if(SOUNDS[n])try{SOUNDS[n]()}catch(e){}}

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
  $('#btn-name-change').onclick = () => { $('#input-new-name').value = state.playerName; openPanel('name'); };
  $('#btn-avatar-change').onclick = () => openPanel('avatar');
  $('#btn-create-room').onclick = createRoom;
  $('#btn-refresh-rooms').onclick = fetchRooms;
  $('#btn-install-topbar').onclick = installApp;
  $('#btn-save-name').onclick = saveName;
  $('#btn-coin-shop').onclick = () => { updateCoinUI(); openPanel('coinshop'); };
  $('#btn-profile').onclick = () => { renderProfile(); openPanel('profile'); };
  $('#btn-global-leaderboard').onclick = () => { renderGlobalLB(); openPanel('global-lb'); };

  // Secret coin tap
  const coinTap = $('#secret-coin-tap');
  if (coinTap) {
    coinTap.addEventListener('click', (e) => {
      e.stopPropagation();
      coinTap.classList.remove('tap-flash'); void coinTap.offsetWidth; coinTap.classList.add('tap-flash');
      secretTapCount++;
      clearTimeout(secretTapTimer);
      secretTapTimer = setTimeout(() => { secretTapCount = 0; }, 600);
      if (secretTapCount >= 3) {
        secretTapCount = 0;
        if (canOpenSecret()) {
          localStorage.setItem('ms-secret-date', new Date().toDateString());
          addCoins(10);
          showToast('🎉 Secret Vault opened! +10 bonus coins!', 3000);
          spawnCoinRain();
          renderSecretTasks();
          openPanel('secret');
        } else {
          showToast('🔒 Secret Vault already opened today!', 2000);
        }
      }
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
  $('#topbar-avatar').textContent = state.avatar;
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
  if (!state.history.length) { l.innerHTML = '<p class="empty-state">No games played yet</p>'; return; }
  l.innerHTML = state.history.slice(0, 20).map(h => `<div class="history-item"><div class="h-date">${h.date}</div><div class="h-result">${h.result}</div><div class="h-score">Score: ${h.score} | Players: ${h.players}</div></div>`).join('');
}

// ─── Room Actions ───
function createRoom() {
  const roomName = $('#input-room-name').value.trim() || 'Room';
  const password = $('#input-room-password').value.trim();
  const maxPlayers = parseInt($('#player-count-toggle .toggle-btn.active')?.dataset.value || '2');
  const totalRounds = parseInt($('#round-count-toggle .toggle-btn.active')?.dataset.value || '4');
  socket.emit('create-room', { playerName: state.playerName, avatar: state.avatar, maxPlayers, totalRounds, roomName, password });
  sfx('click');
}

async function fetchRooms() {
  const list = $('#rooms-list');
  list.innerHTML = '<div class="rooms-loading"><div class="spinner"></div><p>Loading rooms…</p></div>';
  try {
    const res = await fetch('/api/rooms');
    const rooms = await res.json();
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

  if (data.phase === 'question') {
    if (isMyTurn) {
      gc.innerHTML = `<p class="game-phase-label">Your Turn</p><p class="game-turn-info">Write a question and its answer</p>
        <div class="game-input-area">
          <input type="text" id="input-question" class="input-field" placeholder="Type your question…" maxlength="120" autocomplete="off">
          <input type="text" id="input-answer" class="input-field" placeholder="The answer…" maxlength="60" autocomplete="off">
          <button class="btn-primary btn-neon" id="btn-submit-qa">Submit</button>
        </div>`;
      $('#btn-submit-qa').onclick = () => {
        const q = $('#input-question').value.trim(), a = $('#input-answer').value.trim();
        if (!q || !a) return showToast('Fill both fields');
        socket.emit('submit-qa', { roomCode: state.roomCode, question: q, answer: a }); sfx('click');
      };
    } else {
      gc.innerHTML = `<div class="waiting-turn-msg"><span class="wtm-emoji">🤔</span><p><strong>${escHtml(tp)}</strong> is writing a question…</p></div>`;
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
      // NEW: Letter Hint — reveal first 2 letters
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
    $('#game-round-badge').textContent = `Round ${data.currentRound}/${data.totalRounds}`;
    renderGameContent(data);
    updateLB(data.players); updatePL(data.players);
  }
});

socket.on('guess-results', ({ results, correctAnswer, question, scores, anyCorrect }) => {
  clearInterval(state.timerInterval);

  // ─── Helper functions ───
  function matchBadge(r) {
    if (r.matchType === 'exact') return '<span class="match-badge match-exact">Perfect Match 🔥 +2</span>';
    if (r.matchType === 'partial') return '<span class="match-badge match-partial">Close Match 👍 +1</span>';
    return '<span class="match-badge match-none">No Match ❌ 0</span>';
  }
  function matchScoreLabel(r) {
    if (r.matchScore === 2) return '<span class="rr-points rr-points-full">+2</span>';
    if (r.matchScore === 1) return '<span class="rr-points rr-points-half">+1</span>';
    return '<span class="rr-points rr-points-zero">+0</span>';
  }

  const my = results[state.myId];
  const myGuess = my ? (my.guess || '—') : '—';
  const myMatchType = my ? my.matchType : 'none';

  // Determine result text
  let resultLabel = 'No Match ❌ 0', resultClass = 'result-none', resultSub = 'Better luck next time!';
  if (myMatchType === 'exact') { resultLabel = 'Perfect Match 🔥 +2'; resultClass = 'result-exact'; resultSub = 'You nailed it! +2 points'; }
  else if (myMatchType === 'partial') { resultLabel = 'Close Match 👍 +1'; resultClass = 'result-partial'; resultSub = 'Almost there! +1 point'; }

  // ═══════════════════════════════════════════════════════════
  // PHASE 1 (0ms): Show question + HIDDEN answer card
  // ═══════════════════════════════════════════════════════════
  let h = '';

  // Question display
  h += `<div class="game-question-display"><div class="q-label">Question</div><div class="q-text">${escHtml(question)}</div></div>`;

  // Answer card — starts HIDDEN (not flipped), will flip in Phase 2
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

  // ═══ COMPARISON CARDS — hidden initially, shown after answer flip ═══
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

    // Result score text — hidden initially
    h += `<div class="compare-result-text" id="compare-result-text">
      <div class="compare-result-label ${resultClass}">${resultLabel}</div>
      <div class="compare-result-sub">${resultSub}</div>
    </div>`;
  }

  // Results card — all players' guesses with scores/badges hidden
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
  // PHASE 2.5 (1800ms): Show comparison cards (neutral colors)
  // ═══════════════════════════════════════════════════════════
  setTimeout(() => {
    const row = document.getElementById('compare-row');
    if (row) row.style.display = 'flex';
  }, 1800);

  // ═══════════════════════════════════════════════════════════
  // PHASE 3 (3500ms): Apply color feedback + reveal scores
  // ═══════════════════════════════════════════════════════════
  setTimeout(() => {
    // Apply color feedback to "Your Answer" card
    const myCard = document.getElementById('my-answer-card');
    if (myCard) {
      myCard.classList.add(`match-result-${myMatchType}`);
    }

    // Reveal the result text with bounce animation
    const resultText = document.getElementById('compare-result-text');
    if (resultText) resultText.classList.add('revealed');

    // Reveal all hidden score/badge elements in result rows
    document.querySelectorAll('.phase-hidden').forEach(el => {
      el.classList.remove('phase-hidden');
      el.classList.add('phase-reveal');
    });

    // Sound effects based on match result
    if (my?.matchType === 'exact') sfx('correct');
    else if (my?.matchType === 'partial') sfx('click');
    else if (my) sfx('wrong');

    // ─── COIN EARNING: 1 point = 1 coin + BONUS for perfect ───
    if (my && my.matchScore > 0) {
      let earned = state.doubleNext ? my.matchScore * 2 : my.matchScore;
      // BONUS: +1 extra coin for perfect match
      if (my.matchType === 'exact') earned += 1;
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
  // NOTE: Colors are applied via classList.add and will PERSIST
  // until the server sends the next room-state (at ~10s), which
  // replaces game-content innerHTML. No early clearing occurs.

  // ═══════════════════════════════════════════════════════════
  // PHASE 4 (6500ms): Show leaderboard briefly if someone scored
  // ═══════════════════════════════════════════════════════════
  if (anyCorrect) {
    setTimeout(() => openPopup('leaderboard'), 6500);
    setTimeout(() => closePopup('leaderboard'), 8500);
  }

  // Server auto-advances to next question at 10000ms
});

socket.on('game-over', ({ winner, scores }) => {
  clearInterval(state.timerInterval); sfx('winner');
  $('#gameover-title').textContent = winner.id === state.myId ? '🎉 You Won!' : 'Game Over!';
  $('#gameover-winner').innerHTML = `${winner.avatar} <strong>${escHtml(winner.name)}</strong> wins with ${winner.score} pts!`;
  $('#gameover-scores').innerHTML = scores.map((s,i) => `<div class="lb-row${s.id===winner.id?' highlight':''}"><span class="lb-rank ${['gold','silver','bronze'][i]||''}">#${i+1}</span><span class="lb-avatar">${s.avatar}</span><div class="lb-info"><div class="lb-name">${escHtml(s.name)}</div></div><span class="lb-score">${s.score}</span></div>`).join('');
  openPopup('gameover');
  const hi = { date: new Date().toLocaleString(), result: winner.id === state.myId ? '🏆 Won!' : `${winner.name} won`, score: scores.find(s => s.id === state.myId)?.score || 0, players: scores.length };
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
});

// ── Force exit game (server removed this player) ──
socket.on('force-exit-game', ({ reason }) => {
  clearInterval(state.timerInterval);
  closeAllPopups();
  showToast(reason || 'Game ended', 4000);
  cleanupAndGoHome();
});

// ── Game ended (not enough players etc) ──
socket.on('game-ended', ({ reason }) => {
  clearInterval(state.timerInterval);
  closeAllPopups();
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
socket.on('play-again-start', () => { closeAllPopups(); showToast('New game starting!'); });
socket.on('play-again-rejected', ({ byName }) => showToast(`${byName} declined`));
socket.on('play-again-error', msg => showToast('❌ ' + msg));

function requestPlayAgain() {
  // Check if there are other players
  if (state.lastRoomState) {
    const others = state.lastRoomState.players.filter(p => p.id !== state.myId);
    if (others.length < 1) {
      showToast('No players available to play');
      return;
    }
  }
  socket.emit('play-again-request', { roomCode: state.roomCode });
  socket.emit('play-again-accept', { roomCode: state.roomCode });
  showToast('Waiting for others…');
  sfx('click');
}
function acceptPlayAgain() { clearInterval(state._pat); closePopup('play-again'); socket.emit('play-again-accept', { roomCode: state.roomCode }); showToast('Accepted!'); }
function rejectPlayAgain() { clearInterval(state._pat); closePopup('play-again'); socket.emit('play-again-reject', { roomCode: state.roomCode }); }

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
  $('#players-popup-list').innerHTML = (Array.isArray(players)?players:[]).map(p => `<div class="lb-row"><span class="lb-avatar">${p.avatar}</span><div class="lb-info"><div class="lb-name">${escHtml(p.name)}</div></div><span class="lb-score">${p.score}</span></div>`).join('');
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
  $('#profile-rank-badge').textContent = rank.label;
  $('#profile-rank-badge').className = 'profile-rank-badge';
  $('#profile-coins').textContent = state.coins;
  $('#profile-matches').textContent = prof.matches || 0;
  $('#profile-wins').textContent = prof.wins || 0;
  const wr = prof.matches > 0 ? Math.round((prof.wins||0)/(prof.matches)*100) : 0;
  $('#profile-winrate').textContent = wr + '%';
  // Best Friend detection
  const bfEl = $('#profile-best-friend');
  if (prof.opponents && Object.keys(prof.opponents).length > 0) {
    const sorted = Object.entries(prof.opponents).sort((a,b) => b[1]-a[1]);
    $('#bf-name').textContent = sorted[0][0];
    bfEl.style.display = 'flex';
  } else {
    bfEl.style.display = 'none';
  }
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

// ─── Boot ───
document.addEventListener('DOMContentLoaded', () => { initUI(); document.addEventListener('click', () => initSounds(), { once: true }); });
