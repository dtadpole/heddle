//! Name order, as the TypeScript build's `Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })`
//! orders folder and file names.
//!
//! The tree sorts each level with that collator, and a session tie-break uses it too. What it does, and
//! so what this reproduces for the names a tree meets:
//!
//! - **case and accents are ignored** (`base` sensitivity): `Readme` and `README` compare equal, and an
//!   equal pair keeps its input order (byte order, from the directory read);
//! - **digit runs compare by value** (`numeric`): `item-2` before `item-10`;
//! - **ICU's root order of character classes**: whitespace, then punctuation (`_` `-` `,` `;` `:` `!`
//!   `?` `.` `'` `"` `(` `)` `[` `]` `{` `}` `@` `*` `/` `\` `&` `#` `%` `` ` `` `^` `+` `<` `=` `>`
//!   `|` `~` `$`, in that order), then digits, then letters. So `_tools_` sorts before `dist`, as it does
//!   in the TypeScript tree.
//!
//! It is an approximation of full ICU collation, exact for ASCII names and for Latin letters with
//! common accents; other scripts fall back to code-point order after the classes above.

use std::cmp::Ordering;

/// Compare two names the way the tree orders them.
pub fn compare_names(left: &str, right: &str) -> Ordering {
    todo!()
}
