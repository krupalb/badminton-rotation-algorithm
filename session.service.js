/**
 * Session service — all court rotation, pairing, and fairness logic.
 *
 * No Express here. Functions take plain data objects and return results.
 * Routes call these functions and handle the HTTP layer.
 */

// ── Helpers ───────────────────────────────────────────

/**
 * Validate a score pair against BWF-style rules.
 *
 * Rules:
 * - Both scores must be non-negative integers
 * - Winner must reach pointsToWin
 * - If winByTwo: winner must lead by ≥2, unless both are at pointsToWin-1
 *   (deuce), in which case someone must reach pointsToWin+1 up to a cap of
 *   pointsToWin+9 (e.g. 30 for standard 21-point games)
 * - Loser score cannot exceed winner score
 * - Both scores cannot be equal (no draws in badminton)
 *
 * @param {number} s1
 * @param {number} s2
 * @param {object} settings  - { pointsToWin: 21, winByTwo: true }
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
export function validateScore(s1, s2, settings = {}) {
  const pointsToWin = settings.pointsToWin ?? 21;
  const winByTwo = settings.winByTwo ?? true;
  const cap = pointsToWin + 9; // e.g. 30 for 21-point games

  // Must be whole numbers
  if (!Number.isInteger(s1) || !Number.isInteger(s2)) {
    return { valid: false, error: 'Scores must be whole numbers' };
  }

  // Must be non-negative
  if (s1 < 0 || s2 < 0) {
    return { valid: false, error: 'Scores cannot be negative' };
  }

  // Cannot exceed cap
  if (s1 > cap || s2 > cap) {
    return { valid: false, error: `Scores cannot exceed ${cap}` };
  }

  // No draws
  if (s1 === s2) {
    return { valid: false, error: 'Scores cannot be equal — there must be a winner' };
  }

  const high = Math.max(s1, s2);
  const low = Math.min(s1, s2);
  const diff = high - low;

  // Winner must have reached pointsToWin
  if (high < pointsToWin) {
    return { valid: false, error: `Winner must reach at least ${pointsToWin} points` };
  }

  if (winByTwo) {
    if (high === pointsToWin) {
      // Normal win — must lead by at least 2
      if (diff < 2) {
        return { valid: false, error: `Must win by at least 2 points` };
      }
    } else {
      // Extended play (winner went past pointsToWin).
      // BWF rules: game reaches pointsToWin-1 all, then first to get 2 ahead wins.
      // Scores progress together so:
      //   valid:   22-20, 23-21, 24-22 ... 29-27, 30-28 (diff===2)
      //   cap:     30-29 (diff===1, high===cap)
      //   invalid: anything else
      //
      // Loser must be >= pointsToWin-1 (game reached that tie point).
      if (low < pointsToWin - 1) {
        return {
          valid: false,
          error: `If winner exceeds ${pointsToWin}, both scores must have reached ${pointsToWin - 1}`,
        };
      }
      // At cap: 30-29 is the only valid 1-point win
      if (high === cap && diff === 1) {
        return { valid: true };
      }
      // All other extended play: must win by exactly 2
      if (diff !== 2) {
        return { valid: false, error: `In extended play, winner must lead by exactly 2 points` };
      }
    }
  }

  return { valid: true };
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Build partner and opponent history from all rounds.
 */
function buildHistory(rounds) {
  const partnerCounts = {};
  const opponentCounts = {};
  rounds.forEach((round) => {
    [...round.games, ...(round.completedGames || [])].forEach((g) => {
      [g.team1, g.team2].forEach((team) => {
        if (team.length === 2) {
          const key = [...team].sort().join('-');
          partnerCounts[key] = (partnerCounts[key] || 0) + 1;
        }
      });
      for (const a of g.team1) {
        for (const b of g.team2) {
          const key = [a, b].sort().join('-');
          opponentCounts[key] = (opponentCounts[key] || 0) + 1;
        }
      }
    });
  });
  return { partnerCounts, opponentCounts };
}

/**
 * Score a court assignment — lower is better.
 * Penalises repeat partners/opponents, rewards new combinations.
 */
