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
  const seen = new Set();
  const list = Object.entries(rooms)
    .filter(([code, r]) => {
      // Only show waiting rooms with at least 1 active player
      if (!r || !r.roomName || r.phase !== 'waiting') return false;
      const activePlayers = getActivePlayers(r);
      if (activePlayers.length === 0) return false;
      // Deduplicate by roomCode
      if (seen.has(code)) return false;
      seen.add(code);
      return true;
    })
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
const playerProfiles = {}; // playerName -> { name, avatar, coins, matches, wins }
const sharedPacks = {};    // packId -> { id, creatorName, name, questions[], price, buyers[] }
let nextPackId = 1;

// ─── Question Pack Definitions ───
const PACK_QUESTIONS = {
  love: [
    'What is your partner\'s favorite color?','What is your first date memory?','What gift would make you happiest?',
    'What song reminds you of love?','What is your love language?','What is the most romantic place?',
    'What nickname do you use for your partner?','What movie makes you cry?','What is your dream honeymoon?',
    'What is the sweetest thing someone said to you?'
  ],
  school: [
    'Who was the class clown?','What was your favorite subject?','Who was your best friend in school?',
    'What was your most embarrassing moment?','Which teacher was the strictest?','What did you eat for lunch?',
    'What was your school crush\'s name?','What sport did you play?','What was your nickname?',
    'What was your favorite school event?'
  ],
  crazy: [
    'What is the craziest thing you\'ve done?','What secret have you never told?','What is your guilty pleasure?',
    'What would you do with a million dollars?','What is your weirdest habit?','Who would you swap lives with?',
    'What is the most daring thing on your bucket list?','What is your biggest fear?','What lie do you tell most?',
    'If you could break one law, what would it be?'
  ]
};

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

  // Use the pre-selected pack question stored in room (set during startQuestionPhase)
  const packQuestion = room.currentPackQuestion || null;
  const qp = room.questionPack || 'default';

  // Determine pack display name
  let packDisplayName = '';
  if (qp !== 'default') {
    if (PACK_QUESTIONS[qp]) {
      packDisplayName = qp.charAt(0).toUpperCase() + qp.slice(1) + ' Pack';
    } else if (qp.startsWith('shared-')) {
      const pid = qp.replace('shared-', '');
      const sp = sharedPacks[pid];
      if (sp) packDisplayName = sp.name;
    } else if (qp.startsWith('custom-')) {
      packDisplayName = room.packDisplayName || 'Custom Pack';
    }
  }

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
    timerEnd: room.timerEnd,
    questionPack: room.questionPack || 'default',
    packQuestion: packQuestion,
    packDisplayName: packDisplayName || '',
    // Tell client if this is a pack-mode turn (answer-only)
    isPackMode: !!(qp !== 'default' && packQuestion)
  });
}

