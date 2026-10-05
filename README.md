# Brainly — installable notes + flashcards app

Fully self-contained: no build step, no API key, no account, no sync service.
Your notes live on the device you're using. To carry them anywhere, use the
**Files** page (📁 in the sidebar): download a backup file, keep it in your
Google Drive, and upload it on another device. The page explains each step.

## What changed in this version (simpler on purpose)

- **New Files page** — every upload/download in one place, with instructions:
  download/upload a full backup, move a single subject, and import from
  Kindle, PDF, Markdown or a web article.
- **Removed the AI features and API keys** (Summarize, Format, Auto-flashcards,
  Ask about a note, Ask your library) — they were slow and unreliable.
- **Removed Google Drive sync/backup** — your backup file in Drive replaces it.
  (`GOOGLE_DRIVE_SETUP.md` is gone for the same reason.)
- The sidebar is now just Home, Files, your subjects, and the Dark / Reminders /
  passcode toggles.
- Browser data is kept in IndexedDB (no ~5 MB cap); older data is picked up
  automatically.

The feature notes further down are a running history. Anything that mentions
AI features, API keys or Drive sync describes a version that no longer exists.


## Deploy to GitHub Pages

1. Create a new GitHub repo
2. Upload all files in this folder to it (keep them at the repo root, or in
   a subfolder — just make sure `index.html` and `app.jsx` stay together)
3. Repo Settings → Pages → set source to your branch
4. Your app will be live at `https://yourusername.github.io/reponame`

## Install on your phone

**Samsung / Android (Chrome or Samsung Internet):** open the URL → tap the
⋮ menu → "Add to Home screen" / "Install app".

**iPhone (Safari):** open the URL → Share icon → "Add to Home Screen".

Once installed it opens full-screen with its own icon, works fully offline
after the first load (your notes/cards are saved right on your device).

## What's in this version

- **Split a subject that's gotten too big**: "Select" in the Notes tab
  now has a "Move to subject" option alongside "+ Add tag." Pick the
  notes that belong together, move them into a brand-new sub-subject
  created on the spot (or an existing one), and that sub-subject can
  then be archived on its own with "Archive to file" — the actual
  mechanism for splitting an over-large subject to stay under the
  storage limit. Any flashcards made from a moved note travel with it
  automatically.
- **Archive and bring back individual subjects**: "💾 Archive to file" in
  a subject's header saves just that subject (and its sub-subjects) —
  notes, cards, and tags — as its own file, separate from your other
  subjects. "📥 Bring in a subject" in the sidebar reads one of these
  files back in and *merges* it into what's already here, unlike the
  existing "Import from a file," which replaces everything. Re-importing
  an updated version of an archived subject correctly updates it rather
  than duplicating it, and tags with the same name won't end up
  duplicated either. Built for exactly this workflow: archive subjects
  you're not actively studying to stay under the storage limit, bring
  them back when you want to work on them again.
- **Collapsible sub-subjects in the sidebar**: a small chevron appears
  next to any subject with sub-subjects — tap it to expand or collapse
  them. Collapsed by default to keep the sidebar clean; a sub-subject
  you're currently viewing auto-expands its parent so you don't lose
  your place, and collapses again once you navigate elsewhere unless
  you've manually pinned it open.
- **Fixed: the ▧ occlude button (and the whole image/text toolbar) could
  be genuinely invisible, not just easy to miss.** It always tried to
  appear above whatever you selected — for a large image sitting near
  the top of a note (right under the fixed header), that pushed the
  entire toolbar off-screen or behind the header. It now checks for room
  and flips to appear below instead when there isn't enough space above.
- **Occlusion cards from inline images**: the ▧ button now also appears
  on the small toolbar when you select an image pasted or inserted
  directly into a note's text, not just images added via "+ Add image."
  Only shows on notes that are already saved, matching the existing
  restriction on the thumbnail-strip version — brand new, unsaved notes
  don't have anywhere for the cards to link back to yet.
