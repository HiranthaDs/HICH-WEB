export function normalizeProjectSlug(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 240).replace(/-+$/g, '')
}

export async function preparePortfolioImage(file: File): Promise<File> {
  if (!file.size || file.size > 6_000_000) throw new Error(`${file.name}: choose an image up to 6 MB.`)
  const extension = file.name.split('.').pop()?.toLowerCase() || ''
  const type = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' } as Record<string, string>)[extension]
  if (['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
    return file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified })
  }
  if (type !== 'image/svg+xml') throw new Error(`${file.name}: choose a JPG, PNG, WebP or SVG image.`)

  // SVG is decoded only as an image and uploaded as PNG; active SVG markup is
  // never inserted in the page or stored in the public image bucket.
  const source = URL.createObjectURL(new Blob([file], { type: 'image/svg+xml' }))
  try {
    const preview = new Image()
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('SVG loading timed out.')), 15_000)
      preview.onload = () => { window.clearTimeout(timer); resolve() }
      preview.onerror = () => { window.clearTimeout(timer); reject(new Error('This SVG could not be opened.')) }
      preview.src = source
    })
    const width = preview.naturalWidth || 1600
    const height = preview.naturalHeight || 1000
    const scale = Math.min(2, 2560 / width, 2560 / height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Image conversion is unavailable in this browser.')
    context.drawImage(preview, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The SVG could not be converted.')), 'image/png'))
    if (png.size > 6_000_000) throw new Error('The converted image exceeds 6 MB. Use a smaller SVG.')
    return new File([png], file.name.replace(/\.svg$/i, '') + '.png', { type: 'image/png', lastModified: file.lastModified })
  } catch (error) {
    throw new Error(`${file.name}: ${error instanceof Error ? error.message : 'Please export this SVG as PNG and try again.'}`)
  } finally {
    URL.revokeObjectURL(source)
  }
}
