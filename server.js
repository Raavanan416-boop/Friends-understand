const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── REST API ────────────────────────────────────────────────
app.get('/api/rooms', (req, res) => {
  const list = Object.entries(rooms)
    .filter(([, r]) => r.phase === 'waiting')
    .map(([code, r]) => ({
      roomCode: code,
      roomName: r.roomName || code,
      players: getActivePlayers(r).length,
      maxPlayers: r.maxPlayers,
      totalRounds: r.totalRounds,
      hasPassword: !!r.password
    }));
  res.json(list);
});

// ─── State ───────────────────────────────────────────────────
const rooms = {};          // roomCode -> room object
const playerSockets = {};  // socketId -> { roomCode, playerName, avatar }
const leftPlayers = {};    // socketId -> true — tracks players who explicitly left

// ─── Helpers ─────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? generateRoomCode() : code;
}

// Get only active and connected players (the ONLY source of truth for game logic)
function getActivePlayers(room) {
  return room.players.filter(p => p.connected && p.isActive !== false);
}

// Legacy helper — keep backward compat but use isActive check
function getConnectedPlayers(room) {
  return getActivePlayers(room);
}

function broadcastRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const activePlayers = getActivePlayers(room);
  const players = activePlayers.map(p => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    isHost: p.isHost,
    connected: p.connected
  }));
  io.to(roomCode).emit('room-state', {
    roomCode,
    roomName: room.roomName || roomCode,
    players,
    phase: room.phase,
    currentRound: room.currentRound,
    totalRounds: room.totalRounds,
    maxPlayers: room.maxPlayers,
    currentTurnPlayerIndex: room.currentTurnPlayerIndex,
    question: room.currentQuestion,
    // Mask the answer during guess phase to prevent cheating via devtools
    answer: room.phase === 'guess' ? '••••••' : room.currentAnswer,
    answerLength: room.currentAnswer ? room.currentAnswer.length : 0,
    turnPlayerName: activePlayers[room.currentTurnPlayerIndex]?.name || '',
    timerEnd: room.timerEnd
  });
}