function scoreAssignment(teams, partnerCounts, opponentCounts) {
  let score = 0;
  for (const { t1, t2 } of teams) {
    const pk1 = [...t1].sort().join('-');
    const pk2 = [...t2].sort().join('-');
    const p1Count = partnerCounts[pk1] || 0;
    const p2Count = partnerCounts[pk2] || 0;
    // Heavy exponential penalty for repeat partners — first repeat is very expensive
    score += p1Count > 0 ? 100 + p1Count * 50 : -10;
    score += p2Count > 0 ? 100 + p2Count * 50 : -10;
    for (const a of t1) {
      for (const b of t2) {
        const oppKey = [a, b].sort().join('-');
        const oppCount = opponentCounts[oppKey] || 0;
        // Moderate penalty for repeat opponents
        score += oppCount > 0 ? 30 + oppCount * 15 : -3;
      }
    }
  }
  return score;
}

/**
 * Find the best court assignment from a pool of players across n courts.
 * Runs 80 random shuffle attempts and picks the lowest-scoring assignment.
 */
function bestCourtAssignment(playing, numCourts, partnerCounts, opponentCounts) {
  let bestAssignment = null;
  let bestScore = Infinity;

  // More attempts for better coverage — especially important with many players
  const attempts = Math.max(200, playing.length * 20);

  for (let attempt = 0; attempt < attempts; attempt++) {
    const sh = shuffle(playing);
    const courts = [];
    for (let c = 0; c < numCourts; c++) {
      const s = c * 4;
      if (s + 3 >= sh.length) break;
      courts.push({ t1: [sh[s], sh[s + 1]], t2: [sh[s + 2], sh[s + 3]] });
    }
    const score = scoreAssignment(courts, partnerCounts, opponentCounts);
    if (!bestAssignment || score < bestScore) {
      bestAssignment = courts;
      bestScore = score;
      // Early exit if we found a perfectly fresh assignment (no repeats at all)
      if (bestScore <= -(numCourts * 26)) break;
    }
  }

  return bestAssignment;
}

// ── Public API ────────────────────────────────────────

/**
 * Generate an initial round of games.
 *
 * @param {string[]} playerIds   - All checked-in player IDs
 * @param {number}   courts      - Number of configured courts
 * @param {object[]} previousRounds
 * @param {object}   gamesPlayed - { playerId: count }
 * @returns {{ games: object[], sittingOut: string[] }}
 */
export function generateRound(playerIds, courts, previousRounds = [], gamesPlayed = {}) {
  const playersPerRound = courts * 4;

  // Find global minimum games played
  const allCounts = playerIds.map((id) => gamesPlayed[id] || 0);
  const globalMin = allCounts.length > 0 ? Math.min(...allCounts) : 0;

  // Fairness: players within 1 game of minimum are eligible first
  let eligible = playerIds.filter((id) => (gamesPlayed[id] || 0) <= globalMin + 1);
  if (eligible.length < playersPerRound) eligible = [...playerIds]; // fallback

  // Sort by games played (fewest first), then sit-out history
  const sitOutCounts = {};
  playerIds.forEach((id) => (sitOutCounts[id] = 0));
  previousRounds.forEach((round) => {
    const playing = new Set();
    [...round.games, ...(round.completedGames || [])].forEach((g) =>
      [...g.team1, ...g.team2].forEach((id) => playing.add(id)),
    );
    playerIds.forEach((id) => {
      if (!playing.has(id)) sitOutCounts[id]++;
    });
  });

  eligible.sort((a, b) => {
    const gamesDiff = (gamesPlayed[a] || 0) - (gamesPlayed[b] || 0);
    if (gamesDiff !== 0) return gamesDiff;
    const sitDiff = sitOutCounts[b] - sitOutCounts[a];
    if (sitDiff !== 0) return sitDiff;
    return Math.random() - 0.5;
  });

  // Fairness affects WHO plays, not HOW MANY courts run.
  // Always fill as many courts as total players allow.
  const maxPlayable = Math.floor(playerIds.length / 4) * 4;
  const targetPlaying = Math.min(playersPerRound, maxPlayable);
  const eligibleSet = new Set(eligible);
  const remainder = playerIds.filter((id) => !eligibleSet.has(id));
  const playPool = [...eligible, ...remainder];
  const playing = playPool.slice(0, targetPlaying);
  const sittingOut = playerIds.filter((id) => !playing.includes(id));

  const { partnerCounts, opponentCounts } = buildHistory(previousRounds);
  const numCourts = Math.floor(playing.length / 4);
  const bestAssignment = bestCourtAssignment(playing, numCourts, partnerCounts, opponentCounts);

  const now = Date.now();
  const games = bestAssignment.map(({ t1, t2 }, c) => ({
    id: `g${now}-${c}-0`,
    court: c + 1,
    team1: t1,
    team2: t2,
    score1: null,
    score2: null,
    confirmedByTeam1: false,
    confirmedByTeam2: false,
  }));

  return { games, sittingOut };
}

