import { Semaphore } from '@softsky/utils'

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

// const observerIgnoredNodes = new WeakSet<Node>()
const annotateSemaphore = new Semaphore(1)

// CSS + highlights
const HIGHLIGHTS = [
  ['gray', 21, new Highlight()],
  ['aqua', 7, new Highlight()],
  ['lawngreen', 1, new Highlight()],
  ['gold', 0, new Highlight()],
  ['red', -Infinity, new Highlight()],
] as const
const HIGH_HIGHLIGHT = new Highlight()
injectCSS()

const observer = new MutationObserver((mutations) => {
  for (let index = 0; index < mutations.length; index++) {
    const mutation = mutations[index]!
    // Text changes
    if (mutation.type === 'characterData') {
      if (!mutation.target.parentElement?.querySelector('.' + JPREADER))
        void annotate(mutation.target)
    } else {
      // New nodes added
      const addedNodes = mutation.addedNodes
      for (let index = 0; index < addedNodes.length; index++) {
        const node = addedNodes[index]!
        const element =
          node.nodeType === 3 ? node.parentElement! : (node as HTMLElement)
        if (
          element.classList.contains(JPREADER) ||
          element.parentElement?.classList.contains(JPREADER)
        )
          continue
        void annotate(node)
      }
    }
  }
})

function injectCSS() {
  const style = document.createElement('style')
  style.textContent =
    HIGHLIGHTS.map(
      ([name]) => `::highlight(${JPREADER}-${name}-kanji) {
  color: ${name};
}
    
.${JPREADER}-${name} {
  text-decoration: ${name} underline;
  margin: 0 1px;
}`,
    ).join('\n') +
    `::highlight(${JPREADER}-high) {
  text-decoration: overline;
}`
  document.head.appendChild(style)
  CSS.highlights.set('high', HIGH_HIGHLIGHT)
  for (let index = 0; index < HIGHLIGHTS.length; index++) {
    const [name, , highlight] = HIGHLIGHTS[index]!
    CSS.highlights.set(`${JPREADER}-${name}-kanji`, highlight)
  }
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
    HIGH_HIGHLIGHT.clear()
    for (let index = 0; index < HIGHLIGHTS.length; index++)
      HIGHLIGHTS[index]![2].clear()
    observer.disconnect()
    removeAnnotations(document.body)
  }
}

/** Annotate node block */
async function annotate(node?: Node) {
  if (!node) return
  console.log('Annotate', node)
  await annotateSemaphore.acquire()
  const ignoredNodes = new Set<Node>()
  try {
    // Remove all existing annotations to avoid duplication
    removeAnnotations(node)
    const { text, nodes, indexes } = extractJapaneseNodes(node)
    if (!text) return
    let elementIndex = nodes.length - 1
    const tokens = await tokenize(text)
    // Calculate ranges
    for (let index = tokens.length - 1; index !== -1; index--) {
      try {
        const token = tokens[index]!

        // Ignore non japanese text
        let isJapanese = false
        for (let index = 0; index < token.text.length; index++) {
          const charCode = token.text.charCodeAt(index)
          if (charCode > 12288 && charCode < 40960) {
            isJapanese = true
            break
          }
        }
        if (!isJapanese) continue

        // Start element
        while (indexes[elementIndex]! > token.position) elementIndex--
        const element = nodes[elementIndex]!
        const offset = token.position - indexes[elementIndex]!

        // End element
        const endPosition = token.position + token.text.length
        while (indexes[elementIndex]! > endPosition) elementIndex--
        const endElement = nodes[elementIndex]!
        const endOffset = endPosition - indexes[elementIndex]!

        const isAlreadyRuby =
          (element as HTMLElement).tagName === 'RUBY' ||
          (endElement as HTMLElement).tagName === 'RUBY'
        const isWholeKanji =
          token.furigana?.end === token.text.length &&
          (element as HTMLElement).tagName !== 'RUBY'
        const wrapper = document.createElement(
          !isAlreadyRuby && isWholeKanji ? 'ruby' : 'span',
        )
        wrapper.classList.add(JPREADER)

        // Try to surround contents
        // If it fails, it means that range is splitting two different elements in half.
        // In this case we failsafe to surrounding first character.
        // It will look weird, but still better than nothing.
        const range = document.createRange()
        range.setStart(element, offset)
        try {
          range.setEnd(endElement, endOffset)
          range.surroundContents(wrapper)
        } catch {
          range.setEnd(element, offset + 1)
          range.surroundContents(wrapper)
        }

        // Apply anki hightlight
        if (token.interval !== undefined) {
          for (let index = 0; index < HIGHLIGHTS.length; index++) {
            const highlight = HIGHLIGHTS[index]!
            if (highlight[1] <= token.interval) {
              wrapper.classList.add(`${JPREADER}-${highlight[0]}`)
              break
            }
          }
        }

        // Apply furigana inside wrapper
        if (!isAlreadyRuby && token.furigana) {
          const rt = document.createElement('rt')
          rt.textContent = token.furigana.text
          if (isWholeKanji) wrapper.appendChild(rt)
          else {
            const ruby = document.createElement('ruby')
            ignoredNodes.add(ruby)
            ruby.classList.add(JPREADER)
            const range = document.createRange()
            const node = wrapper.childNodes[0]!
            range.setStart(node, token.furigana.start)
            try {
              range.setEnd(node, token.furigana.end)
              range.surroundContents(ruby)
            } catch {
              range.setEnd(node, token.furigana.start + 1)
              range.surroundContents(ruby)
            }
            ruby.appendChild(rt)
          }
        }

        // Add elements' parents to be ignored in MutationObserver.
        ignoredNodes.add(wrapper)
        ignoredNodes.add(element)
        ignoredNodes.add(endElement)
        ignoredNodes.add(element.parentElement!)
        ignoredNodes.add(endElement.parentElement!)
      } catch {
        continue
      }
    }
  } finally {
    annotateSemaphore.release()
    await annotateKanji(node)
  }
}