// ─── Socket.IO ───────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──
  socket.on('create-room', ({ playerName, avatar, maxPlayers, totalRounds, roomName, password }) => {
    // Prevent ghost re-entry: clear any leftPlayers flag
    delete leftPlayers[socket.id];

    const roomCode = generateRoomCode();
    const player = {
      id: socket.id,
      name: playerName,
      avatar: avatar || '😀',
      score: 0,
      isHost: true,
      connected: true,
      isActive: true
    };
    rooms[roomCode] = {
      players: [player],
      phase: 'waiting',
      maxPlayers: maxPlayers || 2,
      totalRounds: totalRounds || 3,
      roomName: roomName || 'Room ' + roomCode,
      password: password || '',
      currentRound: 0,
      currentTurnPlayerIndex: 0,
      currentQuestion: '',
      currentAnswer: '',
      guesses: {},
      timerEnd: null,
      timerRef: null,
      turnOrder: [],
      turnsThisRound: 0
    };
    playerSockets[socket.id] = { roomCode, playerName, avatar };
    socket.join(roomCode);
    socket.emit('room-created', { roomCode });
    broadcastRoomState(roomCode);
    io.emit('rooms-updated');
    console.log(`[Room] ${roomCode} created by ${playerName}`);
  });

  // ── Join Room ──
  socket.on('join-room', ({ roomCode, playerName, avatar, password }) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms[roomCode];
    if (!room) return socket.emit('join-error', 'Room not found');
    if (room.phase !== 'waiting') return socket.emit('join-error', 'Game already in progress');
    const active = getActivePlayers(room);
    if (active.length >= room.maxPlayers) return socket.emit('join-error', 'Room is full');
    if (room.password && room.password !== (password || '')) return socket.emit('join-error', 'Wrong password');
    if (active.some(p => p.name === playerName)) return socket.emit('join-error', 'Name already taken in this room');

    // Prevent players who left from auto-rejoining
    delete leftPlayers[socket.id];

    const player = {
      id: socket.id,
      name: playerName,
      avatar: avatar || '😀',
      score: 0,
      isHost: false,
      connected: true,
      isActive: true
    };
    room.players.push(player);
    playerSockets[socket.id] = { roomCode, playerName, avatar };
    socket.join(roomCode);
    socket.emit('room-joined', { roomCode });
    broadcastRoomState(roomCode);
    io.emit('rooms-updated');
    console.log(`[Room] ${playerName} joined ${roomCode}`);
  });

  // ── Start Game ──
  socket.on('start-game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;
    const active = getActivePlayers(room);
    if (active.length < 2) return socket.emit('game-error', 'Need at least 2 players');

    // Remove inactive/disconnected players before starting
    room.players = active;
    room.turnOrder = room.players.map((_, i) => i).sort(() => Math.random() - 0.5);
    room.currentRound = 1;
    room.turnsThisRound = 0;
    room.currentTurnPlayerIndex = room.turnOrder[0];
    room.players.forEach(p => p.score = 0);

    startQuestionPhase(roomCode);
    io.emit('rooms-updated');
    console.log(`[Game] Started in ${roomCode}`);
  });

  // ── Submit Question + Answer ──
  socket.on('submit-qa', ({ roomCode, question, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'question') return;
    const activePlayers = getActivePlayers(room);
    if (activePlayers[room.currentTurnPlayerIndex]?.id !== socket.id) return;

    clearTimeout(room.timerRef);
    room.currentQuestion = question.trim();
    room.currentAnswer = answer.trim().toLowerCase();

    startGuessPhase(roomCode);
  });

  // ── Submit Guess ──
  socket.on('submit-guess', ({ roomCode, guess }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'guess') return;

    // Safety: check this player is active
    const activePlayers = getActivePlayers(room);
    const playerObj = activePlayers.find(p => p.id === socket.id);
    if (!playerObj || !playerObj.isActive) return;

    const turnPlayerId = activePlayers[room.currentTurnPlayerIndex]?.id;
    if (socket.id === turnPlayerId) return;

    room.guesses[socket.id] = guess.trim().toLowerCase();

    // Check if all active non-turn players have guessed
    const nonTurnPlayers = activePlayers.filter(p => p.id !== turnPlayerId);
    const allGuessed = nonTurnPlayers.every(p => room.guesses[p.id] !== undefined);
    if (allGuessed) {
      clearTimeout(room.timerRef);
      resolveGuesses(roomCode);
    }
  });

  // ── Use Advantage: Reveal Answer ──
  socket.on('use-reveal', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'guess') return;
    const activePlayers = getActivePlayers(room);
    const turnPlayerId = activePlayers[room.currentTurnPlayerIndex]?.id;
    // Only non-turn players can reveal
    if (socket.id === turnPlayerId) return;
    // Track who used reveal to prevent double use
    if (!room.revealUsed) room.revealUsed = {};
    if (room.revealUsed[socket.id]) return;
    room.revealUsed[socket.id] = true;
    // Send the real answer ONLY to this player
    socket.emit('reveal-answer', { answer: room.currentAnswer });
  });

  // ── Use Advantage: Letter Hint (show first 2 letters) ──
  socket.on('use-letter-hint', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'guess') return;
    const activePlayers = getActivePlayers(room);
    const turnPlayerId = activePlayers[room.currentTurnPlayerIndex]?.id;
    if (socket.id === turnPlayerId) return;
    if (!room.letterHintUsed) room.letterHintUsed = {};
    if (room.letterHintUsed[socket.id]) return;
    room.letterHintUsed[socket.id] = true;
    // Build hint: first 2 letters + asterisks
    const answer = room.currentAnswer || '';
    const first2 = answer.substring(0, 2);
    const masked = first2 + '*'.repeat(Math.max(0, answer.length - 2));
    socket.emit('letter-hint', { hint: masked });
  });

  // ── Emoji Reaction (with name) ──
  socket.on('emoji-reaction', ({ roomCode, emoji }) => {
    const info = playerSockets[socket.id];
    if (!info) return;
    io.to(roomCode).emit('emoji-reaction', {
      playerName: info.playerName,
      emoji
    });
  });

  // ── Name Change ──
  socket.on('change-name', ({ newName }) => {
    const info = playerSockets[socket.id];
    if (!info) return;
    const oldName = info.playerName;
    info.playerName = newName;
    // Update in room if in one
    if (info.roomCode) {
      const room = rooms[info.roomCode];
      if (room) {
        const p = room.players.find(p => p.id === socket.id);
        if (p) p.name = newName;
        io.to(info.roomCode).emit('name-changed', { oldName, newName });
        broadcastRoomState(info.roomCode);
      }
    }
  });

  // ── Play Again Request ──
  socket.on('play-again-request', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('play-again-error', 'Room no longer exists');
    const active = getActivePlayers(room);
    if (active.length < 2) {
      socket.emit('play-again-error', 'No player available');
      return;
    }
    // Check if requesting player is still in room
    const isInRoom = active.some(p => p.id === socket.id);
    if (!isInRoom) {
      socket.emit('play-again-error', 'You are no longer in this room');
      return;
    }
    const info = playerSockets[socket.id];
    if (!info) return;

    // Set up play-again timeout (4 seconds server-side)
    if (room.playAgainTimer) clearTimeout(room.playAgainTimer);
    room.playAgainTimer = setTimeout(() => {
      // Timeout: cancel play-again for all
      room.playAgainAccepted = null;
      room.playAgainTimer = null;
      io.to(roomCode).emit('play-again-error', 'Play again timed out. No response.');
    }, 4500);

    socket.to(roomCode).emit('play-again-request', { fromName: info.playerName, fromId: socket.id });
  });

  socket.on('play-again-accept', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (!room.playAgainAccepted) room.playAgainAccepted = new Set();
    room.playAgainAccepted.add(socket.id);

    const active = getActivePlayers(room);
    if (active.length < 2) {
      room.playAgainAccepted = null;
      if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
      io.to(roomCode).emit('play-again-error', 'No player available');
      return;
    }
    const allAccepted = active.every(p => room.playAgainAccepted.has(p.id));
    if (allAccepted) {
      // Clear timeout
      if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
      room.playAgainAccepted = null;
      room.players = active; // Clean inactive
      room.turnOrder = room.players.map((_, i) => i).sort(() => Math.random() - 0.5);
      room.currentRound = 1;
      room.turnsThisRound = 0;
      room.currentTurnPlayerIndex = room.turnOrder[0];
      room.players.forEach(p => p.score = 0);
      io.to(roomCode).emit('play-again-start');
      startQuestionPhase(roomCode);
    }
  });

  socket.on('play-again-reject', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    // Clear timeout
    if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
    room.playAgainAccepted = null;
    const info = playerSockets[socket.id];
    io.to(roomCode).emit('play-again-rejected', { byName: info?.playerName });
  });

  // ── Leave Room (explicit) ──
  socket.on('leave-room', ({ roomCode }) => {
    handleLeave(socket, roomCode, false);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const info = playerSockets[socket.id];
    if (info) {
      handleLeave(socket, info.roomCode, true);
    }
  });
});

