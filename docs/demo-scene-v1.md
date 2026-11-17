# Demo format `mesh-scene-v1`: states and choices

`mesh-scene-v1` lets an agent offer a small interactive walkthrough without supplying or running
code: a set of states, each with a view and buttons that lead to other states. Each pane keeps its
own current state: a choice made on the phone does not move the demo open on the computer. It is
created, updated, opened and restored with the same `mesh-board` tools as
[`mesh-scene-v0`](demo-scene-v0.md).

## Example

This scene starts in `question` and offers two choices, each leading to its own view:

```json
{
  "format": "mesh-scene-v1",
  "version": 0,
  "title": "Choose a layout",
  "theme": "dark",
  "initial": "question",
  "states": [
    {
      "id": "question",
      "view": {
        "format": "mesh-view-v1",
        "nodes": [
          {"type": "heading", "text": "Which layout?"},
          {"type": "text", "text": "This choice triggers no real action."}
        ]
      },
      "choices": [
        {"label": "Compact", "target": "compact"},
        {"label": "Detailed", "target": "detailed"}
      ]
    },
    {
      "id": "compact",
      "view": {"format": "mesh-view-v1", "nodes": [{"type": "badge", "text": "Compact layout"}]},
      "choices": [{"label": "Back", "target": "question"}]
    },
    {
      "id": "detailed",
      "view": {"format": "mesh-view-v1", "nodes": [{"type": "badge", "text": "Detailed layout"}]},
      "choices": [{"label": "Back", "target": "question"}]
    }
  ]
}
```

Pass it to `demo_create` or `demo_create_named` with `version: 0`; an update repeats the current
revision number in `version`, as for v0.

## Rules

A scene holds at most 16 states, with unique identifiers of 1 to 32 ASCII characters, 32 choices
in total, 100 nodes and a depth of 6. `initial` and every `target` must name a declared state. A
view accepts only `heading`, `text`, `badge`, `shape`, `divider`, `card`, `row` and `column`, with
the fields described for v0. Any other field, at any level, is refused.

There is no field for HTML, CSS, a URL, an attribute, an expression or an event handler. A string
such as `<img src=…>` is shown as plain text. A click only changes the view in that pane: it sends
nothing to the server. A new revision, or a restored one, reloads the pane and starts again from
its `initial` state.

## Isolation

The server and the `mesh-board` MCP server both check a scene against this contract before storing
it, and the browser checks it again before building the page. The mesh's own renderer builds the
view in an opaque-origin frame whose Content Security Policy allows only that renderer and its
stylesheet, and forbids network connections, images, forms, navigation, plugins and access to the
page around it. Demos stay on your machine, stored in clear.
