menuitem-collection-label = TagWiz 🏷️
menuitem-tools-label = TagWiz 🏷️

dialog-title = TagWiz 🏷️
dialog-no-library = Select a library or collection first.
dialog-busy = TagWiz is still applying changes. Open it again from there once it has finished.

scope-collection = Tags used in “{ $collection }”
scope-library = Showing all tags in “{ $library }”
include-subcollections = Include subcollections
edits-library-wide = Changes always apply to your whole library.

tab-case = Change Case
tab-unify = Rename & Merge
tab-remove = Remove
tab-duplicates = Clean Duplicates
tab-history = History

filter-placeholder = Filter tags…
select-shown = Select All
select-none = Deselect
selected-count = { $count } selected
selected-count-hidden = { $count } selected ({ $hidden } not shown)
tag-list-empty = No tags to show.
tag-list-more = Showing the first { $shown } of { $total } tags. Use the filter to find the others.
col-tag = Tag
col-type = Type
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
case-keep-acronyms = Keep ALL-CAPS and mixed-case words (NLP, iPhone)
case-prefix = Keep prefix
case-prefix-placeholder = e.g. TECH:
case-prefix-hint = Tags starting with this text keep it exactly as typed (case-sensitive, spaces count).

unify-target = New name
unify-target-placeholder = Type a new tag label…
unify-hint = Select one tag to rename it, or several to merge them into one. Then choose or type the new name.
remove-hint = Select the tags to delete from every item in the library.

dup-level = Treat as duplicates
dup-exact = Same name, different type
dup-case = Ignoring case
dup-normalized = Ignoring case, accents, spaces, “-” and “_”
dup-groups-title = Duplicate groups
dup-none = No duplicates found among the shown tags.
dup-groups-more = Showing the first { $shown } of { $total } groups. All ticked groups are merged, also those not shown.
dup-merge-group = Merge this group
dup-keep = Keep
dup-fuzzy-title = Possible typos and plurals (review each one yourself)
dup-fuzzy-action = Merge…
dup-fuzzy-reason-typo = typo?
dup-fuzzy-reason-plural = plural?
dup-fuzzy-more = Showing the first { $shown } of { $total }.

preview-empty = Nothing to change.
preview-more = Showing the first { $shown } of { $total } changes. All of them are applied.
preview-col-change = Change
preview-col-items = Items
preview-col-notes = Notes
op-remove = Remove
op-retype = { $name }: change type to { $type }
type-manual = manual
type-automatic = auto
type-both = both
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

confirm-title = Apply changes?
confirm-body = Apply { $changes ->
        [one] 1 change
       *[other] { $changes } changes
    } to { $items ->
        [one] 1 item
       *[other] { $items } items
    } in the library ({ $scope ->
        [collection] { $outside } of them outside this collection or in the trash
       *[library] items in the trash included
    })?

    A snapshot is saved first, so you can undo this in the History tab.
confirm-remove-title = Remove tags?
confirm-remove-body = Remove { $count ->
        [one] this tag
       *[other] these { $count } tags
    } from { $items ->
        [one] 1 item
       *[other] { $items } items
    } in the library ({ $scope ->
        [collection] { $outside } of them outside this collection or in the trash
       *[library] items in the trash included
    })?

    { $names }

    A snapshot is saved first, so you can undo this in the History tab.
confirm-remove-more = …and { $count } more
sync-warning = A sync is running. Changing tags now may be overwritten or conflict.
status-working = Applying change { $done } of { $total }…
status-done = Done: { $done } of { $total } changes applied.
status-skipped = { $count ->
        [one] 1 of them changed nothing: its tag is no longer used.
       *[other] { $count } of them changed nothing: their tags are no longer used.
    }
status-cancelled = Cancelled after { $done } of { $total } changes. You can undo what was applied in the History tab.
status-failed = Stopped after { $done } of { $total } changes: { $error }. You can undo what was applied in the History tab.
status-error = Could not apply: { $error }
status-plan-changed = Tags were changed elsewhere in Zotero, so the preview was updated. Review it and apply again.
status-closing = Stopping after the current change, then closing…
error-load = Could not load the tags: { $error }

history-title = Edit History
history-col-date = Date
history-col-time = Time
history-col-kind = Edit Type
history-col-items = Items
history-col-status = Status
history-kind-case = Change case
history-kind-rename = Rename
history-kind-merge = Merge
history-kind-duplicates = Clean duplicates
history-kind-remove = Remove
history-status-undone = undone
history-status-interrupted = interrupted
history-empty = No edits yet.
history-hint = To undo or redo certain edits, select them from the list below and click "Apply".
history-select = Select an edit to undo or redo.
history-unreadable = { $count ->
        [one] 1 snapshot could not be read and is not listed.
       *[other] { $count } snapshots could not be read and are not listed.
    }
history-undo-count = { $count ->
        [one] Undoing 1 edit.
       *[other] Undoing { $count } edits.
    }
history-redo-count = { $count ->
        [one] Redoing 1 edit.
       *[other] Redoing { $count } edits.
    }
history-undo = Undo
history-redo = Redo
history-undo-confirm = Return the tags to how they were before the edit of { $date } { $time }? { $count ->
        [one] This undoes that edit.
       *[other] This undoes that edit and { $later ->
            [one] the 1 edit
           *[other] the { $later } edits
        } made after it.
    }
history-redo-confirm = Apply the edit of { $date } { $time } again? { $count ->
        [one] This redoes that edit.
       *[other] This redoes that edit and { $earlier ->
            [one] the 1 undone edit
           *[other] the { $earlier } undone edits
        } before it.
    }
history-unreadable-skipped = A snapshot among these edits could not be read (it may have been damaged, e.g. by a crash). If it holds an edit of this library, that edit is skipped.
history-undo-done = { $count ->
        [one] Undone: 1 edit.
       *[other] Undone: { $count } edits.
    }
history-redo-done = { $count ->
        [one] Redone: 1 edit.
       *[other] Redone: { $count } edits.
    }
history-drifted = These tags changed after the edit of { $date } { $time }: { $tags }. Undoing it now would overwrite those newer changes, and they cannot be brought back. Undo anyway?
history-interrupted = The edit of { $date } { $time } was interrupted, so TagWiz cannot tell whether its tags were changed again afterwards. Return them to how they were before that edit anyway? Newer changes to them cannot be brought back.
history-redo-drifted = These tags changed after the edit of { $date } { $time } was undone: { $tags }. Redoing it now would overwrite those changes, and they cannot be brought back. Redo anyway?
history-undo-partial = Stopped after undoing { $done } of { $total } edits.
history-redo-partial = Stopped after redoing { $done } of { $total } edits.
history-not-found = That edit can no longer be undone or redone.
error-read-only = This library is read-only.
error-no-library = The library no longer exists.
error-tags-not-loaded = Zotero has not finished loading tags.
error-two-targets = “{ $name }” cannot be renamed to two different names at once.
error-split-types = “{ $name }” is used both as a manual and an automatic tag; renaming it must include both.
