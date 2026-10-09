# TagWiz

TagWiz is a [Zotero](https://www.zotero.org/) plugin for cleaning up tags in bulk: change their case, unify or remove several at once, and find and merge duplicates. Every change is previewed before it is applied, and the last run can be undone.

## Features

- **Change case**: lower case, UPPER CASE, Title Case, Sentence case, camelCase, PascalCase, snake_case or kebab-case.
- **Unify**: pick several tags and a name, and every selected tag becomes that tag. The name can be one of the selected tags, another existing tag, or a brand-new name.
- **Remove**: delete the selected tags from every item.
- **Duplicates**: find tags that differ only by case, spacing or separators, choose which spelling to keep, and merge the rest into it. Possible typos and plurals are suggested for review but never merged automatically.
- **Preview first**: each change is listed with the number of items it affects, notes for merges and lost colors, and a checkbox to leave a change out.
- **Undo**: a snapshot is saved before the first change of every run, and **Undo last run** restores it.
- **Safe with types and colors**: manual and automatic tags keep their type, and tag colors move with the tag. A colored target tag keeps its own color.

## Compatibility

TagWiz was developed and tested on **Zotero 10.0.6**. The add-on manifest accepts Zotero 6.999 up to 10.\*, but earlier versions have not been tried. In particular, the fallback used for menus on Zotero versions without `Zotero.MenuManager` is untested.

## Installation

There is no packaged release yet, so build the plugin from source:

```sh
npm install
npm run build
```

Then, in Zotero, open **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…** and select `.scaffold/build/tag-wiz.xpi`.

## Usage

Open TagWiz from the **Tools** menu, or right-click a collection and choose **TagWiz**. The window lists the tags used in the selected collection, or all tags if a library is selected. The **Include subcollections** checkbox decides whether items in subcollections count.

> [!important]
> The collection only decides which tags are listed. **Every change applies to the whole library**, including items outside the collection and in the trash. The preview and the confirmation dialog say how many items are affected and how many of them are outside the collection.

Pick a tab, select tags (the filter box helps with long lists), check the preview, untick anything you do not want, and press **Apply**.

### Change case

Choose a style. Two options refine it:

- _Keep ALL-CAPS words_ (Title and Sentence case): `NLP methods` becomes `NLP Methods` instead of `Nlp Methods`.
- _Keep the part before ":" or "/"_: in `topic:machine learning` only the part after the colon changes.

| Style         | `machine learning` becomes |
| ------------- | -------------------------- |
| lower case    | machine learning           |
| UPPER CASE    | MACHINE LEARNING           |
| Title Case    | Machine Learning           |
| Sentence case | Machine learning           |
| camelCase     | machineLearning            |
| PascalCase    | MachineLearning            |
| snake_case    | machine_learning           |
| kebab-case    | machine-learning           |

Small words such as _of_ and _the_ stay lower case in Title Case, except at the start. Case changes do not depend on your system language. If two tags end up with the same name, the preview marks them as a merge.

### Unify

Select two or more tags and type or pick the name they should become. The field starts with the most-used selected tag. If the name is a new one, the first colored tag among the selected ones lends it its color.

### Remove

Select tags and apply. Tags that have a color lose it, and the preview says so.

### Duplicates

Choose how strict the match is:

- _Same name, different type_: the same text used as both a manual and an automatic tag.
- _Ignoring case_: `Machine Learning` and `machine learning`.
- _Ignoring case, spaces, "-" and "\_"_: also treats `machine-learning`, `machine_learning`, `machineLearning` and accented variants as the same. Names that differ in other punctuation, such as `C++` and `C#`, are never grouped.

Each group suggests a tag to keep: the most used one, and on a tie a colored one, then a manual one. Pick a different radio button to keep another spelling, or untick the group to skip it. Below the groups, **Possible typos and plurals** lists near-matches; **Unify…** sends a pair to the Unify tab, where you decide.

### Undo and snapshots

Before the first change of each run, TagWiz saves a snapshot of the affected tags to a `tagwiz` folder inside your Zotero data directory and keeps the 10 most recent ones. **Undo last run** restores the tags from the latest run:

- which items carry the tags, their manual or automatic type, and their colors;
- only the most recent run can be undone, and each run only once;
- if the tags were changed again after the run (for example by a sync), TagWiz lists them and asks before overwriting those newer changes.

Edits do not touch an item's _Date Modified_, but Zotero marks the items as changed, so they sync like any other edit. Sync can overwrite or conflict with tags you change while it is running, so TagWiz warns if one is in progress. As with any bulk edit, keep a backup of your Zotero data before the first big run.

## Development

You need [Node.js](https://nodejs.org/) (LTS) and a Zotero installation to run the plugin in.

```sh
npm install
cp .env.example .env   # then fill in the paths, see below
npm start              # build, start Zotero with the plugin, reload on changes
```

In `.env`, point `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` at your Zotero binary and `ZOTERO_PLUGIN_PROFILE_PATH` at a **separate development profile** (create one with `zotero -p`). Never sign in to sync in that profile. To try the plugin on real data, copy `zotero.sqlite` into a separate folder, set `ZOTERO_PLUGIN_DATA_DIR` to it, and never use your live data directory. `.gitignore` already excludes `.env`, `*.sqlite` and `zotero-dev-data/`.

| Command              | What it does                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `npm start`          | Run Zotero with the plugin loaded and hot reload                                            |
| `npm run build`      | Production build and type check; writes `.scaffold/build/tag-wiz.xpi`                       |
| `npm run test:unit`  | Unit tests of the pure logic in plain Node (fast)                                           |
| `npm test`           | All tests inside Zotero, including the engine tests against a throwaway library             |
| `npm run lint:check` | Prettier and ESLint                                                                         |
| `npm run release`    | Bump the version, tag and push; the GitHub workflow builds and publishes (see the scaffold) |

If you build on one operating system and run Zotero on another from the same folder, run `npm install` on each: some dependencies ship platform-specific binaries.

### Project layout

```text
src/
  core/      pure logic, no Zotero APIs: case styles, duplicate detection,
             change plans, task folding (unit-tested in Node)
  zotero/    everything that touches Zotero: tag store (reads), engine
             (rename/retype/remove), snapshots and undo, preflight checks
  ui/        the dialog: an XHTML shell (addon/content/dialog.xhtml) filled
             in by TypeScript
  modules/   menu registration
  hooks.ts   plugin lifecycle (startup, window load, shutdown)
addon/       manifest, dialog shell and stylesheet, Fluent strings (locale/)
test/        unit/ runs in Node; engine.test.ts runs inside Zotero
```

How edits are applied is worth knowing before changing the engine. `Zotero.Tags.rename` is only used when no automatic tag is involved, because it turns every renamed tag into a manual one; otherwise tags are edited item by item. Tag colors are read from the synced `tagColors` setting, because the positions cached by `Zotero.Tags.getColors()` can be stale. Every SQL statement run through `Zotero.DB.queryAsync` must start with `SELECT` and name its columns with aliases, or the rows come back empty or unreadable.

## Acknowledgements

Built on the [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) with the [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit), the [Zotero Plugin Scaffold](https://github.com/northword/zotero-plugin-scaffold) and [Zotero Type Definitions](https://github.com/windingwind/zotero-types).

## License

[AGPL-3.0-or-later](LICENSE). No warranties are provided.
