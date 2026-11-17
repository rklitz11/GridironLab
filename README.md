# Gridiron Lab

Game-by-game NFL offensive stats with context, plus projections for players and game environments (score, spread, total, winner).

## Run it

Requires Node 20+. There are no npm dependencies.

```bash
npm run update   # download data, fetch weather, build features, train models (~2 min after first run)
npm start        # http://localhost:5173
```

Run `npm run update` whenever you want fresh data. During the season, nflverse updates overnight after games. Past seasons are cached in `data/raw/`, so only the current season is downloaded again. `node pipeline/fetch.mjs --force` re-downloads everything.

### Phone page

`npm run mobile` writes `data/out/mobile/week.html`, a single page with the next week's games and player projections laid out for a phone. It's published as a private page at https://claude.ai/artifact/C1SVFLXgwuayYLnRwr88VR, which you can open in the Claude app. To refresh it, run `npm run update && npm run mobile` and ask Claude to republish the page.

### Upcoming-week availability

For games not yet played, the latest depth chart decides the starting QB and adds new signings or traded players (anyone in the top QB1 / RB3 / WR5 / TE3 with NFL game history). The weekly roster marks IR, released and practice-squad players as Out. Until the official injury report comes out on Wednesday, players who were Out or Doubtful the week before are carried forward as Questionable. Run `npm run update` again on Wednesday through Friday so the real report replaces these.

## Pipeline

| Step | File | What it does |
|---|---|---|
| fetch | `pipeline/fetch.mjs` | nflverse data for 2016 to the present: schedules and Vegas lines, play-by-play, weekly player stats, PFR snap counts and advanced stats, Next Gen Stats, injury reports, player bios, plus this season's weekly rosters and daily ESPN depth charts |
| weather | `pipeline/weather.mjs` | Open-Meteo hourly weather over each game's window at the stadium (archive for past games, 16-day forecast for upcoming ones). Cached in `data/cache/weather.json` |
| build | `pipeline/build.mjs` | Builds leak-free features. Every rolling stat uses only games before kickoff |
| model | `pipeline/model.mjs` | Gradient-boosted trees (`pipeline/lib/gbm.mjs`), out-of-sample back-test, calibrated outcome ranges, and JSON for the site in `data/out/` |

### What the models see

- **Team / game**: recency-weighted offensive and defensive EPA (pass and rush), success rate, explosive rate, pace in neutral situations, pass rate over expected, points per drive, red-zone TD rate, turnover rate, fantasy points allowed by position, starting-QB change, rest, travel miles, time-zone shift, body-clock kickoff hour, altitude, home/away/neutral site, division game, primetime, roof, surface, temperature, wind, gusts, precipitation and snow.
- **Player**: snap share, target / air-yard / carry share, volume and efficiency trends (recency-weighted and last 3 games), NGS separation / cushion / YAC over expected / rush yards over expected / CPOE / time to throw, PFR pressure rate / drops / broken tackles / yards after contact, age, experience, draft slot, injury status and practice participation, plus targets and carries left open by injured teammates. All of this sits on top of the game context above.
- The **game model never sees the betting line**, so it can be compared fairly against Vegas. Player models do use the Vegas implied team total. When no line has been posted yet, they use the game model's projection instead.

### Back-test (trained on 2016–2024, scored on 2025–2026)

Choices were tuned on the 2023–24 dev seasons (trained on 2016–21), so 2025–26 stays untouched. Run `node pipeline/experiments/game-exp.mjs` or `player-exp.mjs` to repeat the experiments.

| | v1 | v2 (current) | Vegas close |
|---|---|---|---|
| Game margin MAE | 9.98 | 10.01 | 9.64 |
| Game total MAE | 10.86 | **10.62** | 10.43 |
| PPR MAE | 3.96 | 3.955 | – |
| QB pass attempts RMSE | 9.69 | **9.52** | – |

What changed in v2:
- Opponent-adjusted team efficiency, so EPA, success rate and points account for strength of schedule.
- A starting-QB rating: dropback-weighted EPA and CPOE, shrunk toward replacement level. It follows the projected starter when the usual QB is ruled out.
- Player red-zone, goal-line, end-zone and deep-target opportunity shares from play-by-play.
- Team points from a 70/30 ridge + shallow-tree blend. Poisson objective for count stats. Slower learning for yardage and fantasy points.

What didn't help: long-horizon multi-season ratings, direct margin/total models, seed bagging, and blending the model with the Vegas line, which never beat the line alone.

## Ideas for next iterations

- Offensive/defensive line matchups (pressure rate vs pass block) and coordinator/play-caller changes.
- Depth-chart and roster feeds for better handling of trades and returns from injury in upcoming weeks.
- Project stats jointly so teammates' projections add up to the team totals.
- Line-movement history and props from a sportsbook odds API.