- **Undo in the drawing tool**: undoes your last stroke, shape, or lasso
  move — up to the last 8 actions. "Clear" is now undoable too, so an
  accidental tap doesn't wipe out real work. Disabled when there's
  nothing to undo.
- **Annotate any image with the pen**: a new ✎ button — on the small
  toolbar when you select an inline image, and on each thumbnail in the
  "+ Add image" strip — opens the same drawing tool with that image
  loaded as the background instead of a blank canvas. Same pen, shapes,
  and lasso as free drawing. "Clear" undoes your markup and restores the
  original image rather than wiping it out. Saving replaces that image
  in place with the annotated version.
- **Fixed: the text-selection toolbar was nearly invisible in dark mode.**
  Its background was tied to the same color variable used for regular
  text, which flips from dark to light between themes — meaning in dark
  mode the toolbar background turned light while its icon text stayed
  hardcoded white, white-on-white. It's meant to always be a dark bar
  with white icons regardless of theme (like Google Docs' own floating
  toolbar), so it's now a fixed dark color independent of light/dark mode.
- **Fixed: clearing a note's background color back to default didn't
  actually save.** Picking a new color always worked, but clicking the
  "no color" swatch to remove one silently reverted to the old color on
  save instead — the underlying merge logic treated "explicitly cleared"
  the same as "not specified" and fell back to the previous value.
- **Italic, underline, and numbered lists**: added to both the main
  toolbar and the floating one that appears when you select text —
  closer to the full Word/Docs toolbar. Text alignment and indent
  controls are deliberately left out for now (less useful for study
  notes than a general document), and link insertion needs a proper
  custom input rather than a jarring browser popup, so it's a separate
  follow-up if you want it — say the word.
- **Fixed: text could become nearly invisible on a colored note background,
  worst in dark mode.** The note editor's text was falling back to the
  app's global theme color instead of the note's own color — my fault
  from an earlier layout rewrite, where that rule got dropped and never
  re-added. Restored at the right level so every part of a note
  correctly uses its own color again.
- **Fixed: the scrollbar/fade indicators could stay hidden even on long
  notes.** They were only rechecked when specific things changed (typing,
  window resize) — but a drawing or pasted image can make a note taller
  without tripping any of those triggers. Now driven by a ResizeObserver
  that catches any actual size change in the note, regardless of cause.
- **Font color and size**: select any text and a small toolbar appears
  above it with four color swatches and S/M/L size buttons — the same
  toolbar that already handles bold/heading/highlighting.
- **Found the actual bug behind "can't see the entire note."** There was
  a second, forgotten sticky-positioning rule on the note's formatting
  toolbar, left over from an earlier fix, calibrated for a header layout
  that no longer exists after a later rewrite. As you scrolled, it would
  "catch up" and wedge itself into the middle of your text at a
  meaningless offset — exactly the broken-looking layout in the
  screenshots, with content both above and below it. Removed entirely;
  the toolbar now just scrolls naturally with the rest of the note, and
  the floating toolbar that already appears when you select text handles
  quick formatting without needing this to be sticky at all.
- **An actual visible scrollbar in notes**: a real purple thumb on the
  right edge of the text area that shows roughly where you are and moves
  as you scroll — built entirely from regular page elements rather than
  the browser's native scrollbar, so it shows up the same way on your
  phone as anywhere else, regardless of what the OS normally allows a
  page to do with native scrollbar styling. Only appears when a note
  actually has more content than fits on screen.
- **Fixed: updates could take an extra reload to actually show up.** The
  service worker was serving the cached version first and only updating
  in the background — meaning right after I ship a fix, your very next
  reload could still show the old version. It's now network-first: you
  get the latest whenever you're online, falling back to cache only when
  offline. If you're still seeing an old version after this, a full close
  and reopen of the app (not just switching tabs) should clear it for good.
