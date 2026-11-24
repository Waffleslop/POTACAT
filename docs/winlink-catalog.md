# Winlink catalog requests

Status: written 2026-11-24. Not yet proven against Winlink itself; the live check at the end settles
the three open facts.

Winlink will mail you things on request: propagation forecasts, weather text, gateway frequency
lists, nearby stations, help files. Winlink Express calls this "Winlink Catalog Requests". POTACAT's
Winlink mail window now has it as a **Catalog** button.

The rules are in `lib/winlink-catalog.js` (pure, tested by `test/winlink-catalog-test.js`). The
window, the preload and the glue in `main.js` are guarded by `test/winlink-catalog-wiring-test.js`.

## 1. What the operator sees

Three steps:

1. Winlink Mail > **Catalog**. A list opens in the reading pane.
2. Tick what you want. Press **Put in Outbox**.
3. Press **Send / Receive**. A few minutes later, press it again: each answer is an ordinary
   message in the Inbox.

Everything else exists so those three steps need no knowledge of addresses, item codes or where the
list comes from.

### The panel

The panel is `wl-form-catalog`, a `.wl-form` in the reading pane like Forms and the POTA spot form.
The button sits in the folders column after Forms.

| Part | What it shows |
|---|---|
| Title and lead | "Winlink catalog", and one paragraph that says what it is and that each answer arrives as its own message after a second connect. |
| Source row | Where the list comes from, and one button (below). |
| Find box | Has the focus when the panel opens. Searches POTACAT's name, Winlink's subject, the item ID and the category. Every word must match; case does not matter. A find shows at most 300 rows and says so. |
| Your picks | Only when there are any: the items requested before (newest first, the last 8) and every starred item. A starred item stays. |
| The list | Grouped by category. A group head shows the friendly name, Winlink's category code and a count, and opens or closes the group. |
| A row | A checkbox, the name, the item ID, the size when known, a "large" tag at 60 KB and up, and a star. The whole row ticks the box. |
| Action bar | Never scrolls. The running total ("3 items, about 12 KB"), the size advice when it applies, **Close** and **Put in Outbox**. |

### The source row

One line, a button, and sometimes a quiet second button. The first state that applies is shown.

