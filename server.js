/**
 * Trivia Night — Real-time Multiplayer Backend
 * Run: node server.js
 * Requires: npm install express socket.io
 */

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

// ─── In-Memory Game State ────────────────────────────────────────────────────

const rooms = {}; // roomCode → room object

function createRoom(hostId, hostName) {
  const code = Math.floor(1000 + Math.random() * 9000).toString();
  rooms[code] = {
    code,
    hostId,
    phase: 'lobby',         // lobby | category | writing | answering | results | finished
    players: {},            // socketId → { id, name, score, answered }
    category: null,
    questions: [],          // [{ authorId, question, choices, correctIndex }]
    currentQ: 0,
    timer: null,
    timerEnd: null,
  };
  return code;
}

function getRoom(code) { return rooms[code] || null; }

function addPlayer(room, socketId, name) {
  room.players[socketId] = { id: socketId, name, score: 0, answered: false };
}

function removePlayer(room, socketId) {
  delete room.players[socketId];
}

function playerList(room) {
  return Object.values(room.players).map(p => ({
    id: p.id, name: p.name, score: p.score
  }));
}

function leaderboard(room) {
  return Object.values(room.players)
    .map(p => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function clearTimer(room) {
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
}

function startCountdown(room, seconds, onTick, onEnd) {
  clearTimer(room);
  room.timerEnd = Date.now() + seconds * 1000;
  onTick(seconds);
  room.timer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((room.timerEnd - Date.now()) / 1000));
    onTick(remaining);
    if (remaining <= 0) {
      clearTimer(room);
      onEnd();
    }
  }, 1000);
}

// ─── Socket Events ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] connected: ${socket.id}`);

  // ── Create Room ──────────────────────────────────────────────────────────
  socket.on('create_room', ({ name }, cb) => {
    const code = createRoom(socket.id, name);
    const room = getRoom(code);
    addPlayer(room, socket.id, name);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;
    console.log(`Room ${code} created by ${name}`);
    cb({ success: true, code, playerId: socket.id });
    io.to(code).emit('room_update', { players: playerList(room), phase: room.phase });
  });

  // ── Join Room ────────────────────────────────────────────────────────────
  socket.on('join_room', ({ code, name }, cb) => {
    const room = getRoom(code);
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.phase !== 'lobby') return cb({ success: false, error: 'Game already in progress.' });
    addPlayer(room, socket.id, name);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;
    console.log(`${name} joined room ${code}`);
    cb({ success: true, code, playerId: socket.id });
    io.to(code).emit('room_update', { players: playerList(room), phase: room.phase });
  });

  // ── Host Starts Round → Category Selection ───────────────────────────────
  socket.on('start_game', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'category';
    room.questions = [];
    room.currentQ = 0;
    io.to(room.code).emit('phase_change', { phase: 'category' });
  });

  // ── Category Chosen by Host ──────────────────────────────────────────────
  socket.on('choose_category', ({ category }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.category = category;
    room.phase = 'writing';

    // Reset question submissions
    Object.values(room.players).forEach(p => { p.answered = false; });

    io.to(room.code).emit('phase_change', {
      phase: 'writing',
      category,
      duration: 100,
    });

    startCountdown(
      room,
      100,
      (t) => io.to(room.code).emit('timer', { remaining: t }),
      () => endWritingPhase(room)
    );
  });

  // ── Player Submits Question ──────────────────────────────────────────────
  socket.on('submit_question', ({ question, choices, correctIndex }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.phase !== 'writing') return;
    const player = room.players[socket.id];
    if (!player || player.answered) return;

    // Basic validation
    if (!question || !Array.isArray(choices) || choices.length < 2 || correctIndex == null) return;

    player.answered = true;
    room.questions.push({
      authorId: socket.id,
      authorName: player.name,
      question,
      choices,
      correctIndex,
    });

    io.to(room.code).emit('submission_update', {
      submitted: Object.values(room.players).filter(p => p.answered).length,
      total: Object.keys(room.players).length,
    });
  });

  // ── Answering Phase ──────────────────────────────────────────────────────
  socket.on('answer_question', ({ answerIndex }) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.phase !== 'answering') return;
    const player = room.players[socket.id];
    if (!player || player.answered) return;

    const q = room.questions[room.currentQ];
    if (!q) return;

    player.answered = true;
    const timeLeft = Math.max(0, Math.ceil((room.timerEnd - Date.now()) / 1000));
    const correct = answerIndex === q.correctIndex;

    if (correct) {
      // Points: base 1000 + time bonus (up to 500)
      const bonus = Math.floor((timeLeft / 20) * 500);
      player.score += 1000 + bonus;
    }

    // Ack to the answering player
    socket.emit('answer_result', { correct, correctIndex: q.correctIndex });

    // Check if all answered
    const allAnswered = Object.values(room.players).every(p => p.answered);
    if (allAnswered) {
      clearTimer(room);
      showQuestionResults(room);
    }
  });

  // ── Host Advances to Next Question ───────────────────────────────────────
  socket.on('next_question', () => {
    const room = getRoom(socket.data.roomCode);
    if (!room || room.hostId !== socket.id) return;
    room.currentQ++;
    if (room.currentQ >= room.questions.length) {
      endGame(room);
    } else {
      startAnsweringPhase(room);
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] disconnected: ${socket.id}`);
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    removePlayer(room, socket.id);

    if (Object.keys(room.players).length === 0) {
      clearTimer(room);
      delete rooms[socket.data.roomCode];
      console.log(`Room ${socket.data.roomCode} closed (empty)`);
      return;
    }

    // Transfer host if host left
    if (room.hostId === socket.id) {
      room.hostId = Object.keys(room.players)[0];
      io.to(room.code).emit('host_changed', { hostId: room.hostId });
    }

    io.to(room.code).emit('room_update', { players: playerList(room), phase: room.phase });
  });
});

// ─── Game Flow Helpers ────────────────────────────────────────────────────────

function endWritingPhase(room) {
  if (room.questions.length === 0) {
    // Nobody submitted anything – go back to lobby
    room.phase = 'lobby';
    io.to(room.code).emit('phase_change', { phase: 'lobby', error: 'No questions were submitted!' });
    return;
  }
  room.currentQ = 0;
  startAnsweringPhase(room);
}

function startAnsweringPhase(room) {
  room.phase = 'answering';
  Object.values(room.players).forEach(p => { p.answered = false; });

  const q = room.questions[room.currentQ];
  io.to(room.code).emit('phase_change', {
    phase: 'answering',
    questionIndex: room.currentQ,
    totalQuestions: room.questions.length,
    question: q.question,
    choices: q.choices,
    authorName: q.authorName,
    duration: 20,
  });

  startCountdown(
    room,
    20,
    (t) => io.to(room.code).emit('timer', { remaining: t }),
    () => showQuestionResults(room)
  );
}

function showQuestionResults(room) {
  clearTimer(room);
  room.phase = 'results';
  const q = room.questions[room.currentQ];
  io.to(room.code).emit('phase_change', {
    phase: 'results',
    correctIndex: q.correctIndex,
    leaderboard: leaderboard(room),
    isLast: room.currentQ >= room.questions.length - 1,
  });
}

function endGame(room) {
  clearTimer(room);
  room.phase = 'finished';
  io.to(room.code).emit('phase_change', {
    phase: 'finished',
    leaderboard: leaderboard(room),
  });
}

// ─── Start Server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Trivia Night server running on http://localhost:${PORT}\n`);
});
