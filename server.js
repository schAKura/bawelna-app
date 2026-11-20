// ============================================================
// BawełnaApp – Serwer Multiplayer (Node.js + SQLite + WebSocket)
// ============================================================

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
let Database;
try {
  Database = require('better-sqlite3');
} catch {
  // Fallback dla nowszych wersji Node.js (>= 22.5.0) bez potrzeby kompilowania C++
  const { DatabaseSync } = require('node:sqlite');
  Database = class {
    constructor(filename) {
      this.db = new DatabaseSync(filename);
    }
    pragma(sql) {
      try { this.db.exec(`PRAGMA ${sql}`); } catch {}
    }
    exec(sql) {
      return this.db.exec(sql);
    }
    prepare(sql) {
      return this.db.prepare(sql);
    }
  };
}
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- BAZA DANYCH SQLite ---
const db = new Database(path.join(__dirname, 'bawelna.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Tworzenie tabel
db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS villages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    invite_code TEXT UNIQUE NOT NULL,
    money INTEGER DEFAULT 150,
    game_minutes REAL DEFAULT 570,
    boost_active INTEGER DEFAULT 0,
    boost_timer REAL DEFAULT 0,
    boost_cooldown_timer REAL DEFAULT 0,
    boost_duration REAL DEFAULT 8,
    boost_multiplier REAL DEFAULT 1.8,
    boost_cooldown REAL DEFAULT 20,
    boost_lvl_duration INTEGER DEFAULT 1,
    boost_lvl_power INTEGER DEFAULT 1,
    boost_lvl_cooldown INTEGER DEFAULT 1,
    total_earned INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (owner_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS village_members (
    village_id TEXT NOT NULL,
    player_id TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (village_id, player_id),
    FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE CASCADE,
    FOREIGN KEY (player_id) REFERENCES players(id)
  );

  CREATE TABLE IF NOT EXISTS huts (
    id TEXT PRIMARY KEY,
    village_id TEXT NOT NULL,
    gx INTEGER NOT NULL,
    gy INTEGER NOT NULL,
    level INTEGER DEFAULT 1,
    capacity INTEGER DEFAULT 2,
    FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS workers (
    id TEXT PRIMARY KEY,
    hut_id TEXT NOT NULL,
    village_id TEXT NOT NULL,
    tier INTEGER NOT NULL,
    name TEXT NOT NULL,
    speed REAL NOT NULL,
    max_carry INTEGER NOT NULL,
    value_mult REAL NOT NULL,
    color TEXT NOT NULL,
    FOREIGN KEY (hut_id) REFERENCES huts(id) ON DELETE CASCADE,
    FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ranking (
    village_id TEXT PRIMARY KEY,
    village_name TEXT NOT NULL,
    total_earned INTEGER DEFAULT 0,
    member_count INTEGER DEFAULT 1,
    FOREIGN KEY (village_id) REFERENCES villages(id) ON DELETE CASCADE
  );
`);

// --- PROSTE HASHOWANIE HASŁA ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verify;
}

// --- GENEROWANIE KODU ZAPROSZENIA ---
function generateInviteCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // np. "A3F2B1"
}

// --- PREPARED STATEMENTS ---
const stmts = {
  getPlayer: db.prepare('SELECT * FROM players WHERE username = ?'),
  getPlayerById: db.prepare('SELECT * FROM players WHERE id = ?'),
  createPlayer: db.prepare('INSERT INTO players (id, username, password_hash) VALUES (?, ?, ?)'),

  getVillage: db.prepare('SELECT * FROM villages WHERE id = ?'),
  getVillageByInvite: db.prepare('SELECT * FROM villages WHERE invite_code = ?'),
  getPlayerVillages: db.prepare(`
    SELECT v.*, vm.role FROM villages v
    JOIN village_members vm ON vm.village_id = v.id
    WHERE vm.player_id = ?
  `),
  createVillage: db.prepare(`
    INSERT INTO villages (id, name, owner_id, invite_code, money, game_minutes)
    VALUES (?, ?, ?, ?, 150, 570)
  `),
  updateVillageMoney: db.prepare('UPDATE villages SET money = ?, total_earned = ? WHERE id = ?'),
  updateVillageState: db.prepare(`
    UPDATE villages SET money = ?, game_minutes = ?,
    boost_active = ?, boost_timer = ?, boost_cooldown_timer = ?,
    boost_duration = ?, boost_multiplier = ?, boost_cooldown = ?,
    boost_lvl_duration = ?, boost_lvl_power = ?, boost_lvl_cooldown = ?,
    total_earned = ?
    WHERE id = ?
  `),

  getVillageMembers: db.prepare(`
    SELECT p.id, p.username, vm.role FROM village_members vm
    JOIN players p ON p.id = vm.player_id
    WHERE vm.village_id = ?
  `),
  addMember: db.prepare('INSERT OR IGNORE INTO village_members (village_id, player_id, role) VALUES (?, ?, ?)'),
  removeMember: db.prepare('DELETE FROM village_members WHERE village_id = ? AND player_id = ?'),
  getMembership: db.prepare('SELECT * FROM village_members WHERE village_id = ? AND player_id = ?'),

  getHuts: db.prepare('SELECT * FROM huts WHERE village_id = ?'),
  createHut: db.prepare('INSERT INTO huts (id, village_id, gx, gy, level, capacity) VALUES (?, ?, ?, ?, ?, ?)'),
  updateHut: db.prepare('UPDATE huts SET level = ?, capacity = ? WHERE id = ?'),

  getWorkers: db.prepare('SELECT * FROM workers WHERE village_id = ?'),
  getWorkersByHut: db.prepare('SELECT * FROM workers WHERE hut_id = ?'),
  createWorker: db.prepare('INSERT INTO workers (id, hut_id, village_id, tier, name, speed, max_carry, value_mult, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),

  upsertRanking: db.prepare(`
    INSERT INTO ranking (village_id, village_name, total_earned, member_count)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(village_id) DO UPDATE SET
    village_name = excluded.village_name,
    total_earned = excluded.total_earned,
    member_count = excluded.member_count
  `),
  getRanking: db.prepare('SELECT * FROM ranking ORDER BY total_earned DESC LIMIT 50'),
};

// --- AKTYWNE POŁĄCZENIA WebSocket ---
// Map: villageId -> Set<{ws, playerId, username}>
const villageConnections = new Map();
// Map: villageId -> Set<ws> (obserwatorzy wiosek z rankingu)
const villageSpectators = new Map();
// Map: ws -> {playerId, username, villageId, spectatingVillageId}
const wsInfo = new Map();

function broadcastToVillage(villageId, message, excludeWs = null) {
  const data = JSON.stringify(message);

  // Do członków wioski
  const conns = villageConnections.get(villageId);
  if (conns) {
    for (const conn of conns) {
      if (conn.ws !== excludeWs && conn.ws.readyState === 1) {
        conn.ws.send(data);
      }
    }
  }

  // Do obserwatorów z rankingu
  const specs = villageSpectators.get(villageId);
  if (specs) {
    for (const sWs of specs) {
      if (sWs !== excludeWs && sWs.readyState === 1) {
        sWs.send(data);
      }
    }
  }
}

function sendTo(ws, message) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastSystemNotice(villageId, text) {
  const timeStr = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  broadcastToVillage(villageId, {
    type: 'chat_message',
    sender: '📢 System',
    text,
    time: timeStr,
    system: true
  });
}

// Zarządzanie liderem synchronizacji w wiosce
function updateVillageLeader(villageId) {
  const conns = villageConnections.get(villageId);
  if (!conns || conns.size === 0) return null;

  // Preferuj gracza z aktywną (widoczną) kartą w przeglądarce
  let leaderConn = null;
  for (const c of conns) {
    const cInfo = wsInfo.get(c.ws);
    if (cInfo && cInfo.tabVisible) {
      leaderConn = c;
      break;
    }
  }

  // Jeśli żaden nie ma aktywnej karty lub wszyscy są w tle, wybierz pierwszego online
  if (!leaderConn) {
    leaderConn = conns.values().next().value;
  }
  if (!leaderConn) return null;

  for (const c of conns) {
    const isL = (c === leaderConn);
    sendTo(c.ws, {
      type: 'leader_assigned',
      isLeader: isL,
      leaderUsername: leaderConn.username
    });
  }
  return leaderConn;
}

// Usuwanie obserwatora ze wszystkich list spectators
function removeSpectator(ws) {
  for (const [vId, specs] of villageSpectators) {
    specs.delete(ws);
  }
}

// --- SERWOWANIE PLIKÓW STATYCZNYCH ---
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WEBSOCKET HANDLER ---
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const handler = messageHandlers[msg.type];
    if (handler) handler(ws, msg);
  });

  ws.on('close', () => {
    removeSpectator(ws);

    const info = wsInfo.get(ws);
    if (info && info.villageId) {
      const conns = villageConnections.get(info.villageId);
      if (conns) {
        for (const c of conns) {
          if (c.ws === ws) { conns.delete(c); break; }
        }
        updateVillageLeader(info.villageId);
        broadcastToVillage(info.villageId, {
          type: 'player_left',
          playerId: info.playerId,
          username: info.username,
          online: [...conns].map(c => ({ id: c.playerId, username: c.username }))
        });
      }
    }
    wsInfo.delete(ws);
  });
});

// --- HANDLERY WIADOMOŚCI ---
const messageHandlers = {
  // Rejestracja
  register(ws, msg) {
    const { username, password } = msg;
    if (!username || !password || username.length < 2 || password.length < 3) {
      return sendTo(ws, { type: 'error', message: 'Nazwa min. 2 znaki, hasło min. 3 znaki.' });
    }
    if (stmts.getPlayer.get(username)) {
      return sendTo(ws, { type: 'error', message: 'Ta nazwa jest już zajęta.' });
    }
    const id = uuidv4();
    const hash = hashPassword(password);
    stmts.createPlayer.run(id, username, hash);
    sendTo(ws, { type: 'registered', playerId: id, username });
  },

  // Logowanie
  login(ws, msg) {
    const { username, password } = msg;
    const player = stmts.getPlayer.get(username);
    if (!player || !verifyPassword(password, player.password_hash)) {
      return sendTo(ws, { type: 'error', message: 'Nieprawidłowa nazwa lub hasło.' });
    }

    removeSpectator(ws);

    // Jeśli wcześniej gracz był w wiosce, czyścimy
    const prevInfo = wsInfo.get(ws);
    if (prevInfo && prevInfo.villageId) {
      const conns = villageConnections.get(prevInfo.villageId);
      if (conns) {
        for (const c of conns) {
          if (c.ws === ws) { conns.delete(c); break; }
        }
        updateVillageLeader(prevInfo.villageId);
        broadcastToVillage(prevInfo.villageId, {
          type: 'player_left',
          playerId: prevInfo.playerId,
          username: prevInfo.username,
          online: [...conns].map(c => ({ id: c.playerId, username: c.username }))
        });
      }
    }

    const villages = stmts.getPlayerVillages.all(player.id);
    sendTo(ws, {
      type: 'logged_in',
      playerId: player.id,
      username: player.username,
      villages: villages.map(v => ({
        id: v.id,
        name: v.name,
        role: v.role,
        inviteCode: v.invite_code,
        money: v.money
      }))
    });
    wsInfo.set(ws, { playerId: player.id, username: player.username, villageId: null, spectatingVillageId: null, tabVisible: true });
  },

  // Tworzenie wioski (REGUŁA: maks. 1 wioska na gracza!)
  create_village(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info) return sendTo(ws, { type: 'error', message: 'Nie jesteś zalogowany.' });

    // Sprawdzenie: czy gracz należy już do jakiejś wioski?
    const existing = stmts.getPlayerVillages.all(info.playerId);
    if (existing && existing.length > 0) {
      return sendTo(ws, {
        type: 'error',
        message: 'Możesz należeć tylko do 1 wioski. Aby stworzyć nową, najpierw usuń obecną wioskę lub ją opuść.'
      });
    }

    const name = (msg.name || '').trim() || `Wioska ${info.username}`;
    const id = uuidv4();
    const inviteCode = generateInviteCode();

    stmts.createVillage.run(id, name, info.playerId, inviteCode);
    stmts.addMember.run(id, info.playerId, 'owner');

    // Tworzenie startowej chaty
    const hutId = uuidv4();
    stmts.createHut.run(hutId, id, 3, 4, 1, 2);

    // Startowy wpis w rankingu
    stmts.upsertRanking.run(id, name, 0, 1);

    sendTo(ws, {
      type: 'village_created',
      village: { id, name, inviteCode, money: 150 }
    });
  },

  // Dołączanie do wioski kodem zaproszenia (REGUŁA: maks. 1 wioska na gracza!)
  join_village(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info) return sendTo(ws, { type: 'error', message: 'Nie jesteś zalogowany.' });

    // Sprawdzenie: czy gracz należy już do jakiejś wioski?
    const existingVillages = stmts.getPlayerVillages.all(info.playerId);
    if (existingVillages && existingVillages.length > 0) {
      return sendTo(ws, {
        type: 'error',
        message: 'Należysz już do wioski. Możesz być tylko w 1 wiosce naraz. Aby dołączyć do innej, najpierw opuść lub usuń swoją obecną wioskę.'
      });
    }

    const code = (msg.inviteCode || '').trim().toUpperCase();
    const village = stmts.getVillageByInvite.get(code);
    if (!village) {
      return sendTo(ws, { type: 'error', message: 'Nie znaleziono wioski o podanym kodzie.' });
    }

    const existing = stmts.getMembership.get(village.id, info.playerId);
    if (existing) {
      return sendTo(ws, { type: 'error', message: 'Już należysz do tej wioski!' });
    }

    stmts.addMember.run(village.id, info.playerId, 'member');

    // Zaktualizuj ranking o liczbę członków
    const members = stmts.getVillageMembers.all(village.id);
    stmts.upsertRanking.run(village.id, village.name, village.total_earned, members.length);

    sendTo(ws, {
      type: 'village_joined',
      village: {
        id: village.id,
        name: village.name,
        inviteCode: village.invite_code,
        money: village.money
      }
    });

    broadcastToVillage(village.id, {
      type: 'member_joined',
      playerId: info.playerId,
      username: info.username
    });
    broadcastSystemNotice(village.id, `${info.username} dołączył do wioski!`);
  },

  // Usuwanie wioski (tylko właściciel)
  delete_village(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info) return sendTo(ws, { type: 'error', message: 'Nie jesteś zalogowany.' });

    const village = stmts.getVillage.get(msg.villageId);
    if (!village) return sendTo(ws, { type: 'error', message: 'Wioska nie istnieje.' });

    if (village.owner_id !== info.playerId) {
      return sendTo(ws, { type: 'error', message: 'Tylko właściciel może usunąć wioskę.' });
    }

    const villageId = village.id;
    const villageName = village.name;

    // Powiadom wszystkich członków i obserwatorów
    broadcastToVillage(villageId, {
      type: 'village_deleted',
      villageId,
      message: `Wioska "${villageName}" została usunięta przez właściciela.`
    });

    // Wyczyść połączenia w pamięci
    const conns = villageConnections.get(villageId);
    if (conns) {
      for (const c of conns) {
        const cInfo = wsInfo.get(c.ws);
        if (cInfo) cInfo.villageId = null;
      }
      villageConnections.delete(villageId);
    }
    villageSpectators.delete(villageId);

    // Kaskadowe usunięcie z bazy SQLite
    db.prepare('DELETE FROM workers WHERE village_id = ?').run(villageId);
    db.prepare('DELETE FROM huts WHERE village_id = ?').run(villageId);
    db.prepare('DELETE FROM village_members WHERE village_id = ?').run(villageId);
    db.prepare('DELETE FROM ranking WHERE village_id = ?').run(villageId);
    db.prepare('DELETE FROM villages WHERE id = ?').run(villageId);

    sendTo(ws, {
      type: 'village_deleted_success',
      villageId,
      message: `Wioska "${villageName}" została pomyślnie usunięta.`
    });
  },

  // Opuszczenie wioski (dla członków niebędących właścicielem)
  leave_village(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info) return;

    const village = stmts.getVillage.get(msg.villageId);
    if (!village) return;
    if (village.owner_id === info.playerId) {
      return sendTo(ws, { type: 'error', message: 'Jako właściciel nie możesz opuścić wioski. Użyj opcji "Usuń wioskę".' });
    }

    stmts.removeMember.run(msg.villageId, info.playerId);

    const members = stmts.getVillageMembers.all(msg.villageId);
    stmts.upsertRanking.run(msg.villageId, village.name, village.total_earned, members.length);

    // Jeśli gracz był wewnątrz tej wioski, zaktualizuj jego socket
    if (info.villageId === msg.villageId) {
      info.villageId = null;
      const conns = villageConnections.get(msg.villageId);
      if (conns) {
        for (const c of conns) {
          if (c.ws === ws) { conns.delete(c); break; }
        }
        updateVillageLeader(msg.villageId);
      }
    }

    sendTo(ws, { type: 'village_left', villageId: msg.villageId, message: 'Opuściłeś wioskę.' });
    broadcastToVillage(msg.villageId, {
      type: 'member_left',
      playerId: info.playerId,
      username: info.username
    });
    broadcastSystemNotice(msg.villageId, `${info.username} opuścił wioskę.`);
  },

  // Wejście do wioski (jako członek drużyny)
  enter_village(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info) return sendTo(ws, { type: 'error', message: 'Nie jesteś zalogowany.' });

    removeSpectator(ws);

    const membership = stmts.getMembership.get(msg.villageId, info.playerId);
    if (!membership) {
      return sendTo(ws, { type: 'error', message: 'Nie jesteś członkiem tej wioski.' });
    }

    const village = stmts.getVillage.get(msg.villageId);
    if (!village) return sendTo(ws, { type: 'error', message: 'Wioska nie istnieje.' });

    // Opuść poprzednią wioskę jeśli była
    if (info.villageId) {
      const oldConns = villageConnections.get(info.villageId);
      if (oldConns) {
        for (const c of oldConns) {
          if (c.ws === ws) { oldConns.delete(c); break; }
        }
        updateVillageLeader(info.villageId);
      }
    }

    info.villageId = village.id;
    if (!villageConnections.has(village.id)) {
      villageConnections.set(village.id, new Set());
    }
    villageConnections.get(village.id).add({ ws, playerId: info.playerId, username: info.username });

    const hutRows = stmts.getHuts.all(village.id);
    const workerRows = stmts.getWorkers.all(village.id);
    const members = stmts.getVillageMembers.all(village.id);

    const onlineSet = villageConnections.get(village.id);
    const online = onlineSet ? [...onlineSet].map(c => ({ id: c.playerId, username: c.username })) : [];

    sendTo(ws, {
      type: 'village_data',
      village: {
        id: village.id,
        name: village.name,
        inviteCode: village.invite_code,
        ownerId: village.owner_id,
        money: village.money,
        gameMinutes: village.game_minutes,
        boost: {
          active: !!village.boost_active,
          timer: village.boost_timer,
          cooldownTimer: village.boost_cooldown_timer,
          duration: village.boost_duration,
          multiplier: village.boost_multiplier,
          cooldown: village.boost_cooldown,
          lvlDuration: village.boost_lvl_duration,
          lvlPower: village.boost_lvl_power,
          lvlCooldown: village.boost_lvl_cooldown,
        },
        totalEarned: village.total_earned,
      },
      huts: hutRows.map(h => ({
        id: h.id, gx: h.gx, gy: h.gy, level: h.level, capacity: h.capacity
      })),
      workers: workerRows.map(w => ({
        id: w.id, hutId: w.hut_id, tier: w.tier, name: w.name,
        speed: w.speed, maxCarry: w.max_carry, valueMult: w.value_mult, color: w.color
      })),
      members: members.map(m => ({ id: m.id, username: m.username, role: m.role })),
      online
    });

    // Powiadom pozostałych
    broadcastToVillage(village.id, {
      type: 'player_joined',
      playerId: info.playerId,
      username: info.username,
      online
    }, ws);

    // Zaktualizuj lidera
    updateVillageLeader(village.id);
  },

  // Podgląd innej wioski z rankingu (Spectator mode)
  view_village(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info) return sendTo(ws, { type: 'error', message: 'Nie jesteś zalogowany.' });

    const targetVillageId = msg.villageId;
    const village = stmts.getVillage.get(targetVillageId);
    if (!village) return sendTo(ws, { type: 'error', message: 'Wioska nie istnieje.' });

    removeSpectator(ws);

    if (!villageSpectators.has(targetVillageId)) {
      villageSpectators.set(targetVillageId, new Set());
    }
    villageSpectators.get(targetVillageId).add(ws);

    const hutRows = stmts.getHuts.all(village.id);
    const workerRows = stmts.getWorkers.all(village.id);
    const members = stmts.getVillageMembers.all(village.id);
    const owner = stmts.getPlayerById.get(village.owner_id);

    const onlineSet = villageConnections.get(village.id);
    const online = onlineSet ? [...onlineSet].map(c => ({ id: c.playerId, username: c.username })) : [];

    sendTo(ws, {
      type: 'village_view_data',
      village: {
        id: village.id,
        name: village.name,
        inviteCode: village.invite_code,
        ownerId: village.owner_id,
        ownerName: owner ? owner.username : 'Nieznany',
        money: village.money,
        gameMinutes: village.game_minutes,
        boost: {
          active: !!village.boost_active,
          timer: village.boost_timer,
          cooldownTimer: village.boost_cooldown_timer,
          duration: village.boost_duration,
          multiplier: village.boost_multiplier,
          cooldown: village.boost_cooldown,
          lvlDuration: village.boost_lvl_duration,
          lvlPower: village.boost_lvl_power,
          lvlCooldown: village.boost_lvl_cooldown,
        },
        totalEarned: village.total_earned,
      },
      huts: hutRows.map(h => ({
        id: h.id, gx: h.gx, gy: h.gy, level: h.level, capacity: h.capacity
      })),
      workers: workerRows.map(w => ({
        id: w.id, hutId: w.hut_id, tier: w.tier, name: w.name,
        speed: w.speed, maxCarry: w.max_carry, valueMult: w.value_mult, color: w.color
      })),
      members: members.map(m => ({ id: m.id, username: m.username, role: m.role })),
      online
    });
  },

  // Wyjście z trybu podglądu
  stop_viewing(ws) {
    removeSpectator(ws);
    sendTo(ws, { type: 'viewing_stopped' });
  },

  // Budowanie chaty
  build_hut(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    const village = stmts.getVillage.get(info.villageId);
    if (!village || village.money < 150) return sendTo(ws, { type: 'error', message: 'Za mało pieniędzy (koszt: 150$).' });

    const hutId = uuidv4();
    const newMoney = village.money - 150;
    stmts.createHut.run(hutId, info.villageId, msg.gx, msg.gy, 1, 2);
    stmts.updateVillageMoney.run(newMoney, village.total_earned, info.villageId);

    const hut = { id: hutId, gx: msg.gx, gy: msg.gy, level: 1, capacity: 2 };
    broadcastToVillage(info.villageId, {
      type: 'hut_built',
      hut,
      money: newMoney,
      builtBy: info.username
    });
    broadcastSystemNotice(info.villageId, `${info.username} wybudował nową Chatę!`);
  },

  // Zatrudnianie pracownika
  hire_worker(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    const WORKER_TIERS = [
      { tier: 1, name: "Uczeń", cost: 50, speed: 75, capacity: 1, valueMult: 1.0, color: "#3498db" },
      { tier: 2, name: "Rolnik", cost: 140, speed: 105, capacity: 2, valueMult: 1.5, color: "#e67e22" },
      { tier: 3, name: "Mistrz Zbiorów", cost: 320, speed: 145, capacity: 4, valueMult: 2.2, color: "#9b59b6" }
    ];

    const village = stmts.getVillage.get(info.villageId);
    const hut = stmts.getHuts.all(info.villageId).find(h => h.id === msg.hutId);
    const spec = WORKER_TIERS[msg.tierIndex];

    if (!village || !hut || !spec) return;

    const hutWorkers = stmts.getWorkersByHut.all(msg.hutId);
    if (hutWorkers.length >= hut.capacity) return sendTo(ws, { type: 'error', message: 'Chata osiągnęła maksymalną pojemność.' });
    if (village.money < spec.cost) return sendTo(ws, { type: 'error', message: `Za mało pieniędzy (koszt: ${spec.cost}$).` });
    if (hut.level < spec.tier) return sendTo(ws, { type: 'error', message: `Wymagany poziom chaty: Lv.${spec.tier}.` });

    const workerId = uuidv4();
    const newMoney = village.money - spec.cost;
    stmts.createWorker.run(workerId, msg.hutId, info.villageId, spec.tier, spec.name, spec.speed, spec.capacity, spec.valueMult, spec.color);
    stmts.updateVillageMoney.run(newMoney, village.total_earned, info.villageId);

    const worker = {
      id: workerId, hutId: msg.hutId, tier: spec.tier, name: spec.name,
      speed: spec.speed, maxCarry: spec.capacity, valueMult: spec.valueMult, color: spec.color
    };

    broadcastToVillage(info.villageId, {
      type: 'worker_hired',
      worker,
      money: newMoney,
      hiredBy: info.username
    });
    broadcastSystemNotice(info.villageId, `${info.username} zatrudnił: ${spec.name}!`);
  },

  // Ulepszanie chaty (pojemność lub poziom)
  upgrade_hut(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    const village = stmts.getVillage.get(info.villageId);
    const hut = stmts.getHuts.all(info.villageId).find(h => h.id === msg.hutId);
    if (!village || !hut) return;

    let cost, newLevel, newCapacity;
    if (msg.upgradeType === 'capacity') {
      cost = hut.capacity * 90;
      if (village.money < cost) return sendTo(ws, { type: 'error', message: `Za mało pieniędzy (${cost}$).` });
      newCapacity = hut.capacity + 2;
      newLevel = hut.level;
    } else if (msg.upgradeType === 'level') {
      cost = hut.level * 220;
      if (hut.level >= 3) return sendTo(ws, { type: 'error', message: 'Maksymalny poziom chaty.' });
      if (village.money < cost) return sendTo(ws, { type: 'error', message: `Za mało pieniędzy (${cost}$).` });
      newLevel = hut.level + 1;
      newCapacity = hut.capacity;
    } else return;

    const newMoney = village.money - cost;
    stmts.updateHut.run(newLevel, newCapacity, hut.id);
    stmts.updateVillageMoney.run(newMoney, village.total_earned, info.villageId);

    broadcastToVillage(info.villageId, {
      type: 'hut_upgraded',
      hutId: hut.id,
      level: newLevel,
      capacity: newCapacity,
      money: newMoney,
      upgradedBy: info.username
    });
    broadcastSystemNotice(info.villageId, `${info.username} ulepszył Chatę (Lv.${newLevel}, miejsca: ${newCapacity})!`);
  },

  // Synchronizacja zarobków (tylko autorytatywny lider wysyła)
  sync_earnings(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    const village = stmts.getVillage.get(info.villageId);
    if (!village) return;

    const earned = Math.max(0, Math.round(msg.earned || 0));
    if (earned <= 0) return;

    const newMoney = village.money + earned;
    const newTotal = village.total_earned + earned;
    stmts.updateVillageMoney.run(newMoney, newTotal, info.villageId);

    // Aktualizacja w rankingu
    const members = stmts.getVillageMembers.all(info.villageId);
    stmts.upsertRanking.run(info.villageId, village.name, newTotal, members.length);

    broadcastToVillage(info.villageId, {
      type: 'money_updated',
      money: newMoney,
      totalEarned: newTotal,
      earnedBy: info.username,
      earned
    });
  },

  // Stan widoczności karty w przeglądarce
  tab_visibility(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info) return;
    info.tabVisible = !!msg.visible;
    if (info.villageId) {
      updateVillageLeader(info.villageId);
    }
  },

  // Rozgłaszanie akcji pracowników (gdzie idą zbieracze)
  worker_action(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;
    broadcastToVillage(info.villageId, msg, ws);
  },

  // Rozgłaszanie zerwania bawełny (natychmiastowy feedback wizualny)
  plant_harvested(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;
    broadcastToVillage(info.villageId, msg, ws);
  },

  // Okresowa korekta pozycji pracowników (co parę sekund w celu zapobiegania rozbieżnościom)
  workers_drift_correction(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;
    broadcastToVillage(info.villageId, msg, ws);
  },

  // Synchronizacja pozycji i stanów pracowników w czasie rzeczywistym
  workers_sync(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    // Przekaż do pozostałych graczy i obserwatorów
    broadcastToVillage(info.villageId, {
      type: 'workers_sync',
      workers: msg.workers,
      harvested: msg.harvested,
      gameMinutes: msg.gameMinutes
    }, ws);
  },

  // Aktywacja Boosta
  activate_boost(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    const village = stmts.getVillage.get(info.villageId);
    if (!village || village.boost_active || village.boost_cooldown_timer > 0) return;

    db.prepare(`
      UPDATE villages SET boost_active = 1, boost_timer = boost_duration
      WHERE id = ?
    `).run(info.villageId);

    const updated = stmts.getVillage.get(info.villageId);
    broadcastToVillage(info.villageId, {
      type: 'boost_activated',
      boost: {
        active: true,
        timer: updated.boost_timer,
        duration: updated.boost_duration,
        multiplier: updated.boost_multiplier,
        cooldown: updated.boost_cooldown,
      },
      activatedBy: info.username
    });
    broadcastSystemNotice(info.villageId, `⚡ ${info.username} aktywował BOOST (x${updated.boost_multiplier.toFixed(1)})!`);
  },

  // Ulepszenie Boosta w sklepie
  upgrade_boost(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    const village = stmts.getVillage.get(info.villageId);
    if (!village) return;

    let cost, desc = '';
    if (msg.boostType === 'duration') {
      cost = village.boost_lvl_duration * 120;
      if (village.money < cost) return sendTo(ws, { type: 'error', message: 'Za mało pieniędzy.' });
      db.prepare('UPDATE villages SET money = money - ?, boost_duration = boost_duration + 2, boost_lvl_duration = boost_lvl_duration + 1 WHERE id = ?').run(cost, info.villageId);
      desc = 'Czas trwania (+2s)';
    } else if (msg.boostType === 'power') {
      cost = village.boost_lvl_power * 160;
      if (village.money < cost) return sendTo(ws, { type: 'error', message: 'Za mało pieniędzy.' });
      db.prepare('UPDATE villages SET money = money - ?, boost_multiplier = boost_multiplier + 0.3, boost_lvl_power = boost_lvl_power + 1 WHERE id = ?').run(cost, info.villageId);
      desc = 'Moc przyspieszenia (+0.3x)';
    } else if (msg.boostType === 'cooldown') {
      cost = village.boost_lvl_cooldown * 140;
      if (village.money < cost || village.boost_cooldown <= 6) return sendTo(ws, { type: 'error', message: 'Za mało pieniędzy lub min. cooldown.' });
      db.prepare('UPDATE villages SET money = money - ?, boost_cooldown = MAX(6, boost_cooldown - 2), boost_lvl_cooldown = boost_lvl_cooldown + 1 WHERE id = ?').run(cost, info.villageId);
      desc = 'Czas odnowienia (-2s)';
    } else return;

    const updated = stmts.getVillage.get(info.villageId);
    broadcastToVillage(info.villageId, {
      type: 'boost_upgraded',
      money: updated.money,
      boost: {
        duration: updated.boost_duration,
        multiplier: updated.boost_multiplier,
        cooldown: updated.boost_cooldown,
        lvlDuration: updated.boost_lvl_duration,
        lvlPower: updated.boost_lvl_power,
        lvlCooldown: updated.boost_lvl_cooldown,
      }
    });
    broadcastSystemNotice(info.villageId, `🛒 ${info.username} ulepszył Boost: ${desc}!`);
  },

  // Zapis stanu boosta
  sync_boost(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    db.prepare(`
      UPDATE villages SET boost_active = ?, boost_timer = ?, boost_cooldown_timer = ?
      WHERE id = ?
    `).run(msg.active ? 1 : 0, msg.timer || 0, msg.cooldownTimer || 0, info.villageId);
  },

  // Synchronizacja czasu gry
  sync_time(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;

    db.prepare('UPDATE villages SET game_minutes = ? WHERE id = ?').run(msg.gameMinutes, info.villageId);
  },

  // Czat drużyny
  send_chat(ws, msg) {
    const info = wsInfo.get(ws);
    if (!info || !info.villageId) return;
    const text = (msg.text || '').trim().slice(0, 200);
    if (!text) return;

    const timeStr = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
    broadcastToVillage(info.villageId, {
      type: 'chat_message',
      sender: info.username,
      text,
      time: timeStr,
      system: false
    });
  },

  // Pobranie rankingu drużyn
  get_ranking(ws, msg) {
    const rows = stmts.getRanking.all();
    sendTo(ws, {
      type: 'ranking_data',
      ranking: rows.map((r, i) => ({
        rank: i + 1,
        villageId: r.village_id,
        villageName: r.village_name,
        totalEarned: r.total_earned,
        memberCount: r.member_count
      }))
    });
  }
};

// --- PERIODYCZNA SYNCHRONIZACJA RANKINGU (co 30s) ---
setInterval(() => {
  for (const [villageId] of villageConnections) {
    const village = stmts.getVillage.get(villageId);
    if (village) {
      const members = stmts.getVillageMembers.all(villageId);
      stmts.upsertRanking.run(villageId, village.name, village.total_earned, members.length);
    }
  }
}, 30000);

// --- START SERWERA ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌾 BawełnaApp serwer działa na http://localhost:${PORT}`);
});
