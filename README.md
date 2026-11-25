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

`npm run mobile` writes `data/out/mobile/week.html` (a small page with the week tabs) plus `data/out/mobile/weeks/wN.html`, one file per week that the page loads when you open that week. Together they show every week's games and player projections laid out for a phone. Finished games show the final score and each player's actual PPR against the projection. It's published as a private page at https://claude.ai/artifact/MVbzrefY82DeRrCF6uoWkn, which you can open in the Claude app. The page covers the whole season with week tabs. It opens on the week of the next unplayed game, so the same link moves to the new week on its own after Monday night. Scheduled Claude Code cloud routines refresh it automatically, so no computer needs to be on. Each run starts about 55 minutes before kickoff (after inactives are announced 90 minutes out) and takes about 8 minutes, so the page is current about 45 minutes before games: Sunday at 12:05 and 3:10 PM ET, Thursday, Sunday and Monday at 7:20 PM ET, plus one-time runs for the 2026 Thanksgiving-week (Wed 7:05 PM; Thu 12:05 and 3:35 PM; Fri 2:05 PM), Saturday Dec 19 (4:05 and 7:25 PM) and Christmas (12:05, 3:35 and 7:20 PM) games. Because each kickoff has its own run, each game's Hard Rock lines are pulled within the hour before it starts. A Tuesday, Wednesday and Friday 6 PM ET run rolls the page to the new week and picks up the injury reports; it sets `PROPS_WINDOW_HOURS=0` so it never pulls lines early. Week 18 kickoff times are set late, so its schedule needs a check then. Manage them at https://claude.ai/code/routines. To refresh by hand, run `npm run update && npm run mobile` and ask Claude to republish the page.

### Confident calls

Each game card lists every player call the model gives 60% or better, up to 10 (at least the top 3). When Hard Rock's line for the same player and stat has been pulled, it appears under the call with the model's chance at that number, the book's fair chance and the gap; 5–12 point gaps are highlighted. In the 2026 back-test, calls ranked 1–5 hit 72% (claimed 72%) and calls ranked 6–10 hit 64% (claimed 65%); about two games in five have 10 qualifying calls. A call is OVER or UNDER the player's season average (3+ games played) on stats a sportsbook prices: pass attempts, completions and yards for QBs; rushing yards for QBs and RBs; carries for RBs; receptions and receiving yards for RBs, WRs and TEs. Fantasy points aren't used: they hit about 3 points better in the back-test, but they aren't a bettable number. The percentage comes from how projections of that size actually turned out in 2025–26 games the model hadn't seen, pulled slightly toward 50% because the raw numbers ran 2–5 points too confident. In the back-test (calibrated on 2025, scored on 2026), the top 4 calls per game hit 73%; centring the same distribution on the season average instead of the projection hit 65%, so the model is adding real information beyond "stats skew low". Players with any injury designation are skipped. `PICK_SCOPE=all npm run mobile` shows calls on every upcoming game; the default shows only the next game day. Re-run the check with `node pipeline/experiments/picks-exp.mjs`.

### Best TD chances

Each week opens with the 10 players most likely to score a rushing or receiving TD in that week's Sunday and Monday games, plus any games listed in `TD_EXTRA_GAMES` in `pipeline/lib/config.mjs` (Thanksgiving week's Wednesday–Friday games are). The chance of at least one is `1 - exp(-(projected rush TDs + rec TDs))`. It's well calibrated: in 2025–26 games the model hadn't seen, weekly top-10 lists were claimed at about 53% and scored 53% (2025) and 64% (2026). Players with an injury tag, or who missed their team's last game, are left out. When Hard Rock's anytime-TD price was pulled (Sunday and Monday games only), it's shown next to the model's number. Finished weeks show who scored. Re-run the check with `node pipeline/experiments/td-exp.mjs`.

### Value vs Hard Rock

`pipeline/props.mjs` pulls Hard Rock Bet player-prop lines (passing yards, completions and attempts; rushing yards and carries; receiving yards and receptions) from The Odds API. Each game is pulled once, by the first refresh within 3 hours of kickoff, and saved in `data/cache/props/` so it's never paid for twice. Each market costs 1 credit per game. Before pulling, the step divides the credits left by the games still to come this month and takes that many markets per game in priority order (3 to 7), so the free tier's 500 credits a month get used rather than left over. It never spends the last 25 credits and is skipped when `ODDS_API_KEY` isn't set (in the environment, or in a git-ignored `.env` file).

Each line gets the model's chance from the same calibrated distribution as the confident calls, against Hard Rock's chance with the vig removed. Gaps of 5–12 points are listed as value plays. Bigger gaps are listed apart, because in practice they're usually news the model hasn't caught (a back returning from injury, a new role). Players with an injury tag, or who missed their team's last game, are skipped. Finished games are graded and the page shows a running record for both groups. Book lines are much sharper than season averages, so treat this as tracking until the record says otherwise.

### Upcoming-week availability

For games not yet played, the latest depth chart decides the starting QB and adds new signings or traded players (anyone in the top QB1 / RB3 / WR5 / TE3 with NFL game history). The weekly roster marks IR, released and practice-squad players as Out. Until the official injury report comes out on Wednesday, players who were Out or Doubtful the week before are carried forward as Questionable. Run `npm run update` again on Wednesday through Friday so the real report replaces these.

When teammates are Out, the rushing and fantasy-point models also see each player's share re-scaled for the vacated carries and targets (`pipeline/lib/opp.mjs`). The back-test showed backs whose backfield lost 30%+ of its carries were getting about one carry too few; `node pipeline/experiments/opp-exp.mjs` compares the models with and without it.

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
