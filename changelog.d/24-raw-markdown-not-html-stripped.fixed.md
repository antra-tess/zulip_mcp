- Raw-markdown message text is no longer run through the HTML tag strip (#24).
  History (`get_channel_history`, `fetch_history`, `fetch_around`), context
  injection and wake text are all fetched with `apply_markdown:false`, so
  every `<...>` in them is author text; the strip deleted XML/HTML in code
  blocks, inline generics like `Map<string, T>` and `a < b > c` prose. Side
  effects on the same path, all towards verbatim text: HTML entities such as
  `&amp;` are no longer unescaped, `<https://example.com>` autolinks survive,
  author-typed literal `<p>`/`<br>` no longer turn into newlines, and CR/CRLF
  line endings are normalised to LF. The message-edit path (#22) uses the same
  raw-markdown treatment for the new and previous text. Rendered-HTML output
  (`formatMessages`) still uses `cleanContent`.
