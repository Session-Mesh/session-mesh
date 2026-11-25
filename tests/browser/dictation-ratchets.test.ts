// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Node's public tests/**/*.test.ts discovery imports each consumer ratchet once.
import '../../checks/dictation-admission-identity.ts';
import '../../checks/dictation-expired-discard.ts';
import '../../checks/dictation-keyboard-release.ts';
import '../../checks/dictation-mode-framing.ts';
import '../../checks/dictation-native-interleaving.ts';
import '../../checks/dictation-scope-lifetime.ts';
import '../../checks/dictation-terminal-replies.ts';
