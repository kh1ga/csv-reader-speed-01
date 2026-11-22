// solve.js — a fast drop-in replacement for csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for an
// input {text, header}: the JSON value {columns, rows, errors}, under the
// same broken-row policy: a U+FEFF at the very start is dropped; a record
// ends at LF or CRLF and a line left with no characters is no record; a CR
// outside quotes that is not followed by LF is dropped (stray_cr); a field
// that opens with a quote runs to the next quote that is not doubled (""
// inside it is one quote, and each CRLF or lone CR inside it is read as
// LF); what follows the closing quote, up to the next comma or line break,
// is appended as it stands (quote_junk, when the field ends); a quote that
// never closes is a literal character and the text after it is read again
// as unquoted (unterminated_quote); a quote inside an unquoted field is a
// literal character; fields stay strings, never trimmed. columns is the
// first record when header is true, else null; rows holds the records
// after it (every record when header is false), each padded with empty
// strings (short_row, with fields: its field count) or cut (long_row, with
// extra: the cut fields) to the first record's width. Each error is
// {code, line, row} in the order met: line the 1-based line its record
// starts on (every LF, CRLF and lone CR inside quotes counted), row its
// record's index in rows, null for the header.
//
// The reader is one left-to-right scan over the string by charCodeAt.
// Field values are slices of the input wherever the text allows it; a
// value is assembled from pieces only when the field itself forces it (a
// dropped stray CR, a doubled quote, a CR read as LF, or a prefix carried
// into an unquoted re-read).

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, and the index in rows it
  // takes (null: the header).
  let recLine = 1;
  let recRow = null;

  // scanUnquoted's results, kept in scratch variables so a field costs no
  // result object: the value read, how it ended (0 comma, 1 line break,
  // 2 end of text) and how many characters the read itself kept.
  let scValue = '';
  let scEnded = 2;
  let scAdded = 0;

  // Reads unquoted characters from pos onto `prefix`, up to the next comma
  // or line break: a CR not followed by LF is dropped (stray_cr). Advances
  // pos and line past what it read, delimiter included.
  function scanUnquoted(prefix) {
    const t = text;
    const len = n;
    let j = pos;
    let ln = line;
    let seg = j;
    let end = len;
    let ended = 2;
    let added = 0;
    let parts = null;
    while (j < len) {
      const c = t.charCodeAt(j);
      if (c === 44) { // ','
        end = j; ended = 0; j += 1; break;
      }
      if (c === 10) { // LF
        end = j; ended = 1; ln += 1; j += 1; break;
      }
      if (c === 13) { // CR
        if (t.charCodeAt(j + 1) === 10) {
          end = j; ended = 1; ln += 1; j += 2; break;
        }
        if (parts === null) parts = [prefix];
        parts.push(t.slice(seg, j));
        added += j - seg;
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        j += 1; seg = j;
        continue;
      }
      j += 1;
    }
    pos = j;
    line = ln;
    if (parts === null) {
      scValue = prefix === '' ? t.slice(seg, end) : prefix + t.slice(seg, end);
      scAdded = end - seg;
    } else {
      parts.push(t.slice(seg, end));
      scValue = parts.join('');
      scAdded = added + (end - seg);
    }
    scEnded = ended;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1; line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2; line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let lastQuoted = false;
    let ended = 0;

    do {
      if (text.charCodeAt(pos) === 34) { // '"': a field that opens with a quote
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        const t = text;
        let j = pos + 1;
        let seg = j;
        let parts = null;
        let closed = false;
        while (j < n) {
          const c = t.charCodeAt(j);
          if (c === 34) { // '"'
            if (t.charCodeAt(j + 1) === 34) {
              // A doubled quote is one quote.
              if (parts === null) parts = [];
              parts.push(t.slice(seg, j), '"');
              j += 2; seg = j;
              continue;
            }
            closed = true;
            break;
          }
          if (c === 13) { // a CRLF or a lone CR inside quotes is one LF
            if (parts === null) parts = [];
            parts.push(t.slice(seg, j), '\n');
            line += 1;
            j += t.charCodeAt(j + 1) === 10 ? 2 : 1;
            seg = j;
            continue;
          }
          if (c === 10) line += 1;
          j += 1;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the
          // text after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
          scanUnquoted('"');
          fields.push(scValue);
          ended = scEnded;
        } else {
          let value;
          if (parts === null) {
            value = t.slice(seg, j);
          } else {
            parts.push(t.slice(seg, j));
            value = parts.join('');
          }
          j += 1; // past the closing quote
          if (j >= n) {
            pos = j;
            ended = 2;
            fields.push(value);
          } else {
            const c = t.charCodeAt(j);
            if (c === 44) { // ','
              pos = j + 1; ended = 0;
              fields.push(value);
            } else if (c === 10) { // LF
              pos = j + 1; line += 1; ended = 1;
              fields.push(value);
            } else if (c === 13 && t.charCodeAt(j + 1) === 10) { // CRLF
              pos = j + 2; line += 1; ended = 1;
              fields.push(value);
            } else {
              // What follows the closing quote is appended as it stands,
              // up to the next comma or line break.
              pos = j;
              scanUnquoted(value);
              if (scAdded > 0) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
              fields.push(scValue);
              ended = scEnded;
            }
          }
        }
      } else {
        lastQuoted = false;
        scanUnquoted('');
        fields.push(scValue);
        ended = scEnded;
      }
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
