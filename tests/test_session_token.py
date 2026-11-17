# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Atacama <contact@atacama.tech>

"""The stateless session token `ms1.<name>.<nonce>.<mac>` (sessiontoken.py)."""

import hashlib
import hmac

import pytest

import server
import sessiontoken

NONCE = "0123456789abcdef0123456789abcdef"
OTHER_NONCE = "fedcba9876543210fedcba9876543210"


def live(name, nonce):
    return [{"name": name, "meta": {"agent": None, "nonce": nonce}}]


def forge(key, name, nonce):
    """A syntactically perfect token whose MAC was computed with ``key``."""
    mac = hmac.new(key, b"\0".join((b"ms1", name.encode(), nonce.encode())), hashlib.sha256)
    return f"ms1.{name}.{nonce}.{mac.hexdigest()}"


def test_a_well_formed_token_signed_under_the_old_ds1_domain_is_refused():
    """The ds1 prefix is gone: even a token whose MAC is valid under the old domain is refused."""
    mac = hmac.new(sessiontoken.KEY, b"\0".join((b"ds1", b"work", NONCE.encode())), hashlib.sha256)
    legacy = f"ds1.work.{NONCE}.{mac.hexdigest()}"
    assert sessiontoken.signed(legacy) is None
    assert sessiontoken.verify(legacy, live("work", NONCE)) is None
    assert sessiontoken.signed(f"ms1.work.{NONCE}.{mac.hexdigest()}") is None   # nor under the new prefix


def test_issue_has_the_documented_shape():
    token = sessiontoken.issue("work", NONCE)
    prefix, name, nonce, mac = token.split(".")
    assert (prefix, name, nonce) == ("ms1", "work", NONCE)
    assert len(mac) == 64 and int(mac, 16) >= 0


def test_a_fresh_nonce_is_128_random_bits_in_hex():
    first, second = sessiontoken.new_nonce(), sessiontoken.new_nonce()
    assert first != second
    assert len(first) == 32 and int(first, 16) >= 0


def test_round_trip():
    token = sessiontoken.issue("work-2", NONCE)
    assert sessiontoken.signed(token) == ("work-2", NONCE)
    assert sessiontoken.verify(token, live("work-2", NONCE)) == "work-2"


def test_the_key_is_derived_not_the_master_token():
    token = sessiontoken.issue("work", NONCE)
    assert token != forge(server.TOKEN.encode(), "work", NONCE)
    assert sessiontoken.signed(forge(server.TOKEN.encode(), "work", NONCE)) is None


@pytest.mark.parametrize("token", [
    "", "ms1", "ms1.work", "ms1.work." + NONCE, "x", "....",
    "ds2.work." + NONCE + "." + "0" * 64,                      # other version
    "ms1.wo.rk." + NONCE + "." + "0" * 64,                     # a dot in the name: five fields
    "ms1.." + NONCE + "." + "0" * 64,                          # empty name
    "ms1.wo rk." + NONCE + "." + "0" * 64,                     # bad charset
    "ms1." + "a" * 49 + "." + NONCE + "." + "0" * 64,          # name too long
    "ms1.work." + NONCE[:-1] + "." + "0" * 64,                 # short nonce
    "ms1.work." + NONCE + "0." + "0" * 64,                     # long nonce
    "ms1.work." + NONCE.upper() + "." + "0" * 64,              # not lowercase hex
    "ms1.work." + NONCE + "." + "0" * 63,                      # short mac
    "ms1.work." + NONCE + "." + "g" * 64,                      # not hex
    "ms1.wörk." + NONCE + "." + "0" * 64,                      # non-ascii
    "ms1.work." + NONCE + "." + "0" * 64 + "\n",               # trailing newline
])
def test_malformed_tokens_do_not_parse(token):
    assert sessiontoken.signed(token) is None


def test_a_flipped_mac_is_rejected():
    token = sessiontoken.issue("work", NONCE)
    last = "1" if token[-1] == "0" else "0"
    assert sessiontoken.signed(token[:-1] + last) is None


def test_a_mac_does_not_transfer_to_another_name_or_nonce():
    _, _, _, mac = sessiontoken.issue("work", NONCE).split(".")
    assert sessiontoken.signed(f"ms1.other.{NONCE}.{mac}") is None
    assert sessiontoken.signed(f"ms1.work.{OTHER_NONCE}.{mac}") is None


def test_a_token_signed_under_another_master_token_is_rejected():
    other = sessiontoken.derive_key("another master token")
    assert other != sessiontoken.KEY
    assert sessiontoken.signed(forge(other, "work", NONCE)) is None


def test_the_unconfigured_module_fails_closed(monkeypatch):
    monkeypatch.setattr(sessiontoken, "KEY", b"")
    with pytest.raises(RuntimeError):
        sessiontoken.issue("work", NONCE)
    assert sessiontoken.signed("ms1.work." + NONCE + "." + "0" * 64) is None


def test_a_vanished_session_is_refused():
    token = sessiontoken.issue("work", NONCE)
    assert sessiontoken.verify(token, []) is None
    assert sessiontoken.verify(token, live("elsewhere", NONCE)) is None


def test_a_reused_name_with_a_new_nonce_is_refused():
    old = sessiontoken.issue("work", NONCE)
    assert sessiontoken.verify(old, live("work", OTHER_NONCE)) is None
    assert sessiontoken.verify(sessiontoken.issue("work", OTHER_NONCE),
                               live("work", OTHER_NONCE)) == "work"


@pytest.mark.parametrize("meta", [None, {}, {"agent": "claude"}, {"nonce": None}, {"nonce": 5},
                                  {"nonce": ["x"]}, {"nonce": "é"}, "nonce", []])
def test_a_session_without_a_usable_nonce_never_matches(meta):
    token = sessiontoken.issue("work", NONCE)
    assert sessiontoken.verify(token, [{"name": "work", "meta": meta}]) is None


def test_malformed_session_records_do_not_break_verification():
    token = sessiontoken.issue("work", NONCE)
    sessions = [None, 5, {}, {"name": 3}, {"name": "work", "meta": {"nonce": NONCE}}]
    assert sessiontoken.verify(token, sessions) == "work"


def test_comparisons_are_constant_time(monkeypatch):
    calls = []
    real = hmac.compare_digest

    def spy(a, b):
        calls.append(1)
        return real(a, b)

    monkeypatch.setattr(sessiontoken.hmac, "compare_digest", spy)
    token = sessiontoken.issue("work", NONCE)
    assert sessiontoken.verify(token, live("work", NONCE)) == "work"
    assert len(calls) >= 2          # the MAC and the nonce