| State | Words | Buttons |
|---|---|---|
| A catalog message is in the Inbox that was not asked for (or is much smaller than the one in use) | "A catalog message from SERVICE is in your Inbox: 1,400 items." With a much smaller one: "... 21 items. Yours has 400." | **Use it**, and a quiet **No thanks** |
| A catalog message could not be read | "A catalog message arrived but POTACAT could not read it. The short list still works." With a full catalog already in use: "A newer catalog message arrived but POTACAT could not read it. Your catalog is unchanged." | **Get the full catalog** / **Update the catalog** |
| The request for the full catalog is in the Outbox | "The full catalog is requested. It arrives as a message of about 70 KB after your next Send / Receive, and this list fills in by itself." | none, so it cannot be queued twice |
| The request has gone out and no catalog has come back yet | the same words | a quiet **Request again** |
| The full catalog is here | "Full catalog: N items, as of 9 March 2026." (Winlink's own date for the catalog, else the date of the message) | **Update the catalog** |
| Only the short list | "Showing the short list. Winlink has several hundred more items." | **Get the full catalog** |

"Could not be read" goes before "requested": an operator is never left waiting on a line with no
button. A request is "in the Outbox" only while its message really is there. If the operator deletes
it before it goes out, the Get button is back at once. "Gone out" lasts until a catalog is read or
7 days pass.

Over a radio mode the Get, Update and Request again buttons first show one line, "The catalog is
about 70 KB. Over the radio that can take a long time; it is quick over Telnet.", with **Request it
anyway** and **Cancel**. Over Telnet they queue at once.

### Two sources, one list

- A **starter list** ships in the app (section 4), so the panel is useful the moment it opens.
- The **full catalog** comes from Winlink itself, by mail. The button queues one request. When the
  reply is in the Inbox, POTACAT recognises it, reads it and the panel shows the whole catalog with
  categories and sizes. There is no file to save and nothing to import.
- A catalog is recognised by its table, not by its sender or subject (neither is verified,
  section 3). That is why it is taken **by itself only when the operator asked for one**: a request
  is pending and the message is dated no earlier than 10 minutes before that request. Even then,
  one with fewer than half the items of the catalog in use is not taken.
- **Any other catalog message is offered, never taken.** One requested from another program, or
  months ago, or sent by anyone at all, gets the line "A catalog message from <sender> is in your
  Inbox: N items." and a **Use it** button. The operator's list changes only on that click. The
  sender is shown as plain text.
- An offer the operator answered (either way), or that a newer catalog superseded, is remembered
  by its message and does not come back.
- The message itself is the operator's mail. POTACAT reads it and leaves it as it is: not marked
  read, not moved, not deleted.
- With the full catalog, the starter list's wording stays as the name of the items it covers; every
  other item shows Winlink's own subject line.
- Every time a catalog is taken or offered, one log line names the sender and the item count.
  No message text is ever written to the log.

### Groups

With the starter list every group is open. With the full catalog (hundreds of items) only a group
holding one of the operator's picks starts open; the rest show their head and count. While finding,
every group with a match is open.

Friendly category names: `PROPAGATION` "Propagation", `WL2K_RMS` "Gateway lists", `WL2K_USERS`
"Stations", `WL2K_HELP` "Help". A US state's weather category reads "Weather: " and the state's name (`WX_US_TX` is
"Weather: Texas"), so typing "texas" in Find finds the Texas items. Any other category that starts
with `WX_` reads "Weather: " and the rest with spaces. Anything else shows Winlink's code as it is.

### Size advice

Sizes are Winlink's own estimates of the uncompressed text. One KB here is 1,000 bytes. The advice
is one plain line in the action bar. It never blocks: the operator may be on a fast link.

| Selection | Line |
|---|---|
| Telnet, any size | none |
| Radio mode, under 15 KB | none |
| Radio mode, 15 KB to under 60 KB | "About N KB. That is several minutes over the radio." |
| Radio mode, 60 KB or more | "About N KB. That is slow over the radio; consider Telnet for this one." |
| Any single item over 120 KB, any mode | adds "Winlink compresses messages; one this large may still be refused by your size limit." |
| A ticked item whose size is not known | the total reads "3 items" with no figure, and there is no line about time |

The 15 KB and 60 KB thresholds are POTACAT's own judgement, not Winlink's. They are named constants
(`ADVICE_NOTE_BYTES`, `ADVICE_SLOW_BYTES`) and are compared on the figure that is shown, so "About
15 KB" never appears without its line. The "large" tag follows the same rule. The 120 KB line follows Winlink's message size limit,
which is measured on the compressed message, so POTACAT cannot know whether a large item fits.

### After Put in Outbox

The reading pane says "The request for 3 items is in the Outbox. It goes out with your next
Send / Receive. The answers arrive a few minutes later, so connect once more to collect them." The
ticks clear and the items join Your picks.

A request of more than 10 items goes out as several messages (10 + 2 for 12 items). If Pat refuses
one part way, the panel says how many items are in the Outbox and keeps the rest ticked.

### Other states

| Case | What happens |
|---|---|
| Find matches nothing | "Nothing in the catalog has those words." With only the short list: "The full catalog has several hundred more items." and the Get button. |
| No callsign set | "Set your callsign in Settings > Station first" (the POTA spot form's words). |
| Pat refuses the message | Its error shows in the panel's error line. The ticks stay. |
| A second click on Put in Outbox | Nothing. One request at a time, in the window and in main. |
| More than 200 items ticked | The first 200 go in the Outbox and the line says "200 of the 230 items are in the Outbox. The other 30 are still ticked." Press again for the rest. |
| The list cannot be loaded again (the shack did not answer, for one) | The list as it was and every tick stay; the error line says why. |
| A star or a request made on another open surface | The panel refreshes by itself. |
| Another operator profile is chosen | The picks and the pending request are that operator's; ticks are not carried over. |
| Typing `INQUIRY` in To of a new message | The compose hint says "This is a Winlink catalog request. The Catalog button builds it for you." |

### What POTACAT never does

- It never sends or queues anything the operator did not click.
- It never connects. Putting a request in the Outbox starts nothing; the next Send / Receive
  carries it, like every other message.
- It never refreshes the catalog on its own.
- It never changes the message the catalog came in.
- It never replaces the operator's catalog with one that was not asked for.
- It never asks Winlink for an item that is not in the catalog in force.

### Keyboard

Tab reaches the find box, every checkbox, every star, every group head and the buttons. Space
ticks a box. Each checkbox is labelled "Request <name>", each star "Keep <name> in Your picks" or
"Remove <name> from Your picks" with its pressed state, and each group head says whether it is
open. The total is a live status line. The panel closes with Close, as the Forms panel does.

## 2. Facts

| # | Fact | Status and source |
|---|---|---|
| F1 | A request is a message To `INQUIRY`, Subject `REQUEST`, with one item ID per line in the body. Several IDs may go in one message. | Verified. Winlink FAQ (revised 2020-07-20), https://winlink.org/sites/default/files/download/wl2k_faq_9.pdf ; a working example from Pat, https://github.com/la5nta/pat/issues/286 |
| F2 | The body `LIST` returns the whole catalog as one text message of about 70 KB: a table with the columns CATEGORY, INQUIRY_ID, SUBJECT (in double quotes), SIZE, ORIGINATED and a flag. | Verified. The FAQ above; the 2025-07-23 comment on Pat issue 286 shows the header line and rows. |
| F3 | Each requested item comes back as its own message, on a later connect, after a few minutes. | Verified in the FAQ above and in a training bulletin, https://www.pcacs.org/wp-content/uploads/2022/08/20220803-Winlink-training-Bulletin-18.pdf |
| F4 | There is no size limit special to the catalog. The account's message size limit applies: 120,000 bytes, compressed, by default and at most. The catalog gives a size estimate per item. | Verified. The FAQ above; https://winlink.org/node/158 |
| F5 | Winlink's web service for the catalog needs an access key issued per application, and new key requests are on hold. | Verified. https://api.winlink.org/ ; https://winlink.org/content/developers (published 2026-10-27). So the `LIST` message is the one route open to POTACAT. |
| F6 | Pat has no catalog feature. POTACAT posts to Pat's outbox, and a bare `INQUIRY` address passes `composeFields` (`lib/winlink-pat.js`). | Verified in Pat's source and ours; the open request is Pat issue 286. |
| F7 | A request only works inside Winlink (over a gateway or Telnet), not from ordinary internet email. | Verified in the FAQ above. |
| F8 | Replies are private messages to the requester. | Verified. https://winlink.org/B2F |

## 3. Not verified

| # | Question | What POTACAT does meanwhile |
|---|---|---|
| U1 | The most IDs one request message may hold. A third-party note says 10, with no source. | Sends at most 10 per message and splits a longer request. Safe whichever is true. |
| U2 | Whether item IDs are case sensitive. | Sends every ID exactly as the catalog spells it. |
| U3 | The reply's exact From and Subject. | Recognises the catalog by its table (header line and row shape), never by From or Subject. |
| U4 | Whether a reply can ever arrive in the same session. | Says "connect again", which is right either way. |
| U5 | Whether a body line may still be a web address that Winlink fetches (the 2020 FAQ says so). | Not offered (section 7). |
| U6 | Whether `UPDATE_CAT` (an update instead of the whole list) still works. | Not used; `LIST` was confirmed working in July 2025. |

The live check (section 8) settles U1, U2 and U3. This document is updated when it has run.

## 4. The starter list

Only IDs seen in two independent public sources, or in an official Winlink source. The names are
POTACAT's own words. No sizes are shipped: they come with the full catalog.

Sources: **X** = Winlink Express's catalog, as recorded in public third-party documentation;
**F** = the Winlink FAQ linked above; **M** = the menu of km4ack's patmenu2,
https://github.com/km4ack/patmenu2 ; **H** = the hf-predict project's request text;
**B** = the training bulletin linked above; **W** = a winlink.org page.

| Category | Winlink category | ID | POTACAT's name | Seen in |
|---|---|---|---|---|
| Propagation | `PROPAGATION` | `PROP_3DAY` | Three-day propagation forecast | X, M |
| Propagation | `PROPAGATION` | `PROP_WWV` | WWV solar and geomagnetic report | X, M, H |
| Gateway lists | `WL2K_RMS` | `PUB_ARDOP` | ARDOP gateways and frequencies | X, M |
| Gateway lists | `WL2K_RMS` | `PUB_PACKET` | Packet gateways and frequencies (large) | X, M |
| Gateway lists | `WL2K_RMS` | `PUB_PACTOR` | Pactor gateways and frequencies | X, F, W (https://winlink.org/node/161) |
| Stations | `WL2K_USERS` | `WL2K_NEARBY` | The 30 stations nearest your last position report | X, M |
| Stations | `WL2K_USERS` | `WL2K_MOBILES` | Stations that posted a position in the last 30 days | X, M, B |
| Help | `WL2K_HELP` | `DIDUNO` | Winlink hints and tips | X, F |
| Help | `WL2K_HELP` | `USER.OPTIONS` | Account options you can set by message | X, W (https://winlink.org/node/158) |

`WL2K_NEARBY` carries a note under its name: "Needs a position report first (Templates > Position
report)."

Left out on purpose: `PUB_VARA` (the VARA gateway list) and `INQUIRIES` (the help text about catalog
requests). Each was found in one unofficial source only. Both appear by themselves once the
operator has the full catalog, if Winlink lists them.

### Licences

Other programs have catalog features: km4ack's scripts (GPL-3.0), tuxlink (AGPL-3.0) and Winlink
Express (Winlink's own). POTACAT copies none of them: no code, no list file, no description text.
Item IDs and the reply's column layout are facts about the service. Every name and sentence here is
POTACAT's. The test fixture is written by hand in the documented shape; its subjects are made up.

## 5. The request and the parser contract

### The request (`buildRequests`, `listRequest`)

- To `INQUIRY`, Subject `REQUEST`.
- Body: the item IDs, one per line, in the order ticked, no line after the last. `composeFields`
  makes the line ends CRLF.
- At most 10 IDs in a message; at most 200 IDs (20 messages) in one press.
- An ID is one word of letters, digits, dot, underscore and hyphen, at most 40 characters. IDs go
  out exactly as written.
- Only items of the catalog in force may be asked for (`checkRequest`): the full catalog's items,
  or the starter list when there is none. One ID that is not among them refuses the whole request.
  The command words `LIST` and `UPDATE_CAT` are never items: they are not listed even when a
  catalog names them, and are refused as an item. The window and the remote wire share this check.
- The full catalog: the same address and subject, body `LIST`.

### The parser contract (`parseCatalogList`)

`parseCatalogList(text)` returns `{ ok, items, modified, reason, skipped, firstLine }`. It never
throws.

1. The header is the first line holding `CATEGORY`, `INQUIRY_ID` and `SUBJECT` in that order, in any
   case. No header: `ok: false`, `reason: 'no-header'`.
2. `Global_Modified: YYYY/MM/DD HH:MM` anywhere above the table becomes `modified`.
3. A row is `CATEGORY  ID  "Subject"  SIZE  YYYY/MM/DD HH:MM  [G]`. The part before the first double
   quote must be exactly two words (category, ID), each of letters, digits, dot, underscore and
   hyphen. The subject ends at the first later quote that is followed by the end of the row, or by
   blank space and then a size, a date or a flag. So a subject may hold quotes of its own, and a
   quote in a later column does not stretch it. A line with no such closing quote is not a row. A
   size is a whole number, with or without thousands separators (`1,234`).
4. Tolerated: tabs or runs of spaces, a missing size (`size: null`), a missing date, a missing flag,
   CRLF, trailing spaces, blank lines. A line that is not a row is skipped and counted in `skipped`.
5. It is a catalog only when at least 20 rows parse and they are at least 80% of the non-blank
   lines after the header. Otherwise `ok: false`, `reason: 'not-a-table'`, and `firstLine` is the
   first non-blank line after the header (120 characters). This keeps a help text that merely
   mentions the column names from being taken for a catalog.
6. IDs and categories are kept exactly as written. A second row with the same ID is dropped.
7. Limits: 5,000 items; a subject is cut at 200 characters; a line over 1,000 characters is
   skipped; text past 2,000,000 characters is not read.

8. Known limit: a subject that holds a double quote followed by a space and a number, such as
   `"Chart 5" 12 hour forecast"`, ends at that inner quote (the subject reads `Chart 5` and 12 is
   taken for the size). The table has no escaping, so the two readings cannot be told apart. The
   item ID is unaffected and the item can still be requested.

An item is `{ category, id, subject, size }`.

`looksLikeCatalog(message)` is the cheap check before parsing: the body is over 5,000 characters
and holds `INQUIRY_ID` in any case.

### Untrusted text

Catalog text arrives in mail, so it is untrusted. Categories and IDs are held to the word rule
above. A subject is plain text: the window builds every row from DOM nodes and `textContent`, never
from an HTML string, and a guard test fails if `innerHTML` appears in the catalog code.

### Reading the Inbox

Every decision is a pure function in `lib/winlink-catalog.js`; `main.js` supplies Pat and applies
the result. The glue itself is run by `test/winlink-catalog-glue-test.js`.

When the Inbox is looked at (`shouldScan`):
- while a request for the full catalog is pending, after each refresh of the Inbox;
- once when the Catalog panel is first opened in a run (this is what finds an older reply);
- when Get, Update or Request again is pressed.

Which messages are read (`toExamine`): every Inbox message not examined before, whatever its date.
What was examined is remembered by message ID, per operator profile (a profile switch restarts
POTACAT, so a pass never spans two profiles). The set is pruned to the Inbox as it is now and is
never cut below it (5,000 at most), so a pass can only add to it: a look reads each message once,
always ends, and writes the settings only when the set changed. It is not
remembered by date: a message's date is the sender's, and a future-dated or out-of-order message
must never hide the reply. Reads are one at a time, newest-dated first, at most 200 in a pass; when
more wait, another pass follows.

What happens to one message (`decideMessage`):

| The message | Result |
|---|---|
| Not over 5,000 characters, or no `INQUIRY_ID` in it, or no header line | Not a catalog. Nothing is flagged or logged. |
| Header found, the table does not parse, fewer than 5 rows read | Not a catalog, pending or not. A help text that shows the column names lands here and never ends a wait. |
| Header found, the table does not parse, at least 5 rows read | "Could not read it": noted with its message ID (so a restart still explains it), and one log line gives the sender and the row counts. |
| A catalog, a request is pending, the message is dated no earlier than 10 minutes before the request, and it has at least half the items of the catalog in use | Taken. |
| A catalog in any other case (nobody asked, dated before the request, or much smaller) | Offered. The operator's list is unchanged until **Use it**. |
| A catalog from a message already answered or superseded | Passed over. |

The wait ends (`applyScan`) when the reply arrived: a catalog was taken, or a message dated after
the request was offered or could not be read. It never ends while the request's own message is
still in the Outbox, and an older catalog found on the way ends nothing.

A message counts as examined only on a clean answer (not a catalog, could not read it, offered) or
after its catalog was written to disk. A read that fails, a Pat that does not answer, or a write
that fails or is refused (the settings write gate during a profile switch) leaves it unexamined:
nothing is set in memory, no success is logged, and the next pass asks again.

## 6. Data files and settings

| What | Where | Notes |
|---|---|---|
| The full catalog | `winlink-catalog.json` in POTACAT's user data folder | `{ modified, readAt, sourceMid, sourceDate, sourceFrom, items }`. One file for every operator profile: the catalog is the same for everyone. Written atomically. Never synced to the cloud. Deleting it brings back the short list. |
| Picks | settings `winlinkCatalogPicks`, `winlinkCatalogPicksAt` | Per operator profile: `{ starred: [ids], recent: [ids] }`, at most 50 and 8, and when they last changed. |
| Pending request | setting `winlinkCatalogRequest` | Per operator profile: `{ at, mid }`, when the `LIST` request was queued and which Outbox message it is (`mid` is empty when that could not be told). Removed only by `settleRequest`. |
| An offer | setting `winlinkCatalogOffer` | Per operator profile: `{ mid, from, date, count, have }` of a catalog message waiting for **Use it**. The items are read from the message again on the click. |
| Answered offers | setting `winlinkCatalogDeclined` | Per operator profile: the last 50 message IDs not to offer again. |
| Examined mail | setting `winlinkCatalogExamined` | Per operator profile: the Inbox message IDs already examined (pruned to the Inbox, 5,000 at most). (An earlier date mark, `winlinkCatalogScannedTo`, is ignored and removed.) |
| Could not read | setting `winlinkCatalogUnreadable` | Per operator profile: `{ mid }` of the catalog message that could not be read. Cleared when a good catalog is read or used. |

None of these is a secret.

Where a request stands (`settleRequest`):

| Kind | When | Shown as |
|---|---|---|
| queued | Its message is known to be in the Outbox. | "requested", no button |
| sent | Its message is in Sent, or it could not be identified. | "requested", with **Request again** |
| unknown | Its message is in neither folder as far as is known: the folders are not listed yet, the Sent list is older than the Outbox's, or Sent failed to list. | "requested", no button; settled by the next full refresh |
| none | Nothing is waited for. | Get / Update |

A request is forgotten only when: a catalog was read after it; its message is gone from the Outbox
and a Sent list taken with or after that Outbox list does not hold it (the operator deleted it
before it went); or 7 days have passed and its message is not in the Outbox. A request stamped up
to an hour ahead of the clock (the clock was set back) counts as just made.

Queuing the request (`listRule`, `newRequest`): Pat's Outbox is listed afresh and each catalog
request in it is read, never the cached list. While a `LIST` request is in the Outbox no second one
is queued, whatever the state says; the panel then says "A request for the full catalog is already
in the Outbox. It goes out with your next Send / Receive.", and a `LIST` found there that nobody
recorded is adopted as the request. After the send the Outbox is listed again; the `LIST` message
that is new (of several, the one dated nearest the send) is the one the request is tied to. The
lock that allows one catalog request at a time is taken before the first listing. A newly queued
request clears the "could not read" note, and a request newer than that note outranks it.

Window calls (the Winlink window's preload): `catalogGet`, `catalogRequest(ids)`,
`catalogRequestList(again)`, `catalogStar(id, on)`, `catalogOffer(use)`, `onCatalogUpdated`. Channels:
`winlink-catalog-get`, `winlink-catalog-request`, `winlink-catalog-request-list`,
`winlink-catalog-star`, `winlink-catalog-offer`, and the push `winlink-catalog-updated`.

Sending uses `winlinkSend`, the path every message takes, so the Winlink notice gate, the Outbox
count and every other rule apply unchanged.

### Remote shack and ECHOCAT

The shack holds the catalog, the picks and the pending request, as it holds the mailbox.

- A desktop driving a remote shack: the five window calls go to the shack over the existing link
  (`lib/winlink-remote-shack.js`), so the panel shows the shack's catalog and the request goes into
  the shack's Outbox. A shack that predates the catalog (no `winlink-catalog` in its hello) is
  named at once: the panel says "The POTACAT on the shack PC is older and has no catalog yet.
  Update POTACAT on the shack PC, then open Catalog again." and offers nothing that would not work.
- ECHOCAT devices can ask for the same with the wire messages `winlink-catalog-get`,
  `winlink-catalog-request`, `winlink-catalog-request-list`, `winlink-catalog-star` and
  `winlink-catalog-offer` (`docs/echocat-protocol.md`). The `winlink-catalog` reply carries the
  whole item list in one frame (about 150 kB for 1,400 items), so a device asks for it when its
  panel opens or the stamp changes, never on a timer. A Guest Pass is refused, as for all Winlink messages.
- `winlink-state.catalog` is a small stamp (`count`, `readAt`, `requestedAt`, `pendingKind`,
  `unreadable`, `offerMid`, `picksAt`). A surface asks for the catalog again when it changes (a
  star or a request on another surface included); that is how the list "fills in by itself"
  on every surface.
- ECHOCAT Web has no Catalog panel yet, as it has no Forms panel.

## 7. Out of scope for this version

- Requesting a web address in the body (U5). Verified only in a 2020 FAQ. A later "A web page" row,
  after one live test.
- Saildocs (GRIB files and text weather by `send` lines). A different service with its own address
  and grammar: a separate feature.
- `UPDATE_CAT`. `LIST` always works, and 70 KB over Telnet is nothing.
- Winlink's keyed web service (F5). If Winlink reopens key requests, "Get the full catalog" could
  become instant over the internet; the panel would not change.
- Connecting by itself to collect the answers. Connecting is always the operator's action.

## 8. Live check

The one thing code cannot prove. Three steps, by hand, over Telnet:

1. Winlink Mail > Catalog > tick "Three-day propagation forecast" > Put in Outbox >
   Send / Receive. A few minutes later, Send / Receive again: the forecast is in the Inbox.
2. Catalog > Get the full catalog > Send / Receive, wait, Send / Receive: the panel shows the full
   list with sizes without any other action.
3. Tick 12 items > Put in Outbox: the Outbox holds two request messages (10 and 2).

Report anything that differs: the reply's subject, the table's shape, a refused request. U1, U2 and
U3 are settled by this, and sections 2 and 3 are then updated.

## 9. Tests

- `test/winlink-catalog-test.js`, all executed against the rules:
  - the parser against the hand-written fixture and its hostile variants (tabs, no sizes, an
    apostrophe, two spaces in a subject, quotes inside and after the subject, thousands separators,
    CRLF, a truncated last line, 30 lines of preamble, a message that only mentions INQUIRY_ID,
    markup, huge input, lines built to be slow);
  - what to do with one message: not a catalog, could not read it, taken, offered, the shrink rule,
    a forged 21-row mail in each state;
  - the pass over the Inbox with a stand-in for Pat: newest wins, a failed read, a refused or
    failing write, pending cleared on read, pending plus an unreadable reply, future and
    out-of-order dates, a catalog dated before the request, the cap;
  - where a request stands: queued, deleted, sent, unknown (a stale or failed Sent list), expired,
    answered, a clock set back;
  - which IDs may be asked for, the command words, more than 200;
  - the request messages for 1, 10, 11 and 25 IDs and the exact bytes Pat is given; search and
    grouping; size advice per mode and threshold; the picks; the source row in every combination;
    every sentence;
  - when a Pat binary is present (`assets/pat`, or `POTACAT_TEST_PAT`): a real Pat, offline. Where
    there is none the check is skipped and says so.
- `test/winlink-catalog-glue-test.js`: `main.js`'s catalog functions lifted out and run with
  stand-ins for Pat, the settings, the cached folders and the file write: which Outbox message a
  request is tied to, no second `LIST`, an old catalog while pending, a reply while the request is
  still in the Outbox, a stale or failed Sent list, a save that throws or is refused, an offer
  arriving during Use it, a profile switch in the middle of a pass, more than 200 through the
  remote link.
- `test/winlink-catalog-wiring-test.js`: the button and panel, the preload methods and channels,
  `hideForms`, the one send path, no connect, the glue making no decision of its own, the Inbox
  message never changed, no `innerHTML` with catalog text, the remote link's rows and wire messages.