// ─── Game Phase Functions ────────────────────────────────────

// Timer duration constants (milliseconds)
const QUESTION_TIMER_MS = 60000;  // 60 seconds for question + answer typing
const GUESS_TIMER_MS    = 25000;  // 25 seconds for guessing

function startTimerSync(roomCode, phase) {
  const room = rooms[roomCode];
  if (!room) return;
  // Clear any previous sync interval
  if (room.timerSyncRef) clearInterval(room.timerSyncRef);
  // Emit timer-sync every 1 second so all clients stay in lockstep
  room.timerSyncRef = setInterval(() => {
    if (!rooms[roomCode] || room.phase !== phase) {
      clearInterval(room.timerSyncRef);
      room.timerSyncRef = null;
      return;
    }
    io.to(roomCode).emit('timer-sync', {
      timerEnd: room.timerEnd,
      phase: room.phase,
      serverTime: Date.now()
    });
  }, 1000);
}

function startQuestionPhase(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // ═══ SAFETY CHECK: validate active player count before every turn ═══
  const active = getActivePlayers(room);
  if (active.length < 2) {
    forceEndGame(roomCode, 'Not enough players to continue');
    return;
  }

  // Rebuild players list to only active players
  room.players = active;

  // Make sure current turn player is valid and active
  if (room.currentTurnPlayerIndex >= room.players.length) {
    room.currentTurnPlayerIndex = 0;
  }
  const turnPlayer = room.players[room.currentTurnPlayerIndex];
  if (!turnPlayer || !turnPlayer.connected || turnPlayer.isActive === false) {
    advanceTurn(roomCode);
    return;
  }

  room.phase = 'question';
  room.currentQuestion = '';
  room.currentAnswer = '';
  room.guesses = {};
  room.timerEnd = Date.now() + QUESTION_TIMER_MS;

  broadcastRoomState(roomCode);
  startTimerSync(roomCode, 'question');

  room.timerRef = setTimeout(() => {
    if (room.phase === 'question') {
      room.currentQuestion = '(No question submitted)';
      room.currentAnswer = '';
      advanceTurn(roomCode);
    }
  }, QUESTION_TIMER_MS + 1000);
}

