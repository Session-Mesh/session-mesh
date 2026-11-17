// Synthetic, public lifecycle model for the first replay proof.
//
// tools/check-ptyhost-lifecycle-itf.mjs typechecks this exact source with the
// locked Quint 0.32.0 binary, generates one bounded trace with the fixed seed,
// and compares its public projection with ptyhost_lifecycle.itf.json.  The
// committed ITF deliberately removes Quint's volatile metadata.
//
// It deliberately has no session name, path, command, token, terminal bytes or
// timing input. The adapter reduces observed protocol events to bounded classes.
// `advance` has exactly one enabled branch at every state.
module ptyhost_lifecycle {
  var operation: str
  var order_index: int
  var result_class: str
  var live: bool
  var attached: bool
  var replay_seen: bool
  var reused: bool
  var attachment_mode: str
  var io_class: str
  var queue_class: str
  var size_class: str
  var client_count: int
  var fanout_class: str

  action init = all {
    operation' = "initial",
    order_index' = 0,
    result_class' = "empty_list",
    live' = false,
    attached' = false,
    replay_seen' = false,
    reused' = false,
    attachment_mode' = "none",
    io_class' = "none",
    queue_class' = "none",
    size_class' = "none",
    client_count' = 0,
    fanout_class' = "none",
  }

  action create = all {
    operation == "initial",
    operation' = "created",
    order_index' = 1,
    result_class' = "created",
    live' = true,
    attached' = false,
    replay_seen' = false,
    reused' = false,
    attachment_mode' = "none",
    io_class' = "none",
    queue_class' = "none",
    size_class' = "not_observed",
    client_count' = 0,
    fanout_class' = "none",
  }

  action attach = all {
    operation == "created",
    operation' = "attached",
    order_index' = 2,
    result_class' = "replay",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "replay_first",
    io_class' = "none",
    queue_class' = "none",
    size_class' = "attach_24x80",
    client_count' = 1,
    fanout_class' = "none",
  }

  action resize_first = all {
    operation == "attached",
    operation' = "resized_first",
    order_index' = 3,
    result_class' = "geometry_observed",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "replay_first",
    io_class' = "none",
    queue_class' = "none",
    size_class' = "resize_31x71",
    client_count' = 1,
    fanout_class' = "none",
  }

  action resize_last = all {
    operation == "resized_first",
    operation' = "resized_last",
    order_index' = 4,
    result_class' = "geometry_observed",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "replay_first",
    io_class' = "none",
    queue_class' = "none",
    size_class' = "resize_33x73",
    client_count' = 1,
    fanout_class' = "none",
  }

  action input_output = all {
    operation == "resized_last",
    operation' = "input_output",
    order_index' = 5,
    result_class' = "output",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "replay_first",
    io_class' = "input_then_output",
    queue_class' = "none",
    size_class' = "resize_33x73",
    client_count' = 1,
    fanout_class' = "none",
  }

  action attach_second = all {
    operation == "input_output",
    operation' = "attached_second",
    order_index' = 6,
    result_class' = "replay",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "second_replay_first",
    io_class' = "input_then_output",
    queue_class' = "none",
    size_class' = "resize_33x73",
    client_count' = 2,
    fanout_class' = "none",
  }

  action fanout_both = all {
    operation == "attached_second",
    operation' = "fanout_both",
    order_index' = 7,
    result_class' = "output",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "second_replay_first",
    io_class' = "input_then_output",
    queue_class' = "none",
    size_class' = "resize_33x73",
    client_count' = 2,
    fanout_class' = "both_observed",
  }

  action detach_second = all {
    operation == "fanout_both",
    operation' = "detached_second",
    order_index' = 8,
    result_class' = "detached",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "first_survives",
    io_class' = "input_then_output",
    queue_class' = "none",
    size_class' = "resize_33x73",
    client_count' = 1,
    fanout_class' = "both_observed",
  }

  action surviving_output = all {
    operation == "detached_second",
    operation' = "surviving_output",
    order_index' = 9,
    result_class' = "output",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "first_survives",
    io_class' = "input_then_output",
    queue_class' = "none",
    size_class' = "resize_33x73",
    client_count' = 1,
    fanout_class' = "survivor_observed",
  }

  action overflow = all {
    operation == "surviving_output",
    operation' = "overflow",
    order_index' = 10,
    result_class' = "drop_reported",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "first_survives",
    io_class' = "input_then_output",
    queue_class' = "drop_after_second_frame_reported",
    size_class' = "resize_33x73",
    client_count' = 1,
    fanout_class' = "survivor_observed",
  }

  action recover = all {
    operation == "overflow",
    operation' = "recovered",
    order_index' = 11,
    result_class' = "exact_input_recovered",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "first_survives",
    io_class' = "input_then_output",
    queue_class' = "first_exact_second_dropped_recovery_exact_fifo",
    size_class' = "resize_33x73",
    client_count' = 1,
    fanout_class' = "survivor_observed",
  }

  action terminate = all {
    operation == "recovered",
    operation' = "terminated",
    order_index' = 12,
    result_class' = "exit",
    live' = false,
    attached' = false,
    replay_seen' = true,
    reused' = false,
    attachment_mode' = "closed",
    io_class' = "input_then_output",
    queue_class' = "first_exact_second_dropped_recovery_exact_fifo",
    size_class' = "resize_33x73",
    client_count' = 0,
    fanout_class' = "survivor_observed",
  }

  action recreate = all {
    operation == "terminated",
    operation' = "recreated",
    order_index' = 13,
    result_class' = "created",
    live' = true,
    attached' = false,
    replay_seen' = false,
    reused' = true,
    attachment_mode' = "none",
    io_class' = "none",
    queue_class' = "none",
    size_class' = "not_observed",
    client_count' = 0,
    fanout_class' = "none",
  }

  action reattach = all {
    operation == "recreated",
    operation' = "reattached",
    order_index' = 14,
    result_class' = "replay",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = true,
    attachment_mode' = "replay_after_recreate_no_old_marker",
    io_class' = "none",
    queue_class' = "none",
    size_class' = "attach_24x80",
    client_count' = 1,
    fanout_class' = "none",
  }

  action reused_input_output = all {
    operation == "reattached",
    operation' = "reused_input_output",
    order_index' = 15,
    result_class' = "output",
    live' = true,
    attached' = true,
    replay_seen' = true,
    reused' = true,
    attachment_mode' = "replay_after_recreate_no_old_marker",
    io_class' = "input_then_output_after_recreate",
    queue_class' = "none",
    size_class' = "attach_24x80",
    client_count' = 1,
    fanout_class' = "none",
  }

  action advance = any { create, attach, resize_first, resize_last, input_output, attach_second, fanout_both, detach_second, surviving_output, overflow, recover, terminate, recreate, reattach, reused_input_output }
}