// ─── Socket.IO ───────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // ── Create Room ──
  socket.on('create-room', ({ playerName, avatar, maxPlayers, totalRounds, roomName, password, questionPack, packQuestions, packName }) => {
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

    // Resolve pack questions for custom packs
    let resolvedPack = questionPack || 'default';
    let roomPackQuestions = null;
    let roomPackDisplayName = '';

    if (resolvedPack !== 'default') {
      if (PACK_QUESTIONS[resolvedPack]) {
        // Built-in pack
        roomPackQuestions = [...PACK_QUESTIONS[resolvedPack]];
        roomPackDisplayName = resolvedPack.charAt(0).toUpperCase() + resolvedPack.slice(1) + ' Pack';
      } else if (resolvedPack.startsWith('shared-')) {
        // Shared marketplace pack
        const pid = resolvedPack.replace('shared-', '');
        const sp = sharedPacks[pid];
        if (sp && sp.questions.length > 0) {
          roomPackQuestions = [...sp.questions];
          roomPackDisplayName = sp.name;
        }
      } else if (resolvedPack.startsWith('custom-') && Array.isArray(packQuestions) && packQuestions.length >= 5) {
        // Custom pack — client sent the questions along
        roomPackQuestions = packQuestions.slice(0, 10);
        roomPackDisplayName = packName || 'Custom Pack';
      }
    }

    rooms[roomCode] = {
      players: [player],
      phase: 'waiting',
      maxPlayers: maxPlayers || 2,
      totalRounds: totalRounds || 3,
      roomName: roomName || 'Room ' + roomCode,
      password: password || '',
      questionPack: resolvedPack,
      packQuestions: roomPackQuestions,        // Array of questions for this room's pack
      packDisplayName: roomPackDisplayName,    // Display name
      usedPackQuestionIndices: [],             // Track used question indices to avoid repeats
      currentPackQuestion: null,              // Currently active pack question for this turn
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
    console.log(`[Room] ${roomCode} created by ${playerName} (pack: ${resolvedPack})`);
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

  // ── Submit Question + Answer (handles both pack-mode and default mode) ──
  socket.on('submit-qa', ({ roomCode, question, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'question') return;
    const activePlayers = getActivePlayers(room);
    if (activePlayers[room.currentTurnPlayerIndex]?.id !== socket.id) return;

    clearTimeout(room.timerRef);

    // In pack mode, use the pre-selected pack question (ignore client question)
    if (room.currentPackQuestion) {
      room.currentQuestion = room.currentPackQuestion;
    } else {
      room.currentQuestion = (question || '').trim();
    }
    room.currentAnswer = (answer || '').trim().toLowerCase();

    if (!room.currentQuestion || !room.currentAnswer) {
      // If still empty, skip turn
      room.currentQuestion = room.currentQuestion || '(No question submitted)';
      room.currentAnswer = room.currentAnswer || '';
    }

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

  // ── Use Advantage: Skip Turn (turn player skips their question) ──
  socket.on('use-skip-turn', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'question') return;
    const activePlayers = getActivePlayers(room);
    if (activePlayers[room.currentTurnPlayerIndex]?.id !== socket.id) return;
    clearTimeout(room.timerRef);
    room.currentQuestion = '(Skipped)';
    room.currentAnswer = '';
    io.to(roomCode).emit('turn-skipped', { playerName: activePlayers[room.currentTurnPlayerIndex].name });
    advanceTurn(roomCode);
  });

  // ── Sync Profile (for World Leaderboard) ──
  socket.on('sync-profile', ({ name, avatar, coins, matches, wins }) => {
    if (!name) return;
    if (!playerProfiles[name]) playerProfiles[name] = {};
    playerProfiles[name] = { ...playerProfiles[name], name, avatar: avatar || '😀', score: coins || 0, coins: coins || 0, matches: matches || 0, wins: wins || 0 };
  });

  // ── World Leaderboard ──
  socket.on('get-world-leaderboard', () => {
    const lb = Object.values(playerProfiles).sort((a, b) => b.score - a.score).slice(0, 50);
    socket.emit('world-leaderboard', lb);
  });

  // ── Get Player Profile ──
  socket.on('get-player-profile', ({ name }) => {
    const profile = playerProfiles[name];
    if (profile) {
      // Include pack earnings info
      socket.emit('player-profile', profile);
    } else {
      socket.emit('player-profile', { name, avatar: '😀', coins: 0, matches: 0, wins: 0 });
    }
  });

  // ── Share Pack (Create & publish to marketplace) ──
  socket.on('share-pack', ({ name, questions }) => {
    const info = playerSockets[socket.id];
    if (!info) return socket.emit('share-pack-error', 'Not connected');
    if (!name || !name.trim()) return socket.emit('share-pack-error', 'Enter a pack name');
    if (!questions || !Array.isArray(questions)) return socket.emit('share-pack-error', 'Invalid question data');
    if (questions.length !== 10) return socket.emit('share-pack-error', 'Pack must have exactly 10 questions');
    // Validate each question
    for (let i = 0; i < questions.length; i++) {
      if (!questions[i] || questions[i].trim().length <= 3) {
        return socket.emit('share-pack-error', `Question ${i + 1} is too short (must be > 3 characters)`);
      }
    }
    const packId = 'P' + (nextPackId++);
    sharedPacks[packId] = {
      id: packId,
      creatorName: info.playerName,
      name: name.trim(),
      questions: questions.map(q => q.trim()).slice(0, 10),
      price: 50,
      buyers: []
    };
    socket.emit('share-pack-success', { packId, name: name.trim() });
    // Broadcast to ALL connected clients so everyone sees the new pack immediately
    io.emit('packs-updated');
    console.log(`[Pack] ${info.playerName} shared pack "${name}" (${packId})`);
  });

  // ── Get All Shared Packs ──
  socket.on('get-shared-packs', () => {
    const packs = Object.values(sharedPacks).map(p => ({
      id: p.id,
      creatorName: p.creatorName,
      name: p.name,
      questionCount: p.questions.length,
      price: p.price,
      previewQuestions: p.questions.slice(0, 3),
      buyers: p.buyers || []
    }));
    socket.emit('shared-packs-list', packs);
  });

  // ── Buy Shared Pack ──
  socket.on('buy-shared-pack', ({ packId }) => {
    const info = playerSockets[socket.id];
    if (!info) return;
    const pack = sharedPacks[packId];
    if (!pack) return socket.emit('buy-pack-error', 'Pack not found');
    if (pack.buyers.includes(info.playerName)) return socket.emit('buy-pack-error', 'Already owned');
    if (pack.creatorName === info.playerName) return socket.emit('buy-pack-error', 'You created this pack');
    // Deduct coins handled client-side; server just records the purchase
    pack.buyers.push(info.playerName);
    // Give creator 50 coins
    if (playerProfiles[pack.creatorName]) {
      playerProfiles[pack.creatorName].coins = (playerProfiles[pack.creatorName].coins || 0) + 50;
      playerProfiles[pack.creatorName].score = playerProfiles[pack.creatorName].coins;
      if (!playerProfiles[pack.creatorName].packEarnings) playerProfiles[pack.creatorName].packEarnings = [];
      playerProfiles[pack.creatorName].packEarnings.push({ buyerName: info.playerName, packName: pack.name, amount: 50, time: Date.now() });
    }
    // Send back the full pack questions to the buyer
    socket.emit('buy-pack-success', { packId, name: pack.name, questions: pack.questions });
    console.log(`[Pack] ${info.playerName} bought pack "${pack.name}" from ${pack.creatorName}`);
  });

  // ── Get Pack Earnings (for creator profile) ──
  socket.on('get-pack-earnings', () => {
    const info = playerSockets[socket.id];
    if (!info) return;
    const profile = playerProfiles[info.playerName];
    const earnings = profile?.packEarnings || [];
    const totalEarned = earnings.reduce((sum, e) => sum + e.amount, 0);
    socket.emit('pack-earnings', { earnings, totalEarned });
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

    // ═══ CRITICAL: Re-check active players at request time ═══
    const active = getActivePlayers(room);
    if (active.length < 2) {
      socket.emit('play-again-error', 'Not enough players. Returning home.');
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

    // Initialize play-again tracking
    if (!room.playAgainAccepted) room.playAgainAccepted = new Set();
    // The requesting player is auto-accepted
    room.playAgainAccepted.add(socket.id);

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

    // ═══ CRITICAL: Re-verify active player count FRESH (not cached) ═══
    const active = getActivePlayers(room);
    if (active.length < 2) {
      room.playAgainAccepted = null;
      if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
      io.to(roomCode).emit('play-again-error', 'Not enough players. Returning home.');
      return;
    }

    const allAccepted = active.every(p => room.playAgainAccepted.has(p.id));
    if (allAccepted) {
      // Clear timeout
      if (room.playAgainTimer) { clearTimeout(room.playAgainTimer); room.playAgainTimer = null; }
      room.playAgainAccepted = null;

      // ═══ FINAL SAFETY: One more check right before starting ═══
      const finalActive = getActivePlayers(room);
      if (finalActive.length < 2) {
        io.to(roomCode).emit('play-again-error', 'Not enough players. Returning home.');
        return;
      }

      room.players = finalActive; // Clean inactive
      room.turnOrder = room.players.map((_, i) => i).sort(() => Math.random() - 0.5);
      room.currentRound = 1;
      room.turnsThisRound = 0;
      room.currentTurnPlayerIndex = room.turnOrder[0];
      room.players.forEach(p => p.score = 0);
      // Reset pack question tracking for fresh game
      room.usedPackQuestionIndices = [];
      room.currentPackQuestion = null;
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
  room.currentPackQuestion = null; // Reset for this turn

  // ═══ PACK QUESTION SELECTION: Pick one question from the pack ═══
  const qp = room.questionPack || 'default';
  if (qp !== 'default' && room.packQuestions && room.packQuestions.length > 0) {
    // Get available indices (not yet used)
    const totalQs = room.packQuestions.length;
    let available = [];
    for (let i = 0; i < totalQs; i++) {
      if (!room.usedPackQuestionIndices.includes(i)) available.push(i);
    }
    // If all used, reset (allow repeats)
    if (available.length === 0) {
      room.usedPackQuestionIndices = [];
      available = room.packQuestions.map((_, i) => i);
    }
    // Pick a random available question
    const randomIdx = available[Math.floor(Math.random() * available.length)];
    room.currentPackQuestion = room.packQuestions[randomIdx];
    room.usedPackQuestionIndices.push(randomIdx);
    console.log(`[Pack] Turn question: "${room.currentPackQuestion}" (idx ${randomIdx})`);
  }

  room.timerEnd = Date.now() + QUESTION_TIMER_MS;

  broadcastRoomState(roomCode);
  startTimerSync(roomCode, 'question');

  room.timerRef = setTimeout(() => {
    if (room.phase === 'question') {
      // In pack mode, if no answer submitted, skip turn
      if (room.currentPackQuestion) {
        room.currentQuestion = room.currentPackQuestion;
        room.currentAnswer = '';
      } else {
        room.currentQuestion = '(No question submitted)';
        room.currentAnswer = '';
      }
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

  // Build the turn player's answer for visibility
  const turnPlayerAnswer = room.currentAnswer;

  activePlayers.forEach(p => {
    if (p.id === turnPlayerId) return;
    const guess = room.guesses[p.id] || '';
    const match = smartMatch(guess, correctAnswer);
    // BONUS POINT SYSTEM: Perfect match = +2 base + +1 bonus = +3 total
    let finalScore = match.score;
    if (match.type === 'exact') finalScore = 3; // +2 base + +1 bonus
    if (finalScore > 0) {
      p.score += finalScore;
      anyCorrect = true;
    }
    results[p.id] = {
      guess,
      isCorrect: match.type === 'exact',
      isPartial: match.type === 'partial',
      matchType: match.type,   // 'exact' | 'partial' | 'none'
      matchScore: finalScore,  // 3 | 1 | 0 (with bonus)
      playerName: p.name
    };
  });

  room.phase = 'roundEnd';
  // ANSWER VISIBILITY FIX: Send BOTH answers to ALL players
  // Include turnPlayerId so clients can differentiate creator vs guesser views
  io.to(roomCode).emit('guess-results', {
    results,
    correctAnswer: room.currentAnswer,
    question: room.currentQuestion,
    turnPlayerName: turnPlayer?.name || '',
    turnPlayerId: turnPlayerId || '',
    turnPlayerAnswer: turnPlayerAnswer,
    scores: activePlayers.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar })),
    anyCorrect,
    packDisplayName: room.packDisplayName || ''
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

  // HISTORY DETAILS: Include all player scores for detailed history
  io.to(roomCode).emit('game-over', {
    winner: sorted[0],
    scores: sorted.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar })),
    packName: room.questionPack || 'default',
    totalRounds: room.totalRounds
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

  // ═══ STEP 9: If game is active OR in gameEnd, check player count ═══
  // CRITICAL: Changed to include gameEnd phase — prevents play-again with 1 player
  const isGameActive = room.phase !== 'waiting';

  // ═══ CRITICAL: Cancel any pending play-again on ANY leave ═══
  if (room.playAgainAccepted) {
    room.playAgainAccepted = null;
  }
  if (room.playAgainTimer) {
    clearTimeout(room.playAgainTimer);
    room.playAgainTimer = null;
  }
  // Notify remaining players that play-again is cancelled
  io.to(roomCode).emit('play-again-error', `${leavingName} left. Play again cancelled.`);

  if (isGameActive && active.length < 2) {
    // ──────────────────────────────────────────────
    // NOT ENOUGH PLAYERS → FORCE END FOR ALL MODES
    // Covers: question, guess, roundEnd, AND gameEnd
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