/**
 * Rotate finished courts — pull in waiting players, keep unfinished courts running.
 *
 * @param {object} session  - Active session object (mutated in place)
 * @returns {{ ok: true } | { error: string, status: number }}
 */
export function rotateCourts(session) {
  const curRound = session.rounds[session.rounds.length - 1];
  if (!curRound) return { error: 'No active round', status: 400 };

  const finishedGames = curRound.games.filter((g) => g.confirmedByTeam1 && g.confirmedByTeam2);
  const unfinishedGames = curRound.games.filter((g) => !g.confirmedByTeam1 || !g.confirmedByTeam2);

  if (finishedGames.length === 0) {
    return { error: 'No courts have finished yet', status: 400 };
  }

  // Busy = players on unfinished courts
  const busyPlayers = new Set();
  unfinishedGames.forEach((g) => [...g.team1, ...g.team2].forEach((id) => busyPlayers.add(id)));

  const available = session.checkedIn.filter((id) => !busyPlayers.has(id));
  if (available.length < 4) {
    return { error: 'Not enough available players', status: 400 };
  }

  const gp = session.gamesPlayed || {};
  const lp = session.lastPlayedAt || {};

  // Fairness sort — fewest games first, then longest waiting
  const allGameCounts = session.checkedIn.map((id) => gp[id] || 0);
  const globalMin = Math.min(...allGameCounts);
  const eligible = available.filter((id) => (gp[id] || 0) <= globalMin + 1);
  let pool = eligible.length >= 4 ? eligible : available;

  pool.sort((a, b) => {
    const gamesDiff = (gp[a] || 0) - (gp[b] || 0);
    if (gamesDiff !== 0) return gamesDiff;
    const waitDiff = (lp[a] || 0) - (lp[b] || 0);
    if (waitDiff !== 0) return waitDiff;
    return Math.random() - 0.5;
  });

  // Fairness affects WHO plays, not HOW MANY courts run.
  // Fill up to the session's configured court count, not just the number that finished.
  const maxCourtsFromPlayers = Math.floor(available.length / 4);
  const configuredCourts = session.courts || finishedGames.length;
  const courtsToFill = Math.min(configuredCourts - unfinishedGames.length, maxCourtsFromPlayers);
  const slotsNeeded = courtsToFill * 4;
  const playSource = pool.length >= slotsNeeded ? pool : available;
  const playCount = Math.min(slotsNeeded, Math.floor(playSource.length / 4) * 4);
  const playing = playSource.slice(0, playCount);
  const sittingOut = available.filter((id) => !playing.includes(id));

  const { partnerCounts, opponentCounts } = buildHistory(session.rounds);
  const numCourts = Math.floor(playing.length / 4);
  const bestAssignment = bestCourtAssignment(playing, numCourts, partnerCounts, opponentCounts);

  // Archive finished games
  if (!curRound.completedGames) curRound.completedGames = [];
  finishedGames.forEach((g) => curRound.completedGames.push(g));
  curRound.games = unfinishedGames;

  // Create new games
  const now = Date.now();
  if (!session.lastPlayedAt) session.lastPlayedAt = {};

  const newGames = bestAssignment.map((court, i) => {
    const courtNum = finishedGames[i]?.court || i + 1;
    [...court.t1, ...court.t2].forEach((id) => {
      session.gamesPlayed[id] = (session.gamesPlayed[id] || 0) + 1;
      session.lastPlayedAt[id] = now;
    });
    return {
      id: `g${now}-${courtNum}`,
      court: courtNum,
      team1: court.t1,
      team2: court.t2,
      score1: null,
      score2: null,
      confirmedByTeam1: false,
      confirmedByTeam2: false,
    };
  });

  const newRound = {
    id: `r${now}`,
    roundNumber: (session.rounds?.length || 0) + 1,
    games: [...unfinishedGames, ...newGames].sort((a, b) => a.court - b.court),
    sittingOut,
    completedGames: [],
  };

  curRound.games = [];
  session.rounds.push(newRound);

  return { ok: true };
}

