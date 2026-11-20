---
kind: added
---
- **Agents record their attempts on a task.** A new `mesh-work` tool, `work_attempt`, records the
  end of a pass of work: success, failure (with a reason such as `ci_failure` or `review_nogo`) or
  abandoned, with an optional short text and links. `work_get` and the Projects reader return each
  task's attempt count, its consecutive failures and a flag at three in a row; the attempt number is
  derived, never stored. `wl` still reads the tracker and ignores the new event with a warning. See
  [Attempts](docs/work-mcp.md#attempts-our-extension).
