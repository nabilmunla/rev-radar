REV RADAR 0.3.2 - what really changed between two issues: drawings, BOQs, specs
=====================================================================================

Install
-------
Run "Rev-Radar-Setup-<version>.exe" (from https://github.com/nabilmunla/rev-radar/releases).
Windows 10/11, 64-bit.
  - "Everyone on this PC" (the default) installs into Program Files and asks for admin rights
    once. "Just me" needs no admin rights but goes into your AppData folder, where company
    antivirus may stop programs from starting.
  - Start menu (and desktop) shortcut; remove it from Windows' Installed apps.
  - Running the setup again over an installed copy updates it; settings and remembered results
    stay. An older setup run on purpose goes back to that version (what a setup installs is
    what runs). Uninstall removes only what the setup put in the folder.
  - IT tools: --silent [--just-me] [--no-desktop]; remove with --uninstall --silent.
    Log: %TEMP%\Rev Radar Setup.log. (--updates <folder> from older scripts is accepted and ignored.)

Updates
-------
Rev Radar looks at its releases on GitHub (https://github.com/nabilmunla/rev-radar/releases)
20 seconds after it starts and every 4 hours. A new version is offered on a card (top right) -
nothing is downloaded until you press Update. It is downloaded, checked (the release must be
signed by Rev Radar's maker, and the file must match what was signed - SHA-256), unpacked into
%LOCALAPPDATA%\Rev Radar\app and runs from the next start ("Restart now", or simply the next
time you open Rev Radar). From 0.5.0 on, an updates folder set before is no longer used.
  - No helper program is started for this - Rev Radar.exe restarts itself - so an antivirus
    that blocks programs started from AppData has nothing to block.
  - Without internet GitHub just isn't reached: nothing is shown, Rev Radar works as usual.
  - Settings > Updates: "Check now", and "Go back to <version>" if a new version
    misbehaves (it is then not offered again by itself; "Use <version> again" goes forward).
  - A version that doesn't start on your PC is set aside by itself and the one before runs
    ("Check now" offers it once more).
  - A version with a new runtime (rare) needs its setup run once - the card says so and opens
    its release page.

The portable copy (a "Rev Radar" folder with Rev Radar.exe, no setup) still works anywhere,
and updates the same way.

Use
---
1. Old issue: drop a folder of PDFs (or a few PDFs, or one combined PDF) on the left box.
   New issue: the same on the right box. Sub folders are included unless you untick it.
2. Compare. Sheets are paired by drawing number / file name ("Rev B", "_C02", "(1)", a date in
   front, a title after the number, "_" for "-", a leading zero, a project prefix added or dropped:
   "100101" / "F111.1-AE7-DWG-AR-100101" are all ignored); combined PDFs and odd names are paired
   by what the sheets say. A wrong pair: "unpair" on the right; a New or Removed sheet: pair it by
   hand with the list on the right (remembered for next time).
3. All the sheets show as pictures, with boxes where they changed, filling in as they are
   compared (several at once). Click one to open it - or press Enter / "Start review".
4. The review: press N to go from change to change. When you have seen every change of a
   sheet, the next N ticks it off as reviewed and opens the next sheet to review (changed,
   new, removed and could-not-compare sheets). R ticks a sheet off at once. "To review"
   (left) counts what is left; the summary (Esc, Esc) shows how many are ticked off.
   On a sheet that has bigger changes too, N shows the tiny ones last, after one stop that
   says so (R ticks the sheet off without them). Untick "N shows the ... tiny ones last" on
   the right to go through the changes in sheet order.
   Zoomed in, the little map at the bottom right shows where you are; click it to move. If
   you zoom in or out yourself, the next changes are shown at your zoom (0 forgets it).

What the statuses mean
----------------------
  Changed            the drawing itself changed. The number is how many places.
                     "N tiny" (hollow dot): only very small changes - each under ~1 mm2 of ink
                     and no words changed (a line join, a hair of re-drafting). Worth a glance.
  Title block only   the drawing did not change: only the title block / revision table / issue
                     stamp / logo / sheet border (where most sheets of the same size changed, or
                     revision wording: dates, "ISSUED FOR", "REVISED AS CLOUDED", revision codes
                     in the revision table), old revision clouds taken off, or dashed lines
                     redrawn with their dashes elsewhere. Shown as "Old clouds removed" when old
                     clouds were all that was taken off.
  No change          the sheets look the same.
  Moved only         a part of the sheet moved a few mm, as a whole, and nothing in it changed:
                     usually a view placed elsewhere on the paper - but a building or a piece of
                     equipment moved in the drawing looks just the same, so the move is item 1
                     to review ("moved" in the list).
  Identical file     the very same file was issued again.
  New / Removed      only in the new / old issue. You can pair such a sheet by hand.
  Could not compare  see the details on the right (damaged file, password, out of memory, a
                     network drive that dropped while reading - "Try again").

"To review" lists the changed, new, removed and could-not-compare sheets you have not
ticked off yet (R). A sheet that could not be compared needs a person: ask for the file again.

The sheet view
--------------
  Red   = only in the old issue (removed)      Blue = only in the new issue (added)
  Grey  = unchanged (the "Fade unchanged" slider makes it fainter)
  Overlay / Side by side / Old / New / Flicker (old and new in turn, in one place).
  Every change is boxed and numbered 1..N - the same numbers in the list, the PDF and Excel.
  Highlight (toolbar, H): the paper in every change box turns pale yellow, and a change too small
  to see on the whole sheet gets a yellow dot - easier to spot on a poor screen. The lines keep
  their colour. Remembered until you switch it off.
  "Show N hidden (title block / ...)" brings back the changes that don't count (on every
  sheet); they are lettered:
  T title block, C old cloud, D dashes redrawn, X a spot you left out.
  Right-click a box: leave that spot out on every sheet of this size (e.g. a logo that moved).
  A message says how many changes on how many sheets that hides - with Undo. "bring back"
  (left, under the filters) brings all spots back; "bring this spot back" on an X item, one.

Keys (? shows them all):
       N / P  next / previous change (after the last: ticked off, next sheet to review)
       R  ticked off, next sheet       J / K  next / previous sheet     Enter  start review
       In the search box: Enter opens the first sheet found, Esc clears it.
       O  overlay   S  side by side   1  old   2  new   F  flicker   H  highlight
       0  whole sheet   + / -  zoom    [ / ]  hide / show the list / the details
       Esc  off the change (whole sheet), again: all the sheets (counts and exports)
Mouse: wheel = zoom, drag = move.

Exports (top bar)
-----------------
  Clouded PDF   the changed and new sheets of the new issue with numbered clouds round every
                change (a new sheet: one cloud round the whole drawing), plus summary pages.
                One sheet: "This sheet as clouded PDF" on the right. A very big set (around
                170+ A0 sheets) is written as several files: "... (part 1).pdf", "(part 2)"...
                A sheet that can't be read is left out and named in a message.
  Excel         every sheet with its status, changed text and title block text changes (issue
                status, "not for tender" notes...); a second tab lists each change and where
                on the sheet it is.

How it decides (so you know what to trust)
------------------------------------------
- Both sheets are drawn at 150 dpi and lined up automatically: moved, re-plotted a little
  bigger/smaller (fit to paper included), turned a fraction of a degree, A1 vs A0, or a
  quarter turn. When it had to move or scale the old sheet, the panel says so.
- A line that moved less than 0.25 mm, or anti-aliasing, is not a change. Anything that
  moved more, appeared, disappeared or changed is - down to one digit in small text.
- Text is read from both sheets to describe each change ("4200 -> 4500") and to catch tiny
  text edits the picture check alone could miss.
- Old revision clouds taken off are recognised (the scalloped ring itself) and listed
  separately - anything that changed inside the cloud still counts. So are dashed lines whose
  dashes merely start elsewhere along the very same line, with the same dashes and the same
  ends. Anything doubtful stays an ordinary change.
- Two numbers that swapped places (a schedule row re-ordered) are reported as changed there.
  "Show N hidden (...)" on the right lists everything that was set aside, so you can always
  check.
- A big change (a grid moved, a schedule rewritten) is split into pieces of about 150 mm, so
  a sheet like that can show dozens of changes. The panel warns when most of the sheet differs.
- A plan (a view) placed a few mm elsewhere on the new sheet is lined up on its own: it gets a
  dashed outline saying how far it moved ("Moved 1.9 mm down"), and its real changes are found
  where it is now. The move is listed as a change of its own (item 1, "Moved 1.9 mm down"), so it
  is never ticked off unseen; a sheet where nothing else changed says "Moved only" (the summary
  counts them, and "Moved only" lists them). The overlay shows the part lined up; Old, New, Side by
  side and Flicker show the sheets as issued (there the part visibly jumps, and the boxes follow
  the drawing). Excel and the PDF (a blue dashed outline, not a cloud) say which part moved
  and how far. Something moved against what stayed round it - a wall, a room's furniture, a
  building against its grid - is an ordinary change, never a move.
- Part of a drawing that moved because the drawing was stretched (a floor made taller on an
  elevation, a bay made wider on a plan - the walls running into it got longer) is lined up the
  same way but listed as "Stretched 3.0 mm up" ("Shortened" the other way), with the seam marked
  as a change of its own ("Lines 3.0 mm longer here"), and the sheet counts as Changed. In the
  viewer and the clouded PDF the stretched part has an orange dashed outline (not a cloud); the
  seam is clouded.
- When one issue of a sheet has no text layer (a scan, a print with outlined text) its words are
  not compared - the picture still is.

Known limits
------------
- Monster sheets - a drawing made of millions of separate little line pieces (traced line work,
  some CAD exports; a 46 MB landscape sheet needed more memory than the program has): the
  pieces are joined into longer strokes first (drawn the same) and the sheet is compared one
  page at a time. It works, but slowly: such a sheet takes 2-3 minutes the first time, and
  zooming in on it takes up to a minute a picture. The joined copy is kept in the Windows temp
  folder (Rev Radar\heavy) for two weeks, so the next time is quicker; your file is not touched.
- Scanned sheets are checked with a wider tolerance (paper grain, skew): a change as small as
  one digit in small text may not show on scans. Vector PDFs (exported from CAD) are exact.
- Colour-only changes (same line, different colour) are not reported: the check is on the
  ink, not the colour. Nor are line-weight changes up to about half a millimetre (a 0.35 mm
  line drawn 0.7 mm): the thicker line still covers the old one.
- A change hidden entirely under other ink (a line made longer inside a hatched wall) cannot
  be seen on paper and is not reported.
- A sheet that was redrawn or re-plotted at a very different scale shows as mostly changed
  (the panel warns "most of the sheet differs").
- Some CAD sheets blend their whole drawing ("Darken"); those are drawn by a second engine and
  take about a minute each. Such a sheet re-plotted at a slightly different scale can show a few
  extra small changes.
- A view moved more than about 20 mm, or smaller than about 40 x 40 mm, is not recognised as
  moved: it shows as changed all over, as before. Comparing a sheet with a moved view takes
  longer (each part is lined up separately): a few seconds more, up to about a minute more on
  blended sheets (19 tower floor plans: 13 min instead of 9 on a 2-core PC).
  Views drawn right against each other, or moved onto the border, can leave a few small marks
  where they meet (a dashed line's last dashes) - shown as tiny changes, never hidden. On a
  stretched drawing, dashed lines running across the stretch can show as rows of small marks.
- Title block recognition needs a few sheets of the same size; with only one or two sheets,
  revision-table wording is still recognised, other title block edits show as changes.

BOQ tab - two issues of a bill of quantities
--------------------------------------------
  Drop the old BOQ and the new one (Excel .xlsx / .xls, or PDF; one workbook each, or a folder
  of bills each) and Compare. Every item is paired with itself in the other issue - wherever it
  went - by its whole description (the heading lines above it and its own line; "Ditto" read
  with the item above), then by its place between the items round it, then by likeness.
  The list (left) shows what changed, with counts:
    Quantity, Rounded (50.7 -> 51: the same amount written shorter), Unit, Description (an item's
    line or its heading reworded - a heading reworded over many items is one line), Rate / amount
    (priced BOQs), Added, Removed, Moved (another place or bill), Renumbered (refs are lettered
    afresh on every page, so one added item renumbers the page - shown apart, never as removed +
    added), Check (pairings worth a look: descriptions that differ a lot, or an item read from a
    scanned page by OCR).
  Side by side (the default): the old issue on the left, the new one on the right, as issued -
  a PDF BOQ as its own pages, an Excel BOQ as its sheets (row numbers, the columns used) - with
  a tab per file / sheet and its count of changes. The changes are coloured on them - amber
  changed (the changed cells boxed / darker), violet moved, blue added, red removed, gold
  heading reworded, grey renumbered - the legend over the two sides says it in words. Strong
  colour = a real change: Changed, Added, Removed, Heading reworded (the heading says what the
  item is - its line is boxed, its words shown under the two sides); light, dashed = a minor
  change, the item and its heading the same in both issues: Moved, Letter only (renumbered).
  Untick "Minor changes" to see only what really changed. Click a coloured item on either side:
  the other side goes to the same item - in whatever sheet or file it is now - level with it. Scroll either side and
  the other follows, on the sheet / file where the items in view went, kept level by the items
  paired between them. The bar beside each scrollbar marks where the changes are (click one);
  the strip at the bottom says what changed, word by word.
  A PDF: zoom with - / + (or Ctrl + wheel), the % button back to the page width. "Table as
  read" shows the PDF's table as it was read - rows and columns, with the page of each row -
  which is what was compared: where a mark on the page looks wrong, look there.
  Details: the item old and new field by field - where (sheet, row, page, item), heading,
  description with the words taken out struck red and the new ones blue, quantity / unit /
  rate / amount - with the totals and files on the right.
  N / P go through the changes (both views), R ticks one off. Excel (top bar) writes the change register.
  "New issue is changed pages only": for an addendum that re-issues only the pages that
  changed - items it does not have are then not counted as removed.
  Hidden sheets, rows and columns are left out; page furniture (headers, "To Collection",
  "Brought forward") is not read as items. A PDF BOQ is rebuilt from the page - check it.
  Scanned pages (no text layer) are read by OCR (English) first - "Reading scanned pages (OCR)"
  - and what comes from them is marked "check": a scan's words and figures can be misread.
  Ticks are kept: compare the same files again and what you ticked off is still ticked (a file
  issued again since - another size or date - drops them).

Documents tab - specifications and other documents
---------------------------------------------------
  Drop two issues of a spec (one book each, a few files, or a folder of sections each; PDF or
  Word .docx) and Compare. Spec sections ("SECTION 230713 - DUCT INSULATION") are paired by
  number - a book against a folder of section files works too - then their paragraphs: the same
  text, then by place, then by likeness. Headers, footers, page numbers, contents pages and dates
  are left out; clause numbers are compared on their own, so a clause inserted before others
  shows as "Added" and the rest as "Renumbered", not as changed. Changed paragraphs show the
  words taken out and put in; Moved, Added, Removed, whole Sections added or removed.
  Side by side (the default), as for the BOQ: the old issue's pages on the left, the new one's
  on the right, each paragraph changed marked with a band and the words taken out (old) / put
  in (new) boxed; a Word file shows its paragraphs as rows (it has no pages). Legend: amber
  Changed, blue Added, red Removed; light, dashed (minor - the words the same): Moved, Number
  only (renumbered), Punctuation only. Click a change on either side: the other side goes to
  the same paragraph, level; scroll and the other follows. Details: the change word by word.
  N / P / R and the Excel register as for the BOQ.
  A scanned document (no text layer) is read by OCR (English); its paragraphs are marked "check".

Settings (gear, top right)
--------------------------
  Checking resolution (dpi), ignore movements smaller than (mm), join changes closer than (mm),
  sheets compared at once, updates (Go back to the version before), and the
  remembered results. Defaults are right for A0-A3 architectural and structural sheets. A new
  setting applies from the next comparison ("Save and compare again" for the open one).
  Light / dark: the moon button in the top bar.

Where things are kept
---------------------
  Results cache (makes re-opening a comparison instant): %LOCALAPPDATA%\Rev Radar\cache
  (cleared automatically past 3 GB; safe to delete). Settings and logs: %APPDATA%\Rev Radar.
  Updates: %LOCALAPPDATA%\Rev Radar\app (the version running and the one before; older ones
  are cleared). The setup's log: %TEMP%\Rev Radar Setup.log.
  Nothing is ever written next to your drawings.
