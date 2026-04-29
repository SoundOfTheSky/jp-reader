import { Semaphore, wait } from '@softsky/utils'

import { getKanjiIntervals, SyncStorage, tokenize } from './shared'

const IGNORED_TEXT = new Set(
  '。.、,「」[]『』・？?！!（）()【】ー-—…０１２３４５６７８９',
)
const JPREADER = 'jp-reader'
let storage: SyncStorage
const annotateSemaphore = new Semaphore(1)
const IGNORED_TAGS = new Set(['RT', 'RP', 'SCRIPT', 'STYLE'])

// Wait for load
void Promise.all([
  // Page load
  new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      clearInterval(interval)
      resolve()
    }, 500)
  }),
  // Storage load
  chrome.storage.sync.get<SyncStorage>().then((x) => (storage = x)),
]).then(() => {
  chrome.runtime.onMessage.addListener(
    (message: { type: 'storage'; storage: SyncStorage }) => {
      storage = message.storage
      reload()
    },
  )
  reload()
})

// CSS + highlights
const HIGHLIGHTS = [
  ['gray', 21, new Highlight()],
  ['aqua', 7, new Highlight()],
  ['lawngreen', 1, new Highlight()],
  ['gold', 0, new Highlight()],
  ['red', -Infinity, new Highlight()],
] as const
injectCSS()

const observer = new MutationObserver((mutations) => {
  for (let index = 0; index < mutations.length; index++) {
    const mutation = mutations[index]!
    // Text changes
    if (mutation.type === 'characterData') void annotate(mutation.target)
    else
      // New nodes added
      for (let index = 0; index < mutation.addedNodes.length; index++)
        void annotate(mutation.addedNodes[index]!)
  }
})

function injectCSS() {
  const style = document.createElement('style')
  style.textContent = HIGHLIGHTS.map(
    ([name]) => `.${JPREADER}-${name}:nth-child(even) {
  text-decoration: ${name} underline;
}

.${JPREADER}-${name}:nth-child(odd) {
  text-decoration: ${name} wavy underline;
}

::highlight(${JPREADER}-${name}) {
  color: ${name};
}`,
  ).join('\n')
  for (const [name, , highlight] of HIGHLIGHTS)
    CSS.highlights.set(`${JPREADER}-${name}`, highlight)
  document.head.appendChild(style)
}

/** Starts/restarts annotation */
function reload() {
  if (storage.enabled) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    void annotate(document.body)
  } else {
    observer.disconnect()
    removeAnnotations(document.body)
  }
}

/** Annotate node block */
async function annotate(root: Node) {
  await annotateSemaphore.acquire()
  try {
    // This insane condition tries to filter out already processed blocks
    const parent = root.parentElement
    if (
      !parent ||
      parent.classList.contains(JPREADER) ||
      !parent.isConnected ||
      (root.nodeType === 3
        ? !root.nodeValue ||
          IGNORED_TAGS.has(parent.tagName) ||
          (
            root.previousSibling as { classList?: DOMTokenList } | undefined
          )?.classList?.contains(JPREADER) ||
          (
            root.nextSibling as { classList?: DOMTokenList } | undefined
          )?.classList?.contains(JPREADER)
        : root.nodeType !== 1 ||
          (root as HTMLElement).classList.contains(JPREADER) ||
          IGNORED_TAGS.has((root as HTMLElement).tagName))
    )
      return
    // console.log('Annotate', root)

    // Remove all existing annotations to avoid duplication
    removeAnnotations(root)

    const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT)
    let node: Text | null
    while ((node = iterator.nextNode() as Text | null)) {
      if (
        node.parentElement &&
        (IGNORED_TAGS.has(node.parentElement.tagName) ||
          node.parentElement.classList.contains(JPREADER))
      )
        continue

      // Check if contains japanese and kanji
      const text = node.nodeValue
      if (!text) continue

      // Is japanese
      if (!isJapanese(text)) continue

      const tokens = await tokenize(text)
      for (let index = tokens.length - 1; index !== -1; index--) {
        try {
          const token = tokens[index]!
          if (!isJapanese(token.text)) continue
          // Apply interval
          const isWholeRuby =
            token.furigana?.start === 0 &&
            token.furigana.end === token.text.length
          const isAlreadyRuby =
            node.parentElement?.tagName === 'RUBY' ||
            node.parentElement?.tagName === 'RB'
          const wrapper = document.createElement(
            !isAlreadyRuby && isWholeRuby ? 'ruby' : 'span',
          )
          if (token.interval === undefined) wrapper.className = JPREADER
          else
            for (let index = 0; index < HIGHLIGHTS.length; index++) {
              const x = HIGHLIGHTS[index]!
              if (x[1] <= token.interval) {
                if (token.text === '電車') console.log(token, x)
                wrapper.classList = `${JPREADER} ${JPREADER}-${x[0]}`
                break
              }
            }

          const range = new Range()
          range.setStart(node, token.position)
          range.setEnd(node, token.position + token.text.length)
          range.surroundContents(wrapper)

          // Apply furigana inside wrapper
          if (token.furigana && !isAlreadyRuby) {
            const rt = document.createElement('rt')
            rt.textContent = token.furigana.text
            if (isWholeRuby) wrapper.appendChild(rt)
            else {
              const ruby = document.createElement('ruby')
              const range = document.createRange()
              const node = wrapper.childNodes[0]!
              range.setStart(node, token.furigana.start)
              range.setEnd(node, token.furigana.end)
              range.surroundContents(ruby)
              ruby.appendChild(rt)
            }
          }
        } catch {
          continue
        }
      }
    }

    // Annotate kanji + cleanup empty nodes
    const kanjiIntervals = await getKanjiIntervals()
    let lastUpdate = Date.now()
    while ((node = iterator.previousNode() as Text | null)) {
      const nodeText = node.nodeValue
      if (!nodeText) {
        node.remove()
        continue
      }
      if (!kanjiIntervals) continue
      for (let index = 0; index < nodeText.length; index++) {
        try {
          const charCode = nodeText.charCodeAt(index)
          // Is kanji
          if (charCode < 12540 || charCode > 40879) continue
          const interval = kanjiIntervals.get(nodeText[index]!) ?? -1
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + 1)
          for (let index = 0; index < HIGHLIGHTS.length; index++) {
            const highlight = HIGHLIGHTS[index]!
            if (highlight[1] <= interval) {
              highlight[2].add(range)
              break
            }
          }
        } catch {
          continue
        }
      }
      const now = Date.now()
      if (now - lastUpdate > 100) {
        lastUpdate = now
        await wait(1)
      }
    }
  } finally {
    annotateSemaphore.release()
  }
}

/** Removes annotations. Except kanji ones... */
function removeAnnotations(node: Node) {
  if (node.nodeType !== 1) return
  const element = node as HTMLElement
  const readers: HTMLElement[] = []
  if (element.classList.contains(JPREADER)) readers.push(element)
  for (const el of element.querySelectorAll<HTMLElement>('.' + JPREADER))
    readers.push(el)
  for (const reader of readers) {
    const clone = reader.cloneNode(true) as HTMLElement
    for (const rt of clone.querySelectorAll('rt, rp')) rt.remove()
    reader.replaceWith(clone.childNodes[0]!)
  }
}

/** Does text contain japanese */
function isJapanese(text: string) {
  if (text.length === 1 && IGNORED_TEXT.has(text)) return false
  for (let index = 0; index < text.length; index++) {
    const charCode = text.charCodeAt(index)
    if (charCode > 12288 && charCode < 40960) return true
  }
  return false
}
