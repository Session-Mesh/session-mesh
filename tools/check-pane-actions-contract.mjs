// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Pane-actions source contract only. No application/module evaluation or build.
// Geometry, runtime header updates and generated-bundle checks remain separate.
import assert, { AssertionError } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

try {
  const [html, server, modVectors, i18nRuntime, english] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../server.py", import.meta.url), "utf8"),
    readFile(new URL("../ocaml/mesh_wire/test/mod-descriptor-v1-vectors.json", import.meta.url), "utf8"),
    readFile(new URL("../static/i18n.js", import.meta.url), "utf8"),
    readFile(new URL("../static/i18n/en.json", import.meta.url), "utf8"),
  ]);
  const templates = [...html.matchAll(/<template\b[^>]*\bid=["']pane-tpl["'][^>]*>([\s\S]*?)<\/template>/g)];
  if (templates.length !== 1) throw new Error("setup: expected exactly one existing pane-tpl source seam");
  const buttons = [...templates[0][1].matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  const action = (name) => {
    const matches = buttons.filter((button) => new RegExp(`\\bdata-act=["']${name}["']`).test(button[1]));
    assert.equal(matches.length, 1, `pane template must retain one ${name} button`);
    const button = matches[0];
    const visible = button[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    // Inspect explicit ARIA naming when present, otherwise native text naming.
    // A title-only tooltip cannot satisfy the visible-name requirement.
    const aria = button[1].match(/\baria-label=["']([^"']*)["']/)?.[1];
    return { visible, accessible: aria ?? visible };
  };
  const compose = action("compose");
  const board = action("board");
  assert.match(compose.visible, /[A-Za-zÀ-ÿ]{2}/u,
    `Compose needs a visible word; source has ${JSON.stringify(compose.visible)}`);
  assert.match(board.visible, /[A-Za-zÀ-ÿ]{2}/u,
    `Whiteboard needs a visible word; source has ${JSON.stringify(board.visible)}`);
  assert.notEqual(compose.visible.toLocaleLowerCase("fr"), board.visible.toLocaleLowerCase("fr"),
    "Compose and Whiteboard must have distinct visible names");
  assert.match(compose.accessible, /[A-Za-zÀ-ÿ]{2}/u, "Compose needs an accessible word name");
  assert.match(board.accessible, /[A-Za-zÀ-ÿ]{2}/u, "Whiteboard needs an accessible word name");
  assert.notEqual(compose.accessible.toLocaleLowerCase("fr"), board.accessible.toLocaleLowerCase("fr"),
    "Compose and Whiteboard must have distinct accessible names");
  // The template's inline text is the English fallback (data-i18n names the keys).
  assert.equal(compose.visible, "Mailbox", "the envelope button must be named for the mailbox");
  assert.equal(board.visible, "Whiteboard", "Whiteboard visible name must identify the board");
  assert.equal(compose.accessible, "Open the mailbox of this session", "the envelope accessible name must identify the session mailbox");
  assert.equal(board.accessible, "Open the whiteboard alongside", "Whiteboard accessible name must identify opening the board");

  // Missing future wiring is an assertion, never a failed import of new code.
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]);
  const paneIndex = scripts.indexOf("/static/pane-actions.js");
  const appIndex = scripts.indexOf("/static/app.js");
  assert.ok(paneIndex >= 0 && appIndex > paneIndex,
    "pane-actions generated asset must load before app.js");
  const clientFiles = server.match(/^CLIENT_FILES\s*=\s*\(([^\n]*)\)/m)?.[1];
  if (clientFiles === undefined) throw new Error("setup: existing CLIENT_FILES source seam not found");
  assert.match(clientFiles, /["']pane-actions\.js["']/,
    "pane-actions generated asset must participate in client-version hashing");
  const indexBody = server.match(/^async def index\(request\):\n([\s\S]*?)(?=^#|^async def |^def )/m)?.[1];
  if (indexBody === undefined) throw new Error("setup: existing index asset-stamping source seam not found");
  assert.match(indexBody, /for name in \([^\n]*["']pane-actions\.js["']/,
    "pane-actions generated asset must receive existing index cache stamping");
  const context = { URL };
  runInNewContext(await readFile(new URL("../static/pane-actions.js", import.meta.url), "utf8"), context);
  // The texts are checked in English, through the app's English catalog. No
  // `document` in this sandbox: i18n.js only exposes its pure core.
  const i18nSandbox = {};
  runInNewContext(i18nRuntime, i18nSandbox);
  const englishCatalog = JSON.parse(english);
  context.MeshPaneActions.setTranslator(i18nSandbox.MeshI18n.core.createTranslator({
    lang: "en", catalog: englishCatalog, fallback: englishCatalog,
    onMissing: (key) => { throw new Error(`setup: no English text for ${key}`); } }));
  const facts = context.MeshPaneActions.portfolioProvenance;
  const actionCatalog = context.MeshPaneActions.actionCatalog;
  const actionDefinition = context.MeshPaneActions.actionDefinition;
  const actionMessageKey = context.MeshPaneActions.actionMessageKey;
  const capabilityCatalog = context.MeshPaneActions.capabilityCatalog;
  const capabilityDefinition = context.MeshPaneActions.capabilityDefinition;
  const validateCapabilityRequest = context.MeshPaneActions.validateCapabilityRequest;
  const availableActions = context.MeshPaneActions.availableActions;
  const createHumanInputLease = context.MeshPaneActions.createHumanInputLease;
  assert.equal(typeof actionCatalog, "function", "Mesh actions need a declared catalog");
  assert.equal(typeof actionDefinition, "function", "action lookup must reject unknown input");
  assert.equal(typeof actionMessageKey, "function", "message-key lookup must reject unknown input");
  assert.equal(typeof capabilityCatalog, "function", "capability catalog must be code-owned");
  assert.equal(typeof capabilityDefinition, "function", "capability lookup must reject unknown input");
  assert.equal(typeof validateCapabilityRequest, "function", "capability declaration must be strictly validated");
  assert.equal(typeof availableActions, "function", "menus must be projected from the action catalog");
  assert.equal(typeof createHumanInputLease, "function", "agent wake: human input needs a typed lease arbiter");
  const wire = [];
  let failData = false;
  const lease = createHumanInputLease({ clientId: "browser_client_0001",
    control: (id, dirty) => wire.push(["H", id, dirty]),
    data: (bytes) => { wire.push(["D", [...bytes]]); if (failData) throw new Error("closed"); } });
  assert.equal(lease.write(Uint8Array.of(97)), true);
  assert.equal(lease.write(Uint8Array.of(98)), true);
  assert.equal(lease.write(Uint8Array.of(13), true), true);
  assert.deepEqual(wire, [["H", "browser_client_0001", true], ["D", [97]], ["D", [98]],
    ["D", [13]], ["H", "browser_client_0001", false]], "agent wake: H precedes bytes and release follows submit");
  lease.atomic(Uint8Array.of(27, 91));
  assert.deepEqual(wire.slice(-3), [["H", "browser_client_0001", true], ["D", [27, 91]],
    ["H", "browser_client_0001", false]], "agent wake: binary transaction is enclosed whole");
  failData = true;
  assert.equal(lease.write(Uint8Array.of(120)), false);
  assert.equal(lease.dirty, true, "agent wake: uncertain transport remains dirty");
  failData = false;
  lease.reconnect();
  assert.deepEqual(wire.at(-1), ["H", "browser_client_0001", true], "agent wake: reconnect restores fail-closed state");
  const advisoryWire = [];
  let failControl = true;
  const advisory = createHumanInputLease({ clientId: "browser_client_0002",
    control: (id, dirty) => {
      advisoryWire.push(["H", id, dirty]);
      if (failControl) throw new Error("optional control unavailable");
    },
    data: (bytes) => advisoryWire.push(["D", [...bytes]]),
  });
  assert.equal(advisory.atomic(Uint8Array.of(99)), true,
    "input: unavailable advisory H must not suppress the baseline D frame");
  assert.deepEqual(advisoryWire, [
    ["H", "browser_client_0002", true], ["D", [99]],
  ], "input: D is still attempted after advisory acquisition fails");
  assert.equal(advisory.dirty, false, "input: a lease never acquired is not invented locally");
  assert.doesNotThrow(() => advisory.reconnect(),
    "input: optional reconnect control cannot abort websocket initialization");
  failControl = false;
  assert.equal(advisory.write(Uint8Array.of(100)), true);
  failControl = true;
  assert.equal(advisory.atomic(Uint8Array.of(13)), true,
    "input: release failure does not change the delivered D result");
  assert.equal(advisory.dirty, true, "input: a failed release preserves dirty state for reconnect");
  const actions = actionCatalog();
  assert.ok(Object.isFrozen(actions), "action catalog is immutable");
  assert.equal(new Set(actions.map((action) => action.id)).size, actions.length, "duplicate action identifiers are rejected");
  assert.equal(new Set(actions.map((action) => action.messageKey)).size, actions.length, "stable action message keys are unique");
  for (const action of actions) {
    assert.ok(Object.isFrozen(action), "action definitions are immutable");
    assert.equal(actionDefinition(action.id), action, "catalog lookup preserves the code-owned definition");
  }
  assert.equal(actionDefinition("extension.arbitrary"), null, "unknown action identifiers are refused");
  assert.equal(actionDefinition({ id: "stop" }), null, "structured input cannot masquerade as an action");
  assert.equal(actionMessageKey("extension.arbitrary"), null, "unknown action message keys are refused");
  assert.equal(actionMessageKey({ key: "action.stop" }), null, "structured input cannot masquerade as a message key");
  const capabilities = capabilityCatalog();
  assert.ok(Object.isFrozen(capabilities), "capability catalog is immutable");
  assert.equal(new Set(capabilities.map((capability) => capability.id)).size, capabilities.length, "duplicate capability identifiers are rejected");
  for (const capability of capabilities) {
    assert.ok(Object.isFrozen(capability), "capability definitions are immutable");
    assert.equal(capabilityDefinition(capability.id), capability, "lookup preserves the code-owned definition");
    assert.equal(capability.state, "reserved", "no capability is granted by declaration alone");
  }
  assert.equal(capabilityDefinition("extension.arbitrary"), null, "unknown capability identifiers are refused");
  assert.equal(validateCapabilityRequest({ v: 1, surface: "mod", capabilities: [] }).accepted, true,
    "an empty declaration changes no privilege");
  assert.equal(validateCapabilityRequest({ v: 1, surface: "mod", capabilities: ["extension.arbitrary"] }).reason, "unknown");
  assert.equal(validateCapabilityRequest({ v: 1, surface: "mod", capabilities: ["portfolio.read", "portfolio.read"] }).reason, "duplicate");
  assert.equal(validateCapabilityRequest({ v: 1, surface: "demo", capabilities: ["portfolio.read"] }).reason, "wrong-surface");
  assert.equal(validateCapabilityRequest({ v: 1, surface: "mod", capabilities: ["portfolio.read"] }).reason, "reserved");
  assert.equal(validateCapabilityRequest({ v: 1, surface: "mod", capabilities: [], extra: true }).reason, "malformed");
  const meshActions = availableActions({ kind: "mesh", multiple: true, rawCodex: true, fileWeb: false, watching: false });
  assert.ok(meshActions.every((action) => actionDefinition(action.id) !== null), "menus contain only declared actions");
  const watched = availableActions({ kind: "web", multiple: false, rawCodex: false, fileWeb: true, watching: true });
  assert.equal(JSON.stringify(watched.map((action) => action.messageKey)),
    JSON.stringify(["action.reload", "action.open-external", "action.watch-stop"]));
  assert.equal(typeof facts, "function", "received worktree provenance needs typed projection");
  assert.equal(facts(undefined).state, "not-collected");
  assert.equal(facts({ state: "not-collected" }).state, "not-collected");
  assert.equal(facts({ state: "unexpected" }).state, "malformed");
  assert.equal(facts({ state: "unavailable" }).state, "unavailable");
  assert.equal(facts({ state: "observed", directories: [] }).state, "observed");
  assert.equal(facts({ state: "observed", directories: {} }).state, "malformed");
  const projected = facts({ state: "observed", source: "<img>", observed_at: 1,
    directories: [{ cwd: "/hostile/<script>", state: "observed", source: "git-observer", observed_at: 1,
      worktrees: [{ path: "/<img>", head: null, branch: "<script>", detached: false, bare: true }] },
      { cwd: "/unavailable", state: "unavailable" }] });
  assert.equal(projected.rows.length, 2);
  assert.equal(projected.rows[0].facts[0].branch, "<script>");
  assert.equal(projected.rows[0].facts[0].head, "unknown");
  assert.equal(projected.rows[1].state, "unavailable");
  assert.equal(facts({ state: "observed", observed_at: NaN, directories: [] }).observedAt, "unknown");
  assert.equal(facts({ state: "observed", observed_at: 1e100, directories: [] }).observedAt, "unknown");
  assert.equal(facts({ state: "observed", source: 12, directories: [] }).source, "unknown");
  assert.equal(facts({ state: "observed", directories: [{ cwd: "/bad", state: "observed", worktrees: [{ path: "/bad", head: null, branch: null, detached: "false", bare: false }] }] }).rows[0].state, "malformed");
  const classify = context.MeshPaneActions.contextualDiffLineKind;
  assert.equal(typeof classify, "function", "contextual diff needs typed safe line classification");
  assert.equal(classify("+++ b/<img>.txt"), "file-header");
  assert.equal(classify("--- a/file.txt"), "file-header");
  assert.equal(classify("+<script>danger</script>"), "added");
  assert.equal(classify("-removed"), "deleted");
  assert.equal(classify("@@ -1 +1 @@"), "hunk-header");
  assert.equal(classify(" context"), "context");
  const lifetime = context.MeshPaneActions.createContextualDiffLifetime;
  assert.equal(typeof lifetime, "function", "pending diff requires pane-owned request lifetime");
  const owner = lifetime();
  const first = owner.begin();
  assert.equal(owner.current(first), true);
  const second = owner.begin();
  assert.equal(owner.current(first), false, "refresh invalidates previous completion");
  assert.equal(owner.current(second), true);
  owner.dispose();
  assert.equal(owner.current(second), false, "closed pane cannot receive late diff");
  assert.equal(owner.begin(), null, "disposed owner cannot resurrect");
  const identity = context.MeshPaneActions.identityPresentation;
  assert.equal(typeof identity, "function", "actual generated domain must project panel identity");
  const snapshot = { kind: "document", title: "<script>title</script>", origin: "local",
    externalOrigin: null, sessionLabel: null, readOnly: false, load: "frame-loaded" };
  const document = identity(snapshot);
  assert.equal(document.title, snapshot.title, "presentation returns text, never author HTML");
  assert.equal(document.session, "Linked session: unknown", "document must not inherit active session");
  assert.equal(document.rights, "Rights: not exposed", "loaded frame grants no write/read authority");
  assert.equal(document.state, "Container loaded · response not verified", "iframe load is not HTTP success");
  assert.equal(identity({ ...snapshot, kind: "board", sessionLabel: "session-b" }).session, "Linked session: session-b");
  assert.equal(identity({ ...snapshot, kind: "diff", readOnly: true }).rights, "Read only");
  assert.equal(identity({ ...snapshot, kind: "board", readOnly: true }).rights, "Rights: not exposed");
  assert.equal(identity({ ...snapshot, origin: "external", externalOrigin: "https://example.test/path?token=secret#cap" }).origin, "Origin: https://example.test");
  assert.equal(identity({ ...snapshot, origin: "external", externalOrigin: "not-a-url" }).origin, "Origin: unknown");
  assert.equal(identity({ ...snapshot, load: "unavailable" }).state, "Target unavailable");
  const modDescriptor = context.MeshPaneActions.modDescriptorV1;
  const sameModCodeRevision = context.MeshPaneActions.sameModCodeRevision;
  assert.equal(typeof modDescriptor, "function", "client must project the closed v1 mod identity");
  assert.equal(typeof sameModCodeRevision, "function", "revision identity must be explicit");
  const vectors = JSON.parse(modVectors);
  const canonicalMod = modDescriptor(JSON.parse(vectors.canonical));
  assert.ok(canonicalMod, "canonical OCaml vector must project in the client");
  assert.equal(canonicalMod.modId, "roadmap-card");
  assert.equal(canonicalMod.codeDigest, "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  assert.deepEqual([...canonicalMod.capabilities], [], "descriptor grants no capability");
  assert.equal(Object.isFrozen(canonicalMod), true);
  assert.equal(Object.isFrozen(canonicalMod.capabilities), true);
  for (const invalid of vectors.invalid) {
    // Duplicate raw JSON members are rejected by the canonical OCaml decoder.
    // JSON.parse necessarily loses that byte-level evidence, so this client
    // projection instead refuses every decoded negative form it can observe.
    if (invalid.name === "duplicate-field") continue;
    assert.equal(modDescriptor(JSON.parse(invalid.bytes)), null, `rejects ${invalid.name}`);
  }
  assert.equal(modDescriptor({ v: 1, kind: "mod", mod_id: "roadmap-card", code_digest: canonicalMod.codeDigest,
    capabilities: [], loader: "no" }), null, "no loader field is admitted");
  assert.equal(modDescriptor({ v: 1, kind: "mod", mod_id: "roadmap-card", code_digest: canonicalMod.codeDigest,
    capabilities: ["portfolio.read"] }), null, "reserved capability remains unavailable");
  const changed = modDescriptor({ v: 1, kind: "mod", mod_id: "roadmap-card",
    code_digest: `1${canonicalMod.codeDigest.slice(1)}`, capabilities: [] });
  assert.ok(changed);
  assert.equal(sameModCodeRevision(canonicalMod, canonicalMod), true);
  assert.equal(sameModCodeRevision(canonicalMod, changed), false);
  const createSessionRequestGate = context.MeshPaneActions.createSessionRequestGate;
  assert.equal(typeof createSessionRequestGate, "function", "session actions require a typed owner gate");
  const decisions = [];
  const sessionGate = createSessionRequestGate({
    notify: () => {},
    confirm: (message) => { assert.match(message, /resume its conversation with model “gpt-6\.1-sol”/); return true; },
    claim: async (id) => ({ kind: "claimed", claimNonce: `${id}-claim` }),
    decide: async (id, approve, claimNonce) => {
      decisions.push([id, approve, claimNonce]); return "settled";
    },
  });
  const request = { id: "request-1", action: "restart", state: "pending", preset: "codex",
    model: "gpt-6.1-sol", source: { id: "alpha" } };
  await sessionGate.consider([request, request]);
  await sessionGate.consider([request]);
  assert.deepEqual(decisions, [["request-1", true, "request-1-claim"]],
    "one request produces one owner decision under its claim");
  let attempts = 0;
  let retryPrompts = 0;
  const seenClaimSecrets = [];
  const retryingGate = createSessionRequestGate({ confirm: () => { retryPrompts += 1; return false; },
    notify: () => {},
    claim: async (_id, nonce) => { seenClaimSecrets.push(nonce); return { kind: "claimed", claimNonce: "retry-claim" }; },
    decide: async () => ++attempts === 1 ? "retry" : "settled" });
  await retryingGate.consider([request]);
  await retryingGate.consider([request]);
  assert.equal(attempts, 2, "transport failure permits exactly a later retry");
  assert.equal(retryPrompts, 1, "a lost decision response never opens a second prompt");
  assert.deepEqual(seenClaimSecrets, [undefined, "retry-claim"], "retry proves possession of the claim secret");
  let revisionPrompts = 0;
  const revisions = [];
  const revisionGate = createSessionRequestGate({ confirm: () => { revisionPrompts += 1; return true; }, notify: () => {},
    claim: async () => ({ kind: "claimed", claimNonce: "claim" }),
    decide: async (_id, _approved, _claim, revision) => { revisions.push(revision); return revisions.length < 3 ? "retry" : "settled"; } });
  const createRequest = { ...request, action: "create", options: "--search", options_revision: "one" };
  await revisionGate.consider([createRequest]);
  await revisionGate.consider([createRequest]);
  await revisionGate.consider([{ ...createRequest, options_revision: "two" }]);
  assert.deepEqual(revisions, ["one", "one", "two"]);
  assert.equal(revisionPrompts, 2, "same revision retries silently; a changed revision is confirmed again");
  let claimOwner = null;
  let prompts = 0;
  const competingGate = () => createSessionRequestGate({
    notify: () => {},
    claim: async () => {
      if (claimOwner !== null) return { kind: "busy", leaseExpiresAt: 2 };
      claimOwner = "won";
      return { kind: "claimed", claimNonce: "only-claim" };
    },
    confirm: () => { prompts += 1; return true; },
    decide: async () => "settled",
  });
  await Promise.all([competingGate().consider([request]), competingGate().consider([request])]);
  assert.equal(prompts, 1, "two pages race atomically before either opens an owner dialog");

  let leaseNow = 1_000;
  let loserClaims = 0;
  let loserPrompts = 0;
  const loserGate = createSessionRequestGate({
    now: () => leaseNow, jitterMs: () => 0, notify: () => {},
    claim: async () => ++loserClaims === 1
      ? { kind: "busy", leaseExpiresAt: 2 }
      : { kind: "claimed", claimNonce: "reclaimed-after-expiry" },
    confirm: () => { loserPrompts += 1; return true; },
    decide: async () => "settled",
  });
  await loserGate.consider([request]);
  await loserGate.consider([{ ...request, state: "claimed", lease_expires_at: 2 }]);
  assert.equal(loserClaims, 1, "busy lease suppresses polling and prompt spam");
  leaseNow = 2_001;
  await loserGate.consider([{ ...request, state: "claimed", lease_expires_at: 2 }]);
  assert.equal(loserClaims, 2, "loser retries after the vanished winner's lease expires");
  assert.equal(loserPrompts, 1, "reclaimed request opens exactly one prompt");

  leaseNow = 1_000;
  let lostReplyClaims = 0;
  let lostReplyPrompts = 0;
  const lostReplyGate = createSessionRequestGate({
    now: () => leaseNow, jitterMs: () => 0, notify: () => {},
    claim: async () => ++lostReplyClaims === 1 ? "retry"
      : { kind: "claimed", claimNonce: "replacement-secret" },
    confirm: () => { lostReplyPrompts += 1; return false; },
    decide: async () => "settled",
  });
  await lostReplyGate.consider([request]);
  await lostReplyGate.consider([{ ...request, state: "claimed", lease_expires_at: 2 }]);
  assert.equal(lostReplyClaims, 1, "lost claim reply waits for its unknowable secret to expire");
  leaseNow = 2_001;
  await lostReplyGate.consider([{ ...request, state: "claimed", lease_expires_at: 2 }]);
  assert.equal(lostReplyClaims, 2);
  assert.equal(lostReplyPrompts, 1, "lost claim response recovers with exactly one later prompt");
  const createAgentMailConsentGate = context.MeshPaneActions.createAgentMailConsentGate;
  assert.equal(typeof createAgentMailConsentGate, "function", "agent mail requires a typed owner gate");
  const mailDecisions = [];
  const choices = ["yes", "always", "no", "later", "no", null, "no"];
  let mailNow = 1_000;
  let mailChoiceCount = 0;
  const mailGate = createAgentMailConsentGate({
    choose: async () => { mailChoiceCount += 1; return choices.shift(); },
    decide: async (id, decision) => { mailDecisions.push([id, decision]); return "settled"; },
    now: () => mailNow,
    deferMs: 60_000,
  });
  const consent = (id) => ({id, message_id: `message-${id}`, state: "pending",
    source: {id: "alpha", created: 1, agent: "codex"},
    target: {id: "beta", created: 2, agent: "claude"}});
  await mailGate.consider([consent("once"), consent("always"), consent("no")]);
  assert.deepEqual(mailDecisions, [["once", "yes"], ["always", "always"], ["no", "no"]],
    "owner choices map to yes once, yes always, and no without exposing message text");
  await mailGate.consider([consent("once")]);
  assert.equal(mailDecisions.length, 3, "one consent request is decided only once per page");
  await mailGate.consider([consent("later")]);
  assert.equal(mailDecisions.length, 3, "closing the owner dialog never becomes a destructive refusal");
  await mailGate.consider([consent("later")]);
  assert.equal(mailChoiceCount, 4, "a deferred request is not immediately presented again");
  mailNow += 60_000;
  await Promise.all([mailGate.consider([consent("later")]), mailGate.consider([consent("later")])]);
  assert.deepEqual(mailDecisions.at(-1), ["later", "no"],
    "a deferred request is presented once after its bounded delay, even across concurrent refreshes");
  await mailGate.consider([consent("retry")]);
  await mailGate.consider([consent("retry")]);
  assert.deepEqual(mailDecisions.at(-1), ["retry", "no"], "a temporarily unavailable dialog is retried");
  console.log("PASS: pane-actions source contract (runtime/layout/phone acceptance not assessed)");
} catch (error) {
  if (error instanceof AssertionError) {
    console.error(`ASSERTION: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.error(`SETUP/UNEXPECTED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
