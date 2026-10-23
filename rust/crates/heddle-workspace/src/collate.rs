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

/// One compared element: a single character, or a run of digits compared as a number.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Element {
    Char {
        class: u8,
        value: u32,
    },
    /// A digit run: its value without leading zeros, how many leading zeros it had, and its length.
    Number {
        value: String,
        zeros: usize,
    },
}

impl Element {
    fn class(&self) -> u8 {
        match self {
            Element::Char { class, .. } => *class,
            Element::Number { .. } => 2,
        }
    }
}

/// The class rank and comparison value of one character: whitespace, punctuation, letters, anything
/// else — digits are runs and never reach here.
fn char_element(character: char) -> Element {
    if character.is_whitespace() {
        return Element::Char {
            class: 0,
            value: character as u32,
        };
    }
    if let Some(rank) = PUNCTUATION.iter().position(|punct| *punct == character) {
        return Element::Char {
            class: 1,
            value: rank as u32,
        };
    }
    let base = base_letter(character);
    if base.is_alphabetic() {
        return Element::Char {
            class: 3,
            value: base as u32,
        };
    }
    Element::Char {
        class: 4,
        value: character as u32,
    }
}

/// ICU's root order of the punctuation a folder name uses, as far as this tree needs it.
const PUNCTUATION: [char; 31] = [
    '_', '-', ',', ';', ':', '!', '?', '.', '\'', '"', '(', ')', '[', ']', '{', '}', '@', '*', '/',
    '\\', '&', '#', '%', '`', '^', '+', '<', '=', '>', '|', '~',
];

/// A character folded for `base` sensitivity: lower case, and an accented Latin letter to its base.
fn base_letter(character: char) -> char {
    let lower = character.to_lowercase().next().unwrap_or(character);
    match lower {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'ç' | 'ć' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ğ' | 'ĝ' | 'ġ' | 'ģ' => 'g',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'ĭ' | 'į' | 'ı' => 'i',
        'ł' | 'ľ' | 'ĺ' | 'ļ' => 'l',
        'ñ' | 'ń' | 'ň' | 'ņ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' => 'o',
        'ř' | 'ŕ' => 'r',
        'ś' | 'š' | 'ş' | 'ș' => 's',
        'ť' | 'ț' | 'ţ' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' => 'u',
        'ý' | 'ÿ' => 'y',
        'ź' | 'ž' | 'ż' => 'z',
        other => other,
    }
}

/// Split a name into the elements a collator compares.
fn elements(text: &str) -> Vec<Element> {
    let characters: Vec<char> = text.chars().collect();
    let mut result = Vec::with_capacity(characters.len());
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character.is_ascii_digit() {
            let start = index;
            while index < characters.len() && characters[index].is_ascii_digit() {
                index += 1;
            }
            let run: String = characters[start..index].iter().collect();
            let trimmed = run.trim_start_matches('0');
            result.push(Element::Number {
                zeros: run.len() - trimmed.len(),
                value: trimmed.to_string(),
            });
            continue;
        }
        result.push(char_element(character));
        index += 1;
    }
    result
}

fn compare_elements(left: &Element, right: &Element) -> Ordering {
    let left_class = left.class();
    let right_class = right.class();
    if left_class != right_class {
        return left_class.cmp(&right_class);
    }
    match (left, right) {
        (Element::Char { value: left, .. }, Element::Char { value: right, .. }) => left.cmp(right),
        (
            Element::Number {
                value: left_value,
                zeros: left_zeros,
            },
            Element::Number {
                value: right_value,
                zeros: right_zeros,
            },
        ) => left_value
            .len()
            .cmp(&right_value.len())
            .then_with(|| left_value.cmp(right_value))
            .then_with(|| left_zeros.cmp(right_zeros)),
        _ => Ordering::Equal,
    }
}

/// Compare two names the way the tree orders them.
pub fn compare_names(left: &str, right: &str) -> Ordering {
    let left = elements(left);
    let right = elements(right);
    for (one, other) in left.iter().zip(right.iter()) {
        let order = compare_elements(one, other);
        if order != Ordering::Equal {
            return order;
        }
    }
    left.len().cmp(&right.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(names: &[&str]) -> Vec<String> {
        let mut names: Vec<String> = names.iter().map(|name| (*name).to_string()).collect();
        names.sort_by(|left, right| compare_names(left, right));
        names
    }

    #[test]
    fn a_type_folder_sorts_before_a_plain_letter() {
        // `_tools_` before `dist` is what the TypeScript tree shows, and the reason is the class order.
        assert_eq!(compare_names("_tools_", "dist"), Ordering::Less);
        assert_eq!(
            sorted(&["dist", "_tools_", "shared"]),
            vec!["_tools_", "dist", "shared"]
        );
    }

    #[test]
    fn digit_runs_compare_by_value() {
        assert_eq!(compare_names("item-2", "item-10"), Ordering::Less);
        assert_eq!(compare_names("item-10", "item-9"), Ordering::Greater);
        assert_eq!(sorted(&["v10", "v2", "v1"]), vec!["v1", "v2", "v10"]);
    }

    #[test]
    fn case_is_ignored_and_an_equal_pair_keeps_its_order() {
        assert_eq!(compare_names("README", "Readme"), Ordering::Equal);
        assert_eq!(compare_names("readme", "README"), Ordering::Equal);
        // A stable sort keeps the byte order the directory gave for an equal pair.
        assert_eq!(sorted(&["Readme", "README"]), vec!["Readme", "README"]);
    }

    #[test]
    fn common_accents_fold_to_their_base_letter() {
        assert_eq!(compare_names("café", "cafe"), Ordering::Equal);
        assert_eq!(compare_names("Über", "uber"), Ordering::Equal);
        assert_eq!(compare_names("naïve", "naive"), Ordering::Equal);
    }

    #[test]
    fn punctuation_sorts_before_digits_and_letters() {
        assert_eq!(sorted(&["a", "2", "-", "_"]), vec!["_", "-", "2", "a"]);
        // The punctuation list's own order is ICU's, so `_` comes before `-`.
        assert_eq!(compare_names("_a", "-a"), Ordering::Less);
    }

    #[test]
    fn a_prefix_sorts_before_the_longer_name() {
        assert_eq!(compare_names("some-tool", "some-tools"), Ordering::Less);
        assert_eq!(compare_names("some-tools", "some-tool"), Ordering::Greater);
    }
}
