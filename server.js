const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Load default 72 questions
let defaultQuestions = [];
try {
  const qData = fs.readFileSync(path.join(__dirname, 'public', 'questions.json'), 'utf8');
  defaultQuestions = JSON.parse(qData);
} catch (err) {
  console.error('Error loading default questions:', err);
}

function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const rooms = {};

function generateRoomCode() {
  let code = Math.floor(1000 + Math.random() * 9000).toString();
  while (rooms[code]) {
    code = Math.floor(1000 + Math.random() * 9000).toString();
  }
  return code;
}

app.get('/api/qr', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ qr: qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR' });
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Host creates room with optional question count & custom questions
  socket.on('create_room', ({ customQuestions, questionCount } = {}) => {
    const roomCode = generateRoomCode();
    const rawQuestions = (Array.isArray(customQuestions) && customQuestions.length > 0)
      ? customQuestions
      : defaultQuestions;

    let shuffledQuestions = shuffleArray(rawQuestions);

    const limit = parseInt(questionCount, 10);
    if (limit > 0 && limit < shuffledQuestions.length) {
      shuffledQuestions = shuffledQuestions.slice(0, limit);
    }

    rooms[roomCode] = {
      code: roomCode,
      hostSocketId: socket.id,
      players: {},
      dedications: [],
      questions: shuffledQuestions,
      currentQuestionIndex: -1,
      status: 'lobby',
      timer: 60,
      timerInterval: null
    };

    socket.join(roomCode);
    socket.emit('room_created', {
      roomCode,
      totalQuestions: shuffledQuestions.length
    });
  });

  socket.on('join_room', ({ roomCode, playerName, dedication }) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit('join_error', 'קוד חדר לא קיים');
    }
    const cleanName = playerName ? playerName.trim() : 'שחקן ' + socket.id.substring(0, 4);

    room.players[socket.id] = {
      id: socket.id,
      name: cleanName,
      score: 0,
      correctCount: 0,
      totalAnswered: 0,
      totalSpeedSeconds: 0,
      hasAnswered: false,
      lastAnswerIndex: null,
      lastAnswerTime: 0
    };

    if (dedication && typeof dedication === 'string') {
      const cleanDedication = dedication.trim();
      if (cleanDedication && !room.dedications.includes(cleanDedication)) {
        room.dedications.push(cleanDedication);
      }
    }

    socket.join(roomCode);

    socket.emit('joined_successfully', {
      roomCode,
      playerName: cleanName,
      status: room.status,
      currentQuestionIndex: room.currentQuestionIndex,
      totalQuestions: room.questions.length,
      dedications: room.dedications
    });

    io.to(roomCode).emit('player_list_updated', Object.values(room.players));
    io.to(roomCode).emit('dedications_updated', room.dedications);
  });

  socket.on('start_game', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostSocketId !== socket.id) return;

    room.currentQuestionIndex = 0;
    room.status = 'playing';
    startQuestionRound(roomCode);
  });

  socket.on('submit_answer', ({ roomCode, answerIndex }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return;

    const player = room.players[socket.id];
    if (!player || player.hasAnswered) return;

    player.hasAnswered = true;
    player.lastAnswerIndex = answerIndex;
    player.lastAnswerTime = room.timer;
    player.totalAnswered++;

    const currentQ = room.questions[room.currentQuestionIndex];
    if (currentQ && answerIndex === currentQ.correctIndex) {
      player.correctCount++;
      const speedBonus = Math.floor((room.timer / 60) * 500);
      player.score += (1000 + speedBonus);
      player.totalSpeedSeconds += room.timer;
    }

    socket.emit('answer_received', {
      answerIndex,
      score: player.score
    });

    const answeredCount = Object.values(room.players).filter(p => p.hasAnswered).length;
    const totalPlayers = Object.keys(room.players).length;

    io.to(roomCode).emit('answer_progress', {
      answeredCount,
      totalPlayers
    });

    if (totalPlayers > 0 && answeredCount === totalPlayers) {
      endQuestionRound(roomCode);
    }
  });

  socket.on('next_question', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostSocketId !== socket.id) return;

    if (room.status === 'playing') {
      endQuestionRound(roomCode);
    } else if (room.status === 'revealed') {
      if (room.currentQuestionIndex + 1 < room.questions.length) {
        room.currentQuestionIndex++;
        room.status = 'playing';
        startQuestionRound(roomCode);
      } else {
        finishGame(roomCode);
      }
    }
  });

  // Host manually ends game early and triggers podium/stats
  socket.on('end_game_early', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostSocketId !== socket.id) return;
    finishGame(roomCode);
  });

  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(roomCode).emit('player_list_updated', Object.values(room.players));
      }
    }
  });
});

function startQuestionRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.status = 'playing';
  room.timer = 60;

  Object.values(room.players).forEach(p => {
    p.hasAnswered = false;
    p.lastAnswerIndex = null;
  });

  const q = room.questions[room.currentQuestionIndex];

  const questionPayload = {
    questionIndex: room.currentQuestionIndex,
    totalQuestions: room.questions.length,
    id: q.id,
    question: q.question,
    options: q.options,
    timer: room.timer,
    dedications: room.dedications
  };

  io.to(roomCode).emit('new_question', questionPayload);

  room.timerInterval = setInterval(() => {
    room.timer--;

    io.to(roomCode).emit('timer_tick', { timer: room.timer });

    if (room.timer <= 0) {
      clearInterval(room.timerInterval);
      endQuestionRound(roomCode);
    }
  }, 1000);
}

function endQuestionRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timerInterval) clearInterval(room.timerInterval);

  room.status = 'revealed';

  const q = room.questions[room.currentQuestionIndex];

  const leaderboard = Object.values(room.players)
    .sort((a, b) => b.score - a.score)
    .map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      lastAnswerIndex: p.lastAnswerIndex,
      isCorrect: p.lastAnswerIndex === q.correctIndex
    }));

  const revealPayload = {
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    source: q.source,
    leaderboard,
    hasNext: room.currentQuestionIndex + 1 < room.questions.length
  };

  io.to(roomCode).emit('question_ended', revealPayload);
}

function finishGame(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  if (room.timerInterval) clearInterval(room.timerInterval);
  room.status = 'finished';

  const playersList = Object.values(room.players).sort((a, b) => b.score - a.score);

  // Top 3 Podium
  const winner = playersList[0] || null;
  const secondPlace = playersList[1] || null;
  const thirdPlace = playersList[2] || null;

  // Fun Stats
  // Fastest responder (highest average remaining seconds on correct answers)
  const fastestPlayer = [...playersList].sort((a, b) => {
    const avgA = a.correctCount > 0 ? (a.totalSpeedSeconds / a.correctCount) : 0;
    const avgB = b.correctCount > 0 ? (b.totalSpeedSeconds / b.correctCount) : 0;
    return avgB - avgA;
  })[0] || null;

  // Most accurate player (highest correct percentage)
  const mostAccuratePlayer = [...playersList].sort((a, b) => {
    const pctA = a.totalAnswered > 0 ? (a.correctCount / a.totalAnswered) : 0;
    const pctB = b.totalAnswered > 0 ? (b.correctCount / b.totalAnswered) : 0;
    return pctB - pctA;
  })[0] || null;

  const stats = {
    totalQuestionsPlayed: room.currentQuestionIndex + 1,
    totalPlayers: playersList.length,
    fastestPlayerName: fastestPlayer ? fastestPlayer.name : '-',
    mostAccuratePlayerName: mostAccuratePlayer ? `${mostAccuratePlayer.name} (${mostAccuratePlayer.correctCount}/${mostAccuratePlayer.totalAnswered})` : '-'
  };

  io.to(roomCode).emit('game_finished', {
    winner,
    secondPlace,
    thirdPlace,
    stats,
    leaderboard: playersList,
    dedications: room.dedications
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
