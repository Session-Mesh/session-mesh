The authored JSON in `n4-authored.json` is the `config()` fixture from
`tests/project-metadata.test.ts:11` at isolated commit
`8208c050bbbc8fa5c4226a46e6d1f0660d6978eb`. It contains authored
schema2 metadata only. No snapshot, provider, runtime profile, private transport
or editor implementation was imported. Native tests separately exercise
repository locators and schema1 compatibility.
