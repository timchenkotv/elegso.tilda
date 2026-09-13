/** Basic inline JSON-LD inspection, independent of any builder's data markers.
 * Does not fetch remote contexts or promise a rich-result/Schema.org validation.
 */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absoluteIri = value => typeof value === 'string' && /^https?:\/\/[^\s<>]+$/i.test(value);

function meaningfulContext(value) {
  if (absoluteIri(value)) return true;
  if (Array.isArray(value)) return value.length > 0 && value.some(meaningfulContext);
  if (!object(value)) return false;
  if (absoluteIri(value['@vocab'])) return true;
  return Object.entries(value).some(([term, definition]) => !term.startsWith('@')
    && (absoluteIri(definition) || (object(definition) && absoluteIri(definition['@id']))));
}

function nodeTypes(node, inheritedContext = false) {
  if (Array.isArray(node)) return node.flatMap(value => nodeTypes(value, inheritedContext));
  if (!object(node)) return [];
  const context = Object.hasOwn(node, '@context') ? meaningfulContext(node['@context']) : inheritedContext;
  const types = typeof node['@type'] === 'string' ? [node['@type']] : node['@type'];
  const own = context && Array.isArray(types) && types.length
    && types.every(type => typeof type === 'string' && type.trim() === type && type.length && !/[\s<>]/.test(type)) ? types : [];
  return [...own, ...(Array.isArray(node['@graph']) ? nodeTypes(node['@graph'], context) : [])];
}

export function inspectStructuredData(html) {
  // A commented-out/template-only script is not a page's live structured data.
  const markup = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<template\b[^>]*>[\s\S]*?<\/template\s*>/gi, '');
  const blocks = [];
  for (const match of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = match[1].match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!type || !/^application\/ld\+json$/i.test((type[1] ?? type[2] ?? type[3]).trim())) continue;
    let payload;
    try { payload = JSON.parse(match[2]); }
    catch { blocks.push({ index: blocks.length, valid: false, error: 'invalid-json', types: [] }); continue; }
    const types = [...new Set(nodeTypes(payload))];
    blocks.push({ index: blocks.length, valid: types.length > 0, error: types.length ? null : 'missing-context-or-typed-node', types });
  }
  return {
    count: blocks.length,
    validCount: blocks.filter(block => block.valid).length,
    types: [...new Set(blocks.flatMap(block => block.types))],
    blocks,
    errors: [...(!blocks.some(block => block.valid) ? ['missing-structured-data'] : []),
      ...blocks.filter(block => !block.valid).map(block => `invalid-structured-data:${block.index + 1}:${block.error}`)],
  };
}
