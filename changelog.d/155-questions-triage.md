---
kind: changed
---
- **The Projects view opens on the products again; its open questions are one folded line,
  classified, and answered in context.** The entry screen no longer starts with every open
  question and its answer form: a folded line "Pending questions n" sits above the products, and
  the browser tab remembers whether it is unfolded, with the rest of the view's place.
  Unfolded, it lists the questions by zone (the category of the product), product, project and
  task, with counts, the oldest first, 20 at a time ("Show more questions" adds the next ones),
  a project once under its own product; a row gives the whole text, a "Decision" cue when the
  agent offered options, its age and asker, where it stands, the options and the assumption
  (folded), and opens the task sheet at that question (or the project's Questions tab, the
  sheet of a task in no project, or the question's own sheet), where the answer is given beside
  the task's notes, blockers and events; Back returns to the list. Questions attached to no
  task, or to one the tracker does not know, are grouped under "Without context" by the session
  that asked them and answered on their own sheet. An answer whose sheet cannot be read again
  says so, with "Try again", instead of announcing success. Leaving Projects and coming back, or
  reloading the tab, reopens a sheet opened from the list with the answer typed there; signing
  out forgets it, the unfolded line included. A new read-only `work-read open-questions` gives
  every open question, oldest first, a page at a time and in full, with the true total;
  `work-read resume` and it add a `context` to each question (task title, project, product,
  category), and the `mesh-work` instructions and the agent guide ask agents to attach each
  question to the task or project it concerns. See
  [The Projects view and the project tracker](docs/features.md#the-projects-view-and-the-project-tracker).
