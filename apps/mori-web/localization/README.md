# Bootstrapping Monku no Mori's Japanese interface

Monku no Mori can edit its own English-to-Japanese UI strings as a regular translation project.

Run the source extractor from the t3code root:

    node apps/mori-web/scripts/bootstrap-ui-project.cjs --install

This scans static JSX labels, titles, placeholders and selected messages, generating localization/MonkuNoMoriUI.mori and installing/updating the native project named Monku no Mori · Interface (EN → JA). Existing curated and AI drafts are preserved when English strings match. Stable row IDs are derived from English text rather than source line numbers.

To translate, choose the project from Mori's project picker, then use the Matrix or AI Chats as usual. The source file and line are in each row's notes. English remains authoritative and final Japanese is stored in the regular native project file.

Settings -> Language switches between English and Japanese. Translated labels appear immediately; untranslated labels fall back to English. The app loads curated UI translations from the self-translation project independently of whichever project is currently active.

Current first milestone: the core sidebar, titlebar breadcrumb, search command, and selected Settings elements call tr(). The catalog also includes many more UI strings that are not wired at runtime yet. Continue integrating tr() progressively in the remaining components; never translate user content, IDs or code. If a new string is added to the source, run the extractor again.
