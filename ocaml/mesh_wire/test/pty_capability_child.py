# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""Disposable PTY probe child: fixed metadata and markers, never owner data."""
import json
import os
import sys
import time

with open('/dev/tty', 'rb') as tty:
    print(json.dumps({'pid': os.getpid(), 'sid': os.getsid(0),
                      'pgid': os.getpgrp(), 'cwd': os.getcwd(),
                      'tty': os.isatty(0) and os.isatty(1) and os.isatty(2),
                      'controlling_tty': os.isatty(tty.fileno())}), flush=True)
if sys.argv[1] == 'withhold':
    time.sleep(30)
else:
    print('READY', flush=True)
    assert sys.stdin.readline() == 'PING\n'
    print('PONG', flush=True)
    time.sleep(30)
