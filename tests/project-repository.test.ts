// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import fs from 'node:fs/promises';
import childProcess, { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateSnapshot } from '../tools/project-snapshot.ts';
import { parseProjectCatalog } from '../static/project-catalog.ts';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
async function repository(run: (dir: string, git: (args: string[], input?: string) => string, primary: string) => Promise<void>, content: string | Buffer = 'Primary README\n', objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const dir = await fs.mkdtemp(join(tmpdir(), 'project-repository-'));
  const git = (args: string[], input?: string) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: dir, env, input, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', '--quiet', `--object-format=${objectFormat}`]); await fs.writeFile(join(dir, 'README.md'), content); git(['add', '--', 'README.md']);
    const primary = git(['commit-tree', git(['write-tree'])], 'Fixture primary\n');
    git(['update-ref', 'refs/heads/release', primary]); git(['update-ref', 'refs/remotes/origin/release', primary]);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/release']);
    await run(dir, git, primary);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
const config = (path?: string) => ({ kind: 'mesh-project-config', schema_version: 2, features: ['project-metadata/1'],
  machine_id: 'declared', projects: [{ id: 'project', title: 'Project', sessions: [], sources: [],
    repository: { url: 'https://example.test/repository', ...(path ? { local_path: path } : {}) } }] });
async function observe(value: any, enabled = true) {
  const catalog = await generateSnapshot(value, { catalogVersion: 2, inspectRepositories: enabled });
  const observation = (catalog.projects[0]?.repository as any)?.observation;
  assert.ok(observation, 'actual producer must publish explicit repository evidence');
  return { catalog, observation };
}

test('cached non-main primary reference wins over the checked-out topic and private locators do not escape', async () => {
  await repository(async (dir, git, primary) => {
    await fs.writeFile(join(dir, 'README.md'), 'Topic README\n'); git(['add', '--', 'README.md']);
    const topic = git(['commit-tree', git(['write-tree']), '-p', primary], 'Fixture topic\n');
    git(['update-ref', 'refs/heads/topic', topic]); git(['symbolic-ref', 'HEAD', 'refs/heads/topic']);
    const { catalog, observation } = await observe(config(dir));
    assert.equal(observation.status, 'valid'); assert.equal(observation.method, 'local-origin-head');
    assert.equal(observation.ref, 'refs/remotes/origin/release'); assert.equal(observation.commit, primary);
    assert.equal(observation.readme.status, 'valid'); assert.equal(observation.readme.text, 'Primary README\n');
    assert.equal(observation.readme.size, Buffer.byteLength(observation.readme.text));
    assert.ok(!JSON.stringify(catalog).includes(dir));
    const explicit: any = config(dir); explicit.projects[0].repository.primary_ref = 'refs/heads/topic';
    const configured = await observe(explicit); assert.equal(configured.observation.method, 'configured-ref');
    assert.equal(configured.observation.commit, topic); assert.equal(configured.observation.readme.text, 'Topic README\n');
  });
});

test('disabled and absent repository inspection remain explicitly unconfigured', async () => {
  await repository(async dir => {
    const disabled = (await observe(config(dir), false)).observation;
    assert.equal(disabled.status, 'unconfigured'); assert.equal(disabled.reason, 'inspection-disabled'); assert.equal(disabled.commit, null);
    const absent = (await observe(config())).observation;
    assert.equal(absent.status, 'unconfigured'); assert.equal(absent.reason, 'no-local-repository'); assert.equal(absent.readme.text, null);
  });
});

test('missing cached primary reference never falls back to HEAD', async () => {
  await repository(async (dir, git, primary) => {
    git(['symbolic-ref', 'HEAD', 'refs/heads/release']); git(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD']);
    const observation = (await observe(config(dir))).observation;
    assert.equal(observation.status, 'unavailable'); assert.equal(observation.reason, 'ref-unavailable');
    assert.equal(observation.commit, null); assert.notEqual(observation.commit, primary); assert.equal(observation.readme.text, null);
  });
});

test('README preview retains BOM and truncates UTF16 without splitting a surrogate pair', async () => {
  await repository(async dir => {
    const readme = (await observe(config(dir))).observation.readme;
    assert.equal(readme.status, 'valid'); assert.equal(readme.text, '\uFEFFsmall\r\n'); assert.equal(readme.truncated, false);
  }, '\uFEFFsmall\r\n');
  await repository(async dir => {
    const readme = (await observe(config(dir))).observation.readme;
    assert.equal(readme.text, 'a'.repeat(3999)); assert.equal(readme.truncated, true); assert.equal(readme.size, 4003);
  }, 'a'.repeat(3999) + '😀');
});

test('first existing root README is authoritative even when invalid or unsupported', async () => {
  for (const kind of ['invalid-text', 'symlink', 'tree', 'submodule']) await repository(async (dir, git, primary) => {
    await fs.writeFile(join(dir, 'README.txt'), 'Alternative must not hide the first entry\n');
    await fs.unlink(join(dir, 'README.md'));
    if (kind === 'invalid-text') await fs.writeFile(join(dir, 'README.md'), Buffer.from([0xff]));
    if (kind === 'symlink') await fs.symlink('README.txt', join(dir, 'README.md'));
    if (kind === 'tree') { await fs.mkdir(join(dir, 'README.md')); await fs.writeFile(join(dir, 'README.md', 'nested'), 'Nested is not a root README'); }
    git(['add', '-A']);
    if (kind === 'submodule') git(['update-index', '--add', '--cacheinfo', `160000,${primary},README.md`]);
    const next = git(['commit-tree', git(['write-tree']), '-p', primary], 'Fixture root modes\n');
    git(['update-ref', 'refs/remotes/origin/release', next]);
    const readme = (await observe(config(dir))).observation.readme;
    assert.equal(readme.status, 'unavailable'); assert.equal(readme.reason, kind === 'invalid-text' ? 'invalid-text' : 'unsupported-type');
    assert.equal(readme.path, 'README.md'); assert.equal(readme.text, null); assert.equal(readme.truncated, false);
  });
});

test('blob byte limits, invalid controls and actual absence retain distinct outcomes', async () => {
  for (const [content, expected] of [[Buffer.alloc(65537, 97), 'too-large'], [Buffer.from('a\0b'), 'invalid-text'],
    [Buffer.from('a\x7fb'), 'invalid-text'], [Buffer.alloc(0), null]] as const) await repository(async dir => {
    const { catalog, observation } = await observe(config(dir)), readme = observation.readme;
    assert.equal(readme.reason, expected); assert.equal(readme.status, expected === null ? 'valid' : 'unavailable');
    assert.equal(readme.size, content.length); assert.equal(readme.text, expected === null ? '' : null);
    assert.ok(parseProjectCatalog(catalog));
  }, content);
  await repository(async (dir, git, primary) => {
    git(['rm', '--cached', '--', 'README.md']); const empty = git(['commit-tree', git(['write-tree']), '-p', primary], 'Fixture absent\n');
    git(['update-ref', 'refs/remotes/origin/release', empty]);
    const readme = (await observe(config(dir))).observation.readme;
    assert.deepEqual(readme, { status: 'absent', reason: 'not-found', path: null, blob: null, size: null, text: null, truncated: false });
  });
});

test('catalog repository observations enforce closed fields and correlated known facts', async () => {
  await repository(async dir => {
    const { catalog } = await observe(config(dir));
    const mutations = [
      o => { o.token = 'invented'; }, o => { o.assembled_at = 'yesterday'; }, o => { o.commit = null; },
      o => { o.method = null; }, o => { o.reason = 'ref-unavailable'; }, o => { o.readme.blob = 'a'.repeat(64); },
      o => { o.readme.size++; }, o => { o.readme.path = null; }, o => { o.readme.text = 'bad\0text'; },
      o => { o.readme.status = 'unconfigured'; }, o => { o.readme.truncated = true; },
      o => { o.status = 'unavailable'; }, o => { o.readme = { ...o.readme, status: 'unavailable', reason: 'not-found', text: null }; },
    ];
    for (const [i, mutate] of mutations.entries()) {
      const changed: any = structuredClone(catalog); mutate(changed.projects[0].repository.observation);
      assert.ok(parseProjectCatalog(changed) === null, `correlation ${i}`);
    }
  });
});

test('real Git aggregate output and mixed jobs share four owned child slots', async () => {
  await repository(async dir => {
    const spawn = childProcess.spawn.bind(childProcess);
    const provider = join(dir, 'provider');
    await fs.writeFile(provider, `#!/usr/bin/node\nsetTimeout(()=>process.stdout.write('{}'),Number(require('node:path').basename(process.argv[3])));\n`, { mode: 0o700 });
    let active = 0, maximum = 0, calls = 0, providers = 0, overlap = false;
    const injection = mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
      const child = spawn(...args);
      if (args[0] === provider || args[0] === '/usr/bin/git') {
        active++; maximum = Math.max(active, maximum); if (args[0] === provider) providers++;
        child.once('close', () => { active--; if (args[0] === provider) providers--; });
      }
      if (args[0] === '/usr/bin/git') {
        calls++; if (providers) overlap = true;
        const options: any = args[2]; assert.equal(options.shell, false);
        assert.equal(options.env.GIT_NO_LAZY_FETCH, '1'); assert.equal(options.env.GIT_CONFIG_GLOBAL, '/dev/null');
        assert.equal(options.env.GIT_CONFIG_COUNT, '0'); assert.ok((args[1] as string[]).includes('--no-replace-objects'));
      }
      return child;
    }); syncBuiltinESMExports();
    try {
      const value: any = config(dir); value.projects = Array.from({ length: 40 }, (_, i) => ({ ...structuredClone(value.projects[0]), id: `p${i}` }));
      value.projects[0].sources = [100,200,300,400].map((delay,i)=>({id:`source${i}`,kind:'roster',label:'Source',board_path:join(dir,String(delay))}));
      const catalog = await generateSnapshot(value, { catalogVersion: 2, inspectRepositories: true, rosterCLI: provider });
      const states = catalog.projects.map(p => (p.repository as any).observation);
      assert.equal(catalog.projects.length, 40); assert.ok(states.some(o => o.status === 'valid'));
      assert.ok(states.some(o => o.status === 'unavailable' && o.reason === 'budget-exceeded'));
      assert.ok(maximum <= 4); assert.equal(active, 0); assert.ok(overlap, 'actual source and Git children overlapped within one shared limit'); assert.ok(calls <= 40 * 10);
    } finally { injection.mock.restore(); syncBuiltinESMExports(); }
  }, 'x'.repeat(65536));
});

