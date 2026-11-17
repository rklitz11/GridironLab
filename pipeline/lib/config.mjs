import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RAW = path.join(ROOT, 'data/raw');
export const CACHE = path.join(ROOT, 'data/cache');
export const OUT = path.join(ROOT, 'data/out');

export const FIRST_SEASON = 2016;
// NFL season rolls over in March; before then the "current" season is last year.
const now = new Date();
export const CURRENT_SEASON = now.getMonth() + 1 >= 3 ? now.getFullYear() : now.getFullYear() - 1;
export const SEASONS = Array.from({ length: CURRENT_SEASON - FIRST_SEASON + 1 }, (_, i) => FIRST_SEASON + i);

const REL = 'https://github.com/nflverse/nflverse-data/releases/download';
export const SOURCES = {
  games: () => [`${REL}/schedules/games.csv`, 'games.csv'],
  players: () => [`${REL}/players/players.csv`, 'players.csv'],
  stats: s => [`${REL}/stats_player/stats_player_week_${s}.csv`, `stats_player_week_${s}.csv`],
  pbp: s => [`${REL}/pbp/play_by_play_${s}.csv.gz`, `play_by_play_${s}.csv.gz`],
  snaps: s => [`${REL}/snap_counts/snap_counts_${s}.csv`, `snap_counts_${s}.csv`],
  injuries: s => [`${REL}/injuries/injuries_${s}.csv`, `injuries_${s}.csv`],
  rosterWeekly: s => [`${REL}/weekly_rosters/roster_weekly_${s}.csv`, `roster_weekly_${s}.csv`],
  depthCharts: s => [`${REL}/depth_charts/depth_charts_${s}.csv`, `depth_charts_${s}.csv`],
  ngsRec: () => [`${REL}/nextgen_stats/ngs_receiving.csv.gz`, 'ngs_receiving.csv.gz'],
  ngsRush: () => [`${REL}/nextgen_stats/ngs_rushing.csv.gz`, 'ngs_rushing.csv.gz'],
  ngsPass: () => [`${REL}/nextgen_stats/ngs_passing.csv.gz`, 'ngs_passing.csv.gz'],
  pfrPass: s => [`${REL}/pfr_advstats/advstats_week_pass_${s}.csv`, `advstats_week_pass_${s}.csv`],
  pfrRush: s => [`${REL}/pfr_advstats/advstats_week_rush_${s}.csv`, `advstats_week_rush_${s}.csv`],
  pfrRec: s => [`${REL}/pfr_advstats/advstats_week_rec_${s}.csv`, `advstats_week_rec_${s}.csv`],
};
