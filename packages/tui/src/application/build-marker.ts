/**
 * Identifies a build that is NOT the published npm package.
 *
 * WHY THE VERSION STRING IS NOT ENOUGH
 * ------------------------------------
 * The installed `@minimax-ai/code` and a source build of this repository report
 * different numbers for closely related code: the published artifact is
 * versioned by the release pipeline (currently 0.6.12 on npm), while this
 * checkout keeps the version of its own source projection (currently 0.6.5).
 * Reading `v…` therefore cannot tell a developer whether they just launched
 * their own build or the installed package — which is the one thing they most
 * need to know before trusting a behaviour change.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * The local dev launcher exports `MCODE_BUILD_CHANNEL=local`. Only a build
 * started through that launcher can carry the marker, so the badge is a
 * positive claim ("this is a local build") rather than an inference from a
 * number that is ambiguous by design. An installed package never sets the
 * variable and therefore never claims to be a local build.
 *
 * Fail-closed: an unset, empty or unknown value renders nothing, so an
 * unexpected value can never mislabel an official build as a local one.
 */

/** Channel value the local dev launcher exports. */
const LOCAL_BUILD_CHANNEL = 'local';

export function resolveBuildChannel(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const channel = environment['MCODE_BUILD_CHANNEL']?.trim();
  return channel === LOCAL_BUILD_CHANNEL ? LOCAL_BUILD_CHANNEL : undefined;
}

/**
 * Header suffix for a local build, or an empty string for an installed
 * package. Returns an empty string — not `undefined` — so it can be
 * interpolated without a conditional at the call site.
 */
export function buildChannelSuffix(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return resolveBuildChannel(environment) ? ' · local build' : '';
}
