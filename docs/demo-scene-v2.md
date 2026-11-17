# Demo format `mesh-scene-v2`: states, choices and gears

`mesh-scene-v2` is [`mesh-scene-v1`](demo-scene-v1.md) with one more node, `gear`, which draws a
gear at a given angle. States, choices, limits and isolation are those of v1, but each state's view
uses the format `mesh-view-v2`. A v1 scene that contains a `gear` is refused: use v2 for it.

```json
{
  "format": "mesh-scene-v2",
  "version": 0,
  "title": "Two gears",
  "theme": "dark",
  "initial": "start",
  "states": [{
    "id": "start",
    "view": {
      "format": "mesh-view-v2",
      "nodes": [{"type": "row", "children": [
        {"type": "gear", "angle": 90},
        {"type": "gear", "angle": 270}
      ]}]
    },
    "choices": []
  }]
}
```

The node is exactly `{"type": "gear", "angle": <integer from 0 to 359>}`. The mesh draws the gear
and its rotation; the scene supplies no style, animation or callback. The other nodes are those of
v1.

The browser's parser is strict: it refuses unknown fields, formats and types, duplicate keys,
control characters and any excess in size, depth or node count before building the page. All text
is inserted as plain text.
