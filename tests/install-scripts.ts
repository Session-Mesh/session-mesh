// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// The files of the installer that a test checkout needs besides install.sh (which sources them
// from its own directory) and systemd/: one list for every installer test.
import fs from 'node:fs';
import path from 'node:path';

export const INSTALL_SCRIPTS = ['install-checkout.sh', 'install-common.sh', 'install-release.sh', 'install-linux.sh', 'install-linux-units.sh',
  'install-macos.sh', 'install-macos-launchd.sh', 'install-macos-release.sh'];

export function copyInstallerScripts(source: string, checkout: string, skip: string[] = []): void {
  fs.mkdirSync(path.join(checkout, 'scripts'), {recursive: true});
  for (const file of INSTALL_SCRIPTS) {
    if (!skip.includes(file)) fs.copyFileSync(path.join(source, 'scripts', file), path.join(checkout, 'scripts', file));
  }
}
