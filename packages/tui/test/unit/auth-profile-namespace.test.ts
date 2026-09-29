import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAuthNamespace } from '@mavis/oauth-core';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveProfileDataDirPaths } from '@mavis/config';

/**
 * A profile is only useful if it actually separates credentials. The namespace
 * derives both its on-disk path and its keychain-style credential key from the
 * data directory, so isolating the data directory is what keeps two signed-in
 * accounts from overwriting each other's token. These tests pin that link: if
 * the namespace ever stops deriving from the data directory, a `work` profile
 * would silently start reusing the personal token.
 */
describe('auth namespaces are isolated per profile', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function home(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'mcode-profile-namespace-'));
    roots.push(root);
    return root;
  }

  it('stores the credential record in a different file per profile', async () => {
    const root = await home();
    const personal = createAuthNamespace({
      dataDir: resolveProfileDataDirPaths(null, root).dataDir,
      buildEnv: 'prod',
      region: 'cn',
    });
    const work = createAuthNamespace({
      dataDir: resolveProfileDataDirPaths('work', root).dataDir,
      buildEnv: 'prod',
      region: 'cn',
    });

    expect(work.credentialPath).not.toBe(personal.credentialPath);
    expect(work.statePath).not.toBe(personal.statePath);
    expect(work.lockPath).not.toBe(personal.lockPath);
    expect(work.namespaceHome).not.toBe(personal.namespaceHome);
  });

  it('derives a different credential key per profile', async () => {
    const root = await home();
    const personal = createAuthNamespace({
      dataDir: resolveProfileDataDirPaths(null, root).dataDir,
      buildEnv: 'prod',
      region: 'cn',
    });
    const work = createAuthNamespace({
      dataDir: resolveProfileDataDirPaths('work', root).dataDir,
      buildEnv: 'prod',
      region: 'cn',
    });

    // The service name is shared by design; the account is the discriminator
    // that keeps the two tokens apart.
    expect(work.credentialKey.service).toBe(personal.credentialKey.service);
    expect(work.credentialKey.account).not.toBe(personal.credentialKey.account);
  });

  it('keeps profiles apart across regions and build environments', async () => {
    const root = await home();
    const accounts = new Set<string>();
    for (const profile of [null, 'work', 'client']) {
      for (const region of ['cn', 'en'] as const) {
        for (const buildEnv of ['prod', 'test'] as const) {
          const namespace = createAuthNamespace({
            dataDir: resolveProfileDataDirPaths(profile, root).dataDir,
            buildEnv,
            region,
          });
          accounts.add(`${namespace.credentialKey.service}:${namespace.credentialKey.account}`);
        }
      }
    }
    expect(accounts.size).toBe(12);
  });

  it('uses a separate lock per profile so two profiles can refresh concurrently', async () => {
    const root = await home();
    const personal = createAuthNamespace({
      dataDir: resolveProfileDataDirPaths(null, root).dataDir,
      buildEnv: 'prod',
      region: 'cn',
    });
    const work = createAuthNamespace({
      dataDir: resolveProfileDataDirPaths('work', root).dataDir,
      buildEnv: 'prod',
      region: 'cn',
    });
    // A shared lock would serialise the two accounts and could make one wait on
    // the other's token refresh.
    expect(work.lockPath).not.toBe(personal.lockPath);
    expect(work.lockPath.startsWith(work.namespaceHome)).toBe(true);
  });
});
