/**
 * Remove Rust comments from source while preserving every line and column:
 * comment characters become spaces, newlines are untouched. Line numbers in
 * prompts and anchors therefore stay valid, and string contents (`"//"`,
 * raw strings, char literals) are never mistaken for comments.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  const length = source.length;
  let i = 0;

  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') {
        out[k] = ' ';
      }
    }
  };

  const skipString = (start: number, quoteAt: number): number => {
    let j = quoteAt + 1;
    while (j < length) {
      if (source[j] === '\\') {
        j += 2;
        continue;
      }
      if (source[j] === '"') {
        return j + 1;
      }
      j += 1;
    }
    return length;
  };

  while (i < length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === '/' && next === '/') {
      let j = i;
      while (j < length && source[j] !== '\n') {
        j += 1;
      }
      blankRange(i, j);
      i = j;
      continue;
    }

    if (char === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < length && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          depth += 1;
          j += 2;
          continue;
        }
        if (source[j] === '*' && source[j + 1] === '/') {
          depth -= 1;
          j += 2;
          continue;
        }
        j += 1;
      }
      blankRange(i, j);
      i = j;
      continue;
    }

    // Raw strings: r"…", r#"…"#, br"…", br##"…"##.
    const boundary = i === 0 || !/[A-Za-z0-9_]/.test(source[i - 1]);
    if (boundary && (char === 'r' || (char === 'b' && next === 'r'))) {
      let j = char === 'b' ? i + 1 : i;
      j += 1;
      let hashes = 0;
      while (source[j] === '#') {
        hashes += 1;
        j += 1;
      }
      if (source[j] === '"') {
        const terminator = `"${'#'.repeat(hashes)}`;
        const end = source.indexOf(terminator, j + 1);
        i = end === -1 ? length : end + terminator.length;
        continue;
      }
    }

    if (char === 'b' && next === '"') {
      i = skipString(i, i + 1);
      continue;
    }

    if (char === '"') {
      i = skipString(i, i);
      continue;
    }

    if (char === "'") {
      if (next === '\\') {
        let j = i + 2;
        while (j < length) {
          if (source[j] === '\\') {
            j += 2;
            continue;
          }
          if (source[j] === "'") {
            j += 1;
            break;
          }
          j += 1;
        }
        i = j;
        continue;
      }
      if (next !== undefined && source[i + 2] === "'") {
        i += 3;
        continue;
      }
      // A lifetime like 'static: just skip the quote, the identifier stays.
      i += 1;
      continue;
    }

    i += 1;
  }

  return out.join('');
}