test('Git stdout, stderr and timeout faults terminate and reap their owned children', async () => {
  await repository(async dir => {
    const spawn = childProcess.spawn.bind(childProcess);
    for (const [program, reason] of [["process.stdout.write(Buffer.alloc(65537));setInterval(()=>{},1000)", 'budget-exceeded'],
      ["process.stderr.write(Buffer.alloc(8193));setInterval(()=>{},1000)", 'budget-exceeded'],
      ["setInterval(()=>{},1000)", 'timeout']] as const) {
      const children: ReturnType<typeof childProcess.spawn>[] = [];
      const injection = mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
        if (args[0] !== '/usr/bin/git') return spawn(...args);
        const child = spawn(process.execPath, ['-e', program], args[2]); children.push(child); return child;
      }); syncBuiltinESMExports();
      try {
        const observation = (await observe(config(dir))).observation;
        assert.equal(observation.status, 'unavailable'); assert.equal(observation.reason, reason);
        assert.equal(children.length, 1); assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
      } finally { injection.mock.restore(); syncBuiltinESMExports(); }
    }
  });
});

test('ref movement after resolution cannot change the pinned README commit/blob', async () => {
  await repository(async (dir, git, primary) => {
    await fs.writeFile(join(dir, 'README.md'), 'Replacement ref content\n'); git(['add', 'README.md']);
    const replacement = git(['commit-tree', git(['write-tree']), '-p', primary], 'Fixture replacement\n');
    const spawn = childProcess.spawn.bind(childProcess); let moved = false;
    const injection = mock.method(childProcess, 'spawn', (...args: Parameters<typeof childProcess.spawn>) => {
      if (!moved && args[0] === '/usr/bin/git' && (args[1] as string[]).includes('ls-tree')) {
        git(['update-ref', 'refs/remotes/origin/release', replacement]); moved = true;
      }
      return spawn(...args);
    }); syncBuiltinESMExports();
    try {
      const observation = (await observe(config(dir))).observation;
      assert.equal(moved, true); assert.equal(git(['rev-parse', 'refs/remotes/origin/release']), replacement);
      assert.equal(observation.commit, primary); assert.equal(observation.readme.text, 'Primary README\n');
      assert.equal(observation.readme.blob, git(['rev-parse', `${primary}:README.md`]));
    } finally { injection.mock.restore(); syncBuiltinESMExports(); }
  });
});

test('detached checkout and SHA256 object identities preserve cached default evidence', async () => {
  await repository(async (dir, git, primary) => {
    git(['update-ref', '--no-deref', 'HEAD', primary]);
    const observation = (await observe(config(dir))).observation;
    assert.equal(observation.commit, primary); assert.equal(primary.length, 64); assert.equal(observation.readme.blob.length, 64);
    assert.equal(observation.readme.text, 'SHA256 README\n');
  }, 'SHA256 README\n', 'sha256');
});
