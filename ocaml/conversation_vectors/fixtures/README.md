# Conversation name reference vectors

These synthetic cases capture the behavior of `conversation_names.py` at
`62177559ff11bfa51641155988b1d35594a5e695` with its original filesystem helper
and an isolated registry file. They cover sanitized snapshots and projections,
stable ordering, exact timestamps past the precision of IEEE-754 doubles,
age filtering, alias ordering and limits, and late observations around
renames and closure. Wide integer fixtures use values near 2^53.

## Replay

1. Load `vectors.json` with a JSON decoder that preserves signed 64-bit
   integers. Adjacent values near 2^53 identify distinct incarnations
   even when a conversion to a floating-point number loses precision.
   The `created` value `1.0` in the nonfinite-number case is intentionally a
   float.
2. Start a fresh temporary directory for each case. Point the reference
   module's `FILE` at a file in that directory. Serialize `registry_rows`
   as a JSON array and write it as UTF-8. For cases with `registry_json`,
   write the string as-is in UTF-8, including any malformed JSON or
   nonstandard number tokens.
3. Execute the steps in order, patching `conversation_names.time.time` to
   return the integer in `at` for each step. Call the named function with
   a fresh copy of `args` and pass `kwargs` through. For `enrich`, append the
   current `snapshot()` as the second positional argument.
4. Compare `expected` with the function result. For `active_aliases`, compare
   the mutated sessions argument. For `observe`, `rename`, `close`, and
   `forget`, compare the subsequent `snapshot()`. For these mutation calls,
   `registry_bytes_changed` compares the file contents before and after.

To validate the outer JSON syntax with Node, run the following from the
repository root.

```sh
node -e 'JSON.parse(require("node:fs").readFileSync("ocaml/conversation_vectors/fixtures/vectors.json", "utf8"))'
```

The OCaml test replays these cases through the private protocol. Run it from
the repository root with `dune runtest --root ocaml conversation_vectors`.
