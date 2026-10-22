import { describe, expect, it } from 'vitest';

import { buildChannelSuffix, resolveBuildChannel } from '../../src/application/build-marker.js';

function env(value: string | undefined): NodeJS.ProcessEnv {
  return value === undefined ? {} : { MCODE_BUILD_CHANNEL: value };
}

describe('build marker', () => {
  // The whole point of this module: a developer must be able to tell their own
  // build from the installed package. The version string cannot do that job,
  // so the badge is driven by an explicit opt-in instead.
  it('claims a local build only for the exact local channel', () => {
    expect(resolveBuildChannel(env('local'))).toBe('local');
    expect(buildChannelSuffix(env('local'))).toBe(' · local build');
  });

  it('stays silent for an installed package', () => {
    expect(buildChannelSuffix(env(undefined))).toBe('');
    expect(buildChannelSuffix(env(''))).toBe('');
  });

  it('never mislabels an official build from an unexpected value', () => {
    // Fail-closed: anything that is not the known local channel renders
    // nothing, so a typo or a future channel name cannot put a "local build"
    // badge on a published artifact.
    for (const value of ['npm', 'release', 'LOCAL', 'loc al', 'local-dev', 'locall']) {
      expect(buildChannelSuffix(env(value))).toBe('');
    }
  });

  it('trims surrounding whitespace from the channel value', () => {
    expect(buildChannelSuffix(env('  local  '))).toBe(' · local build');
  });
});