- **"More below" indicator on notes**: since Android/Samsung Internet
  don't let a page force a persistent visible scrollbar (that's the OS's
  call, not something CSS can override), a soft fade now appears at the
  bottom of a note whenever there's more content below, and disappears
  once you've actually scrolled to the end. Desktop browsers already show
  a themed scrollbar via existing styling; this fade is specifically for
  where that doesn't apply.
- **Fixed: the note editor's header could scroll away, hiding the title
  and top of your text.** The previous approach faked a "pinned" header
  using CSS sticky-positioning tricks, which wasn't holding up reliably.
  Replaced with a proper fixed layout — a real header, a real footer,
  and only the middle actually scrolls — plus the editor now always
  opens scrolled to the top, regardless of where the cursor lands.
- **Drag-and-drop and paste now insert inline**: drop an image file
  anywhere in a note's text and it lands right at the drop point;
  clipboard paste now works the same way (previously paste attached
  images as a thumbnail below the note — this is a real behavior change,
  say so if you preferred the old way). Dragging a local file (from your
  gallery/file manager) works reliably; dragging an image straight off a
  webpage in another tab often won't, because most sites don't allow that
  — you'll get a clear message rather than nothing happening, and can
  save the image first and drag that file instead.
- **Resize inline images**: tap an image you've inserted into a note's
  text to select it, then pick S/M/L/Full from the small toolbar that
  appears above it (or ✕ to remove it) — a click-based approach rather
  than a drag handle, since that's something I can actually verify works
  correctly rather than guess at.
- **Insert images inline in your notes**: a new 🖼 button in the note
  toolbar drops an image right at your cursor, flowing with the text —
  separate from the existing "+ Add image" (which still attaches images
  as a thumbnail strip below the note, unchanged).
- **Shapes and lasso-resize in the drawing tool**: rectangle, ellipse,
  line, and arrow tools alongside the pen, plus a lasso — draw a loop
  around ink to lift it into a floating, draggable, resizable piece; drag
  the corner handle to scale it, then "Done resizing" (or double-tap it)
  to bake it back onto the canvas. Honest note: this is the one feature
  in this whole app whose actual touch/pen *feel* I have no way to test —
  everything about it checks out structurally and mathematically, but
  real-device dragging is worth trying directly before trusting it.
- **Import from a file**: the companion to "Export everything to a
  device" — pick a previously-exported file and it validates the file
  actually looks like a Brainly export (rejects garbage or unrelated
  files with a clear message instead of guessing) before showing you
  exactly how many notes and cards it contains and asking you to confirm.
  This replaces everything currently on this device, so export a backup
  first if you're unsure.
- **Passcode lock** (opt-in, off by default): set a 4-12 digit passcode in
  the sidebar to gate the app behind a lock screen. Honest limits worth
  knowing — this is a lock screen, not encryption; the underlying data
  isn't scrambled, so it stops casual access but not someone deliberately
  digging into browser storage. Forget the code and there's no recovery —
  only a hash is ever stored, never the passcode itself.
- **Export everything to a device**: one button, saves your whole library
  as a single file. On a browser that supports it, it opens a real save
  dialog where a plugged-in USB drive shows up directly; everywhere else
  it downloads normally and you move the file over yourself.
- **Faster Drive reconnect**: if this device was connected before, the app
  now tries a silent, no-popup reconnect on open instead of making you
  click "Connect" every time.
- **Manual backup to Drive**: a separate "📥 Backup now to Drive" button
  (same Google Drive setup as auto-sync, see `GOOGLE_DRIVE_SETUP.md`) —
  each click saves a new, dated snapshot file rather than overwriting one,
  so you build up a set of restore points. Works independently of
  auto-sync — use one, the other, or both.
