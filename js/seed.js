/* Synapse — starter vault shown on first launch. All sample content is fictional. */
(function (S) {
  'use strict';
  S.seedVault = async () => {
    const now = Date.now();
    const P = (o, ago = 0) => S.newPage(Object.assign({ created: now - ago, updated: now - ago }, o));

    const welcome = P({
      title: 'Welcome to Synapse', icon: '🧠', favorite: true,
      content: `Synapse is your **offline second brain** — Obsidian-style linked notes meets Notion-style pages and databases. Everything lives in this browser, on this device. No account, no cloud.

> [!tip] Start here
> Type \`/\` anywhere in a note for the block menu, and \`[[\` to link another page. Press **Ctrl+K** to jump anywhere.

## Connect ideas
- Link a page: [[Atomic notes]] — typing \`[[\` autocompletes titles.
- Link a **section**: [[Linking your thinking#Why links beat folders]]
- Rename a link's text: [[Evergreen notes|notes that keep growing]]
- Cite a **specific page of a book**: [[Thinking in Networks@42]] — books collect every citation in their *Backlinks* panel.
- Link to a page that doesn't exist yet, like [[Spaced repetition]], then click it to create it.
- Tag anything: #inbox #learning

## See the connections
- 🕸️ **Graph view** (sidebar) shows your whole vault. Hover to highlight neighbours, drag to rearrange, scroll to zoom.
- The **◫ panel** on the right shows backlinks, unlinked mentions, an outline and a *local graph* of this page.

## Diagrams & pictures
- Paste or drag an image straight into a note.
- Make a diagram with **◇ Diagram** in the sidebar, then embed it in any note:

![[Note-taking workflow]]

## Databases
Every page has a **type** (note, book, person, project…) and properties. Browse them in 🗂️ **Databases** as a table, kanban board or gallery — or drop a live query into a note:

\`\`\`query
type:book
\`\`\`

## Your checklist
- [x] Open Synapse
- [ ] Create your first page with **＋ New page**
- [ ] Add a book to the 📚 Library and cite it
- [ ] Open the graph view
- [ ] Export a backup from ⚙️ Settings (your data lives only in this browser!)
`,
    }, 5000);

    const book = P({
      title: 'Thinking in Networks', type: 'book', icon: '📘',
      props: { author: 'A. Example', year: '2021', status: 'In progress', rating: '4', pages: '240', tags: 'books, learning' },
      content: `*A fictional sample book, so you can see how book notes and page citations work.*

## Summary
Ideas become valuable when they connect. The book argues for small, linked notes over long documents filed in folders.

## Key ideas
1. One idea per note → see [[Atomic notes]]
2. Links are more flexible than folders → [[Linking your thinking]]
3. Notes should be revisited and grow over time → [[Evergreen notes]]

## Quotes & highlights
> "Write notes for your future self, who has forgotten everything." — p. 42

## Questions
- [ ] How does this compare with a traditional commonplace book?
`,
    }, 4000);

    const atomic = P({
      title: 'Atomic notes', type: 'concept',
      content: `Each note should hold **one idea**, expressed in your own words, so it can be linked from many places.

The author makes this point on [[Thinking in Networks@17]] and returns to it on [[Thinking in Networks@42]].

## Rules of thumb
- Title the note with the idea itself
- Keep it short enough to read in a minute
- Link it to at least one other note, e.g. [[Linking your thinking]]

#learning #method
`,
    }, 3000);

    const linking = P({
      title: 'Linking your thinking', type: 'concept',
      content: `## Why links beat folders
A note can only sit in one folder, but it can have many links. Links let one idea live in many contexts.

See the discussion in [[Thinking in Networks@88-91]].

## How to link well
- Explain *why* you're linking: "this contradicts [[Evergreen notes]]"
- Prefer links to tags for ideas; use tags for status like #inbox

#method
`,
    }, 2500);

    const evergreen = P({
      title: 'Evergreen notes', type: 'concept',
      content: `Notes that are written to evolve and accumulate over time, rather than being captured once and forgotten.

They are built from [[Atomic notes]] and densely linked ([[Linking your thinking]]).

> [!question] Open question
> How often should evergreen notes be reviewed? Maybe related to [[Spaced repetition]].

#learning
`,
    }, 2000);

    const author = P({
      title: 'A. Example', type: 'person', props: { role: 'Author' },
      content: `Author of [[Thinking in Networks]]. (A fictional person for the sample vault.)`,
    }, 1800);

    const project = P({
      title: 'Build my second brain', type: 'project', icon: '🚀',
      props: { status: 'In progress', due: S.isoDay(new Date(now + 14 * 864e5)) },
      content: `## Goals
- [ ] Import my old notes (⚙️ Settings → Import Markdown)
- [ ] Read and summarise 3 books
- [ ] Write 20 [[Atomic notes]]

## Related
- [[Welcome to Synapse]]
- Book notes so far:

\`\`\`query
type:book view:list
\`\`\`
`,
    }, 1500);
    project.parentId = null;

    const sub = P({ title: 'Reading list', parentId: project.id, icon: '📖', content: '- [ ] [[Thinking in Networks]]\n- [ ] Find two more books\n\n#reading' }, 1400);

    const canvas = P({ title: 'Note-taking workflow', type: 'canvas', icon: '◇', content: '' }, 1000);
    canvas.canvas = {
      view: { x: 60, y: 120, k: 0.9 },
      nodes: [
        { id: 'n1', kind: 'text', shape: 'ellipse', x: 0, y: 40, w: 150, h: 80, color: 'blue', text: '**Capture**\nfleeting notes' },
        { id: 'n2', kind: 'text', shape: 'rect', x: 230, y: 40, w: 160, h: 80, color: 'yellow', text: '**Process**\nrewrite in own words' },
        { id: 'n3', kind: 'page', pageId: atomic.id, x: 470, y: 10, w: 230, h: 140, color: '' },
        { id: 'n4', kind: 'text', shape: 'diamond', x: 490, y: 220, w: 190, h: 120, color: 'purple', text: 'Connects to\nexisting notes?' },
        { id: 'n5', kind: 'text', shape: 'rect', x: 230, y: 240, w: 160, h: 80, color: 'green', text: '**Create**\nessays, projects' },
      ],
      edges: [
        { id: 'e1', from: 'n1', to: 'n2', label: '' },
        { id: 'e2', from: 'n2', to: 'n3', label: 'distil' },
        { id: 'e3', from: 'n3', to: 'n4', label: '' },
        { id: 'e4', from: 'n4', to: 'n5', label: 'yes → link' },
      ],
    };

    const tplBook = P({
      title: 'Book notes', type: 'template', icon: '🧩',
      content: `## Summary


## Key ideas
1.

## Quotes & highlights
> "" — p.

## How this connects
-

#books
`,
    }, 900);
    const tplDaily = P({
      title: 'Daily', type: 'template', icon: '🧩',
      content: `## Top 3
- [ ]
- [ ]
- [ ]

## Notes


## Ideas worth keeping
`,
    }, 800);

    for (const p of [welcome, book, atomic, linking, evergreen, author, project, sub, canvas, tplBook, tplDaily]) await S.db.putPage(p);
    return welcome;
  };
})(window.S);
