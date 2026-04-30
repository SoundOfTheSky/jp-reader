import { wait } from '@softsky/utils'

import { getKanjiIntervals, SyncStorage, tokenize } from './shared'

const IGNORED_TEXT = new Set(
  '。.、,「」[]『』・？?！!（）()【】ー-—…０１２３４５６７８９',
)
const JPREADER = 'jp-reader'
let storage: SyncStorage
const IGNORED_TAGS = new Set([
  'RT',
  'RP',
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'RT',
  'TITLE',
])
const annotateQueue = new Set<Node>()
let annotating = false
// Wait for load
void Promise.all([
  // Page load
  new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (document.readyState === 'complete') {
        clearInterval(interval)
        resolve()
      }
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
async function annotate(nextRoot: Node) {
  annotateQueue.add(nextRoot)
  if (annotating) return
  annotating = true
  for (const root of annotateQueue) {
    // annotateQueue.delete(root)
    try {
      const parent = root.parentElement
      if (
        // Ignore without parent
        !parent ||
        // Not in DOM for some reason
        !parent.isConnected ||
        // If parent is JPREADER
        parent.classList.contains(JPREADER) ||
        // If Text node
        (root.nodeType === 3
          ? // No value
            !root.nodeValue ||
            // Parent ignored
            IGNORED_TAGS.has(parent.tagName) ||
            // Next sibling is JPREADER (caused by splitting nodes)
            (
              root.previousSibling as { classList?: DOMTokenList } | undefined
            )?.classList?.contains(JPREADER) ||
            // Previous sibling is JPREADER (caused by splitting nodes)
            (
              root.nextSibling as { classList?: DOMTokenList } | undefined
            )?.classList?.contains(JPREADER)
          : // If HTMLElement
            root.nodeType !== 1 ||
            // If JPREADER
            (root as HTMLElement).classList.contains(JPREADER) ||
            // If ignored
            IGNORED_TAGS.has((root as HTMLElement).tagName))
      )
        continue
      // console.log('Annotate', root)
      // Remove all existing annotations to avoid duplication
      removeAnnotations(root)
      // Iterate all text nodes
      const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT)
      let node: Text | null
      while ((node = iterator.nextNode() as Text | null)) {
        const parent = node.parentElement
        const text = node.nodeValue
        // Skip if ignored, non japanese or doesn't have a parent
        if (
          !parent ||
          !text ||
          IGNORED_TAGS.has(parent.tagName) ||
          parent.classList.contains(JPREADER) ||
          !isJapanese(text)
        )
          continue
        const tokens = await tokenize(text)
        for (let index = tokens.length - 1; index !== -1; index--) {
          try {
            const token = tokens[index]!
            if (!isJapanese(token.text)) continue
            const isNotAlreadyRuby =
              parent.tagName !== 'RUBY' && parent.tagName !== 'RB'
            const isWholeRuby =
              isNotAlreadyRuby &&
              token.furigana?.start === 0 &&
              token.furigana.end === token.text.length
            const wrapper = document.createElement(
              isWholeRuby ? 'ruby' : 'span',
            )
            if (token.interval === undefined) wrapper.className = JPREADER
            // Apply interval
            else
              for (let index = 0; index < HIGHLIGHTS.length; index++) {
                const x = HIGHLIGHTS[index]!
                if (x[1] <= token.interval) {
                  wrapper.classList = `${JPREADER} ${JPREADER}-${x[0]}`
                  break
                }
              }

            const range = new Range()
            range.setStart(node, token.position)
            range.setEnd(node, token.position + token.text.length)
            range.surroundContents(wrapper)

            // Apply furigana inside wrapper
            if (token.furigana && isNotAlreadyRuby) {
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
      root.normalize()
      const kanjiIntervals = await getKanjiIntervals()
      if (kanjiIntervals) {
        let lastUpdate = Date.now()
        while ((node = iterator.previousNode() as Text | null)) {
          const nodeText = node.nodeValue
          if (!nodeText) continue
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
          if (now - lastUpdate > 500) {
            lastUpdate = now
            await wait(1)
          }
        }
      }
    } catch {
      continue
    }
  }
  annotating = false
  annotateQueue.clear()
  // console.log('Annotation finished')
}

/** Removes annotations. Except kanji ones... */
function removeAnnotations(root: Node) {
  if (root.nodeType !== 1) return
  const element = root as HTMLElement
  const readers: HTMLElement[] = []
  if (element.classList.contains(JPREADER)) readers.push(element)
  for (const el of element.querySelectorAll<HTMLElement>('.' + JPREADER))
    readers.push(el)
  for (const reader of readers) {
    const clone = reader.cloneNode(true) as HTMLElement
    for (const rt of clone.querySelectorAll('rt, rp')) rt.remove()
    reader.replaceWith(...clone.childNodes)
  }
  root.normalize()
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