/** Annotate kanji at node */
async function annotateKanji(root: Node) {
  const kanjiIntervals = await getKanjiIntervals()
  if (!kanjiIntervals) return
  const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT)
  let node: Text | null
  while ((node = iterator.nextNode() as Text | null)) {
    if (isInvisibleNode(node)) continue
    // Check if contains japanese and kanji
    const nodeText = node.nodeValue
    if (!nodeText) continue
    for (let index = 0; index < nodeText.length; index++) {
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
    }
  }
}

/** Extract visible text with links to the nodes contaning this text */
function extractJapaneseNodes(root: Node) {
  const nodes: Node[] = []
  const indexes: number[] = []
  let text = ''
  const kanji = new Map<string, number[]>()
  const iterator = document.createNodeIterator(root, NodeFilter.SHOW_TEXT)
  let node: Text | null
  while ((node = iterator.nextNode() as Text | null)) {
    if (isInvisibleNode(node)) continue
    // Check if contains japanese and kanji
    const nodeText = node.nodeValue
    if (!nodeText) continue
    let containsJapanese = false
    for (let index = 0; index < nodeText.length; index++) {
      const charCode = nodeText.charCodeAt(index)
      // Is japanese
      if (charCode > 12288 && charCode < 40960) {
        containsJapanese = true
        const char = nodeText[index]!
        // Is kanji + evil oneliner
        if (charCode > 12539 && charCode < 40880)
          (kanji.get(char) ?? kanji.set(char, []).get(char)!).push(
            text.length + index,
          )
      }
    }
    if (!containsJapanese) continue
    nodes.push(node)
    indexes.push(text.length)
    text += nodeText
  }
  return { text, nodes, indexes, kanji }
}

/** Is node invisible in DOM */
function isInvisibleNode(node: Node) {
  const parent = node.parentElement!
  // Ignore if too small or furigana
  if (
    (parent.offsetWidth < 2 && parent.offsetHeight < 2) ||
    parent.tagName === 'RT' ||
    parent.tagName === 'RP'
  )
    return true

  // Ignore if hidden
  const style = getComputedStyle(parent)
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.opacity === '0'
  )
    return true
  return false
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

// function isPitchHigh(pos: number, mora: number) {
//   if (pos === 0) return mora !== 0
//   if (pos === 1) return mora === 0
//   if (mora === 0) return false
//   return mora < pos
// }

//   function buildPitch(range: Range, accentPosition: number) {
//     const types = [
//       ['平板[へいばん]', 'heiban'],
//       ['頭高[あたまだか]', 'atamadaka'],
//       ['中高[なかだか]', 'nakadaka'],
//       ['尾高[おだか]', 'odaka'],
//     ]
//     const $pitch = document.querySelector('.pitch')
//     const expression = $pitch.innerText
//     $pitch.innerHTML = ''
//     const $pitchWrapper = document.createElement('div')
//     $pitch.appendChild($pitchWrapper)
//     let typeIndex = 2
//     if (accentPosition === 0) typeIndex = 0
//     else if (accentPosition === 1) typeIndex = 1
//     else if (
//       accentPosition ===
//       expression.replace(/[ァィゥェォャュョヮぁぃぅぇぉゃゅょゎ]/g, '').length
//     )
//       typeIndex = 3
//     $pitchWrapper.classList.add(types[typeIndex][1])
//     for (let index = 0, mora = 0, $pos; index < expression.length; index++) {
//       const character = expression[index]
//       if (noMora.has(character)) $pos.innerText += character
//       else {
//         $pos = document.createElement('span')
//         $pitchWrapper.appendChild($pos)
//         $pos.innerText += character
//         const high = isPitchHigh(accentPosition, mora)
//         const next = isPitchHigh(accentPosition, ++mora)
//         $pos.classList.add(high ? 'high' : 'low')
//         if (high !== next) $pos.classList.add('changing')
//       }
//     }
//     const $pitchTag = document.createElement('sup')
//     $pitchTag.classList.add('pitch-tag')
//     $pitchTag.innerText = accentPosition
//     $pitchWrapper.appendChild($pitchTag)
//   }
// }
