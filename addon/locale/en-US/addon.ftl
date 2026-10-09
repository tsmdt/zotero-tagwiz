menuitem-collection-label = Clean Tags…
menuitem-tools-label = Tag Cleaner…

dialog-title = Tag Cleaner
dialog-no-library = Select a library or collection first.

scope-collection = Tags used in “{ $collection }”
scope-library = All tags in “{ $library }”
include-subcollections = Include subcollections
edits-library-wide = Changes always apply to the whole library, not only to this collection.

tab-case = Change case
tab-unify = Unify
tab-remove = Remove
tab-duplicates = Duplicates

filter-placeholder = Filter tags…
select-shown = Select shown
select-none = Select none
selected-count = { $count } selected
tag-list-empty = No tags to show.
col-tag = Tag
col-items = Library
col-in-collection = Collection
flag-auto = auto
flag-color = color

case-style = Style
case-lower = lower case
case-upper = UPPER CASE
case-title = Title Case
case-sentence = Sentence case
case-camel = camelCase
case-pascal = PascalCase
case-snake = snake_case
case-kebab = kebab-case
case-keep-acronyms = Keep ALL-CAPS words (Title/Sentence case)
case-preserve-prefix = Keep the part before “:” or “/”

unify-target = Unify into
unify-hint = Select the tags to merge, then choose or type the name they should all become.
remove-hint = Select the tags to delete from every item in the library.

dup-level = Treat as duplicates
dup-exact = Same name, different type
dup-case = Ignoring case
dup-normalized = Ignoring case, spaces, “-” and “_”
dup-none = No duplicates found among the shown tags.
dup-merge-group = Merge this group
dup-keep = Keep
dup-fuzzy-title = Possible typos and plurals (review each one yourself)
dup-fuzzy-action = Unify…
dup-fuzzy-reason-typo = typo?
dup-fuzzy-reason-plural = plural?
dup-fuzzy-more = Showing the first { $shown } of { $total }.

preview-title = Preview
preview-empty = Nothing to change.
preview-col-change = Change
preview-col-items = Items
preview-col-notes = Notes
op-remove = Remove
op-retype = { $name }: change type to { $type }
type-manual = manual
type-automatic = automatic
note-merge = merges into an existing tag
note-loses-color = loses its color
note-empty = the new name would be empty
note-too-long = the new name is too long
note-target-changed = the target is also changed here
impact = Affects { $total } items in the library, { $outside } of them outside this collection (or in the trash).
impact-library = Affects { $total } items in the library.

apply = Apply
cancel = Cancel
close = Close
undo-last = Undo last run

confirm-title = Apply changes?
confirm-body = Apply { $changes } changes to { $items } items in the library ({ $outside } outside this collection or in the trash)?

    A snapshot is saved first, so “Undo last run” can restore the previous state.
sync-warning = A sync is running. Changing tags now may be overwritten or conflict.
status-working = Applying change { $done } of { $total }…
status-done = Done: { $done } of { $total } changes applied.
status-cancelled = Cancelled after { $done } of { $total } changes. You can undo what was applied.
status-failed = Stopped after { $done } of { $total } changes: { $error }. You can undo what was applied.
status-error = Could not apply: { $error }

undo-confirm = Restore the tags changed by the last run to how they were before?
undo-drifted = These tags changed after the last run: { $tags }. Restoring now would overwrite those newer changes. Restore anyway?
undo-done = Restored { $count } tags.
undo-none = There is nothing to undo.
undo-unavailable = The last run cannot be undone ({ $reason }).
error-read-only = This library is read-only.
error-no-library = The library no longer exists.
error-tags-not-loaded = Zotero has not finished loading tags.
