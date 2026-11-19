(******************************************************************************)
(*                                                                            *)
(* SPDX-License-Identifier: AGPL-3.0-or-later                                 *)
(* Copyright (c) 2026 Atacama <contact@atacama.tech>                          *)
(*                                                                            *)
(******************************************************************************)

(* An ordinary name (letters, digits, inner spaces, a few separators, not typed
   by YAML) stays plain; any other is written as a double-quoted (JSON-style)
   string, so that no name can be read as a boolean, number, null, indicator or
   anchor. *)
let plain_safe name =
  let alnum c = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') in
  name <> ""
  && alnum name.[0]
  && name.[String.length name - 1] <> ' '
  && String.for_all (fun c -> alnum c || c = ' ' || c = '_' || c = '.' || c = '-') name
  && Yaml_lite.is_conservative_string name

let name_text name = if plain_safe name then name else Yojson.Safe.to_string (`String name)

let taxonomy_text ~category ~category_name ~product =
  Printf.sprintf "categories:\n  %s:\n    name: %s\n    products:\n      - %s\n" category
    (name_text category_name) product

(* Refuse, before anything is written, a text that the loader would not read back
   as the category and product that were asked for. *)
let check_readable ~category ~category_name ~product text =
  match Taxonomy.of_string text with
  | Error why -> Err.usage "category name %S cannot be written to taxonomy.yaml: %s" category_name why
  | Ok t -> (
      match t.Taxonomy.categories with
      | [ c ] when c.Taxonomy.key = category && c.Taxonomy.name = category_name
                   && c.Taxonomy.products = [ product ] -> ()
      | _ -> Err.usage "category name %S does not read back from taxonomy.yaml unchanged" category_name)

let gitignore_text = ".wl.lock\nindex.sqlite\n.wl-state/\n"

let check_inputs ~category ~category_name ~product =
  List.iter
    (fun (what, v) ->
      if not (Textcheck.valid_name v) then Err.usage "invalid %s %S" what v;
      if not (Yaml_lite.is_conservative_string v) then
        Err.usage "invalid %s %S: YAML would read it as a boolean, null or number" what v)
    [ ("category", category); ("product", product) ];
  Validate.check (Textcheck.text_error ~field:"category name" ~limit:100 category_name);
  if String.contains category_name ':' || String.contains category_name '#' then
    Err.usage "category name %S must not contain ':' or '#'" category_name

let write_new path content =
  if not (Sys.file_exists path) then Appendfile.create_exclusive path content

let init ~root ?(category = "main") ?(category_name = "Main") ?(product = "general") ?(git = true) () =
  Err.protect (fun () ->
      check_inputs ~category ~category_name ~product;
      let taxonomy = Filename.concat root "taxonomy.yaml" in
      if Sys.file_exists taxonomy then Err.usage "%s already exists: refusing to overwrite a data repository" taxonomy;
      let text = taxonomy_text ~category ~category_name ~product in
      check_readable ~category ~category_name ~product text;
      Appendfile.mkdir_p root;
      Appendfile.create_exclusive taxonomy text;
      write_new (Filename.concat root ".gitignore") gitignore_text;
      List.iter
        (fun d -> write_new (Filename.concat (Filename.concat root d) ".gitkeep") "")
        [ "tasks"; "events" ];
      if git then begin
        (match Gitrun.run ~dir:root [ "init"; "-q" ] with
        | 0, _ -> ()
        | _, why -> Err.fail Err.Other ("git init failed: " ^ String.trim why));
        let paths = List.map (Filename.concat root) [ "taxonomy.yaml"; ".gitignore"; "tasks/.gitkeep"; "events/.gitkeep" ] in
        match Gitrun.commit_paths ~root ~paths ~message:"wl: init" with
        | Ok _ -> ()
        | Error why -> Err.fail Err.Other why
      end)
