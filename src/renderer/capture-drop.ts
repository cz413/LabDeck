const name = new URLSearchParams(window.location.search).get('name') ?? ''
const target = document.querySelector<HTMLDivElement>('#paste-target')!

target.addEventListener('paste', async (event) => {
  event.preventDefault()
  let image: Blob | null = [...(event.clipboardData?.items ?? [])]
    .map((item) => item.getAsFile())
    .find((file) => file?.type.startsWith('image/')) ?? null
  const text = event.clipboardData?.getData('text/plain') ?? ''
  if (!image && /^data:image\/(?:jpeg|png);base64,/.test(text)) {
    image = await fetch(text).then((response) => response.blob())
  }
  if (!image) {
    target.textContent = '剪贴板里没有图片，请返回应用页重新复制截图。'
    return
  }
  target.textContent = '正在保存到 docs/screenshots…'
  try {
    const response = await fetch(`/__capture_upload?name=${encodeURIComponent(name)}`, { method: 'POST', body: image })
    target.textContent = response.ok ? await response.text() : `保存失败：${await response.text()}`
  } catch (error) {
    target.textContent = `保存失败：${error instanceof Error ? error.message : String(error)}`
  }
})