/**
 * Respin a single court — redraw from full available pool.
 *
 * @param {object} session
 * @param {number} court   - Court number to respin
 * @returns {{ ok: true } | { error: string, status: number }}
 */
export function respinCourt(session, court) {
  const curRound = session.rounds[session.rounds.length - 1];
  if (!curRound) return { error: 'No active round', status: 400 };

  const targetGame = curRound.games.find((g) => g.court === court && g.score1 === null && g.score2 === null);
  if (!targetGame) return { error: 'Court not found or already scored', status: 400 };

  const otherGames = curRound.games.filter((g) => g.id !== targetGame.id);
  const busyPlayers = new Set();
  otherGames.forEach((g) => [...g.team1, ...g.team2].forEach((id) => busyPlayers.add(id)));

  const allAvailable = session.checkedIn.filter((id) => !busyPlayers.has(id));
  if (allAvailable.length < 4) return { error: 'Not enough available players', status: 400 };

  // Build history excluding the target game so it doesn't bias the draw
  const previousRounds = [...session.rounds.slice(0, -1)];
  const fakeCurrentRound = { games: otherGames, completedGames: curRound.completedGames || [] };
  previousRounds.push(fakeCurrentRound);

  // Decrement target court players from gamesPlayed so sitting-out players
  // get fair selection (they look equal to current players)
  const tempGamesPlayed = { ...session.gamesPlayed };
  [...targetGame.team1, ...targetGame.team2].forEach((id) => {
    if (tempGamesPlayed[id] > 0) tempGamesPlayed[id]--;
  });

  const newRound = generateRound(allAvailable, 1, previousRounds, tempGamesPlayed);
  if (!newRound.games || newRound.games.length === 0) {
    return { error: 'Could not generate pairing', status: 400 };
  }

  const newGame = newRound.games[0];
  newGame.court = court;
  newGame.id = `g${Date.now()}-${court}`;

  // Adjust gamesPlayed: old players out, new players in
  const oldPlayers = new Set([...targetGame.team1, ...targetGame.team2]);
  const newPlayers = new Set([...newGame.team1, ...newGame.team2]);
  const now = Date.now();
  if (!session.lastPlayedAt) session.lastPlayedAt = {};

  oldPlayers.forEach((id) => {
    if (!newPlayers.has(id) && session.gamesPlayed[id] > 0) session.gamesPlayed[id]--;
  });
  newPlayers.forEach((id) => {
    if (!oldPlayers.has(id)) session.gamesPlayed[id] = (session.gamesPlayed[id] || 0) + 1;
    session.lastPlayedAt[id] = now;
  });

  curRound.games = curRound.games.map((g) => (g.id === targetGame.id ? newGame : g));
  curRound.sittingOut = session.checkedIn.filter(
    (id) => !curRound.games.some((g) => [...g.team1, ...g.team2].includes(id)),
  );

  return { ok: true };
}

/**
 * Shuffle same 4 players on a court into new teams.
 *
 * @param {object} session
 * @param {number} court
 * @returns {{ ok: true } | { error: string, status: number }}
 */
export function shuffleCourt(session, court) {
  const curRound = session.rounds[session.rounds.length - 1];
  if (!curRound) return { error: 'No active round', status: 400 };

  const game = curRound.games.find((g) => g.court === court && g.score1 === null);
  if (!game) return { error: 'Court not found or already scored', status: 400 };

  const players = shuffle([...game.team1, ...game.team2]);
  game.team1 = [players[0], players[1]];
  game.team2 = [players[2], players[3]];

  return { ok: true };
}
