// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Atacama <contact@atacama.tech>

// Phone "direct writing": pure rules for the input line (see app.js, "phone input line").
// Agents show their command and skill completion while a key is typed, so on a phone a line
// that starts with `/` (or `$`) stops holding its text: each insertion goes to the terminal as
// typed, and the field is emptied. The field is never a mirror of the agent's line.

export type AgentType = "claude" | "codex" | "pi";

/** The first character that starts direct writing in a given agent, or null for any other
 * session. `/` opens the command menu of Claude Code, Codex and Pi; `$` opens the skill
 * menu of Codex only. A shell, or an agent that has left the foreground, is not an agent
 * here: a path typed in a shell stays an ordinary line. */
export function directLineTrigger(agent: AgentType | null, first: string): boolean {
  if (agent === null) return false;
  if (first === "/") return true;
  return first === "$" && agent === "codex";
}

/** The agent that currently owns the terminal's input, or null. */
export function foregroundAgent(session: {kind?: unknown; agent?: {type?: unknown; foreground?: unknown} | null} | null | undefined): AgentType | null {
  if (!session || session.kind !== "mesh" || session.agent?.foreground !== true) return null;
  const type = session.agent.type;
  return type === "claude" || type === "codex" || type === "pi" ? type : null;
}

// C0 controls (line breaks and tab included), DEL and C1 controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Every control but tab, line feed and carriage return: never sent, not even inside a paste
// (an ESC could close the bracketed paste early and let the rest run as keys).
const NEVER_PASTED = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const BREAKS_OR_TAB = /[\t\n\r]/;
const TYPING = new Set(["insertText", "insertCompositionText", "insertFromComposition"]);

/** How text that reached the field is handed to the terminal in direct writing:
 * - `typed`: typed text with no control character, sent as it is;
 * - `paste`: pasted, dropped or otherwise inserted text without line break or tab, sent as one paste;
 * - `multiline`: text with a line break or a tab, sent only as one bracketed paste (the caller
 *   refuses it when the terminal's program has not asked for bracketed paste);
 * - `refused`: text with another control character, never sent;
 * - `replacement`: a keyboard's autocorrection or suggestion that replaces text. The field is
 *   empty in direct writing, so there is nothing to replace: the terminal already has the
 *   original word, and sending the replacement would add to it instead. Never sent.
 * No line break or control character ever reaches the terminal as typed bytes. */
export type DirectInput = "typed" | "paste" | "multiline" | "refused" | "replacement";
export function directInput(text: string, inputType: string): DirectInput {
  if (NEVER_PASTED.test(text)) return "refused";
  if (BREAKS_OR_TAB.test(text)) return "multiline";
  if (inputType === "insertReplacementText") return "replacement";
  return TYPING.has(inputType) && !CONTROL.test(text) ? "typed" : "paste";
}

/** Whether `value`, which an insertion of type `inputType` just made the whole content of an
 * empty field, starts direct writing for this agent: its first character is the agent's
 * trigger and the insertion is typed text without any control character. A paste, a drop and
 * any multi-line insertion never start it. */
export function directLineStarts(agent: AgentType | null, value: string, inputType: string): boolean {
  const first = Array.from(value)[0];
  return first !== undefined && directLineTrigger(agent, first) && directInput(value, inputType) === "typed";
}
