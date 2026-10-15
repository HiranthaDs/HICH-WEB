/** Prepare trusted proposal HTML for an isolated srcdoc frame without changing the saved source. */
export function prepareProposalHtml(html: string, readySignal?: string): string {
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
  if (readySignal) {
    // Report parsed, visible content without waiting for images, fonts or other
    // external assets to finish. The parent checks the sending frame before
    // recording an open; admin previews do not install this signal.
    const signal = JSON.stringify(readySignal).replace(/</g, '\\u003c')
    const origin = JSON.stringify(window.location.origin).replace(/</g, '\\u003c')
    const readyScript = `<script>document.addEventListener('DOMContentLoaded',function(){requestAnimationFrame(function(){parent.postMessage({type:${signal}},${origin})})},{once:true})</script>`
    if (/<head(?:\s[^>]*)?>/i.test(prepared)) prepared = prepared.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${readyScript}`)
    else prepared = `${readyScript}${prepared}`
  }
  return prepared
}