function startGuessPhase(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // ═══ SAFETY CHECK ═══
  const active = getActivePlayers(room);
  if (active.length < 2) {
    forceEndGame(roomCode, 'Not enough players to continue');
    return;
  }

  room.phase = 'guess';
  room.guesses = {};
  room.revealUsed = {};
  room.letterHintUsed = {};
  room.timerEnd = Date.now() + GUESS_TIMER_MS;

  broadcastRoomState(roomCode);
  startTimerSync(roomCode, 'guess');

  room.timerRef = setTimeout(() => {
    if (room.phase === 'guess') {
      resolveGuesses(roomCode);
    }
  }, GUESS_TIMER_MS + 1000);
}

// ═══════════════════════════════════════════════════════════════
// ─── ADVANCED AI-STYLE MULTI-LANGUAGE MATCHING ENGINE ────────
// ═══════════════════════════════════════════════════════════════

// ── 1. TEXT NORMALIZATION ─────────────────────────────────────
function normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, '')   // remove punctuation
    .replace(/\s+/g, ' ')      // collapse multiple spaces
    .trim();
}

// ── 2. TANGLISH PHONETIC NORMALIZATION ───────────────────────
// Collapses vowel stretching, double consonants, and common
// Tanglish spelling variations so "aaamaa" ≈ "ama" ≈ "aama"
function phoneticsNormalize(word) {
  let w = word.toLowerCase().trim();
  // Collapse repeated vowels: "aaa" → "a", "ooo" → "o", "eee" → "e"
  w = w.replace(/([aeiou])\1+/g, '$1');
  // Collapse repeated consonants: "nnn" → "n", "ppp" → "p"
  w = w.replace(/([^aeiou\s])\1+/g, '$1');
  // Normalize common Tanglish phonetic variants
  w = w.replace(/th/g, 't');    // "thanni" → "tani"
  w = w.replace(/zh/g, 'l');    // "mazhai" → "malai"
  w = w.replace(/sh/g, 's');    // "kushi" → "kusi"
  w = w.replace(/ch/g, 's');    // "padichu" → "padisu"
  w = w.replace(/dh/g, 'd');    // "saadham" → "sadam"
  w = w.replace(/gh/g, 'g');
  w = w.replace(/kh/g, 'k');
  // Collapse again after substitutions
  w = w.replace(/([aeiou])\1+/g, '$1');
  w = w.replace(/([^aeiou\s])\1+/g, '$1');
  return w;
}

// ── 3. LEVENSHTEIN DISTANCE & SIMILARITY RATIO ──────────────
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// Returns 0.0–1.0 similarity ratio
function similarityRatio(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(a, b) / maxLen;
}

// ── 4. ENGLISH WORD NORMALIZATION ────────────────────────────
function stripPlural(w) {
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.endsWith('es'))  return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function stemLight(w) {
  let s = stripPlural(w);
  if (s.endsWith('ing') && s.length > 5) s = s.slice(0, -3);
  if (s.endsWith('ed') && s.length > 4)  s = s.slice(0, -2);
  if (s.endsWith('ly') && s.length > 4)  s = s.slice(0, -2);
  if (s.endsWith('er') && s.length > 4)  s = s.slice(0, -2);
  return s;
}

