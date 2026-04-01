# Badminton Rotation Algorithm

A fairness-based court allocation and rotation algorithm for badminton club nights. Used in production at [Blazers Badminton Club](https://blazers-badminton.duckdns.org).

## What it does

Manages the full lifecycle of a badminton club session:

- Decides **who plays next** based on fairness (fewest games, longest wait)
- Forms **teams** that minimise repeated partner and opponent pairings
- Handles **partial rotation** — courts that finish early get new games while unfinished courts keep playing
- Supports **respin** (redraw a court from the pool) and **shuffle** (new teams, same 4 players)

---

## Core concepts

### The three player states

At any point in a session, every player is in one of three states:

| State | Meaning |
|-------|---------|
| **Busy** | Currently playing on an unfinished court |
| **Free** | Available for the next draw |
| **Sitting out** | Available but not selected this round |

### Fairness gate

Before each draw, players are ranked by how many games they've played tonight:

1. Find the **global minimum** games played by anyone
2. Players with `gamesPlayed <= min + 1` get **priority**
3. Among those, sort by **fewest games first**, then **most times sat out**
4. Fill as many courts as available players allow — fairness affects *who* plays, not *how many courts* run

### Pairing algorithm

Once the playing pool is selected, teams are formed by:

1. Tracking full **partner history** (who has played doubles with whom) and **opponent history** (who has faced whom)
2. Running `N` random shuffles of the pool (`max(200, players × 20)` attempts)
3. Scoring each arrangement — **repeat pairings are heavily penalised**, fresh combinations are rewarded
4. Picking the lowest-penalty arrangement

**Scoring weights:**
- Repeat partner: `100 + (count × 50)` penalty — very expensive
- Fresh partner: `-10` reward
- Repeat opponent: `30 + (count × 15)` penalty
- Fresh opponent: `-3` reward

Early exit if a completely fresh assignment (no repeats at all) is found.

### Partial rotation

When one court finishes before others:

1. Players on **unfinished courts stay put** — they are marked busy
2. Only **free players** (finished + sitting out) are considered for new draws
3. The algorithm fills back up to the configured court count
4. Completed games are archived into `completedGames`

This means rotation is continuous — you don't wait for all courts to finish.

---

## Exported functions

### `generateRound(playerIds, courts, previousRounds, gamesPlayed)`

Generates an initial round of games from the full checked-in pool.

```js
const { games, sittingOut } = generateRound(
  ['p1', 'p2', 'p3', ...],  // all checked-in player IDs
  2,                          // number of courts
  [],                         // previous rounds (for history)
  { p1: 3, p2: 3, p3: 2 }   // games played per player this session
);
```

Returns `{ games, sittingOut }` where each game has `{ id, court, team1, team2, score1, score2, ... }`.

---

### `rotateCourts(session)`

Rotates finished courts while leaving unfinished courts running.

```js
const result = rotateCourts(session);
if (result.error) {
  console.error(result.error); // e.g. 'No courts have finished yet'
}
// session is mutated in place — new round added
```

---

### `respinCourt(session, court)`

Redraws a specific unscored court from the full available pool. The 4 players currently on that court have their `gamesPlayed` temporarily decremented so they compete fairly with sitting-out players.

```js
const result = respinCourt(session, 1); // redraw court 1
```

---

### `shuffleCourt(session, court)`

Keeps the same 4 players on a court but randomly reassigns team pairings.

```js
const result = shuffleCourt(session, 2); // new teams on court 2
```

---

### `validateScore(s1, s2, settings)`

Validates a score pair against BWF-style rules.

```js
const result = validateScore(21, 15, { pointsToWin: 21, winByTwo: true });
// { valid: true }

const result = validateScore(21, 20, { pointsToWin: 21, winByTwo: true });
// { valid: false, error: 'Must win by at least 2 points' }
```

Settings default to `{ pointsToWin: 21, winByTwo: true }`.

---

## Data shapes

### Session object (minimal)

```js
{
  id: 's123',
  status: 'playing',       // 'check-in' | 'playing' | 'completed'
  courts: 2,               // configured court count
  checkedIn: ['p1', 'p2', ...],
  gamesPlayed: { p1: 3, p2: 4, ... },
  lastPlayedAt: { p1: 1711234567890, ... },
  leavingSoon: [],
  rounds: [
    {
      id: 'r1',
      games: [...],
      completedGames: [...],
      sittingOut: ['p5']
    }
  ]
}
```

### Game object

```js
{
  id: 'g1711234567890-0-0',
  court: 1,
  team1: ['p1', 'p2'],
  team2: ['p3', 'p4'],
  score1: null,            // null until submitted
  score2: null,
  confirmedByTeam1: false,
  confirmedByTeam2: false,
  submittedBy: null,
  ratingProcessed: false
}
```

---

## Late joiner handling

Players who check in after the session has started are assigned `gamesPlayed` equal to the **current session average** rather than 0. This prevents late joiners from monopolising courts at the expense of punctual players.

---

## Known limitations

- The pairing algorithm is **heuristic**, not provably optimal — it finds a very good assignment in `N` random attempts rather than the mathematical best
- With small player pools (8 players, many rounds), some opponent repeats are **mathematically inevitable** — the algorithm minimises them but cannot always eliminate them
- `opponentCounts` tracking is implemented and penalised but with smaller weights than partner repeats — opponents change more frequently so repeats are expected sooner

---

## Usage

The algorithm has no dependencies beyond Node.js. Import the functions you need:

```js
import { generateRound, rotateCourts, respinCourt, shuffleCourt, validateScore } from './session.service.js';
```

The file uses ES module syntax (`export`). If you need CommonJS, rename `.js` to `.mjs` or transpile with your build tool.

---

## License

MIT
