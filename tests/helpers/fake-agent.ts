// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

/**
 * The first lines of a fake agent written as a shell script, named `name` on every system.
 *
 * The mesh recognises an agent by its process name or the name in its argv[0] (discover.is_agent).
 * Linux names a script's process after the script (comm "agy"). macOS names it after its
 * interpreter (comm "bash", argv[0] "/bin/sh"), so the mesh would see no agent in the session.
 * There the script runs itself again with argv[0] set to `name`, the arguments unchanged, through
 * perl (Debian's /bin/sh has no `exec -a`). The rest of the script follows these lines.
 */
export function fakeAgentPrologue(name: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`not an agent name: ${name}`);
  return `#!/bin/sh
if [ "$(uname -s)" = Darwin ] && [ -z "\${FAKE_AGENT_NAMED:-}" ]; then
  FAKE_AGENT_NAMED=1 exec perl -e 'exec {"/bin/sh"} "${name}", @ARGV' "$0" "$@"
fi
unset FAKE_AGENT_NAMED
`;
}
