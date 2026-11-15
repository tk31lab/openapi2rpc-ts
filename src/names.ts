/** Splits an arbitrary name ("get-pet_by.ID", "petId", "X-Request-Id", "HTTPServer") into words. */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  const chars = [...s];
  const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
  const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
  const isDigit = (c: string) => c >= '0' && c <= '9';
  chars.forEach((c, i) => {
    if (!/[\p{L}\p{N}]/u.test(c)) {
      if (cur) out.push(cur);
      cur = '';
      return;
    }
    if (isUpper(c) && cur) {
      const prev = cur[cur.length - 1]!;
      const next = chars[i + 1];
      // boundary at lower->Upper ("petId") and at the end of an acronym ("HTTPServer")
      if (isLower(prev) || isDigit(prev) || (isUpper(prev) && next !== undefined && isLower(next))) {
        out.push(cur);
        cur = '';
      }
    }
    cur += c;
  });
  if (cur) out.push(cur);
  return out;
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const leadingDigit = (s: string) => (/^[0-9]/.test(s) ? `_${s}` : s);

/** PascalCase, keeping the casing inside each word ("petID" -> "PetID"). */
export function pascal(s: string): string {
  const out = words(s).map(upperFirst).join('');
  return out ? leadingDigit(out) : '_';
}

/** lowerCamelCase ("X-Request-Id" -> "xRequestId", "ID" -> "id"). */
export function camel(s: string): string {
  const ws = words(s);
  if (ws.length === 0) return '_';
  const [first, ...rest] = ws as [string, ...string[]];
  const head = first.toUpperCase() === first ? first.toLowerCase() : first.charAt(0).toLowerCase() + first.slice(1);
  return leadingDigit(head + rest.map(upperFirst).join(''));
}

/** UPPER_SNAKE_CASE for enum keys ("in-progress" -> "IN_PROGRESS"). */
export function constName(s: string): string {
  const ws = words(s);
  if (ws.length === 0) return 'EMPTY';
  return leadingDigit(ws.map((w) => w.toUpperCase()).join('_'));
}

/** Renders an object key, quoting it when it is not a valid identifier. */
export function propKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Returns `base`, or `base2`, `base3`, ... — whichever is not in `used` — and records it. */
export function unique(used: Set<string>, base: string): string {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}${i}`;
  used.add(name);
  return name;
}

/** Renders a JSDoc block; returns "" when there is nothing to say. */
export function docComment(indent: string, ...lines: (string | undefined | false)[]): string {
  const body = lines
    .filter((l): l is string => typeof l === 'string')
    .flatMap((l) => l.replace(/\s+$/, '').split('\n'))
    .map((l) => l.replace(/\s+$/, '').replace(/\*\//g, '*\\/'));
  while (body.length > 0 && body[0] === '') body.shift();
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  if (body.length === 0) return '';
  if (body.length === 1) return `${indent}/** ${body[0]} */\n`;
  return `${indent}/**\n${body.map((l) => (l ? `${indent} * ${l}` : `${indent} *`)).join('\n')}\n${indent} */\n`;
}