// ── 5. SEMANTIC MEANING GROUPS ───────────────────────────────
// Each group = array of words that share the SAME meaning
// Includes English + Tanglish variants as base seeds
const meaningGroups = [
  ['yes','ama','aama','om','yeah','yep','yup','ha','correct','right','sure'],
  ['no','illa','illai','nah','nope','venda','vendam'],
  ['ok','seri','sari','okey','okay','fine','alright'],
  ['good','nalla','nalladhu','great','nice','awesome','super'],
  ['bad','ketta','kettadhu','mosam','worst','terrible','horrible'],
  ['come','vaa','vaanga','vaango'],
  ['go','po','ponga','pongo','leave'],
  ['eat','saapdu','saapidu','sapdu','thinna','saapadu'],
  ['sleep','thoongu','thoonga','urangu','rest','nap'],
  ['water','thanni','tanneer','thaneer'],
  ['food','sapadu','saapadu','saappaadu','soru','sooru','meal','dinner','lunch','breakfast'],
  ['friend','nanban','nanba','machaan','machan','machi','thala','bro','buddy','dude','mate'],
  ['love','kaadhal','kadhal','anbu','luv','pyaar'],
  ['happy','santhosam','santosam','kushee','kushi','joy','glad','cheerful'],
  ['sad','varuththam','sogam','unhappy','upset','depressed'],
  ['angry','kovam','koovam','seenam','mad','furious','irritated'],
  ['beautiful','azhagu','azhaga','sundaram','beauty','pretty','gorgeous','handsome'],
  ['money','panam','kaasu','cash','salary','income'],
  ['home','veedu','veetu','illam','house','apartment','flat'],
  ['mother','amma','ammaa','thaayi','mom','mummy','mum','mama'],
  ['father','appa','appaa','thanthai','dad','daddy','papa'],
  ['brother','anna','annaa','thambi','bro','sibling'],
  ['sister','akka','akkaa','thangai','sis','sibling'],
  ['school','palli','college','university'],
  ['study','padippu','padipu','padi','learn','education'],
  ['work','velai','velaai','pannunga','job','career','office'],
  ['big','periya','perisu','large','huge','giant'],
  ['small','chinna','sinna','chinnadhu','tiny','little','mini'],
  ['fast','vegam','vegama','seekiram','quick','rapid','speedy'],
  ['slow','methuvaa','methava','nidhanam','lazy'],
  ['hot','soodu','sudu','warm','heat'],
  ['cold','kulir','thanuppu','thanuppa','cool','chill','freezing'],
  ['rain','mazhai','malai','mazhaikalam'],
  ['sun','suriyan','suryan','veyyil','sunshine','sunny'],
  ['night','iravu','ratri','evening','midnight'],
  ['morning','kaalai','kalai','dawn','sunrise'],
  ['dog','naai','nai','naayi','puppy','doggy'],
  ['cat','poonai','punai','kitten','kitty'],
  ['car','vandi','vehicle','auto','bike'],
  ['movie','padam','cinema','film','picture'],
  ['song','paatu','paattu','isai','music','tune'],
  ['game','aatam','vilaiyaattu','match','play'],
  ['win','jei','vetri','jeyippu','victory','champion'],
  ['lose','tholu','tholvi','failure','defeat','lost'],
  ['thanks','nandri','nanri','thankyou','ty'],
  ['sorry','mannichu','mannikunga','mannichuko','apology'],
  ['what','enna','yenna'],
  ['why','yen'],
  ['who','yaaru','yaru'],
  ['where','enga','engae'],
  ['when','eppoo','eppo'],
  ['how','eppadi','yeppadi'],
  ['this','idhu','idha'],
  ['that','adhu','adha'],
  ['today','innaiku','innikku','indru'],
  ['tomorrow','naalaikku','naalai','nalaikku'],
  ['yesterday','nethu','netrikku','netru'],
  ['true','unmai','nijam','truth'],
  ['false','poi','poy','lie','fake'],
  ['wait','iru','irukku','podhu','hold'],
  ['stop','nillu','nillungo','niruthu','halt'],
  ['run','oodu','sprint','jog'],
  ['walk','nadai','nada','stroll'],
  ['talk','pesu','paesu','pesungo','speak','chat','converse'],
  ['laugh','siri','sirippu','chiragu','lol','haha','giggle'],
  ['cry','azhu','weep','tears','sob'],
  ['fight','sandai','sanda','argue','quarrel'],
  ['dance','aadu','naatyam','groove'],
  ['tea','chai','theneer'],
  ['coffee','kaapi','cappuccino','latte'],
  ['rice','arisi','soru','sooru','saadham','biryani'],
  ['chicken','kozhi','hen','poultry'],
  ['fish','meen','meenu','seafood'],
  ['pizza','pizza'],
  ['burger','burger','hamburger'],
  ['ice cream','icecream','kulfi'],
];

// Build fast reverse lookup: word → group index
const wordToGroup = {};
meaningGroups.forEach((group, gi) => {
  group.forEach(w => { wordToGroup[w.toLowerCase()] = gi; });
});

// ── 6. SMART SEMANTIC LOOKUP ─────────────────────────────────
// Checks if two words share the same meaning group (exact or fuzzy)
function getSemanticGroup(word) {
  // Direct lookup
  if (wordToGroup[word] !== undefined) return wordToGroup[word];
  // Phonetic-normalized lookup
  const pn = phoneticsNormalize(word);
  if (wordToGroup[pn] !== undefined) return wordToGroup[pn];
  // Fuzzy lookup: find closest match in all group words
  let bestGroup = -1, bestSim = 0;
  for (const [w, gi] of Object.entries(wordToGroup)) {
    const sim = similarityRatio(pn, phoneticsNormalize(w));
    if (sim > bestSim && sim >= 0.80) {
      bestSim = sim;
      bestGroup = gi;
    }
  }
  return bestGroup >= 0 ? bestGroup : -1;
}

