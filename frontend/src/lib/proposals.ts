/** Prepare trusted proposal HTML for an isolated srcdoc frame without changing the saved source. */
export function prepareProposalHtml(html: string): string {
  // AI-generated Hich templates commonly use this friendly relative filename.
  // Point it at the portal's real public logo so the same source works in both
  // admin previews and tokenized client URLs at any route depth.
  const logoUrl = new URL('/hich.png', window.location.origin).href
  let prepared = html.replace(/(["'(])(?:\.\/)?hich[_-]?logo\.png(?=["')])/gi, `$1${logoUrl}`)
  if (!/<meta\s+[^>]*name\s*=\s*["']viewport["']/i.test(prepared)) {
    const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1">'
    if (/<head(?:\s[^>]*)?>/i.test(prepared)) prepared = prepared.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${viewport}`)
    else if (/<html(?:\s[^>]*)?>/i.test(prepared)) prepared = prepared.replace(/<html(\s[^>]*)?>/i, (root) => `${root}<head>${viewport}</head>`)
    else prepared = `${viewport}${prepared}`
  }
  return prepared
}
