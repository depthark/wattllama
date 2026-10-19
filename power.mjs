// The NVIDIA power-limit range WattLlama allows. A power limit is a cap, not a voltage
// setting: below the default the card only gets slower. Above the default (some cards allow
// it, e.g. 450 W default / 600 W max) a weak power supply can trip its over-current protection
// and switch the whole PC off, so that needs DASH_POWER_LIMIT_ABOVE_DEFAULT=1.
//
//   floor   60 % of the card's default, rounded up to 5 W, never below the driver's minimum
//   ceiling the card's default; its driver maximum only when allowed above default
// The Linux root helper (platform/power-limit.sh) applies the same rule on its own.

export function powerRange({ min, def, max }, aboveDefault = false) {
  if (min == null || max == null || def == null) return null;
  const floor = Math.max(Math.ceil(min), Math.ceil(def * 0.6 / 5) * 5);
  const ceiling = Math.floor(aboveDefault ? max : Math.min(max, def));
  return floor <= ceiling ? { floor, ceiling } : null;
}
