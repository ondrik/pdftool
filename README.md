# pdftool

A static page for basic PDF manipulation: **<https://ondrik.github.io/pdftool/>**

Everything runs in the browser — files are never uploaded anywhere.

## What it does

- **Combine** any number of PDFs (and images: JPG, PNG, WebP, …) into one document.
- **Pick and reorder pages**: every page of every file is shown as a thumbnail;
  drag pages (or a multi-page selection) into an arbitrary order.
- **Rotate**, **delete** and **duplicate** pages.
- **Extract** pages: select some and use *Download selection*.
- Preview a page at full size (double-click), undo/redo.

### Keyboard

| Key | Action |
| --- | --- |
| click / Shift+click | select a page / a range |
| `Ctrl+A`, `Esc` | select all / none |
| `R`, `Shift+R` | rotate selection right / left |
| `D` | duplicate selection |
| `Del` | delete selection |
| `Ctrl+Z`, `Ctrl+Shift+Z` | undo / redo |
| `Ctrl+S` | download the result |

### Limitations

- Encrypted / password-protected PDFs are rejected.
- Document-level features are not carried over to the output: bookmarks
  (outline), fillable-form definitions, metadata. Page content and
  page annotations are preserved.

## Development

There is no build step. Serve the directory with any static server, e.g.

```sh
python3 -m http.server 8000
```

and open <http://localhost:8000/>. (Opening `index.html` via `file://` does not
work because the page uses ES modules.)

- `index.html`, `css/style.css`, `js/app.js` — the whole app
- `vendor/` — third-party libraries, committed so the page has no external
  dependencies at runtime:
  - [pdf-lib](https://pdf-lib.js.org/) 1.17.1 (MIT) — writes the output PDF
  - [PDF.js](https://mozilla.github.io/pdf.js/) 6.5.438 (Apache-2.0) — renders thumbnails
  - [SortableJS](https://sortablejs.github.io/Sortable/) 1.15.7 (MIT) — drag & drop

The page is deployed by GitHub Pages straight from the `master` branch.

## License

[MIT](LICENSE). The libraries under `vendor/` keep their own licenses, included
alongside them.
