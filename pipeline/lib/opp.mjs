// Expected opportunity after teammates' absences: when players holding a share v of the team's carries (or targets)
// are out, the rest is assumed to be split in proportion to who already had it, so a player's share becomes s / (1 - v).
const rescale = (s, v) => (s == null ? null : Math.min(1, s / Math.max(0.3, 1 - (v || 0))));
export function addOppFeatures(f) {
  f.exp_car_share = rescale(f.p_carry_share, f.vac_car);
  f.exp_tgt_share = rescale(f.p_target_share, f.vac_tgt);
  f.exp_carries = f.exp_car_share != null && f.off_team_car != null ? f.exp_car_share * f.off_team_car : null;
  f.exp_targets = f.exp_tgt_share != null && f.off_team_att != null ? f.exp_tgt_share * f.off_team_att : null;
  return f;
}
export const OPP_FEATS = ['exp_car_share', 'exp_tgt_share', 'exp_carries', 'exp_targets'];
