// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Hooks declared in Git configuration (`hook.<name>.event` / `hook.<name>.command`). They run next to the
// hooks of `core.hooksPath`, so nothing is written to the hooks directory and `core.hooksPath` is untouched.
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {git} from './gitrepo.ts';
import {ToolError} from './rules.ts';

export const HOOKS = [
  {name: 'session-mesh-leaks-staged', event: 'pre-commit'},
  {name: 'session-mesh-leaks-msg', event: 'commit-msg'},
] as const;

export type Scope = 'worktree' | 'local';
// Hooks declared in configuration and `git hook list` appeared in Git 2.54.0 (its release notes:
// "Hook commands are now allowed to be defined [...] in the configuration files"). An older git
// accepts the `hook.*` keys like any unknown key and never runs them.
export const MIN_GIT = [2, 54] as const;
const CLI = path.join(import.meta.dirname, 'cli.ts');

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function optional(root: string, args: string[]): string | null {
  const run = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  return run.status === 0 ? run.stdout.trim() : null;
}

export function defaultScope(root: string): Scope {
  return optional(root, ['config', '--bool', '--get', 'extensions.worktreeConfig']) === 'true' ? 'worktree' : 'local';
}

// Git appends the hook arguments (e.g. the message file) after this command.
export function hookCommand(event: string, privateRules: string | null): string {
  const parts = [process.execPath, '--experimental-strip-types', CLI, 'hook', event].map(quote);
  if (privateRules) parts.push('--private', quote(path.resolve(privateRules)));
  return parts.join(' ');
}

export function gitVersion(root: string): {text: string; supported: boolean} {
  const text = (optional(root, ['version']) ?? '').replace(/^git version /, '') || 'unknown';
  const match = /^(\d+)\.(\d+)/.exec(text);
  const [major, minor] = match ? [Number(match[1]), Number(match[2])] : [0, 0];
  return {text, supported: major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1])};
}

function tooOld(version: string): string {
  return `git ${version} is too old for the leak-guard hooks: they are declared in Git configuration, which needs Git ${MIN_GIT.join('.')} or later. `
    + 'This git would ignore them without a word, so commits here are NOT checked locally. '
    + 'Upgrade git, or run the check by hand before pushing (cli.ts staged, cli.ts commits <A..B>); the CI leak check runs in any case.';
}

function listed(root: string, event: string, name: string): boolean {
  const list = optional(root, ['hook', 'list', event]) ?? '';
  return list.split('\n').map(line => line.trim()).includes(name);
}

export function install(root: string, scope: Scope, privateRules: string | null, log: (line: string) => void): void {
  const version = gitVersion(root);
  if (!version.supported) throw new ToolError(`${tooOld(version.text)} Nothing was written.`);
  const hooksPath = optional(root, ['config', '--get', 'core.hooksPath']);
  for (const hook of HOOKS) {
    const command = hookCommand(hook.event, privateRules);
    git(root, ['config', `--${scope}`, `hook.${hook.name}.event`, hook.event]);
    git(root, ['config', `--${scope}`, `hook.${hook.name}.command`, command]);
    log(`wrote (${scope}) hook.${hook.name}.event = ${hook.event}`);
    log(`wrote (${scope}) hook.${hook.name}.command = ${command}`);
  }
  if (!privateRules) log('warning: no private list given; the hooks apply generic rules only');
  if (optional(root, ['config', '--get', 'core.hooksPath']) !== hooksPath) throw new ToolError('core.hooksPath changed during install');
  log(`core.hooksPath unchanged: ${hooksPath ?? '(unset)'}`);
  for (const hook of HOOKS) {
    if (!listed(root, hook.event, hook.name)) throw new ToolError(`git hook list ${hook.event} does not show ${hook.name}`);
  }
  log('verified with git hook list: both hooks are registered');
}

// Prints every key and whether git lists the hook; returns true when both hooks are active.
export function status(root: string, log: (line: string) => void): boolean {
  log(`core.hooksPath: ${optional(root, ['config', '--get', 'core.hooksPath']) ?? '(unset)'}`);
  const version = gitVersion(root);
  if (!version.supported) {
    log(`leak-guard hooks: NOT active (${tooOld(version.text)})`);
    return false;
  }
  let active = true;
  for (const hook of HOOKS) {
    const command = optional(root, ['config', '--show-origin', '--get', `hook.${hook.name}.command`]);
    const registered = listed(root, hook.event, hook.name);
    active &&= command !== null && registered;
    log(`${hook.name} (${hook.event}): ${registered ? 'registered' : 'NOT registered'}`);
    log(`  command: ${command ?? '(none)'}`);
  }
  log(active ? 'leak-guard hooks: active' : 'leak-guard hooks: NOT active (run: hooks install)');
  return active;
}

export function uninstall(root: string, scope: Scope, log: (line: string) => void): void {
  for (const hook of HOOKS) {
    const removed = spawnSync('git', ['config', `--${scope}`, '--remove-section', `hook.${hook.name}`], {cwd: root}).status === 0;
    log(removed ? `removed (${scope}) hook.${hook.name}` : `not installed (${scope}): hook.${hook.name}`);
  }
}