function isSameSemanticGroup(wordA, wordB) {
  const gA = getSemanticGroup(wordA);
  const gB = getSemanticGroup(wordB);
  return gA >= 0 && gB >= 0 && gA === gB;
}

// ── 7. MASTER smartMatch FUNCTION ────────────────────────────
function smartMatch(guess, answer) {
  if (!guess || !answer) return { score: 0, type: 'none' };

  // ─ Step 1: Normalize both inputs
  const g = normalize(guess);
  const a = normalize(answer);
  if (!g || !a) return { score: 0, type: 'none' };

  // ─ Step 2: Exact match → 2 pts
  if (g === a) return { score: 2, type: 'exact' };

  // ─ Step 3: Phonetic-normalized exact match → 2 pts
  const gPhon = phoneticsNormalize(g);
  const aPhon = phoneticsNormalize(a);
  if (gPhon === aPhon) return { score: 2, type: 'exact' };

  // ─ Step 4: Semantic group match (cross-language) → 2 pts
  if (isSameSemanticGroup(g, a)) return { score: 2, type: 'exact' };

  // ─ Step 5: High fuzzy similarity (>= 80%) → 2 pts
  const rawSim = similarityRatio(g, a);
  if (rawSim >= 0.80) return { score: 2, type: 'exact' };

  // ─ Step 5b: Phonetic fuzzy similarity (>= 80%) → 2 pts
  const phonSim = similarityRatio(gPhon, aPhon);
  if (phonSim >= 0.80) return { score: 2, type: 'exact' };

  // ─ Step 6: Stemmed/plural match → 2 pts
  if (stemLight(g) === stemLight(a)) return { score: 2, type: 'exact' };

  // ─ Step 7: Multi-word semantic match → 2 pts
  const gWords = g.split(/\s+/).filter(Boolean);
  const aWords = a.split(/\s+/).filter(Boolean);
  if (gWords.length > 0 && aWords.length > 0 && gWords.length === aWords.length) {
    const allMatch = gWords.every((gw, i) =>
      gw === aWords[i] ||
      isSameSemanticGroup(gw, aWords[i]) ||
      similarityRatio(phoneticsNormalize(gw), phoneticsNormalize(aWords[i])) >= 0.80
    );
    if (allMatch) return { score: 2, type: 'exact' };
  }

  // ── PARTIAL MATCH CHECKS (1 point) ──

  // ─ Step 8: Containment check → 1 pt
  if (g.includes(a) || a.includes(g)) return { score: 1, type: 'partial' };

  // ─ Step 9: Moderate fuzzy similarity (>= 55%) → 1 pt
  if (rawSim >= 0.55 || phonSim >= 0.55) return { score: 1, type: 'partial' };

  // ─ Step 10: Stemmed partial → 1 pt
  if (similarityRatio(stemLight(g), stemLight(a)) >= 0.65) return { score: 1, type: 'partial' };

  // ─ Step 11: Word-level overlap (>= 50% words match) → 1 pt
  if (gWords.length > 0 && aWords.length > 0) {
    const matchCount = gWords.filter(gw =>
      aWords.some(aw =>
        gw === aw ||
        isSameSemanticGroup(gw, aw) ||
        similarityRatio(gw, aw) >= 0.75
      )
    ).length;
    const ratio = matchCount / Math.max(gWords.length, aWords.length);
    if (ratio >= 0.5) return { score: 1, type: 'partial' };
  }

  // ─ Step 12: No match → 0 pts
  return { score: 0, type: 'none' };
}

function resolveGuesses(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const correctAnswer = room.currentAnswer;
  const results = {};
  let anyCorrect = false;
  const activePlayers = getActivePlayers(room);
  const turnPlayer = activePlayers[room.currentTurnPlayerIndex];
  const turnPlayerId = turnPlayer?.id;

  activePlayers.forEach(p => {
    if (p.id === turnPlayerId) return;
    const guess = room.guesses[p.id] || '';
    const match = smartMatch(guess, correctAnswer);
    if (match.score > 0) {
      p.score += match.score;
      anyCorrect = true;
    }
    results[p.id] = {
      guess,
      isCorrect: match.type === 'exact',
      isPartial: match.type === 'partial',
      matchType: match.type,   // 'exact' | 'partial' | 'none'
      matchScore: match.score, // 2 | 1 | 0
      playerName: p.name
    };
  });

  room.phase = 'roundEnd';
  io.to(roomCode).emit('guess-results', {
    results,
    correctAnswer: room.currentAnswer,
    question: room.currentQuestion,
    scores: activePlayers.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar })),
    anyCorrect
  });

  // 10s total: 3.5s reveal delay + 5s visible result + 1.5s buffer
  room.timerRef = setTimeout(() => {
    advanceTurn(roomCode);
  }, 10000);
}

function advanceTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // ═══ SAFETY CHECK: Clean and validate active players ═══
  room.players = getActivePlayers(room);

  if (room.players.length < 2) {
    forceEndGame(roomCode, 'Not enough players to continue');
    return;
  }

  room.turnsThisRound++;

  if (room.turnsThisRound >= room.players.length) {
    room.turnsThisRound = 0;
    room.currentRound++;
    room.turnOrder = room.players.map((_, i) => i).sort(() => Math.random() - 0.5);
  }

  if (room.currentRound > room.totalRounds) {
    endGame(roomCode);
    return;
  }

  room.currentTurnPlayerIndex = room.turnOrder[room.turnsThisRound];
  // Safety check
  if (room.currentTurnPlayerIndex >= room.players.length) {
    room.currentTurnPlayerIndex = 0;
  }

  // Verify the next turn player is still active
  const nextPlayer = room.players[room.currentTurnPlayerIndex];
  if (!nextPlayer || !nextPlayer.connected || nextPlayer.isActive === false) {
    // Skip this player's turn
    advanceTurn(roomCode);
    return;
  }

  startQuestionPhase(roomCode);
}

function endGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.phase = 'gameEnd';
  clearTimeout(room.timerRef);
  if (room.timerSyncRef) { clearInterval(room.timerSyncRef); room.timerSyncRef = null; }

  const active = getActivePlayers(room);
  const sorted = [...active].sort((a, b) => b.score - a.score);

  if (sorted.length === 0) {
    cleanupRoom(roomCode);
    return;
  }

  io.to(roomCode).emit('game-over', {
    winner: sorted[0],
    scores: sorted.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }))
  });
  broadcastRoomState(roomCode);
}

function forceEndGame(roomCode, reason) {
  const room = rooms[roomCode];
  if (!room) return;

  room.phase = 'gameEnd';
  clearTimeout(room.timerRef);
  if (room.timerSyncRef) { clearInterval(room.timerSyncRef); room.timerSyncRef = null; }

  // Emit specific events for client-side handling
  io.to(roomCode).emit('game-ended', { reason });
  io.to(roomCode).emit('force-exit-game', { reason });
  io.to(roomCode).emit('room-closed', { reason });
  console.log(`[Room] ${roomCode} force-ended: ${reason}`);

  // Clean up after a short delay
  setTimeout(() => cleanupRoom(roomCode), 1500);
}

function cleanupRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  clearTimeout(room.timerRef);
  if (room.timerSyncRef) { clearInterval(room.timerSyncRef); room.timerSyncRef = null; }
  room.players.forEach(p => {
    delete playerSockets[p.id];
  });
  delete rooms[roomCode];
  io.emit('rooms-updated');
  console.log(`[Room] ${roomCode} cleaned up`);
}