- **Multi-device sync via your own Google Drive** (opt-in, needs one-time
  setup — see `GOOGLE_DRIVE_SETUP.md`): once connected, saves quietly push
  to a private file in your own Drive that only this app can see, so your
  other devices pick up the changes. Off by default and completely
  invisible until you set it up — nothing else changes if you skip this.
  Known limit: editing the same note on two devices before they sync means
  whichever saves last wins; there's no merging.
- **Search everything from Home**: one search bar finds notes by title,
  body text, or tag, across every subject, with a snippet showing where
  the match is and which subject it's filed under.
- **Formatting toolbar stays with you**: while editing a note, Bold/
  Heading/Highlight stay pinned near the top as you scroll through a long
  note — select text anywhere and the tools are already right there.
- **Split with the same note**: "+ Split view" now also offers "This note
  (side by side)" — two views of the same note at once. Heads up: if you
  edit and save from both sides, whichever you save last wins — there's
  no merging between the two.
- **True full-screen note editing, rebuilt for real this time**: the whole
  pane scrolls as one unit (like Apple Notes) instead of a fragile
  "auto-fit" text box — a big, reliable text area, with the title bar and
  Save/Cancel staying reachable at top and bottom as you scroll.
- **Split view, always side-by-side**: tap "+ Split view" while editing a
  note for a clear menu — open this note's flashcards, or another note
  entirely — always left/right like Notion or Obsidian, never stacked.
  Panes are independently editable and save separately.
  (Notes and flashcards only for now — PDFs aren't supported yet.)
- **Link notes to other notes**: while editing a note, search and link any
  other note (even across subjects) — linked notes show as clickable chips
  that jump straight there. Also shows **"Linked from"** — notes that link
  *to* the one you're viewing, automatically, no setup needed. A small 🔗
  shows on any note card in the grid that has links either direction.
- **Bigger note editor**: opens wider and taller now, so you can actually
  see a full note instead of scrolling a cramped box
- **Tap an image to zoom**: any attached image — in the note grid, while
  editing, or while composing — opens full-screen with zoom in/out,
  double-tap to toggle 100%/200%, and a reset button
- **Sub-folders**: already supported — any subject can have any number of
  sub-subjects under it (e.g. Cardiology → Testing, Labs, Procedures,
  Arrhythmias, all as siblings). Pick "Sub-subject of [parent]" when
  creating each one.
- **Keyboard shortcuts in review**: Space/Enter to flip, ←/1 for Missed,
  →/2 for Got it, S to star, Esc to close
- **Due-today forecast**: a 7-day bar chart on Home showing your card load
  coming up, so pile-ups don't sneak up on you
- **Bulk tag editing**: "Select" in the Notes tab, check off multiple notes,
  add a tag to all of them at once
- **Linked flashcards in your notes**: write a line like `question :: answer`
  anywhere in a note and it becomes a real flashcard on save, linked back to
  that note. Edit the answer later and the existing card updates in place
  (review progress preserved); delete the line and its card goes with it;
  re-saving unchanged text never creates duplicates.
- **Study by tag, across every subject**: on the Home screen, "Study by tag"
  lists every tag with a card count spanning *all* subjects — study or
  Match all your Cardiology-tagged cards in one sitting, no matter which
  subject they're filed under.
- **Image occlusion cards**: upload a diagram (or occlude an image you've
  already attached to a note), draw boxes over the parts to be tested on,
  label each one — you get one card per box: front shows the image with
  just that region masked, back shows the full image and the label.
  Reachable from the Study tab's "Occlude" tile, or from the ✎▧ button on
  any image thumbnail while editing a note. Occlusion cards sit out of
  Match mode (they don't fit the text-tile format) but work everywhere
  else — Cards review, export, editing.
- **Dark theme**: toggle at the bottom of the sidebar (☀/☾), persists across
  visits
- **Overdue banner**: a bar at the top shows total cards overdue across
  *every* subject, tap it to jump straight into reviewing the subject with
  the most overdue cards
- **Study reminders**: toggle in the sidebar (🔔/🔕). When on, if cards are
  overdue and Brainly is open in the background, you'll get a local
  notification every 30 minutes. **This is not push notification** — it
  only works while the app is actually running in a tab; a static site
  with no backend server can't alert you while it's fully closed. True
  push would need a real server — say so if you want to go there.
- **Visible scrollbars**: styled, theme-aware scrollbars everywhere content
  can overflow (notes list, modals, the rich text editor, etc.)
- **Notes**: rich text (bold, headings, bullets, highlight — now in three
  colors: yellow/red/green, plus undo/redo), subjects with one level of
  sub-subjects, tags, colors, pasted or drawn images
- **Move notes between subjects**: open any note, use the Subject dropdown
  to move it — any flashcards made from that note move with it
- **Share into Brainly from any app**: once installed, "Brainly" appears in
  your phone's share sheet. Sharing text, a link, or a snippet from any app
  creates a note straight into a **Review** subject (created automatically
  the first time), ready for you to tag, edit, and move into the right
  subject later. Text/link shares only — sharing photos/files this way
  isn't included yet.
- **Highlight → card**: select text in a saved note, tap Highlight, type
  the answer — instant flashcard
- **Import cards**: paste term/definition pairs (like a Quizlet export or
  a spreadsheet column), pick your separators, review before adding
- **Study**: flip-card review with spaced repetition (5-box system),
  a timed Match game, star/scope filtering, a weak-tags dashboard
- **Export & share**: every note and every subject's card deck can be
  copied as Markdown, downloaded as Markdown or PDF, or sent through your
  phone's native share sheet
- **Draw**: a canvas that supports pressure-sensitive input from an S Pen
  (and works fine with touch/mouse too) — saved as an image in the note

## Share target: a couple of things worth knowing

- Only works on **installed** Android/Samsung PWAs — Chrome and Samsung
  Internet support this (`share_target` in the manifest); iOS Safari does
  not support this at all, so this piece is Android-only.
- If you **reinstall** the app (remove and re-add to home screen) after
  this update, the OS should pick up the new share-target registration
  automatically. If "Brainly" doesn't show up in your share sheet right
  away, try removing and re-adding it to your home screen once.
- Shared content lands as a **new note** in Review, not merged into
  anything — nothing gets overwritten.

## Known limitation: handwriting stays a picture

Your S Pen strokes are captured faithfully as an image, but they are
**not** converted to searchable, editable text (that's real OCR/ML, not
something free client-side JavaScript can do). You can still see and share
the drawing — it just won't be part of text search or exports as text.

## A note on how this was tested — and what broke the first time

The version you tried got stuck on "loading brainly…" — that was a real bug,
and I found it. The original build shipped `app.jsx` as raw JSX, transpiled
**in the browser** at page-load time using a CDN copy of Babel. That's a
fragile pattern: if anything hiccups in that fetch-and-transpile step, the
page just sits there forever with no visible error.

To actually verify the fix instead of guessing again, I got a real
JavaScript/JSX compiler working locally, used it to (1) syntax-check the
full file, (2) pre-compile the JSX into plain `app.js` ahead of time, and
(3) used React's own server-rendering to force-execute the component with
sample data — including the Dashboard, Notes tab, and Study tab — and
confirmed all three render without errors.

The app now ships as **plain compiled JavaScript** (`app.js`), loaded with
a normal `<script src="app.js">` tag — no in-browser transpilation step at
all, nothing that can silently fail. `index.html` also now shows the real
error on screen if anything else goes wrong loading, instead of hanging
silently.

This is a meaningfully more solid guarantee than the balance-checks I was
relying on before, but it's still not the same as a human clicking through
every button on a real phone. If something still breaks, tell me exactly
what you tapped and what happened (or open the browser's dev tools console
if you can — Chrome on Android: menu → More tools → Developer tools) and
I'll go straight to that code path instead of re-guessing broadly.
