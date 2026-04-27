import { Semaphore, wait } from '@softsky/utils'

import { getKanjiIntervals, SyncStorage, tokenize } from './shared'

const JPREADER = 'jp-reader'
let storage: SyncStorage
// Wait for load
void Promise.all([
  // Page load
  new Promise<void>((resolve) => {
    if (document.readyState !== 'loading') resolve()
    else
      document.addEventListener('DOMContentLoaded', () => {
        resolve()
      })
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

const annotateSemaphore = new Semaphore(1)

// CSS + highlights
const HIGHLIGHTS = [
  ['gray', 21],
  ['aqua', 7],
  ['lawngreen', 1],
  ['gold', 0],
  ['red', -Infinity],
] as const
injectCSS()

const observer = new MutationObserver((mutations) => {
  for (let index = 0; index < mutations.length; index++) {
    const mutation = mutations[index]!
    // Text changes
    if (mutation.type === 'characterData') {
      const parent = mutation.target.parentElement!
      if (
        parent.tagName !== 'RT' &&
        parent.tagName !== 'RP' &&
        !parent.classList.contains(JPREADER) &&
        // If text node check next and previous sibling for JPREADER
        !(
          mutation.target.previousSibling as
            | { classList?: DOMTokenList }
            | undefined
        )?.classList?.contains(JPREADER) &&
        !(
          mutation.target.nextSibling as
            | { classList?: DOMTokenList }
            | undefined
        )?.classList?.contains(JPREADER)
      )
        void annotate(mutation.target)
    } else {
      // New nodes added
      const addedNodes = mutation.addedNodes
      for (let index = 0; index < addedNodes.length; index++) {
        const node = addedNodes[index]!
        if (
          // If text node check next and previous sibling for JPREADER
          (node.nodeType === 3 &&
            ((
              node.previousSibling as { classList?: DOMTokenList } | undefined
            )?.classList?.contains(JPREADER) ||
              (
                node.nextSibling as { classList?: DOMTokenList } | undefined
              )?.classList?.contains(JPREADER))) ||
          // Check if element is JPREADER
          node.parentElement!.classList.contains(JPREADER) ||
          // Check if parent is JPREADER
          (node as { classList?: DOMTokenList }).classList?.contains(JPREADER)
        )
          continue
        void annotate(node)
      }
    }
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

.${JPREADER}-${name}-kanji {
  color: ${name};
} `,
  ).join('\n')
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
async function annotate(root?: Node) {
  if (!root) return
  await annotateSemaphore.acquire()
  try {
    // Remove all existing annotations to avoid duplication
    removeAnnotations(root)

    // Extract japanese nodes and tokenize
    for (const textNode of extractJapaneseNodes(root)) {
      const text = textNode.nodeValue!
      const tokens = await tokenize(text)
      for (let index = tokens.length - 1; index !== -1; index--) {
        try {
          const token = tokens[index]!

          // Skip non-japanese results of tokenizer
          let isJapanese = Boolean(token.furigana)
          if (!isJapanese)
            for (let index = 0; index < token.text.length; index++) {
              const charCode = token.text.charCodeAt(index)
              if (charCode > 12288 && charCode < 40960) {
                isJapanese = true
                break
              }
            }
          if (!isJapanese) continue

          // Apply interval
          const isWholeRuby =
            token.furigana?.start === 0 &&
            token.furigana.end === token.text.length
          const wrapper = document.createElement(isWholeRuby ? 'ruby' : 'span')
          if (token.interval === undefined) wrapper.className = JPREADER
          else {
            for (let index = 0; index < HIGHLIGHTS.length; index++) {
              const x = HIGHLIGHTS[index]!
              if (x[1] <= token.interval) {
                wrapper.classList = `${JPREADER} ${JPREADER}-${x[0]}`
                break
              }
            }
          }

          const range = new Range()
          range.setStart(textNode, token.position)
          range.setEnd(textNode, token.position + token.text.length)
          range.surroundContents(wrapper)

          // Apply furigana inside wrapper
          if (token.furigana) {
            const rt = document.createElement('rt')
            rt.textContent = token.furigana.text
            if (isWholeRuby) wrapper.appendChild(rt)
            else {
              const ruby = document.createElement('ruby')
              ruby.className = JPREADER
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
  } finally {
    annotateSemaphore.release()
    await annotateKanji(root)
  }
}

async function annotateKanji(root: Node) {
  await annotateSemaphore.acquire()
  try {
    const kanjiIntervals = await getKanjiIntervals()
    if (!kanjiIntervals) return
    const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT)
    let node: Text | null
    let skipNext = false
    while ((node = iterator.nextNode() as Text | null)) {
      if (skipNext) {
        skipNext = false
        continue
      }
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
          const kanjiWrapper = document.createElement('span')
          for (let index = 0; index < HIGHLIGHTS.length; index++) {
            const highlight = HIGHLIGHTS[index]!
            if (highlight[1] <= interval) {
              kanjiWrapper.className = `${JPREADER} ${JPREADER}-${highlight[0]}-kanji`
              break
            }
          }
          range.surroundContents(kanjiWrapper)
          skipNext = true
        } catch {
          continue
        }
      }
      await wait(1)
    }
  } finally {
    annotateSemaphore.release()
  }
}

/** Extract visible text with links to the nodes contaning this text */
function* extractJapaneseNodes(root: Node) {
  const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT)
  let text: Text | null
  let parent
  let skipParent = false
  while ((text = iterator.nextNode() as Text | null)) {
    // On parent update, check if it's invisible
    if (parent !== text.parentElement!) {
      parent = text.parentElement!
      // Ignore if too small or furigana
      if (
        (parent.offsetWidth < 2 && parent.offsetHeight < 2) ||
        parent.tagName === 'RT' ||
        parent.tagName === 'RP' ||
        parent.classList.contains(JPREADER)
      ) {
        skipParent = true
        continue
      }

      // Ignore if hidden
      const style = getComputedStyle(parent)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      ) {
        skipParent = true
        continue
      }
      skipParent = false
    }
    if (skipParent) continue

    // Check if contains japanese and kanji
    const nodeText = text.nodeValue
    if (!nodeText) continue

    // Is japanese
    let containsJapanese = false
    for (let index = 0; index < nodeText.length; index++) {
      const charCode = nodeText.charCodeAt(index)
      if (charCode > 12288 && charCode < 40960) {
        containsJapanese = true
        break
      }
    }
    if (!containsJapanese) continue
    yield text
  }
}

/** Removes annotations. Except kanji ones... */
function removeAnnotations(node: Node) {
  if (node.nodeType === 1) {
    const element = node as HTMLElement
    const readers: HTMLElement[] = []
    if (element.classList.contains(JPREADER)) readers.push(element)
    for (const el of element.querySelectorAll<HTMLElement>('.' + JPREADER))
      readers.push(el)
    for (const reader of readers) {
      const clone = reader.cloneNode(true) as HTMLElement
      for (const rt of clone.querySelectorAll('rt, rp')) rt.remove()
      reader.replaceWith(document.createTextNode(clone.textContent))
    }
  }
}