// ─── CRITICAL: Handle Leave (explicit leave OR disconnect) ───
function handleLeave(socket, roomCode, isDisconnect = false) {
  const room = rooms[roomCode];
  if (!room) {
    delete playerSockets[socket.id];
    return;
  }

  const playerIndex = room.players.findIndex(p => p.id === socket.id);
  if (playerIndex === -1) {
    delete playerSockets[socket.id];
    return;
  }

  const leavingPlayer = room.players[playerIndex];
  const leavingName = leavingPlayer.name;
  const wasCurrentTurn = (playerIndex === room.currentTurnPlayerIndex);

  // ═══ STEP 1: Mark player as COMPLETELY INACTIVE ═══
  leavingPlayer.isActive = false;
  leavingPlayer.connected = false;

  // ═══ STEP 2: Track this player as LEFT to prevent auto-rejoin ═══
  leftPlayers[socket.id] = true;

  // ═══ STEP 3: Remove player from room completely ═══
  room.players.splice(playerIndex, 1);
  socket.leave(roomCode);
  delete playerSockets[socket.id];

  // ═══ STEP 4: Clean up ALL their game state ═══
  if (room.guesses) delete room.guesses[socket.id];
  // Remove from playAgainAccepted if present
  if (room.playAgainAccepted) room.playAgainAccepted.delete(socket.id);
  // Clear play-again timer if active (prevent ghost play-again)
  if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
  room.playAgainAccepted = null;

  // ═══ STEP 5: Tell the leaving player to force-exit (stop listening) ═══
  // This fires BEFORE we emit to the room, so the leaving player gets it
  socket.emit('force-exit-game', {
    reason: 'You left the room'
  });
  socket.emit('remove-player-from-room', {
    playerId: socket.id,
    playerName: leavingName
  });

  // ═══ STEP 6: Notify remaining players ═══
  const active = getActivePlayers(room);
  io.to(roomCode).emit('player-left', {
    playerName: leavingName,
    remainingPlayers: active.length
  });
  io.to(roomCode).emit('update-turn-queue', {
    activePlayers: active.map(p => ({ id: p.id, name: p.name }))
  });

  // ═══ STEP 7: Room empty → delete immediately ═══
  if (active.length === 0) {
    clearTimeout(room.timerRef);
    if (room.timerSyncRef) { clearInterval(room.timerSyncRef); room.timerSyncRef = null; }
    delete rooms[roomCode];
    io.emit('rooms-updated');
    console.log(`[Room] ${roomCode} deleted (empty)`);
    return;
  }

  // ═══ STEP 8: Assign new host if needed ═══
  if (!active.some(p => p.isHost)) {
    active[0].isHost = true;
  }

  // ═══ STEP 9: If game is active, check player count ═══
  const isGameActive = room.phase !== 'waiting' && room.phase !== 'gameEnd';

  if (isGameActive && active.length < 2) {
    // ──────────────────────────────────────────────
    // NOT ENOUGH PLAYERS → FORCE END FOR ALL MODES
    // 2-player mode: other player left → game over
    // 4-player mode: dropped below 2 → game over
    // ──────────────────────────────────────────────
    clearTimeout(room.timerRef);
    if (room.timerSyncRef) { clearInterval(room.timerSyncRef); room.timerSyncRef = null; }
    room.phase = 'gameEnd';

    const reason = `${leavingName} left the game. Not enough players to continue.`;
    io.to(roomCode).emit('game-ended', { reason });
    io.to(roomCode).emit('force-exit-game', { reason });
    io.to(roomCode).emit('room-closed', { reason });

    // Clean up room after short delay
    setTimeout(() => {
      const r = rooms[roomCode];
      if (r) {
        r.players.forEach(p => delete playerSockets[p.id]);
        delete rooms[roomCode];
        io.emit('rooms-updated');
      }
    }, 1500);
    console.log(`[Room] ${roomCode} force-ended: player left, < 2 remaining`);
    return;
  }

  // ═══ STEP 10: Game is active and enough players remain ═══
  if (isGameActive) {
    // Rebuild players list to only active
    room.players = active;

    // Rebuild turn order with new player indices
    room.turnOrder = room.players.map((_, i) => i).sort(() => Math.random() - 0.5);

    // Handle turn adjustment
    if (wasCurrentTurn) {
      // The leaving player was the current turn player → skip their turn immediately
      clearTimeout(room.timerRef);
      room.turnsThisRound = 0;

      // If it was question phase with no answer yet, just advance
      if (room.phase === 'question') {
        room.currentQuestion = '';
        room.currentAnswer = '';
        room.guesses = {};
        advanceTurn(roomCode);
        return;
      }

      // If it was guess phase, the question asker left — resolve what we have
      if (room.phase === 'guess') {
        room.currentTurnPlayerIndex = Math.min(room.currentTurnPlayerIndex, room.players.length - 1);
        resolveGuesses(roomCode);
        return;
      }

      // roundEnd phase — just advance
      advanceTurn(roomCode);
      return;
    } else {
      // Adjust turn index after splice (player removed before current turn player)
      if (playerIndex < room.currentTurnPlayerIndex) {
        room.currentTurnPlayerIndex = Math.max(0, room.currentTurnPlayerIndex - 1);
      }
      if (room.currentTurnPlayerIndex >= room.players.length) {
        room.currentTurnPlayerIndex = 0;
      }

      // If in guess phase, check if all remaining active non-turn players have guessed
      if (room.phase === 'guess') {
        const turnPlayerId = room.players[room.currentTurnPlayerIndex]?.id;
        const nonTurnPlayers = active.filter(p => p.id !== turnPlayerId);
        const allGuessed = nonTurnPlayers.every(p => room.guesses[p.id] !== undefined);
        if (allGuessed && nonTurnPlayers.length > 0) {
          clearTimeout(room.timerRef);
          resolveGuesses(roomCode);
          return;
        }
      }
    }
  }

  broadcastRoomState(roomCode);
  io.emit('rooms-updated');
}

// ─── Start Server ────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🧠 Mind Sync Game running on http://localhost:${PORT}`);
});
