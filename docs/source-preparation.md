# Preparing external sources

The AISB curriculum links to papers, articles, documentation, and other public
references. The companion can make supported references available to the tutor
and whole-day review without repeatedly downloading them or placing every
source in every prompt.

Preparation is always explicit. Opening **Prepare references**, a lesson, or a
review page does not contact any external website.

## Before you start

Install Poppler if you want PDF papers to become searchable text:

```bash
brew install poppler
pdftotext -v
```

The app still caches a verified PDF when text extraction fails, but assistants
cannot search or quote that PDF until a text projection is available.

## The two preparation actions

Open <http://127.0.0.1:7575/prepare> or select **Prepare references** in the
sidebar.

### Inventory links

This scans the current AISB material manifests and records their canonical
public HTTPS links. It does not use the network and does not download anything.

Learner-visible arXiv abstract and PDF links are both normalized to the paper's
full PDF endpoint. Equivalent arXiv link spellings are recorded once, with all
of their curriculum origins retained. If an arXiv paper is cited only inside a
protected answer or solution, the paper URL is retained with a neutral label so
the external paper can still provide context. The protected wording itself is
not included.

Use it to check which sources the current curriculum refers to after pulling a
new AISB revision.

### Inventory & cache public sources

This first rebuilds the same inventory, then contacts every recorded source
that fits the preparation boundary. It uses six bounded workers and publishes
one immutable run ledger when the work finishes.

The current defaults are:

| Boundary | Default |
| --- | ---: |
| Recorded references | 256 per run |
| Sources contacted | Up to all 256 recorded references |
| Concurrent requests | 6 |
| Source size | 16 MiB |
| Total stored bytes | 512 MiB per run |
| Redirects | 3 per source |
| Request time | 15 seconds per request |
| PDF extraction time | 45 seconds per PDF |
| PDF text output | 12 MiB per PDF |

The total includes both original source bytes and generated Markdown text.
These are safety and resource bounds, not a target number of sources. A normal
run can finish below them.

## What is accepted

The downloader accepts credential-free `https://` URLs on the standard HTTPS
port. It resolves and checks every destination, including redirects, and
rejects private, local, reserved, or otherwise unsuitable network addresses.

Only these response types are prepared:

- HTML, stored as verified original bytes plus an inert Markdown projection;
- PDF, stored as verified original bytes plus locally extracted, page-numbered
  Markdown when Poppler succeeds.

For arXiv, preparation fetches the full paper PDF even when the curriculum link
points to an `/abs/` landing page. The abstract page alone is not used as the
assistant's paper context.

The preparation run does not execute page JavaScript, submit credentials,
follow arbitrary URLs supplied by a model, run Codex enrichment, transcribe
audio or video, or fetch images and other media. Compressed HTTP responses are
also rejected by this deliberately small downloader.

## Reading the result

The page shows the latest immutable run and a row for every recorded source.
Common states are:

- **HTML + Markdown** — the source is ready as inert text;
- **PDF + N indexed pages** — the original paper and page-aware text are ready;
- **PDF · text unavailable** — the original PDF is safe in the cache, but local
  extraction failed;
- **Inventory only** — the link was recorded without a network request;
- **Fetch failed safely** — the source exceeded a boundary or could not be
  fetched without weakening it;
- **Unsupported** — the returned media type is outside the HTML/PDF boundary.

A **partial** run is still useful. It means at least one source was cached but
one or more sources or PDF projections failed. Expand a source's provenance to
see its requested and final URL, curriculum origins, content hashes, cache
object, text projection, and extraction status.

Run preparation again after:

- pulling a newer AISB curriculum revision;
- installing Poppler after an earlier PDF-only run;
- changing or adding curriculum references; or
- retrying a temporary external failure.

Re-running does not overwrite content-addressed objects. The latest run ledger
becomes the active inventory while verified objects are reused by hash.

## How assistants use prepared material

Prepared material is untrusted reference content, never an instruction source.
The original HTML or PDF bytes are not placed directly in a model prompt.

- A lesson tutor receives small, verified text excerpts for quick orientation.
  It can also search the complete prepared projections linked to the current
  section and read relevant parts in bounded chunks. PDF page headings and
  source/projection hashes are retained in tool results.
- The overall **Learning manager** receives a bounded snapshot. It does not
  have a general source-reading or web-browsing tool.
- **Review day** receives a compact inventory for that day and can search or
  read relevant prepared text in bounded chunks through day-scoped tools. This
  is the preferred flow for a source-grounded whole-day review.

Lesson-tutor and day-review tools accept opaque application IDs, not paths or
URLs. The server rebuilds and rechecks the selected section or day's resource
set for every call. Protected folds, solutions, participant answer files, and
sources outside that scope remain unavailable.

## Storage and privacy

Prepared data is learner runtime state, not repository content. By default it
lives under:

```text
~/Library/Application Support/AISB Learning Companion/preparation/
```

The directory contains content-addressed cached objects and immutable run
records. Do not commit it to the companion or AISB repositories. Include it in
your learning-record backup when you want the prepared cache and its provenance
to travel with the rest of your local state.

## Troubleshooting

### A PDF has no indexed text

Run `pdftotext -v`. If it succeeds, start a new cache run. Scanned PDFs without
an embedded text layer may still produce little or no useful text; OCR is not
performed.

### A source is too large

The current per-source limit is 16 MiB. The app does not provide a UI override.
Open the source directly in the browser if it cannot be prepared safely.

### The run is partial

Expand the failed rows. A partial run does not invalidate successful rows.
Retry only if the reported cause is temporary or you have fixed a local
requirement such as Poppler.

### An assistant says a reference is unavailable

Confirm that the latest run shows a complete text projection and that the
reference is linked from the current section or a section belonging to the
reviewed day. Then start a new tutor or **Review day** turn; opening either one
never prepares missing sources itself.
