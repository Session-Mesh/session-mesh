---
kind: added
---
- **Answer an agent's question with one click, and correct an answer later.** When the agent gives
  options, the answer form of the Projects view (task sheet, Questions tab, and the sheet of a
  question about no task) shows them as buttons (one choice), checkboxes (every choice that
  applies, for a question the agent marks `multi`) or Yes / No; Send confirms and free text stays
  available. "Edit answer" records a correction as a new answer, and the earlier one stays in the
  history. Ticked choices and an unsent correction come back with the other drafts when you return
  to the view. Agents set the question kind with the new `kind` field of `work_ask`. See
  [The Projects view](docs/features.md#the-projects-view-and-the-project-tracker). `work_ask` now
  refuses a question whose options repeat one (`invalid_input`), since an answer names the options
  it picks by their text.
